const express = require('express');
const axios = require('axios');
const qs = require('querystring');
const router = express.Router();
const db = require('../firebase').db;
const admin = require('../firebase').admin;
const crypto = require('crypto');

const BLING_CLIENT_ID = process.env.BLING_CLIENT_ID || '57f339b6be5fdc0d986c1170b709b8d82ece3a76';
const BLING_CLIENT_SECRET = process.env.BLING_CLIENT_SECRET || '5f59f5f4610f20bfd74984f151bcca343cb1375d68cc27216c4b2bc8a97d';

const BLING_SCOPES = [
  'contas-contabeis',
  'financeiro',
  'contas-pagar',
  'contas-receber',
  'borderos',
  'naturezas-operacao',
  'formas-pagamento',
  'categorias-receitas-despesas',
  'canais-venda',
  'campos-customizados',
  'vendas',
  'movimentacoes-financeiras',
  'contas-bancarias',
  'conciliacoes',
  'boletos',
].join('+');

const canalVendaMap = {
  '203520103': 'Mercado Livre',
  '204640345': 'Shopee',
};

const statusMap = {
  2: 'Cancelado',
  6: 'Em andamento',
  9: 'Atendido',
  11: 'Em aberto',
  12: 'Finalizado',
  18: 'Pendente',
};

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
      try {
        await db.collection('users').doc(uid).update({ bling: admin.firestore.FieldValue.delete() });
        console.log('[bling/refresh] Campo bling removido devido a refresh token inválido');
      } catch (cleanErr) {
        console.warn('[bling/refresh] Falha ao limpar campo bling:', cleanErr.message);
      }
      throw new Error('Token Bling expirado ou inválido. Refaça a conexão.');
    }
    throw refreshErr;
  }
}

async function blingPagedGet(url, token, params = {}, refreshFn, uid) {
  let allData = [];
  let page = params.pagina || 1;
  const limit = params.limite || 100;
  let tokenUsado = token;
  let tentouRefresh = false;
  while (true) {
    try {
      console.log(`[blingPagedGet] Requesting ${url} with page=${page}, limit=${limit}, params=${JSON.stringify(params)}`);
      const response = await axios.get(url, {
        headers: { Authorization: `Bearer ${tokenUsado}` },
        params: { ...params, limite: limit, pagina: page },
      });
      if (!response.data || !Array.isArray(response.data.data)) {
        throw new Error('Resposta inesperada do Bling: data não é um array');
      }
      allData = allData.concat(response.data.data);
      if (response.data.data.length < limit) break;
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
            await db.collection('users').doc(uid).update({ bling: admin.firestore.FieldValue.delete() });
            throw new Error('Token Bling expirado ou inválido. Refaça a conexão.');
          } else if (refreshErr.response?.data?.error === 'insufficient_scope') {
            throw new Error('Permissões insuficientes no Bling. Reconecte sua conta com as permissões corretas.');
          }
          throw refreshErr;
        }
      } else if (err.response?.status === 404 && err.response?.data?.error?.type === 'RESOURCE_NOT_FOUND') {
        throw new Error('Recurso não encontrado no Bling. Verifique se o recurso está habilitado na sua conta Bling.');
      } else if (err.response?.data?.error === 'insufficient_scope') {
        throw new Error('Permissões insuficientes no Bling. Reconecte sua conta com as permissões corretas.');
      }
      throw err;
    }
  }
  return allData;
}

