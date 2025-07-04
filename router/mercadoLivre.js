const express = require('express');
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
const crypto = require('crypto');
const router = express.Router();

const CLIENT_ID = '4762241412857004';
const CLIENT_SECRET = 'yBJNREOR3izbhIGRJtUP8P4FsGNXLIvB';
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

    const url = `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256&scope=offline_access`;
    
    console.log('Iniciando autenticação com:', { redirectUri, state, codeChallenge, scope: 'offline_access' });
    res.redirect(url);
  } catch (error) {
    console.error('Erro ao iniciar autenticação:', error.message);
    res.status(500).json({ error: 'Erro ao iniciar autenticação' });
  }
});

router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    console.error('Erro retornado pelo Mercado Livre:', error);
    return res.redirect(getFrontendUrl(false));
  }
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
      throw new Error('code_verifier não encontrado');
    }

    console.log('Callback chamado com:', { code, state, redirectUri, client_id: CLIENT_ID });

    const tokenResponse = await fetch('https://api.mercadolibre.com/oauth/token', {
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

    const { access_token, refresh_token, user_id, expires_in } = tokenData;
    console.log('Tokens recebidos:', { user_id, access_token, refresh_token, expires_in });

    if (!refresh_token) {
      console.warn('Nenhum refresh_token retornado pelo Mercado Livre. Verifique as permissões do aplicativo.');
    }

    const userResponse = await fetch(`https://api.mercadolibre.com/users/${user_id}`, {
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
      refresh_token: refresh_token || null,
      status: 'ativo',
      createdAt: new Date().toISOString(),
      expires_in,
      phoneNumbers: [],
      phoneNumbersStatus: {},
      phoneNumbersNames: {}
    }, { merge: true });

    codeVerifiers.delete(state);
    console.log('Conta conectada com sucesso, redirecionando para:', getFrontendUrl());
    res.redirect(getFrontendUrl());
  } catch (error) {
    console.error('Erro no callback:', error.message, error.stack);
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
    const skusSnap = await db.collection('users').doc(uid).collection('skus').limit(1000).get();
    const normalizeSku = sku => (sku || '').toString().trim().toUpperCase();
    const skusMap = {};
    skusSnap.forEach(doc => {
      const data = doc.data();
      if (data.sku) {
        skusMap[normalizeSku(data.sku)] = data;
      }
    });
    console.log('[ML API] SKUs carregados:', Object.keys(skusMap));

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
        const url = `https://api.mercadolibre.com/orders/search?seller=${user_id}&order.status=paid&offset=${offset}&limit=${limit}`;
        console.log('[ML API] Buscando vendas na URL:', url);
        let vendasRes, vendasData;
        try {
          vendasRes = await fetch(url, {
            headers: { Authorization: `Bearer ${access_token}` }
          });
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

        const novasVendasParaBuscar = vendasResults.filter(venda => {
          const id = venda.id?.toString();
          return id && !idsFirestore.has(id);
        });

        if (novasVendasParaBuscar.length === 0) {
          offset += limit;
          continue;
        }

        const vendasDetalhadas = await Promise.all(novasVendasParaBuscar.map(async (venda) => {
          const orderId = venda.id;
          console.log('[ML API] Buscando detalhes para orderId:', orderId);
          const orderDetailsRes = await fetch(`https://api.mercadolibre.com/orders/${orderId}`, {
            headers: { Authorization: `Bearer ${access_token}` }
          });
          const orderDetails = await orderDetailsRes.json();

          let discounts = [];
          try {
            const discountsRes = await fetch(`https://api.mercadolibre.com/orders/${orderId}/discounts`, {
              headers: { Authorization: `Bearer ${access_token}` }
            });
            const discountsData = await discountsRes.json();
            if (discountsData && Array.isArray(discountsData.details)) {
              discounts = discountsData.details;
            }
          } catch (discountErr) {
            console.warn('[ML API] Falha ao buscar descontos da venda:', orderId, discountErr.message);
          }

          let feedback = {};
          try {
            const feedbackRes = await fetch(`https://api.mercadolibre.com/orders/${orderId}/feedback`, {
              headers: { Authorization: `Bearer ${access_token}` }
            });
            feedback = await feedbackRes.json();
          } catch (feedbackErr) {
            console.warn('[ML API] Falha ao buscar feedback da venda:', orderId, feedbackErr.message);
          }

          let shipmentDetails = {};
          if (orderDetails.shipping?.id) {
            const shipmentRes = await fetch(`https://api.mercadolibre.com/shipments/${orderDetails.shipping.id}`, {
              headers: { Authorization: `Bearer ${access_token}` }
            });
            shipmentDetails = await shipmentRes.json();
          }

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

          if (Array.isArray(orderDetails.order_items)) {
            orderDetails.order_items = orderDetails.order_items.map(item => {
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

          let buyer = orderDetails.buyer;
          let seller = orderDetails.seller;
          try {
            if (buyer && buyer.id) {
              const buyerRes = await fetch(`https://api.mercadolibre.com/users/${buyer.id}`, {
                headers: { Authorization: `Bearer ${access_token}` }
              });
              buyer = await buyerRes.json();
            }
          } catch (err) { }
          try {
            if (seller && seller.id) {
              const sellerRes = await fetch(`https://api.mercadolibre.com/users/${seller.id}`, {
                headers: { Authorization: `Bearer ${access_token}` }
              });
              seller = await sellerRes.json();
            }
          } catch (err) { }

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
                updatedAt: new Date().toISOString(),
                discounts,
                feedback,
                buyer,
                seller
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
            shipment_base_cost: shipmentDetails.base_cost || 0,
            discounts,
            feedback,
            buyer,
            seller
          };
        }));

        novasVendas = novasVendas.concat(vendasDetalhadas);

        offset += limit;
      } while (vendasResults.length === limit && (total === 0 || offset < total));
    }

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

    const todasVendas = [...vendasFirestoreAtualizadas, ...novasVendas];
    console.log('[ML API] Vendas retornadas (Firestore + Novas):', todasVendas.length);

    res.json(todasVendas);
  } catch (error) {
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

router.get('/vendas/sync', async (req, res) => {
  const { uid } = req.query;
  if (!uid) {
    return res.status(400).json({ error: 'UID obrigatório' });
  }
  try {
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

      const url = `https://api.mercadolibre.com/orders/search?seller=${user_id}&order.status=paid&limit=${MAX_SYNC}`;
      const vendasRes = await fetch(url, {
        headers: { Authorization: `Bearer ${access_token}` }
      });
      const vendasData = await vendasRes.json();

      if (!Array.isArray(vendasData.results)) continue;

      for (const venda of vendasData.results) {
        if (totalSincronizadas >= MAX_SYNC) break;
        const orderId = venda.id;
        const vendaDoc = await db.collection('users').doc(uid).collection('mlVendas').doc(orderId.toString()).get();
        if (vendaDoc.exists) continue;

        const orderDetailsRes = await fetch(`https://api.mercadolibre.com/orders/${orderId}`, {
          headers: { Authorization: `Bearer ${access_token}` }
        });
        const orderDetails = await orderDetailsRes.json();

        let shipmentDetails = {};
        if (orderDetails.shipping?.id) {
          const shipmentRes = await fetch(`https://api.mercadolibre.com/shipments/${orderDetails.shipping.id}`, {
            headers: { Authorization: `Bearer ${access_token}` }
          });
          shipmentDetails = await shipmentRes.json();
        }

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

router.post('/vendas/fake', async (req, res) => {
  const uid = req.query.uid || req.body.uid;
  if (!uid) {
    return res.status(400).json({ error: 'UID obrigatório' });
  }
  try {
    const fakeVenda = {
      id: 'FAKE_ML_123456',
      order_id: 'FAKE_ML_123456',
      date_created: new Date().toISOString(),
      date_closed: new Date().toISOString(),
      status: 'paid',
      status_detail: 'payment_received',
      total_amount: 199.99,
      paid_amount: 199.99,
      currency_id: 'BRL',
      buyer: {
        id: '99999999',
        nickname: 'comprador_teste',
        first_name: 'João',
        last_name: 'Silva'
      },
      seller: {
        id: '88888888',
        nickname: 'vendedor_teste'
      },
      order_items: [
        {
          item: {
            id: 'MLB123456789',
            title: 'Produto Teste Mercado Livre',
            seller_sku: 'SKU-FAKE-ML-01'
          },
          quantity: 2,
          unit_price: 99.99,
          tipo_anuncio: 'premium',
          faixa_comissao: '11% + R$ 5,00',
          comissao_percentual: 0.11,
          custo_fixo: 5,
          taxa_plataforma_calculada: 27.998
        }
      ],
      payments: [
        {
          id: 'PAYMENT_FAKE_001',
          status: 'approved',
          transaction_amount: 199.99,
          date_approved: new Date().toISOString(),
          payment_method_id: 'credit_card',
          installments: 1,
          marketplace_fee: 22.00,
          coupon_amount: 0,
          fee_details: [
            { type: 'marketplace_fee', amount: 22.00 },
            { type: 'mercadopago_fee', amount: 5.99 }
          ]
        }
      ],
      shipping: {
        id: 'SHIP_FAKE_001',
        status: 'shipped',
        delivery_type: 'me2',
        tracking_number: 'TRK123456BR',
        list_cost: 15.00,
        base_cost: 10.00
      },
      tags: ['test_order'],
      feedback: {},
      discounts: [],
      comment: 'Pedido de teste gerado via API fake',
      ml_fee: 27.99,
      ml_fee_real: 27.99,
      ads: 0,
      shipment_list_cost: 15.00,
      shipment_base_cost: 10.00,
      updatedAt: new Date().toISOString()
    };

    await db.collection('users')
      .doc(uid)
      .collection('mlVendas')
      .doc(fakeVenda.id.toString())
      .set(fakeVenda, { merge: true });

    res.json({ success: true, venda: fakeVenda });
  } catch (err) {
    console.error('[ml/vendas/fake][POST] Erro ao criar venda fake:', err);
    res.status(500).json({ error: 'Erro ao criar venda fake', detalhe: err.message });
  }
});

module.exports = router;
module.exports.NGROK = NGROK;