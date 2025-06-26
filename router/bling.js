const express = require('express');
const axios = require('axios');
const qs = require('querystring');
const router = express.Router();
const db = require('../firebase').db;
const admin = require('../firebase').admin;
const crypto = require('crypto');

const BLING_CLIENT_ID = process.env.BLING_CLIENT_ID || '57f339b6be5fdc0d986c1170b709b8d82ece3a76';
const BLING_CLIENT_SECRET = process.env.BLING_CLIENT_SECRET || '5f59f5f4610f20bfd74984f151bcca343cb1375d68cc27216c4b2bc8a97d';

// Mapa de IDs de canais para nomes descritivos
const canalVendaMap = {
  '203520103': 'Mercado Livre',
  '204640345': 'Shopee',
};

// Mapa de status do Bling para textos descritivos
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

router.get('/auth', (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
  const redirectUri = getRedirectUri(req);
  const state = Buffer.from(JSON.stringify({ uid })).toString('base64');
  const url = `https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=${BLING_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
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
    console.error('Erro no callback Bling:', err.response?.data || err.message || err);
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
    console.log('[bling/vendas] Token renovado com sucesso');
    return access_token;
  } catch (refreshErr) {
    console.error('[bling/vendas] Erro ao renovar token:', refreshErr.response?.data || refreshErr.message);
    throw refreshErr;
  }
}

router.get('/vendas', async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'UID obrigatório' });

  async function getPedidosLista(token) {
    try {
      const pedidosRes = await axios.get('https://www.bling.com.br/Api/v3/pedidos/vendas', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
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
        headers: {
          Authorization: `Bearer ${token}`,
        },
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
      return res.status(401).json({ error: 'Conta Bling não conectada' });
    }

    let tokenUsado = bling.access_token;
    let pedidosLista;

    try {
      pedidosLista = await getPedidosLista(tokenUsado);
    } catch (err) {
      if (err.response?.status === 401 && bling.refresh_token) {
        try {
          tokenUsado = await refreshToken(bling, uid);
          pedidosLista = await getPedidosLista(tokenUsado);
        } catch (refreshErr) {
          // NÃO exclua o campo bling aqui!
          return res.status(401).json({ error: 'Token Bling expirado ou inválido. Refaça a conexão.' });
        }
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
            if (err.response?.data?.error?.type === 'invalid_token' && bling.refresh_token) {
              try {
                tokenUsado = await refreshToken(bling, uid);
                const detalhes = await getPedidoDetalhe(idVenda, tokenUsado);
                pedidos.push(mapearVenda(detalhes || pedido));
              } catch (refreshErr) {
                console.warn(`[bling/vendas] Falha ao renovar token para pedido ${idVenda}, usando dados da lista:`, pedido);
                pedidos.push(mapearVenda(pedido));
              }
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
    if (err.response && err.response.data && err.response.data.error && err.response.data.error.type === 'error_not_found') {
      console.warn('[bling/vendas] Bling retornou error_not_found, tratando como sem vendas.');
      return res.json({
        motivo: 'sem-vendas',
        msg: 'Nenhuma venda encontrada no Bling.',
        debug: err.response.data,
      });
    }
    console.error('[bling/vendas] Erro geral:', err.response?.data || err.message);
    res.status(500).json({
      error: 'Erro ao buscar dados do Bling',
      detalhe: err.response?.data || err.message,
    });
  }
});

// Nova rota para obter todas as contas contábeis do Bling do usuário
router.get('/financeiro', async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'UID obrigatório' });

  let bling;
  try {
    const docSnap = await db.collection('users').doc(uid).get();
    bling = docSnap.data()?.bling;
    if (!bling || !bling.access_token) {
      return res.status(401).json({ 
        error: 'Conta Bling não conectada. Conecte sua conta Bling para acessar o Financeiro.' 
      });
    }

    // Log para debug: token usado
    console.log('[bling/financeiro] Usando access_token:', bling.access_token);

    // Chama o endpoint de contas contábeis do Bling
    const response = await axios.get('https://www.bling.com.br/Api/v3/contas-contabeis', {
      headers: {
        Authorization: `Bearer ${bling.access_token}`,
      },
      params: {
        limite: 100,
      }
    });

    res.json(response.data);

  } catch (err) {
    // Só tenta renovar token se erro for 401
    if (err.response?.status === 401 && bling?.refresh_token) {
      try {
        console.warn('[bling/financeiro] 401 recebido, tentando renovar token...');
        const tokenUsado = await refreshToken(bling, req.query.uid);
        console.log('[bling/financeiro] Novo access_token após refresh:', tokenUsado);
        // Tenta novamente com o novo token
        try {
          const response = await axios.get('https://www.bling.com.br/Api/v3/contas-contabeis', {
            headers: {
              Authorization: `Bearer ${tokenUsado}`,
            },
            params: {
              limite: 100,
            }
          });
          return res.json(response.data);
        } catch (secondErr) {
          // Se ainda der 401, NÃO apague o campo bling, apenas informe o erro ao frontend
          if (secondErr.response?.status === 401) {
            console.warn('[bling/financeiro] 401 mesmo após refresh. Não apagando campo bling.');
            return res.status(401).json({
              error: 'Acesso negado pelo Bling mesmo após renovar o token. Verifique permissões da conta Bling ou tente reconectar.',
              detalhe: secondErr.response?.data || secondErr.message
            });
          }
          // Outros erros após refresh
          return res.status(secondErr.response?.status || 500).json({
            error: 'Erro ao acessar contas contábeis após renovar token',
            detalhe: secondErr.response?.data || secondErr.message
          });
        }
      } catch (refreshErr) {
        let isTokenInvalid = false;
        if (refreshErr.response?.status === 401) {
          isTokenInvalid = true;
        } else if (refreshErr.response?.data?.error === 'invalid_grant') {
          isTokenInvalid = true;
        } else if (
          typeof refreshErr.response?.data?.error_description === 'string' &&
          (
            refreshErr.response.data.error_description.toLowerCase().includes('invalid') ||
            refreshErr.response.data.error_description.toLowerCase().includes('expired')
          )
        ) {
          isTokenInvalid = true;
        }
        if (isTokenInvalid) {
          try {
            await db.collection('users').doc(req.query.uid).update({ bling: admin.firestore.FieldValue.delete() });
          } catch (cleanErr) {
            console.warn('[bling/financeiro] Falha ao limpar campo bling após erro de token:', cleanErr.message);
          }
          return res.status(401).json({ error: 'Token Bling expirado ou inválido. Refaça a conexão.' });
        } else {
          return res.status(500).json({ error: 'Erro ao renovar token Bling', detalhe: refreshErr.response?.data || refreshErr.message });
        }
      }
    }
    // Se não for erro 401, retorna o erro real do Bling para o frontend
    if (err.response?.data) {
      console.error('[bling/financeiro] Erro da API do Bling:', {
        status: err.response.status,
        data: err.response.data,
        headers: err.response.headers,
        access_token: bling?.access_token
      });
      return res.status(err.response.status || 500).json({
        error: err.response.data.error || 'Erro do Bling',
        detalhe: err.response.data,
        bling_access_token: bling?.access_token
      });
    }
    // Outros erros
    console.error('[bling/financeiro] Erro:', err.response?.data || err.message);
    res.status(500).json({ error: 'Erro ao buscar dados financeiros do Bling', detalhe: err.response?.data || err.message });
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