// Utility function to map detailed account data
function mapearConta(conta, tipo) {
  return {
    id: conta.id || '-',
    fornecedor: tipo === 'pagar' ? (conta.fornecedor?.nome || '-') : null,
    cliente: tipo === 'receber' ? (conta.cliente?.nome || '-') : null,
    valor: Number(conta.valor || 0).toFixed(2),
    valorOriginal: Number(conta.valorOriginal || conta.valor || 0).toFixed(2),
    valorPago: Number(conta.valorPago || 0).toFixed(2),
    dataVencimento: conta.dataVencimento || '-',
    dataEmissao: conta.dataEmissao || '-',
    dataBaixa: conta.dataBaixa || '-',
    situacao: conta.situacao?.descricao || '-',
    categoria: conta.categoria?.descricao || '-',
    formaPagamento: conta.formaPagamento?.descricao || '-',
    centroCusto: conta.centroCusto?.descricao || '-',
    usuarioCriacao: conta.usuarioCriacao?.nome || '-',
    usuarioAlteracao: conta.usuarioAlteracao?.nome || '-',
    dataUltimaAlteracao: conta.dataUltimaAlteracao || '-',
    numeroDocumento: conta.numeroDocumento || '-',
    juros: Number(conta.juros || 0).toFixed(2),
    multa: Number(conta.multa || 0).toFixed(2),
    desconto: Number(conta.desconto || 0).toFixed(2),
    anexos: Array.isArray(conta.anexos) ? conta.anexos.map(a => ({ nome: a.nome, url: a.url })) : [],
    historicoMovimentacoes: Array.isArray(conta.historicoMovimentacoes) ? conta.historicoMovimentacoes.map(h => ({
      data: h.data || '-',
      tipo: h.tipo || '-',
      valor: Number(h.valor || 0).toFixed(2),
      observacao: h.observacao || '-',
    })) : [],
    raw: conta,
  };
}

router.get('/financeiro', async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'UID obrigatório' });

  try {
    const docSnap = await db.collection('users').doc(uid).get();
    const bling = docSnap.data()?.bling;
    if (!bling?.access_token) {
      return res.status(401).json({
        error: 'Conta Bling não conectada. Conecte sua conta Bling para acessar o Financeiro.',
        action: 'reconnect',
      });
    }

    const refreshFn = async () => await refreshToken(bling, uid);
    const data = await blingPagedGet(
      'https://www.bling.com.br/Api/v3/contas-contabeis',
      bling.access_token,
      {},
      refreshFn,
      uid
    );
    const mappedData = data.map(conta => ({
      id: conta.id || '-',
      nome: conta.nome || '-',
      tipo: conta.tipo || '-',
      saldoInicial: conta.saldoInicial || 0,
      saldoAtual: conta.saldoAtual || 0,
      moeda: conta.moeda || 'BRL',
      ativo: conta.ativo !== undefined ? conta.ativo : true,
      dataCriacao: conta.dataCriacao || conta.data || '-',
      observacoes: conta.observacoes || '',
      raw: conta,
    }));
    return res.json({ data: mappedData });
  } catch (err) {
    if (
      err.message?.includes('Token Bling expirado ou inválido') ||
      err.message?.toLowerCase().includes('invalid_token') ||
      err.message?.toLowerCase().includes('invalid_grant')
    ) {
      return res.status(401).json({
        error: 'Token Bling expirado ou inválido. Refaça a conexão.',
        action: 'reconnect',
        detalhe: err.response?.data || err.message,
      });
    }
    console.error('[bling/financeiro] Erro:', err.response?.data || err.message);
    return res.status(err.response?.status || 500).json({
      error: err.message || 'Erro ao buscar dados financeiros do Bling',
      action: err.message.includes('Refaça a conexão') || err.message.includes('Permissões insuficientes') ? 'reconnect' : undefined,
      detalhe: err.response?.data || err.message,
    });
  }
});

router.get('/borderos', async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
  try {
    const docSnap = await db.collection('users').doc(uid).get();
    const bling = docSnap.data()?.bling;
    if (!bling?.access_token) return res.status(401).json({ error: 'Conta Bling não conectada', action: 'reconnect' });
    const refreshFn = async () => await refreshToken(bling, uid);
    const data = await blingPagedGet('https://www.bling.com.br/Api/v3/borderos', bling.access_token, {}, refreshFn, uid);
    res.json({ data });
  } catch (err) {
    console.error('[bling/borderos] Erro:', err.response?.data || err.message);
    return res.status(err.response?.status || 500).json({
      error: err.message || 'Erro ao buscar borderôs. Verifique se o recurso Borderôs está habilitado na sua conta Bling.',
      action: err.message.includes('Refaça a conexão') || err.message.includes('Permissões insuficientes') ? 'reconnect' : undefined,
      detalhe: err.response?.data || err.message,
    });
  }
});

