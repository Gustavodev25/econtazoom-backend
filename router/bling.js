const express = require('express');
const axios = require('axios');
const qs = require('querystring');
const router = express.Router();
const db = require('../firebase').db;
const admin = require('../firebase').admin;
const crypto = require('crypto');

const BLING_CLIENT_ID = process.env.BLING_CLIENT_ID || '57f339b6be5fdc0d986c1170b709b8d82ece3a76';
const BLING_CLIENT_SECRET = process.env.BLING_CLIENT_SECRET || '5f59f5f4610f20bfd74984f151bcca343cb1375d68cc27216c4b2bc8a97d';

// Updated scopes to include 'vendas' explicitly
const BLING_SCOPES = process.env.BLING_SCOPES || 'vendas+contas';

function getRedirectUri(req) {
  if (process.env.NODE_ENV === 'production' || !req.app.locals.ngrokUrl) {
    return 'https://econtazoom-backend.onrender.com/bling/callback';
  }
  return `${req.app.locals.ngrokUrl}/bling/callback`;
}

function getFrontendUrl() {
  if (process.env.NODE_ENV === 'production') {
    return 'https://econtazoom.com.br/contas';
  }
  return 'http://localhost:8080/contas';
}

router.get('/api/ngrok-url', (req, res) => {
  const ngrokUrl = req.app.locals.ngrokUrl || 'http://localhost:3001';
  res.json({ url: ngrokUrl });
});

router.get('/auth', (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
  const redirectUri = getRedirectUri(req);
  const state = Buffer.from(JSON.stringify({ uid })).toString('base64');
  const url = `https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=${BLING_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&scope=${BLING_SCOPES}`;
  console.log('[bling/auth] Authorization URL:', url);
  res.redirect(url);
});

router.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) {
    console.error('Callback Bling: code ou state ausente', { code, state });
    return res.status(400).json({ error: 'Code e state obrigatórios' });
  }
  const redirectUri = getRedirectUri(req);
  const { uid } = JSON.parse(Buffer.from(state, 'base64').toString());
  try {
    const basicAuth = Buffer.from(`${BLING_CLIENT_ID}:${BLING_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await axios.post(
      'https://www.bling.com.br/Api/v3/oauth/token',
      qs.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${basicAuth}`,
        },
      }
    );
    const { access_token, refresh_token, expires_in } = tokenRes.data;

    let blingAccount = {};
    try {
      const userRes = await axios.get('https://www.bling.com.br/Api/v3/usuarios/me', {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      blingAccount = {
        nome: userRes.data?.nome || userRes.data?.name || '',
        email: userRes.data?.email || '',
        id: userRes.data?.id || '',
        ...userRes.data,
      };
    } catch (e) {
      console.warn('[bling/callback] Falha ao obter dados do usuário:', e.message);
      blingAccount = {};
    }

    await db.collection('users').doc(uid).set(
      {
        bling: {
          access_token,
          refresh_token,
          expires_in,
          connectedAt: new Date().toISOString(),
          ...blingAccount,
        },
      },
      { merge: true }
    );

    console.log('Callback Bling: sucesso, redirecionando para frontend');
    res.redirect(getFrontendUrl() + '?bling=success');
  } catch (err) {
    console.error('Erro no callback Bling:', err.response?.data || err.message);
    res.redirect(getFrontendUrl() + `?bling=error&msg=${encodeURIComponent(err.response?.data?.error_description || err.message || 'Erro desconhecido')}`);
  }
});

router.get('/status', async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
  const docSnap = await db.collection('users').doc(uid).get();
  const bling = docSnap.data()?.bling;
  res.json({ connected: !!bling, bling });
});

router.post('/logout', async (req, res) => {
  const { uid } = req.body;
  if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
  try {
    await db.collection('users').doc(uid).update({ bling: admin.firestore.FieldValue.delete() });
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao remover conta Bling' });
  }
});

