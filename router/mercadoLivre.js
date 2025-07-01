const express = require('express');
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
const crypto = require('crypto');
const router = express.Router();
const CLIENT_ID = '3824907447184431';
const CLIENT_SECRET = '43I19nlTO0OLK5tw3K0rEeYiDObENV5z';
const NGROK = { url: null };

const codeVerifiers = new Map();
const db = require('../firebase').db;

function base64urlEncode(str) {
  return str
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function generatePKCE() {
  const codeVerifier = crypto.randomBytes(32).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const codeChallenge = base64urlEncode(
    crypto.createHash('sha256').update(codeVerifier).digest('base64')
  );
  return { codeVerifier, codeChallenge };
}

function getRedirectUri() {
  if (process.env.NODE_ENV === 'production' || !NGROK.url) {
    return 'https://econtazoom-backend.onrender.com/ml/callback';
  }
  return `${NGROK.url}/ml/callback`;
}

function getFrontendUrl(success = true) {
  const baseUrl = process.env.NODE_ENV === 'production'
    ? 'https://econtazoom.com.br/contas'
    : 'http://localhost:8080/contas';
  const query = success
    ? 'success=Conta%20conectada%20com%20sucesso'
    : 'error=Erro%20na%20conex%C3%A3o%20com%20Mercado%20Livre';
  return `${baseUrl}?${query}`;
}

router.get('/auth', async (req, res) => {
  const { uid } = req.query;
  if (!uid) {
    console.error('UID não fornecido');
    return res.status(400).json({ error: 'UID obrigatório' });
  }
  const redirectUri = getRedirectUri();
  if (!redirectUri) {
    console.error('ngrok não inicializado');
    return res.status(503).json({ error: 'ngrok ainda não inicializado' });
  }

  try {
    const { codeVerifier, codeChallenge } = generatePKCE();
    const state = Buffer.from(JSON.stringify({ uid })).toString('base64');

    codeVerifiers.set(state, codeVerifier);

    const url = `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256`;
    
    console.log('Iniciando autenticação com:', { redirectUri, state, codeChallenge });
    res.redirect(url);
  } catch (error) {
    console.error('Erro ao iniciar autenticação:', error.message);
    res.status(500).json({ error: 'Erro ao iniciar autenticação' });
  }
});

router.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) {
    console.error('Parâmetros code ou state ausentes:', { code, state });
    return res.redirect(getFrontendUrl(false));
  }

  try {
    const decodedState = JSON.parse(Buffer.from(state, 'base64').toString());
    const uid = decodedState.uid;
    const redirectUri = getRedirectUri();
    const codeVerifier = codeVerifiers.get(state);
    if (!codeVerifier) {
      console.error('code_verifier não encontrado para o state:', state);
      throw new Error('code_verifier não encontrado para o state fornecido');
    }

    console.log('Callback chamado com:', { code, state, redirectUri, client_id: CLIENT_ID, codeVerifier });

    const tokenResponse = await fetch('https://api.mercadolivre.com/oauth/token', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier
      })
    });

    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok) {
      console.error('Erro na requisição de token:', {
        status: tokenResponse.status,
        data: tokenData
      });
      throw new Error(tokenData.message || 'Erro ao obter token');
    }

    const { access_token, refresh_token, user_id } = tokenData;
    console.log('Tokens recebidos:', { user_id, access_token, refresh_token });

    const userResponse = await fetch(`https://api.mercadolivre.com/users/${user_id}`, {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    const userData = await userResponse.json();
    if (!userResponse.ok) {
      console.error('Erro ao obter dados do usuário:', userData);
      throw new Error(userData.message || 'Erro ao obter dados do usuário');
    }

    const nickname = userData.nickname || '';

    await db.collection('users').doc(uid).collection('mercadoLivre').doc(user_id.toString()).set({
      user_id,
      nickname,
      access_token,
      refresh_token,
      status: 'ativo',
      createdAt: new Date().toISOString(),
      phoneNumbers: [],
      phoneNumbersStatus: {},
      phoneNumbersNames: {}
    }, { merge: true });

    codeVerifiers.delete(state);
    console.log('Conta conectada com sucesso, redirecionando para:', getFrontendUrl());
    res.redirect(getFrontendUrl());
  } catch (error) {
    console.error('Erro no callback:', error.message);
    res.redirect(getFrontendUrl(false));
  }
});