router.get('/naturezas-operacoes', async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
  try {
    const docSnap = await db.collection('users').doc(uid).get();
    const bling = docSnap.data()?.bling;
    if (!bling?.access_token) return res.status(401).json({ error: 'Conta Bling não conectada', action: 'reconnect' });
    const refreshFn = async () => await refreshToken(bling, uid);
    const data = await blingPagedGet('https://www.bling.com.br/Api/v3/naturezas-operacao', bling.access_token, {}, refreshFn, uid);
    res.json({ data });
  } catch (err) {
    console.error('[bling/naturezas-operacoes] Erro:', err.response?.data || err.message);
    return res.status(err.response?.status || 500).json({
      error: err.message || 'Erro ao buscar naturezas de operações',
      action: err.message.includes('Refaça a conexão') || err.message.includes('Permissões insuficientes') ? 'reconnect' : undefined,
      detalhe: err.response?.data || err.message,
    });
  }
});

router.get('/contas-pagar', async (req, res) => {
  const { uid, dataInicio, dataFim, situacao } = req.query;
  if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
  try {
    const docSnap = await db.collection('users').doc(uid).get();
    const bling = docSnap.data()?.bling;
    if (!bling?.access_token) return res.status(401).json({ error: 'Conta Bling não conectada', action: 'reconnect' });
    const refreshFn = async () => await refreshToken(bling, uid);
    const params = { dataInicio, dataFim, situacao };
    const data = await blingPagedGet('https://www.bling.com.br/Api/v3/contas-pagar', bling.access_token, params, refreshFn, uid);
    const mappedData = data.map(conta => mapearConta(conta, 'pagar'));
    res.json({ data: mappedData });
  } catch (err) {
    console.error('[bling/contas-pagar] Erro:', err.response?.data || err.message);
    return res.status(err.response?.status || 500).json({
      error: err.message || 'Erro ao buscar contas a pagar',
      action: err.message.includes('Refaça a conexão') || err.message.includes('Permissões insuficientes') ? 'reconnect' : undefined,
      detalhe: err.response?.data || err.message,
    });
  }
});

router.get('/contas-receber', async (req, res) => {
  const { uid, dataInicio, dataFim, situacao } = req.query;
  if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
  try {
    const docSnap = await db.collection('users').doc(uid).get();
    const bling = docSnap.data()?.bling;
    if (!bling?.access_token) return res.status(401).json({ error: 'Conta Bling não conectada', action: 'reconnect' });
    const refreshFn = async () => await refreshToken(bling, uid);
    const params = { dataInicio, dataFim, situacao };
    const data = await blingPagedGet('https://www.bling.com.br/Api/v3/contas-receber', bling.access_token, params, refreshFn, uid);
    const mappedData = data.map(conta => mapearConta(conta, 'receber'));
    res.json({ data: mappedData });
  } catch (err) {
    console.error('[bling/contas-receber] Erro:', err.response?.data || err.message);
    return res.status(err.response?.status || 500).json({
      error: err.message || 'Erro ao buscar contas a receber',
      action: err.message.includes('Refaça a conexão') || err.message.includes('Permissões insuficientes') ? 'reconnect' : undefined,
      detalhe: err.response?.data || err.message,
    });
  }
});