async function refreshToken(bling, uid) {
  try {
    const basicAuth = Buffer.from(`${BLING_CLIENT_ID}:${BLING_CLIENT_SECRET}`).toString('base64');
    const refreshRes = await axios.post(
      'https://www.bling.com.br/Api/v3/oauth/token',
      qs.stringify({
        grant_type: 'refresh_token',
        refresh_token: bling.refresh_token,
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${basicAuth}`,
        },
      }
    );
    const { access_token, refresh_token, expires_in } = refreshRes.data;
    await db.collection('users').doc(uid).set(
      {
        bling: {
          ...bling,
          access_token,
          refresh_token,
          expires_in,
          connectedAt: new Date().toISOString(),
        },
      },
      { merge: true }
    );
    console.log('[bling/refresh] Token renovado com sucesso');
    return access_token;
  } catch (refreshErr) {
    console.error('[bling/refresh] Erro ao renovar token:', refreshErr.response?.data || refreshErr.message);
    if (refreshErr.response?.data?.error === 'invalid_grant' || refreshErr.response?.data?.error === 'invalid_token') {
      throw new Error('Token Bling expirado ou inválido. Refaça a conexão.');
    }
    throw refreshErr;
  }
}

async function blingPagedGet(url, token, params = {}, refreshFn, uid, maxTotal = 400) {
  let allData = [];
  let page = params.pagina || 1;
  const limit = params.limite || 100;
  let tokenUsado = token;
  let tentouRefresh = false;
  let totalBuscadas = 0;
  while (true) {
    try {
      // Corrige: sempre passa o número correto da página e do limite
      const pageParams = { ...params, limite: Math.min(limit, maxTotal - totalBuscadas), pagina: page };
      console.log(`[blingPagedGet] Requesting ${url} with page=${page}, limit=${pageParams.limite}, params=${JSON.stringify(pageParams)}`);
      const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${tokenUsado}` },
        params: pageParams,
      });
      if (!response.data || !Array.isArray(response.data.data)) {
        throw new Error('Resposta inesperada do Bling: data não é um array');
      }
      allData = allData.concat(response.data.data);
      totalBuscadas = allData.length;
      if (response.data.data.length < pageParams.limite || totalBuscadas >= maxTotal) break;
      page++;
    } catch (err) {
      console.error(`[blingPagedGet] Erro ao acessar ${url}:`, err.response?.data || err.message);
      if (err.response?.status === 401 && refreshFn && !tentouRefresh) {
        tentouRefresh = true;
        try {
          tokenUsado = await refreshFn();
          continue;
        } catch (refreshErr) {
          if (refreshErr.response?.data?.error === 'invalid_grant' || refreshErr.response?.data?.error === 'invalid_token') {
            throw new Error('Token Bling expirado ou inválido. Refaça a conexão.');
          } else if (refreshErr.response?.data?.error === 'insufficient_scope') {
            throw new Error('Permissões insuficientes no Bling. Reconecte sua conta com as permissões corretas.');
          }
          throw refreshErr;
        }
      } else if (err.response?.status === 404 && err.response?.data?.error?.type === 'RESOURCE_NOT_FOUND') {
        throw new Error('Recurso de vendas não encontrado no Bling. Verifique se o módulo de vendas está habilitado na sua conta Bling.');
      } else if (err.response?.data?.error === 'insufficient_scope') {
        throw new Error('Permissões insuficientes no Bling. Reconecte sua conta com as permissões corretas.');
      }
      throw err;
    }
  }
  // Garante que nunca retorna mais que o máximo
  return allData.slice(0, maxTotal);
}

// Cache simples em memória para categorias e portadores
const categoriasCache = {};
const portadoresCache = {};