router.get('/contas', async (req, res) => {
  const { uid } = req.query;
  if (!uid) {
    console.error('UID não fornecido');
    return res.status(400).json({ error: 'UID obrigatório' });
  }

  try {
    const snapshot = await db.collection('users').doc(uid).collection('mercadoLivre').get();
    const contas = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        user_id: data.user_id,
        nickname: data.nickname,
        status: data.status,
        createdAt: data.createdAt
      };
    });
    res.json(contas);
  } catch (error) {
    console.error('Erro ao buscar contas:', error.message);
    res.status(500).json({ error: 'Erro ao buscar contas' });
  }
});

router.get('/vendas', async (req, res) => {
  const { uid } = req.query;
  console.log('[ML API] /vendas chamada com uid:', uid);
  if (!uid) {
    console.error('[ML API] UID não fornecido');
    return res.status(400).json({ error: 'UID obrigatório' });
  }
  try {
    // 1. Buscar SKUs cadastrados do usuário (limite de 1000 para evitar quota)
    const skusSnap = await db.collection('users').doc(uid).collection('skus').limit(1000).get();
    // Normaliza os SKUs para garantir o join correto (removendo espaços e usando maiúsculas)
    const normalizeSku = sku => (sku || '').toString().trim().toUpperCase();
    const skusMap = {};
    skusSnap.forEach(doc => {
      const data = doc.data();
      if (data.sku) {
        skusMap[normalizeSku(data.sku)] = data;
      }
    });
    console.log('[ML API] SKUs carregados:', Object.keys(skusMap));

    // 2. Buscar vendas já salvas no Firestore (limite de 1000 para evitar quota)
    const vendasFirestoreSnap = await db.collection('users').doc(uid).collection('mlVendas').limit(1000).get();
    let vendasFirestore = [];
    let idsFirestore = new Set();
    vendasFirestoreSnap.forEach(doc => {
      const venda = doc.data();
      vendasFirestore.push(venda);
      if (venda.id) idsFirestore.add(venda.id.toString());
      else if (venda.order_id) idsFirestore.add(venda.order_id.toString());
      else if (doc.id) idsFirestore.add(doc.id);
    });
    if (vendasFirestoreSnap.size === 1000) {
      return res.status(429).json({
        error: 'Limite de vendas atingido para consulta. Reduza o volume de dados ou filtre por período.',
        detalhe: 'O sistema limita a leitura a 1000 vendas por vez para evitar exceder a cota do Firestore.'
      });
    }
    console.log('[ML API] Vendas já salvas no Firestore:', vendasFirestore.length);

    // 3. Buscar IDs de vendas do Mercado Livre (apenas IDs)
    const contasSnap = await db.collection('users').doc(uid).collection('mercadoLivre').get();
    if (contasSnap.empty) {
      console.warn('[ML API] Nenhuma conta Mercado Livre conectada para o usuário:', uid);
      return res.json([]);
    }

    let novasVendas = [];
    for (const docConta of contasSnap.docs) {
      const conta = docConta.data();
      const access_token = conta.access_token;
      const user_id = conta.user_id;
      console.log(`[ML API] Buscando vendas para user_id: ${user_id}`);

      let offset = 0;
      const limit = 50;
      let total = 0;
      let vendasResults = [];
      do {
        const url = `https://api.mercadolivre.com/orders/search?seller=${user_id}&order.status=paid&offset=${offset}&limit=${limit}`;
        console.log('[ML API] Buscando vendas na URL:', url);
        let vendasRes, vendasData;
        try {
          vendasRes = await fetch(url, {
            headers: { Authorization: `Bearer ${access_token}` }
          });
          // Tenta fazer o parse do JSON, se falhar retorna vazio
          const text = await vendasRes.text();
          try {
            vendasData = JSON.parse(text);
          } catch (jsonErr) {
            console.error('[ML API] Erro ao fazer parse do JSON da resposta do Mercado Livre:', jsonErr, 'Resposta bruta:', text);
            vendasData = { results: [] };
          }
        } catch (fetchErr) {
          console.error('[ML API] Erro de rede/fetch ao buscar vendas:', fetchErr);
          vendasData = { results: [] };
        }
        if (!Array.isArray(vendasData.results)) break;
        if (offset === 0 && vendasData.paging && vendasData.paging.total) {
          total = vendasData.paging.total;
        }
        vendasResults = vendasData.results;
        if (!vendasResults.length) break;

        // Filtra apenas vendas que ainda não estão no Firestore
        const novasVendasParaBuscar = vendasResults.filter(venda => {
          const id = venda.id?.toString();
          return id && !idsFirestore.has(id);
        });

        // Busca detalhes completos só das novas vendas
        const vendasDetalhadas = await Promise.all(novasVendasParaBuscar.map(async (venda) => {
          const orderId = venda.id;
          console.log('[ML API] Buscando detalhes para orderId:', orderId);
          const orderDetailsRes = await fetch(`https://api.mercadolivre.com/orders/${orderId}`, {
            headers: { Authorization: `Bearer ${access_token}` }
          });
          const orderDetails = await orderDetailsRes.json();

          // Busca detalhes do envio, se disponível
          let shipmentDetails = {};
          if (orderDetails.shipping?.id) {
            const shipmentRes = await fetch(`https://api.mercadolivre.com/shipments/${orderDetails.shipping.id}`, {
              headers: { Authorization: `Bearer ${access_token}` }
            });
            shipmentDetails = await shipmentRes.json();
          }

          // Calcula ml_fee somando todas as taxas relevantes
          let ml_fee = 0;
          if (Array.isArray(orderDetails.payments)) {
            orderDetails.payments.forEach(payment => {
              if (Array.isArray(payment.fee_details)) {
                payment.fee_details.forEach(fee => {
                  if (['marketplace_fee', 'mercadopago_fee'].includes(fee.type)) {
                    ml_fee += fee.amount || 0;
                  }
                });
              }
            });
          }

          // --- JOIN dos SKUs ---
          if (Array.isArray(orderDetails.order_items)) {
            orderDetails.order_items = orderDetails.order_items.map(item => {
              // Normaliza o SKU do item para comparar corretamente
              const sku = normalizeSku(item.item?.seller_sku || item.sku || item.SKU || null);
              if (sku && skusMap[sku]) {
                return {
                  ...item,
                  sku_info: {
                    hierarquia1: skusMap[sku].hierarquia1 || null,
                    hierarquia2: skusMap[sku].hierarquia2 || null,
                    custoUnitario: skusMap[sku].custoUnitario || null,
                    quantidadeSkuFilho: skusMap[sku].quantidadeSkuFilho || null,
                    skuFilhos: skusMap[sku].skuFilhos || null
                  }
                };
              }
              return item;
            });
          }

          // Salva/atualiza a venda no Firestore
          try {
            await db.collection('users')
              .doc(uid)
              .collection('mlVendas')
              .doc(orderId.toString())
              .set({
                ...orderDetails,
                shipping: shipmentDetails,
                ml_fee: ml_fee,
                ads: orderDetails.payments?.[0]?.coupon_amount || 0,
                shipment_list_cost: shipmentDetails.list_cost || orderDetails.shipping?.cost || 0,
                shipment_base_cost: shipmentDetails.base_cost || 0,
                updatedAt: new Date().toISOString()
              }, { merge: true });
          } catch (err) {
            console.error(`[ML API] Erro ao salvar venda ${orderId} no Firestore:`, err.message);
          }

          return {
            ...orderDetails,
            shipping: shipmentDetails,
            ml_fee: ml_fee,
            ads: orderDetails.payments?.[0]?.coupon_amount || 0,
            shipment_list_cost: shipmentDetails.list_cost || orderDetails.shipping?.cost || 0,
            shipment_base_cost: shipmentDetails.base_cost || 0
          };
        }));

        novasVendas = novasVendas.concat(vendasDetalhadas);

        offset += limit;
      } while (vendasResults.length === limit && (total === 0 || offset < total));
    }

    // Atualiza vendas já salvas no Firestore com SKUs normalizados
    const vendasFirestoreAtualizadas = await Promise.all(
      vendasFirestore.map(async (venda) => {
        let alterado = false;
        if (Array.isArray(venda.order_items)) {
          const novosOrderItems = venda.order_items.map(item => {
            const sku = normalizeSku(item.item?.seller_sku || item.sku || item.SKU || null);
            if (sku && skusMap[sku]) {
              alterado = true;
              return {
                ...item,
                sku_info: {
                  hierarquia1: skusMap[sku].hierarquia1 || null,
                  hierarquia2: skusMap[sku].hierarquia2 || null,
                  custoUnitario: skusMap[sku].custoUnitario || null,
                  quantidadeSkuFilho: skusMap[sku].quantidadeSkuFilho || null,
                  skuFilhos: skusMap[sku].skuFilhos || null
                }
              };
            }
            return item;
          });
          if (alterado) {
            // Atualiza no Firestore apenas se houve alteração
            try {
              await db.collection('users')
                .doc(uid)
                .collection('mlVendas')
                .doc((venda.id || venda.order_id || '').toString())
                .set({
                  ...venda,
                  order_items: novosOrderItems
                }, { merge: true });
            } catch (err) {
              console.warn('[ML API] Falha ao atualizar venda existente com SKUs normalizados:', err.message);
            }
            return { ...venda, order_items: novosOrderItems };
          }
        }
        return venda;
      })
    );

    // Junta as vendas já salvas (agora atualizadas) + as novas buscadas
    const todasVendas = [...vendasFirestoreAtualizadas, ...novasVendas];
    console.log('[ML API] Vendas retornadas (Firestore + Novas):', todasVendas.length);

    res.json(todasVendas);
  } catch (error) {
    // Tratamento especial para quota exceeded do Firestore
    let msg = error?.message || '';
    if (
      (msg && msg.toLowerCase().includes('quota')) ||
      (error?.code === 8 && msg.toLowerCase().includes('resource_exhausted'))
    ) {
      msg = 'Limite de uso do banco de dados atingido. Tente novamente mais tarde ou aguarde a renovação da cota do Firestore.';
    }
    console.error('[ML API] Erro ao buscar vendas Mercado Livre:', error, error?.response?.data || error?.message);
    res.status(500).json({ error: 'Erro ao buscar vendas do Mercado Livre', detalhe: msg });
  }
});