router.get('/formas-pagamento', async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
  try {
    const docSnap = await db.collection('users').doc(uid).get();
    const bling = docSnap.data()?.bling;
    if (!bling?.access_token) return res.status(401).json({ error: 'Conta Bling não conectada', action: 'reconnect' });
    const refreshFn = async () => await refreshToken(bling, uid);
    const data = await blingPagedGet('https://www.bling.com.br/Api/v3/formas-pagamento', bling.access_token, {}, refreshFn, uid);
    res.json({ data });
  } catch (err) {
    console.error('[bling/formas-pagamento] Erro:', err.response?.data || err.message);
    return res.status(err.response?.status || 500).json({
      error: err.message || 'Erro ao buscar formas de pagamento',
      action: err.message.includes('Refaça a conexão') || err.message.includes('Permissões insuficientes') ? 'reconnect' : undefined,
      detalhe: err.response?.data || err.message,
    });
  }
});

router.get('/categorias-receitas-despesas', async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
  try {
    const docSnap = await db.collection('users').doc(uid).get();
    const bling = docSnap.data()?.bling;
    if (!bling?.access_token) return res.status(401).json({ error: 'Conta Bling não conectada', action: 'reconnect' });
    const refreshFn = async () => await refreshToken(bling, uid);
    const data = await blingPagedGet('https://www.bling.com.br/Api/v3/categorias-receitas-despesas', bling.access_token, {}, refreshFn, uid);
    res.json({ data });
  } catch (err) {
    console.error('[bling/categorias-receitas-despesas] Erro:', err.response?.data || err.message);
    return res.status(err.response?.status || 500).json({
      error: err.message || 'Erro ao buscar categorias de receitas/despesas',
      action: err.message.includes('Refaça a conexão') || err.message.includes('Permissões insuficientes') ? 'reconnect' : undefined,
      detalhe: err.response?.data || err.message,
    });
  }
});

router.get('/canais-venda', async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
  try {
    const docSnap = await db.collection('users').doc(uid).get();
    const bling = docSnap.data()?.bling;
    if (!bling?.access_token) return res.status(401).json({ error: 'Conta Bling não conectada', action: 'reconnect' });
    const refreshFn = async () => await refreshToken(bling, uid);
    const data = await blingPagedGet('https://www.bling.com.br/Api/v3/canais-venda', bling.access_token, {}, refreshFn, uid);
    res.json({ data });
  } catch (err) {
    console.error('[bling/canais-venda] Erro:', err.response?.data || err.message);
    return res.status(err.response?.status || 500).json({
      error: err.message || 'Erro ao buscar canais de venda',
      action: err.message.includes('Refaça a conexão') || err.message.includes('Permissões insuficientes') ? 'reconnect' : undefined,
      detalhe: err.response?.data || err.message,
    });
  }
});

router.get('/campos-customizados', async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
  try {
    const docSnap = await db.collection('users').doc(uid).get();
    const bling = docSnap.data()?.bling;
    if (!bling?.access_token) return res.status(401).json({ error: 'Conta Bling não conectada', action: 'reconnect' });
    const refreshFn = async () => await refreshToken(bling, uid);
    const data = await blingPagedGet('https://www.bling.com.br/Api/v3/campos-customizados', bling.access_token, {}, refreshFn, uid);
    res.json({ data });
  } catch (err) {
    console.error('[bling/campos-customizados] Erro:', err.response?.data || err.message);
    return res.status(err.response?.status || 500).json({
      error: err.message || 'Erro ao buscar campos customizados',
      action: err.message.includes('Refaça a conexão') || err.message.includes('Permissões insuficientes') ? 'reconnect' : undefined,
      detalhe: err.response?.data || err.message,
    });
  }
});