async function getCategoriaNome(id, token) {
  if (!id) return '-';
  if (categoriasCache[id]) return categoriasCache[id];
  try {
    const res = await axios.get(`https://www.bling.com.br/Api/v3/categorias/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const nome = res.data?.data?.descricao || res.data?.data?.nome || '-';
    categoriasCache[id] = nome;
    return nome;
  } catch {
    return '-';
  }
}

async function getPortadorNome(id, token) {
  if (!id) return '-';
  if (portadoresCache[id]) return portadoresCache[id];
  try {
    const res = await axios.get(`https://www.bling.com.br/Api/v3/portadores/${id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const nome = res.data?.data?.descricao || res.data?.data?.nome || '-';
    portadoresCache[id] = nome;
    return nome;
  } catch {
    return '-';
  }
}

// Função utilitária para mapear conta a pagar (listagem)
function mapearContaPagar(conta) {
  return {
    id: conta.id || '-',
    situacao: conta.situacao || '-',
    vencimento: conta.vencimento || '-',
    valor: Number(conta.valor || 0).toFixed(2),
    saldo: conta.saldo !== undefined ? Number(conta.saldo).toFixed(2) : '-',
    dataEmissao: conta.dataEmissao || '-',
    vencimentoOriginal: conta.vencimentoOriginal || '-',
    numeroDocumento: conta.numeroDocumento || '-',
    competencia: conta.competencia || '-',
    historico: conta.historico || '-',
    numeroBanco: conta.numeroBanco || '-',
    contato: conta.contato?.id || null,
    formaPagamento: conta.formaPagamento?.id || null,
    categoria: conta.categoria?.id || null,
    portador: conta.portador?.id || null,
    borderos: Array.isArray(conta.borderos) ? conta.borderos : [],
    ocorrencia: conta.ocorrencia || null,
    raw: conta,
  };
}

// Listagem paginada
router.get('/contas/pagar', async (req, res) => {
  const { uid, pagina = 1, limite = 100, dataEmissaoInicial, dataEmissaoFinal, dataVencimentoInicial, dataVencimentoFinal, dataPagamentoInicial, dataPagamentoFinal, situacao, idContato } = req.query;
  if (!uid) return res.status(400).json({ error: 'UID obrigatório' });

  try {
    const docSnap = await db.collection('users').doc(uid).get();
    const bling = docSnap.data()?.bling;
    if (!bling?.access_token) return res.status(401).json({ error: 'Conta Bling não conectada', action: 'reconnect' });

    const params = {
      pagina,
      limite,
      dataEmissaoInicial,
      dataEmissaoFinal,
      dataVencimentoInicial,
      dataVencimentoFinal,
      dataPagamentoInicial,
      dataPagamentoFinal,
      situacao,
      idContato,
    };

    Object.keys(params).forEach(k => params[k] === undefined && delete params[k]);

    let response;
    try {
      response = await axios.get('https://www.bling.com.br/Api/v3/contas/pagar', {
        headers: { Authorization: `Bearer ${bling.access_token}` },
        params,
      });
    } catch (err) {
      if (err.response?.status === 401 && bling.refresh_token) {
        try {
          const newToken = await refreshToken(bling, uid);
          response = await axios.get('https://www.bling.com.br/Api/v3/contas/pagar', {
            headers: { Authorization: `Bearer ${newToken}` },
            params,
          });
        } catch (refreshErr) {
          return res.status(401).json({
            error: 'Token Bling expirado ou inválido. Refaça a conexão.',
            action: 'reconnect',
            detalhe: refreshErr.response?.data || refreshErr.message,
          });
        }
      } else {
        if (err.response?.status === 404 && err.response?.data?.error?.type === 'RESOURCE_NOT_FOUND') {
          return res.status(404).json({
            error: 'Recurso "Contas a Pagar" não encontrado no Bling. Verifique se o recurso está habilitado na sua conta Bling.',
            detalhe: err.response?.data || err.message,
          });
        }
        if (err.response?.status === 401) {
          return res.status(401).json({
            error: 'Token Bling expirado ou inválido. Refaça a conexão.',
            action: 'reconnect',
            detalhe: err.response?.data || err.message,
          });
        }
        console.error('[bling/contas/pagar] Erro:', err.response?.data || err.message);
        return res.status(err.response?.status || 500).json({
          error: err.message || 'Erro ao buscar contas a pagar',
          detalhe: err.response?.data || err.message,
        });
      }
    }

    if (!response.data || !Array.isArray(response.data.data)) {
      return res.json({ data: [] });
    }

    const mapped = response.data.data.map(mapearContaPagar);
    res.json({ data: mapped });
  } catch (err) {
    return res.status(err.response?.status || 500).json({
      error: err.message || 'Erro ao buscar contas a pagar',
      detalhe: err.response?.data || err.message,
    });
  }
});

// Detalhe de uma conta a pagar
router.get('/contas/pagar/:idContaPagar', async (req, res) => {
  const { uid } = req.query;
  const { idContaPagar } = req.params;
  if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
  if (!idContaPagar) return res.status(400).json({ error: 'ID da conta a pagar obrigatório' });

  try {
    const docSnap = await db.collection('users').doc(uid).get();
    const bling = docSnap.data()?.bling;
    if (!bling?.access_token) return res.status(401).json({ error: 'Conta Bling não conectada', action: 'reconnect' });

    const response = await axios.get(`https://www.bling.com.br/Api/v3/contas/pagar/${idContaPagar}`, {
      headers: { Authorization: `Bearer ${bling.access_token}` },
    });

    if (!response.data || !response.data.data) {
      return res.status(404).json({ error: 'Conta a pagar não encontrada.' });
    }

    const conta = mapearContaPagar(response.data.data);
    res.json({ data: conta });
  } catch (err) {
    if (err.response?.status === 404) {
      return res.status(404).json({ error: 'Conta a pagar não encontrada.' });
    }
    if (err.response?.status === 401) {
      return res.status(401).json({
        error: 'Token Bling expirado ou inválido. Refaça a conexão.',
        action: 'reconnect',
        detalhe: err.response?.data || err.message,
      });
    }
    return res.status(err.response?.status || 500).json({
      error: err.message || 'Erro ao buscar detalhes da conta a pagar',
      detalhe: err.response?.data || err.message,
    });
  }
});

// Função utilitária para mapear conta a receber (listagem)
function mapearContaReceber(conta) {
  return {
    id: conta.id || '-',
    situacao: conta.situacao || '-',
    vencimento: conta.vencimento || '-',
    valor: Number(conta.valor || 0).toFixed(2),
    dataEmissao: conta.dataEmissao || '-',
    contato: conta.contato?.id || null,
    contatoNome: conta.contato?.nome || '-',
    formaPagamento: conta.formaPagamento?.id || null,
    formaPagamentoCodigoFiscal: conta.formaPagamento?.codigoFiscal || null,
    contaContabil: conta.contaContabil?.descricao || '-',
    linkQRCodePix: conta.linkQRCodePix || null,
    linkBoleto: conta.linkBoleto || null,
    idTransacao: conta.idTransacao || null,
    origem: conta.origem || null,
    raw: conta,
  };
}

// Listagem paginada de contas a receber
router.get('/contas/receber', async (req, res) => {
  const { uid, pagina = 1, limite = 100, situacoes, tipoFiltroData, dataInicial, dataFinal, idsCategorias, idPortador, idContato, idVendedor, idFormaPagamento, boletoGerado } = req.query;
  if (!uid) return res.status(400).json({ error: 'UID obrigatório' });

  try {
    const docSnap = await db.collection('users').doc(uid).get();
    const bling = docSnap.data()?.bling;
    if (!bling?.access_token) return res.status(401).json({ error: 'Conta Bling não conectada', action: 'reconnect' });

    const params = {
      pagina,
      limite,
      tipoFiltroData,
      dataInicial,
      dataFinal,
      idPortador,
      idContato,
      idVendedor,
      idFormaPagamento,
      boletoGerado,
    };

    if (situacoes) params['situacoes[]'] = situacoes;
    if (idsCategorias) params['idsCategorias[]'] = idsCategorias;

    Object.keys(params).forEach(k => params[k] === undefined && delete params[k]);

    let response;
    try {
      response = await axios.get('https://www.bling.com.br/Api/v3/contas/receber', {
        headers: { Authorization: `Bearer ${bling.access_token}` },
        params,
      });
    } catch (err) {
      if (err.response?.status === 401 && bling.refresh_token) {
        try {
          const newToken = await refreshToken(bling, uid);
          response = await axios.get('https://www.bling.com.br/Api/v3/contas/receber', {
            headers: { Authorization: `Bearer ${newToken}` },
            params,
          });
        } catch (refreshErr) {
          return res.status(401).json({
            error: 'Token Bling expirado ou inválido. Refaça a conexão.',
            action: 'reconnect',
            detalhe: refreshErr.response?.data || refreshErr.message,
          });
        }
      } else {
        if (err.response?.status === 404 && err.response?.data?.error?.type === 'RESOURCE_NOT_FOUND') {
          return res.status(404).json({
            error: 'Recurso "Contas a Receber" não encontrado no Bling. Verifique se o recurso está habilitado na sua conta Bling.',
            detalhe: err.response?.data || err.message,
          });
        }
        if (err.response?.status === 401) {
          return res.status(401).json({
            error: 'Token Bling expirado ou inválido. Refaça a conexão.',
            action: 'reconnect',
            detalhe: err.response?.data || err.message,
          });
        }
        console.error('[bling/contas/receber] Erro:', err.response?.data || err.message);
        return res.status(err.response?.status || 500).json({
          error: err.message || 'Erro ao buscar contas a receber',
          detalhe: err.response?.data || err.message,
        });
      }
    }

    if (!response.data || !Array.isArray(response.data.data)) {
      return res.json({ data: [] });
    }

    const contas = response.data.data;
    const mapped = await Promise.all(contas.map(async (conta) => {
      const categoriaId = conta.categoria?.id;
      const portadorId = conta.portador?.id;
      const categoriaNome = await getCategoriaNome(categoriaId, bling.access_token);
      const portadorNome = await getPortadorNome(portadorId, bling.access_token);
      return {
        id: conta.id || '-',
        situacao: conta.situacao || '-',
        vencimento: conta.vencimento || '-',
        valor: Number(conta.valor || 0).toFixed(2),
        dataEmissao: conta.dataEmissao || '-',
        contato: conta.contato?.id || null,
        contatoNome: conta.contato?.nome || '-',
        formaPagamento: conta.formaPagamento?.id || null,
        formaPagamentoCodigoFiscal: conta.formaPagamento?.codigoFiscal || null,
        contaContabil: conta.contaContabil?.descricao || '-',
        categoria: categoriaNome,
        portador: portadorNome,
        linkQRCodePix: conta.linkQRCodePix || null,
        linkBoleto: conta.linkBoleto || null,
        idTransacao: conta.idTransacao || null,
        origem: conta.origem || null,
        raw: conta,
      };
    }));

    res.json({ data: mapped });
  } catch (err) {
    return res.status(err.response?.status || 500).json({
      error: err.message || 'Erro ao buscar contas a receber',
      detalhe: err.response?.data || err.message,
    });
  }
});

// Detalhe de uma conta a receber
router.get('/contas/receber/:idContaReceber', async (req, res) => {
  const { uid } = req.query;
  const { idContaReceber } = req.params;
  if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
  if (!idContaReceber) return res.status(400).json({ error: 'ID da conta a receber obrigatório' });

  try {
    const docSnap = await db.collection('users').doc(uid).get();
    const bling = docSnap.data()?.bling;
    if (!bling?.access_token) return res.status(401).json({ error: 'Conta Bling não conectada', action: 'reconnect' });

    const response = await axios.get(`https://www.bling.com.br/Api/v3/contas/receber/${idContaReceber}`, {
      headers: { Authorization: `Bearer ${bling.access_token}` },
    });

    if (!response.data || !response.data.data) {
      return res.status(404).json({ error: 'Conta a receber não encontrada.' });
    }

    res.json({ data: response.data.data });
  } catch (err) {
    if (err.response?.status === 404) {
      return res.status(404).json({ error: 'Conta a receber não encontrada.' });
    }
    if (err.response?.status === 401) {
      return res.status(401).json({
        error: 'Token Bling expirado ou inválido. Refaça a conexão.',
        action: 'reconnect',
        detalhe: err.response?.data || err.message,
      });
    }
    return res.status(err.response?.status || 500).json({
      error: err.message || 'Erro ao buscar detalhes da conta a receber',
      detalhe: err.response?.data || err.message,
    });
  }
});

router.post('/webhook', express.json({ type: '*/*' }), (req, res) => {
  const signature = req.header('X-Bling-Signature-256');
  const clientSecret = BLING_CLIENT_SECRET;
  const payload = JSON.stringify(req.body);

  function isValidSignature(payload, signature, secret) {
    if (!signature || !signature.startsWith('sha256=')) return false;
    const hash = crypto.createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
    return signature === `sha256=${hash}`;
  }

  if (!isValidSignature(payload, signature, clientSecret)) {
    console.warn('[Bling Webhook] Assinatura inválida!');
    return res.status(401).json({ error: 'Assinatura inválida' });
  }

  console.log('[Bling Webhook] Evento recebido:', JSON.stringify(req.body, null, 2));
  res.status(200).json({ ok: true });
});

// Rota para inserir dados de conexão do Bling manualmente para testes
router.post('/test/bling-connect', async (req, res) => {
  const { uid, access_token, refresh_token, expires_in, connectedAt } = req.body;
  if (!uid || !access_token || !refresh_token || !expires_in || !connectedAt) {
    return res.status(400).json({ error: 'Campos obrigatórios: uid, access_token, refresh_token, expires_in, connectedAt' });
  }
  try {
    await db.collection('users').doc(uid).set(
      {
        bling: {
          access_token,
          refresh_token,
          expires_in,
          connectedAt,
        },
      },
      { merge: true }
    );
    res.json({ success: true, bling: { access_token, refresh_token, expires_in, connectedAt } });
  } catch (e) {
    res.status(500).json({ error: 'Erro ao inserir dados de conexão do Bling', detalhe: e.message });
  }
});

// Cache simples para formas de pagamento
let formasPagamentoCache = null;
let formasPagamentoCacheTimestamp = 0;
const FORMAS_PAGAMENTO_CACHE_TTL = 5 * 60 * 1000; // 5 minutos

// Rota para listar formas de pagamento do Bling
router.get('/formas-pagamento', async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'UID obrigatório' });

  // Cache simples para evitar excesso de requisições
  if (formasPagamentoCache && Date.now() - formasPagamentoCacheTimestamp < FORMAS_PAGAMENTO_CACHE_TTL) {
    return res.json({ data: formasPagamentoCache });
  }

  try {
    const docSnap = await db.collection('users').doc(uid).get();
    const bling = docSnap.data()?.bling;
    if (!bling?.access_token) return res.status(401).json({ error: 'Conta Bling não conectada', action: 'reconnect' });

    let page = 1;
    let all = [];
    while (true) {
      const resp = await axios.get('https://www.bling.com.br/Api/v3/formas-pagamentos', {
        headers: { Authorization: `Bearer ${bling.access_token}` },
        params: { pagina: page, limite: 100 }
      });
      if (Array.isArray(resp.data?.data)) {
        all = all.concat(resp.data.data);
        if (resp.data.data.length < 100) break;
        page++;
      } else {
        break;
      }
    }
    formasPagamentoCache = all;
    formasPagamentoCacheTimestamp = Date.now();
    res.json({ data: all });
  } catch (err) {
    res.status(err.response?.status || 500).json({
      error: err.message || 'Erro ao buscar formas de pagamento',
      detalhe: err.response?.data || err.message,
    });
  }
});