// Sincroniza vendas do Mercado Livre para o Firestore (pode ser chamado por um cron job)
router.get('/vendas/sync', async (req, res) => {
  const { uid } = req.query;
  if (!uid) {
    return res.status(400).json({ error: 'UID obrigatório' });
  }
  try {
    // Limite de vendas sincronizadas por chamada para evitar quota
    const MAX_SYNC = 500;
    const contasSnap = await db.collection('users').doc(uid).collection('mercadoLivre').get();
    if (contasSnap.empty) {
      return res.json({ msg: 'Nenhuma conta Mercado Livre conectada' });
    }

    let novasVendas = [];
    let totalSincronizadas = 0;
    for (const doc of contasSnap.docs) {
      if (totalSincronizadas >= MAX_SYNC) break;
      const conta = doc.data();
      const access_token = conta.access_token;
      const user_id = conta.user_id;

      const url = `https://api.mercadolivre.com/orders/search?seller=${user_id}&order.status=paid&limit=${MAX_SYNC}`;
      const vendasRes = await fetch(url, {
        headers: { Authorization: `Bearer ${access_token}` }
      });
      const vendasData = await vendasRes.json();

      if (!Array.isArray(vendasData.results)) continue;

      for (const venda of vendasData.results) {
        if (totalSincronizadas >= MAX_SYNC) break;
        const orderId = venda.id;
        // Verifica se já existe no Firestore
        const vendaDoc = await db.collection('users').doc(uid).collection('mlVendas').doc(orderId.toString()).get();
        if (vendaDoc.exists) continue; // Já existe, não duplica

        // Busca detalhes do pedido
        const orderDetailsRes = await fetch(`https://api.mercadolivre.com/orders/${orderId}`, {
          headers: { Authorization: `Bearer ${access_token}` }
        });
        const orderDetails = await orderDetailsRes.json();

        // Busca detalhes do envio, se disponível
        let shipmentDetails = {};
        if (orderDetails.shipping?.id) {
          const shipmentRes = await fetch(`https://api.mercadolivre.com/shipments/${orderDetails.shipping.id}`, {
            headers: { Authorization: `Bearer ${access_token}` }
          });
          shipmentDetails = await shipmentRes.json();
        }

        // Calcula ml_fee
        let ml_fee = 0;
        if (Array.isArray(orderDetails.payments)) {
          orderDetails.payments.forEach(payment => {
            if (Array.isArray(payment.fee_details)) {
              payment.fee_details.forEach(fee => {
                if (['marketplace_fee', 'mercadopago_fee'].includes(fee.type)) {
                  ml_fee += fee.amount || 0;
                }
              });
            }
          });
        }

        // Salva a venda nova
        await db.collection('users')
          .doc(uid)
          .collection('mlVendas')
          .doc(orderId.toString())
          .set({
            ...orderDetails,
            shipping: shipmentDetails,
            ml_fee: ml_fee,
            ads: orderDetails.payments?.[0]?.coupon_amount || 0,
            shipment_list_cost: shipmentDetails.list_cost || orderDetails.shipping?.cost || 0,
            shipment_base_cost: shipmentDetails.base_cost || 0,
            updatedAt: new Date().toISOString()
          }, { merge: true });
        totalSincronizadas++;
      }
    }

    if (totalSincronizadas >= MAX_SYNC) {
      return res.status(429).json({
        error: 'Limite de sincronização atingido. Tente novamente mais tarde ou sincronize por períodos menores.',
        detalhe: `A sincronização foi limitada a ${MAX_SYNC} vendas para evitar exceder a cota do Firestore.`
      });
    }

    res.json({ msg: 'Sincronização concluída', novasVendas, totalSincronizadas });
  } catch (error) {
    console.error('Erro ao sincronizar vendas Mercado Livre:', error.message);
    res.status(500).json({ error: 'Erro ao sincronizar vendas do Mercado Livre' });
  }
});

// ROTA PARA EXCLUIR TODAS AS VENDAS DO MERCADO LIVRE DE UM USUÁRIO
router.delete('/vendas', async (req, res) => {
  const uid = req.query.uid || req.body.uid;
  if (!uid) {
    return res.status(400).json({ error: 'UID obrigatório' });
  }
  try {
    const vendasRef = db.collection('users').doc(uid).collection('mlVendas');
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
    console.error('[ml/vendas][DELETE] Erro ao excluir:', err);
    res.status(500).json({ error: 'Erro ao excluir vendas do Mercado Livre', detalhe: err.message });
  }
});

module.exports = router;
module.exports.NGROK = NGROK;