router.get('/movimentacoes-financeiras', async (req, res) => {
  const { uid, dataInicio, dataFim } = req.query;
  if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
  try {
    const docSnap = await db.collection('users').doc(uid).get();
    const bling = docSnap.data()?.bling;
    if (!bling?.access_token) return res.status(401).json({ error: 'Conta Bling não conectada', action: 'reconnect' });
    const refreshFn = async () => await refreshToken(bling, uid);
    const params = { dataInicio, dataFim };
    const data = await blingPagedGet('https://www.bling.com.br/Api/v3/movimentacoes-financeiras', bling.access_token, params, refreshFn, uid);
    const mappedData = data.map(mov => ({
      id: mov.id || '-',
      tipo: mov.tipo || '-',
      valor: Number(mov.valor || 0).toFixed(2),
      dataEfetivacao: mov.dataEfetivacao || '-',
      origem: mov.origem || 'manual',
      contaOrigem: mov.contaOrigem?.nome || '-',
      contaDestino: mov.contaDestino?.nome || '-',
      categoria: mov.categoria?.descricao || '-',
      observacao: mov.observacao || '-',
      raw: mov,
    }));
    res.json({ data: mappedData });
  } catch (err) {
    console.error('[bling/movimentacoes-financeiras] Erro:', err.response?.data || err.message);
    return res.status(err.response?.status || 500).json({
      error: err.message || 'Erro ao buscar movimentações financeiras',
      action: err.message.includes('Refaça a conexão') || err.message.includes('Permissões insuficientes') ? 'reconnect' : undefined,
      detalhe: err.response?.data || err.message,
    });
  }
});

router.get('/contas-bancarias', async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
  try {
    const docSnap = await db.collection('users').doc(uid).get();
    const bling = docSnap.data()?.bling;
    if (!bling?.access_token) return res.status(401).json({ error: 'Conta Bling não conectada', action: 'reconnect' });
    const refreshFn = async () => await refreshToken(bling, uid);
    const data = await blingPagedGet('https://www.bling.com.br/Api/v3/contas-bancarias', bling.access_token, {}, refreshFn, uid);
    const mappedData = data.map(conta => ({
      id: conta.id || '-',
      nome: conta.nome || '-',
      tipo: conta.tipo || '-',
      saldo: Number(conta.saldo || 0).toFixed(2),
      banco: conta.banco || '-',
      agencia: conta.agencia || '-',
      numeroConta: conta.numeroConta || '-',
      ativo: conta.ativo !== undefined ? conta.ativo : true,
      dataCriacao: conta.dataCriacao || '-',
      raw: conta,
    }));
    res.json({ data: mappedData });
  } catch (err) {
    console.error('[bling/contas-bancarias] Erro:', err.response?.data || err.message);
    return res.status(err.response?.status || 500).json({
      error: err.message || 'Erro ao buscar contas bancárias',
      action: err.message.includes('Refaça a conexão') || err.message.includes('Permissões insuficientes') ? 'reconnect' : undefined,
      detalhe: err.response?.data || err.message,
    });
  }
});

router.get('/conciliacoes', async (req, res) => {
  const { uid, dataInicio, dataFim } = req.query;
  if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
  try {
    const docSnap = await db.collection('users').doc(uid).get();
    const bling = docSnap.data()?.bling;
    if (!bling?.access_token) return res.status(401).json({ error: 'Conta Bling não conectada', action: 'reconnect' });
    const refreshFn = async () => await refreshToken(bling, uid);
    const params = { dataInicio, dataFim };
    const data = await blingPagedGet('https://www.bling.com.br/Api/v3/conciliacoes', bling.access_token, params, refreshFn, uid);
    const mappedData = data.map(conc => ({
      id: conc.id || '-',
      contaBancaria: conc.contaBancaria?.nome || '-',
      dataConciliacao: conc.dataConciliacao || '-',
      status: conc.status || '-',
      valorConciliado: Number(conc.valorConciliado || 0).toFixed(2),
      movimentacao: conc.movimentacao?.id || '-',
      observacao: conc.observacao || '-',
      raw: conc,
    }));
    res.json({ data: mappedData });
  } catch (err) {
    console.error('[bling/conciliacoes] Erro:', err.response?.data || err.message);
    return res.status(err.response?.status || 500).json({
      error: err.message || 'Erro ao buscar conciliações bancárias',
      action: err.message.includes('Refaça a conexão') || err.message.includes('Permissões insuficientes') ? 'reconnect' : undefined,
      detalhe: err.response?.data || err.message,
    });
  }
});