// Cache simples para categorias receitas/despesas
let categoriasReceitasDespesasCache = null;
let categoriasReceitasDespesasCacheTimestamp = 0;
const CATEGORIAS_RD_CACHE_TTL = 5 * 60 * 1000; // 5 minutos

router.get('/categorias-receitas-despesas', async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'UID obrigatório' });

  // Cache simples para evitar excesso de requisições
  if (categoriasReceitasDespesasCache && Date.now() - categoriasReceitasDespesasCacheTimestamp < CATEGORIAS_RD_CACHE_TTL) {
    return res.json({ data: categoriasReceitasDespesasCache });
  }

  try {
    const docSnap = await db.collection('users').doc(uid).get();
    const bling = docSnap.data()?.bling;
    if (!bling?.access_token) return res.status(401).json({ error: 'Conta Bling não conectada', action: 'reconnect' });

    let page = 1;
    let all = [];
    while (true) {
      const resp = await axios.get('https://www.bling.com.br/Api/v3/categorias/receitas-despesas', {
        headers: { Authorization: `Bearer ${bling.access_token}` },
        params: { pagina: page, limite: 100 }
      });
      if (Array.isArray(resp.data?.data)) {
        all = all.concat(resp.data.data);
        if (resp.data.data.length < 100) break;
        page++;
      } else {
        break;
      }
    }
    categoriasReceitasDespesasCache = all;
    categoriasReceitasDespesasCacheTimestamp = Date.now();
    res.json({ data: all });
  } catch (err) {
    res.status(err.response?.status || 500).json({
      error: err.message || 'Erro ao buscar categorias receitas/despesas',
      detalhe: err.response?.data || err.message,
    });
  }
});