router.get('/boletos', async (req, res) => {
  const { uid, dataInicio, dataFim, situacao } = req.query;
  if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
  try {
    const docSnap = await db.collection('users').doc(uid).get();
    const bling = docSnap.data()?.bling;
    if (!bling?.access_token) return res.status(401).json({ error: 'Conta Bling não conectada', action: 'reconnect' });
    const refreshFn = async () => await refreshToken(bling, uid);
    const params = { dataInicio, dataFim, situacao };
    const data = await blingPagedGet('https://www.bling.com.br/Api/v3/boletos', bling.access_token, params, refreshFn, uid);
    const mappedData = data.map(boleto => ({
      id: boleto.id || '-',
      cliente: boleto.cliente?.nome || '-',
      valor: Number(boleto.valor || 0).toFixed(2),
      dataEmissao: boleto.dataEmissao || '-',
      dataVencimento: boleto.dataVencimento || '-',
      status: boleto.status || '-',
      linhaDigitavel: boleto.linhaDigitavel || '-',
      urlPDF: boleto.urlPDF || '-',
      numeroDocumento: boleto.numeroDocumento || '-',
      raw: boleto,
    }));
    res.json({ data: mappedData });
  } catch (err) {
    console.error('[bling/boletos] Erro:', err.response?.data || err.message);
    return res.status(err.response?.status || 500).json({
      error: err.message || 'Erro ao buscar boletos emitidos',
      action: err.message.includes('Refaça a conexão') || err.message.includes('Permissões insuficientes') ? 'reconnect' : undefined,
      detalhe: err.response?.data || err.message,
    });
  }
});

router.get('/vendas', async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'UID obrigatório' });

  async function getPedidosLista(token) {
    try {
      const pedidosRes = await axios.get('https://www.bling.com.br/Api/v3/pedidos/vendas', {
        headers: { Authorization: `Bearer ${token}` },
        params: { limite: 30 },
      });
      console.log('[bling/vendas] Resposta bruta da lista do Bling:', JSON.stringify(pedidosRes.data, null, 2));
      return pedidosRes.data;
    } catch (err) {
      console.error('[bling/vendas] Erro ao chamar API de lista do Bling:', err.response?.data || err.message);
      throw err;
    }
  }

  async function getPedidoDetalhe(id, token) {
    try {
      const pedidoRes = await axios.get(`https://www.bling.com.br/Api/v3/pedidos/vendas/${id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      console.log(`[bling/vendas] Detalhes do pedido ${id}:`, JSON.stringify(pedidoRes.data, null, 2));
      return pedidoRes.data.data;
    } catch (err) {
      console.error(`[bling/vendas] Erro ao buscar detalhes do pedido ${id}:`, err.response?.data || err.message);
      throw err;
    }
  }

  try {
    const docSnap = await db.collection('users').doc(uid).get();
    const bling = docSnap.data()?.bling;
    if (!bling || !bling.access_token) {
      return res.status(401).json({ error: 'Conta Bling não conectada', action: 'reconnect' });
    }

    let tokenUsado = bling.access_token;
    let pedidosLista;
    const refreshFn = async () => await refreshToken(bling, uid);

    try {
      pedidosLista = await getPedidosLista(tokenUsado);
    } catch (err) {
      if (err.response?.status === 401 && bling.refresh_token) {
        try {
          tokenUsado = await refreshFn();
          pedidosLista = await getPedidosLista(tokenUsado);
        } catch (refreshErr) {
          if (refreshErr.response?.data?.error === 'insufficient_scope') {
            return res.status(401).json({
              error: 'Permissões insuficientes no Bling. Reconecte sua conta com as permissões corretas.',
              action: 'reconnect',
            });
          }
          return res.status(401).json({
            error: refreshErr.message || 'Token Bling expirado ou inválido. Refaça a conexão.',
            action: 'reconnect',
          });
        }
      } else if (err.response?.data?.error === 'insufficient_scope') {
        return res.status(401).json({
          error: 'Permissões insuficientes no Bling. Reconecte sua conta com as permissões corretas.',
          action: 'reconnect',
        });
      } else if (err.response?.status === 404 && err.response?.data?.error?.type === 'RESOURCE_NOT_FOUND') {
        return res.status(404).json({
          error: 'Recurso não encontrado no Bling. Verifique se o recurso Vendas está habilitado na sua conta Bling.',
          detalhe: err.response?.data || err.message,
        });
      } else {
        throw err;
      }
    }

    let pedidos = [];
    if (Array.isArray(pedidosLista.data)) {
      for (const pedido of pedidosLista.data) {
        const idVenda = pedido.id || pedido.numero;
        if (idVenda) {
          try {
            const detalhes = await getPedidoDetalhe(idVenda, tokenUsado);
            pedidos.push(mapearVenda(detalhes || pedido));
          } catch (err) {
            if (err.response?.data?.error === 'invalid_token' && bling.refresh_token) {
              try {
                tokenUsado = await refreshFn();
                const detalhes = await getPedidoDetalhe(idVenda, tokenUsado);
                pedidos.push(mapearVenda(detalhes || pedido));
              } catch (refreshErr) {
                if (refreshErr.response?.data?.error === 'insufficient_scope') {
                  return res.status(401).json({
                    error: 'Permissões insuficientes no Bling. Reconecte sua conta com as permissões corretas.',
                    action: 'reconnect',
                  });
                }
                console.warn(`[bling/vendas] Falha ao renovar token para pedido ${idVenda}, usando dados da lista:`, pedido);
                pedidos.push(mapearVenda(pedido));
              }
            } else if (err.response?.data?.error === 'insufficient_scope') {
              return res.status(401).json({
                error: 'Permissões insuficientes no Bling. Reconecte sua conta com as permissões corretas.',
                action: 'reconnect',
              });
            } else if (err.response?.status === 404 && err.response?.data?.error?.type === 'RESOURCE_NOT_FOUND') {
              console.warn(`[bling/vendas] Recurso não encontrado para pedido ${idVenda}, usando dados da lista:`, pedido);
              pedidos.push(mapearVenda(pedido));
            } else {
              console.warn(`[bling/vendas] Usando dados da lista para pedido ${idVenda} devido a erro:`, err.response?.data || err.message);
              pedidos.push(mapearVenda(pedido));
            }
          }
        }
      }
    } else {
      console.warn('[bling/vendas] Formato de resposta inesperado:', JSON.stringify(pedidosLista));
      pedidos = [];
    }

    function mapearVenda(venda) {
      console.log(`[bling/vendas] Mapeando venda ${venda.id || venda.numero}:`, JSON.stringify(venda, null, 2));

      let canalVenda = 'Bling';
      if (venda.loja?.id) {
        canalVenda = canalVendaMap[venda.loja.id] || venda.loja.nome || 'Bling';
      }

      const idVendaBling = venda.id || venda.numero || '-';
      const cliente = venda.contato?.nome || 'Desconhecido';
      const dataHora = venda.data || '-';

      let itens = [];
      if (Array.isArray(venda.itens)) {
        itens = venda.itens.map((i) => ({
          nomeAnuncio: i.descricao || 'Produto sem descrição',
          sku: i.codigo || '-',
          quantidade: Number(i.quantidade || 1),
          valorUnitario: Number(i.valor || 0).toFixed(2),
        }));
      }

      const nomeProdutoVendido = itens.length > 0 ? itens[0].nomeAnuncio : '-';
      const valorTotalVenda = Number(venda.total || 0).toFixed(2);
      const status = venda.situacao?.id ? statusMap[venda.situacao.id] || 'Desconhecido' : 'Desconhecido';

      const contato = venda.contato || null;
      const itensDetalhados = Array.isArray(venda.itens)
        ? venda.itens.map((i) => ({
            id: i.id || null,
            quantidade: i.quantidade || 0,
            valor: i.valor || 0,
            descricao: i.descricao || '-',
            codigo: i.codigo || '-',
            unidade: i.unidade || '-',
            desconto: i.desconto || 0,
            aliquotaIPI: i.aliquotaIPI || 0,
            descricaoDetalhada: i.descricaoDetalhada || '-',
            produto: i.produto ? { id: i.produto.id } : null,
            comissao: i.comissao
              ? {
                  base: i.comissao.base || 0,
                  aliquota: i.comissao.aliquota || 0,
                  valor: i.comissao.valor || 0,
                }
              : null,
          }))
        : [];
      const parcelas = Array.isArray(venda.parcelas)
        ? venda.parcelas.map((p) => ({
            id: p.id || null,
            dataVencimento: p.dataVencimento || '-',
            valor: p.valor || 0,
            formaPagamento: p.formaPagamento ? { id: p.formaPagamento.id } : null,
            observacoes: p.observacoes || '-',
          }))
        : [];
      const loja = venda.loja ? { id: venda.loja.id } : null;
      const desconto = venda.desconto || null;
      const categoria = venda.categoria ? { id: venda.categoria.id } : null;
      const notaFiscal = venda.notaFiscal ? { id: venda.notaFiscal.id } : null;
      const tributacao = venda.tributacao || null;
      const transporte = venda.transporte
        ? {
            fretePorConta: venda.transporte.fretePorConta || 0,
            frete: venda.transporte.frete || 0,
            quantidadeVolumes: venda.transporte.quantidadeVolumes || 0,
            pesoBruto: venda.transporte.pesoBruto || 0,
            prazoEntrega: venda.transporte.prazoEntrega || 0,
            contato: venda.transporte.contato || null,
            etiqueta: venda.transporte.etiqueta || null,
            volumes: Array.isArray(venda.transporte.volumes)
              ? venda.transporte.volumes.map((v) => ({
                  id: v.id || null,
                  servico: v.servico || '-',
                  codigoRastreamento: v.codigoRastreamento || '-',
                }))
              : [],
          }
        : null;
      const vendedor = venda.vendedor ? { id: venda.vendedor.id } : null;
      const intermediador = venda.intermediador || null;

      return {
        canalVenda,
        idVendaBling,
        cliente,
        dataHora,
        itens,
        valorTotalVenda,
        status,
        nomeProdutoVendido,
        contato,
        itensDetalhados,
        parcelas,
        numero: venda.numero || null,
        numeroLoja: venda.numeroLoja || null,
        data: venda.data || null,
        dataSaida: venda.dataSaida || null,
        dataPrevista: venda.dataPrevista || null,
        totalProdutos: venda.totalProdutos || 0,
        total: venda.total || 0,
        situacao: venda.situacao || null,
        loja,
        numeroPedidoCompra: venda.numeroPedidoCompra || null,
        outrasDespesas: venda.outrasDespesas || 0,
        observacoes: venda.observacoes || '-',
        observacoesInternas: venda.observacoesInternas || '-',
        desconto,
        categoria,
        notaFiscal,
        tributacao,
        transporte,
        vendedor,
        intermediador,
      };
    }

    console.log('[bling/vendas] Pedidos processados:', JSON.stringify(pedidos, null, 2));

    if (pedidos.length === 0) {
      return res.json({
        motivo: 'sem-vendas',
        msg: 'Nenhuma venda encontrada no Bling.',
        debug: pedidosLista,
      });
    }

    res.json(pedidos);
  } catch (err) {
    console.error('[bling/vendas] Erro:', err.response?.data || err.message);
    return res.status(err.response?.status || 500).json({
      error: err.message || 'Erro ao buscar dados do Bling',
      action: err.message.includes('Refaça a conexão') || err.message.includes('Permissões insuficientes') ? 'reconnect' : undefined,
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

module.exports = router;