// Cache simples para canais de venda
let canaisVendaCache = null;
let canaisVendaCacheTimestamp = 0;
const CANAIS_VENDA_CACHE_TTL = 5 * 60 * 1000; // 5 minutos

async function getCanaisVenda(token) {
  if (canaisVendaCache && Date.now() - canaisVendaCacheTimestamp < CANAIS_VENDA_CACHE_TTL) {
    return canaisVendaCache;
  }
  try {
    let page = 1;
    let all = [];
    while (true) {
      const resp = await axios.get('https://www.bling.com.br/Api/v3/canais-venda', {
        headers: { Authorization: `Bearer ${token}` },
        params: { pagina: page, limite: 100 }
      });
      if (Array.isArray(resp.data?.data)) {
        all = all.concat(resp.data.data);
        if (resp.data.data.length < 100) break;
        page++;
      } else {
        break;
      }
    }
    canaisVendaCache = all;
    canaisVendaCacheTimestamp = Date.now();
    return all;
  } catch (err) {
    return [];
  }
}

// ROTA: Buscar vendas do Bling para o dashboard
router.get('/vendas', async (req, res) => {
  const { uid } = req.query;
  let limite = 100;
  if (req.query.limite) {
    const l = parseInt(req.query.limite, 10);
    if (!isNaN(l) && l > 0) {
      limite = Math.min(l, 400);
    }
  } else {
    limite = 400;
  }
  if (!uid) return res.status(400).json({ error: 'UID obrigatório' });

  try {
    const docSnap = await db.collection('users').doc(uid).get();
    const bling = docSnap.data()?.bling;
    if (!bling?.access_token) {
      return res.status(401).json({ error: 'Conta Bling não conectada.', action: 'reconnect' });
    }

    let vendas = [];
    try {
      // Busca vendas do Bling
      const vendasRes = await axios.get('https://www.bling.com.br/Api/v3/pedidos/vendas', {
        headers: { Authorization: `Bearer ${bling.access_token}` },
        params: { limite: 100 }
      });
      // Trata resposta como array ou objeto único
      if (Array.isArray(vendasRes.data?.data)) {
        vendas = vendasRes.data.data;
      } else if (vendasRes.data?.data && typeof vendasRes.data.data === 'object') {
        vendas = [vendasRes.data.data];
      } else {
        vendas = [];
      }
    } catch (err) {
      if (err.response?.status === 401) {
        return res.status(401).json({ error: 'Token Bling expirado ou inválido. Por favor, reconecte sua conta.', action: 'reconnect' });
      }
      if (err.response?.status === 404 && err.response?.data?.error?.type === 'RESOURCE_NOT_FOUND') {
        return res.status(404).json({
          error: 'Módulo de vendas não habilitado ou sem vendas no Bling. Verifique sua conta Bling.',
          action: 'check_account',
        });
      }
      if (err.response?.data?.error === 'insufficient_scope') {
        return res.status(403).json({
          error: 'Permissões insuficientes no Bling. Reconecte sua conta com a permissão de vendas.',
          action: 'reconnect',
        });
      }
      console.error('[bling/vendas] Erro ao buscar vendas:', err.response?.data || err.message);
      return res.status(500).json({ error: err.message || 'Erro ao buscar vendas do Bling' });
    }

    if (!Array.isArray(vendas) || vendas.length === 0) {
      return res.json({ motivo: 'sem-vendas', msg: 'Sua conta Bling está conectada, mas não há vendas cadastradas no Blling.' });
    }

    // Busca e mapeia canais de venda
    const canaisVenda = await getCanaisVenda(bling.access_token);
    const canaisMap = {};
    canaisVenda.forEach(canal => {
      if (canal.id) canaisMap[canal.id] = canal;
    });

    // Mapeia todos os campos possíveis do pedido para o frontend
    const mapped = await Promise.all(vendas.slice(0, limite).map(async (venda) => {
      // Busca nome do canal de venda
      let canalVendaNome = 'Bling';
      if (venda.loja?.id && canaisMap[venda.loja.id]) {
        canalVendaNome = canaisMap[venda.loja.id].descricao || canaisMap[venda.loja.id].tipo || 'Bling';
      }
      const categoriaNome = await getCategoriaNome(venda.categoria?.id, bling.access_token);
      return {
        canalVenda: canalVendaNome,
        idVendaBling: venda.id || venda.numero || venda.numeroLoja || '-',
        numero: venda.numero || null,
        numeroLoja: venda.numeroLoja || null,
        data: venda.data || null,
        dataSaida: venda.dataSaida || null,
        dataPrevista: venda.dataPrevista || null,
        totalProdutos: venda.totalProdutos || 0,
        total: venda.total || 0,
        valorTotalVenda: Number(venda.total || venda.valor || 0),
        situacao: venda.situacao?.valor || venda.situacao || null,
        situacaoId: venda.situacao?.id || null,
        loja: venda.loja?.id || venda.loja || null,
        numeroPedidoCompra: venda.numeroPedidoCompra || null,
        outrasDespesas: venda.outrasDespesas || 0,
        observacoes: venda.observacoes || '-',
        observacoesInternas: venda.observacoesInternas || '-',
        desconto: venda.desconto?.valor || venda.desconto || null,
        descontoUnidade: venda.desconto?.unidade || null,
        categoria: categoriaNome,
        categoriaId: venda.categoria?.id || null,
        notaFiscal: venda.notaFiscal || null,
        notaFiscalId: venda.notaFiscal?.id || null,
        tributacao: venda.tributacao || null,
        totalICMS: venda.tributacao?.totalICMS || null,
        totalIPI: venda.tributacao?.totalIPI || null,
        contato: venda.contato || null,
        contatoId: venda.contato?.id || null,
        cliente: venda.cliente?.nome || venda.contato?.nome || '-',
        clienteTipoPessoa: venda.contato?.tipoPessoa || null,
        clienteDocumento: venda.contato?.numeroDocumento || null,
        vendedor: venda.vendedor?.id || venda.vendedor || null,
        intermediador: venda.intermediador || null,
        intermediadorCnpj: venda.intermediador?.cnpj || null,
        intermediadorNomeUsuario: venda.intermediador?.nomeUsuario || null,
        taxas: venda.taxas || null,
        taxaComissao: venda.taxas?.taxaComissao || null,
        custoFrete: venda.taxas?.custoFrete || null,
        valorBase: venda.taxas?.valorBase || null,
        transporte: venda.transporte || null,
        fretePorConta: venda.transporte?.fretePorConta || null,
        frete: venda.transporte?.frete || null,
        quantidadeVolumes: venda.transporte?.quantidadeVolumes || null,
        pesoBruto: venda.transporte?.pesoBruto || null,
        prazoEntrega: venda.transporte?.prazoEntrega || null,
        transportador: venda.transporte?.contato?.nome || null,
        etiqueta: venda.transporte?.etiqueta || null,
        volumes: venda.transporte?.volumes || [],
        itens: Array.isArray(venda.itens)
          ? venda.itens.map(item => ({
              id: item.id || null,
              codigo: item.codigo || null,
              unidade: item.unidade || null,
              quantidade: item.quantidade || null,
              desconto: item.desconto || null,
              valor: item.valor || null,
              aliquotaIPI: item.aliquotaIPI || null,
              descricao: item.descricao || null,
              descricaoDetalhada: item.descricaoDetalhada || null,
              produto: item.produto || null,
              produtoId: item.produto?.id || null,
              comissao: item.comissao || null,
              comissaoBase: item.comissao?.base || null,
              comissaoAliquota: item.comissao?.aliquota || null,
              comissaoValor: item.comissao?.valor || null,
            }))
          : [],
        itensDetalhados: Array.isArray(venda.itens)
          ? venda.itens.map(item => ({
              id: item.id || null,
              codigo: item.codigo || null,
              unidade: item.unidade || null,
              quantidade: item.quantidade || null,
              desconto: item.desconto || null,
              valor: item.valor || null,
              aliquotaIPI: item.aliquotaIPI || null,
              descricao: item.descricao || null,
              descricaoDetalhada: item.descricaoDetalhada || null,
              produto: item.produto || null,
              produtoId: item.produto?.id || null,
              comissao: item.comissao || null,
              comissaoBase: item.comissao?.base || null,
              comissaoAliquota: item.comissao?.aliquota || null,
              comissaoValor: item.comissao?.valor || null,
            }))
          : [],
        parcelas: Array.isArray(venda.parcelas)
          ? venda.parcelas.map(parcela => ({
              id: parcela.id || null,
              dataVencimento: parcela.dataVencimento || null,
              valor: parcela.valor || null,
              observacoes: parcela.observacoes || null,
              formaPagamento: parcela.formaPagamento?.id || null,
            }))
          : [],
        nomeProdutoVendido: Array.isArray(venda.itens) && venda.itens.length > 0
          ? venda.itens[0].produto?.descricao || venda.itens[0].descricao || '-'
          : '-',
        dataHora: venda.data || venda.dataSaida || venda.dataPrevista || '-',
        txPlataforma: Number(venda.outrasDespesas || 0),
        custo: Number(
          Array.isArray(venda.itens)
            ? venda.itens.reduce((acc, item) => acc + (item.custo || 0) * (item.quantidade || 0), 0)
            : 0
        ),
      };
    }));

    res.json(mapped);
  } catch (err) {
    console.error('[bling/vendas] Erro geral:', err.response?.data || err.message);
    res.status(500).json({ error: err.message || 'Erro ao buscar vendas do Bling' });
  }
});

// ROTA PARA EXCLUIR TODAS AS VENDAS DO BLING DE UM USUÁRIO
router.delete('/vendas', async (req, res) => {
  const uid = req.query.uid || req.body.uid;
  if (!uid) {
    return res.status(400).json({ error: 'UID obrigatório' });
  }
  try {
    const vendasRef = db.collection('users').doc(uid).collection('blingVendas');
    let deleted = 0;
    let lastDoc = null;
    while (true) {
      let query = vendasRef.limit(500);
      if (lastDoc) query = query.startAfter(lastDoc);
      const snap = await query.get();
      if (snap.empty) break;
      const batch = db.batch();
      snap.docs.forEach(doc => {
        batch.delete(doc.ref);
      });
      await batch.commit();
      deleted += snap.size;
      if (snap.size < 500) break;
      lastDoc = snap.docs[snap.docs.length - 1];
    }
    res.json({ success: true, deleted });
  } catch (err) {
    console.error('[bling/vendas][DELETE] Erro ao excluir:', err);
    res.status(500).json({ error: 'Erro ao excluir vendas do Bling', detalhe: err.message });
  }
});

// NOVA ROTA: Excluir todas as vendas Bling e Mercado Livre de um usuário
router.delete('/vendas/todas', async (req, res) => {
  const uid = req.query.uid || req.body.uid;
  if (!uid) {
    return res.status(400).json({ error: 'UID obrigatório' });
  }

  // Função utilitária para apagar em batches pequenos
  async function deleteCollectionBatch(ref, batchSize = 100) {
    let deleted = 0;
    let lastDoc = null;
    while (true) {
      let query = ref.limit(batchSize);
      if (lastDoc) query = query.startAfter(lastDoc);
      const snap = await query.get();
      if (snap.empty) break;
      const batch = db.batch();
      snap.docs.forEach(doc => {
        batch.delete(doc.ref);
      });
      await batch.commit();
      deleted += snap.size;
      if (snap.size < batchSize) break;
      lastDoc = snap.docs[snap.docs.length - 1];
    }
    return deleted;
  }

  try {
    const vendasBlingRef = db.collection('users').doc(uid).collection('blingVendas');
    const vendasMLRef = db.collection('users').doc(uid).collection('mlVendas');

    // Apaga as duas coleções em paralelo
    const [blingDeleted, mlDeleted] = await Promise.all([
      deleteCollectionBatch(vendasBlingRef),
      deleteCollectionBatch(vendasMLRef)
    ]);

    res.json({ success: true, blingDeleted, mlDeleted });
  } catch (err) {
    console.error('[bling/vendas/todas][DELETE] Erro ao excluir:', err);
    res.status(500).json({ error: 'Erro ao excluir vendas do Bling e Mercado Livre', detalhe: err.message });
  }
});

module.exports = router;