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

// Corrija o mapeamento do tipo de anúncio para garantir "Grátis", "Clássico" ou "Premium"
function mapearTipoAnuncio(listingTypeId) {
  if (!listingTypeId || listingTypeId === '-') return '-';
  const id = listingTypeId.toLowerCase();
  if (id === 'gold_pro' || id === 'premium') return 'Premium';
  if (id === 'gold_special' || id === 'classic') return 'Clássico';
  if (id === 'free') return 'Grátis';
  return '-';
}

// Torne calcularTaxaAnuncio global
function calcularTaxaAnuncio(listingType, precoUnit) {
  precoUnit = Number(precoUnit || 0);
  if (listingType === 'gold_pro' || listingType === 'premium') {
    return { tipo: 'Premium', comissao: 0.17, custoFixo: 0 };
  } else if (listingType === 'gold_special' || listingType === 'classic') {
    if (precoUnit < 79) {
      return { tipo: 'Clássico', comissao: 0.12, custoFixo: 6.5 };
    } else {
      return { tipo: 'Clássico', comissao: 0.12, custoFixo: 0 };
    }
  } else if (listingType === 'free') {
    return { tipo: 'Grátis', comissao: 0, custoFixo: 0 };
  }
  return { tipo: listingType || '-', comissao: 0, custoFixo: 0 };
}

// Nova função para calcular a taxa real dos payments (mercadopago_fee + marketplace_fee)
function calcularTaxaPayments(payments) {
  if (!Array.isArray(payments)) return 0;
  let total = 0;
  payments.forEach(payment => {
    if (typeof payment.mercadopago_fee === 'number') total += payment.mercadopago_fee;
    if (typeof payment.marketplace_fee === 'number') total += payment.marketplace_fee;
    // Fallback: fee_details
    if (Array.isArray(payment.fee_details)) {
      payment.fee_details.forEach(fee => {
        if (['marketplace_fee', 'mercadopago_fee'].includes(fee.type)) {
          total += fee.amount || 0;
        }
      });
    }
  });
  return total;
}

function formatarTaxaPayments(payments) {
  if (!Array.isArray(payments)) return '0,00';
  let total = 0;
  payments.forEach(payment => {
    if (typeof payment.mercadopago_fee === 'number') total += payment.mercadopago_fee;
    if (typeof payment.marketplace_fee === 'number') total += payment.marketplace_fee;
  });
  // Multiplica por -1 conforme regra
  total = total * -1;
  // Formata com duas casas e vírgula
  return total.toFixed(2).replace('.', ',');
}

// Corrija o cálculo detalhado da taxa da plataforma conforme a tabela fornecida
function calcularTaxaPlataformaMercadoLivre({ tipoAnuncio, precoUnit, quantidade }) {
  let comissao = 0;
  let custoFixo = 0;
  let faixaComissao = '';
  precoUnit = Number(precoUnit || 0);
  quantidade = Number(quantidade || 1);

  if (!tipoAnuncio) tipoAnuncio = '-';
  const tipo = tipoAnuncio.toLowerCase();

  if (tipo === 'grátis' || tipo === 'gratis' || tipo === 'free') {
    comissao = 0;
    custoFixo = 0;
    faixaComissao = '0%';
  } else if (tipo === 'clássico' || tipo === 'classico') {
    if (precoUnit < 79) {
      comissao = 0.12;
      custoFixo = 6.0;
      faixaComissao = '12% + R$ 6,00';
    } else {
      comissao = 0.12;
      custoFixo = 0;
      faixaComissao = '12%';
    }
  } else if (tipo === 'premium') {
    if (precoUnit < 79) {
      comissao = 0.16;
      custoFixo = 6.0;
      faixaComissao = '16% + R$ 6,00';
    } else {
      comissao = 0.16;
      custoFixo = 0;
      faixaComissao = '16%';
    }
  } else {
    comissao = 0;
    custoFixo = 0;
    faixaComissao = '0%';
  }

  // Valor total da taxa para a quantidade vendida
  const taxaTotal = ((precoUnit * comissao) + custoFixo) * quantidade;

  return {
    tipoAnuncio,
    faixaComissao,
    comissaoPercentual: comissao,
    custoFixo,
    taxaTotal: Number(taxaTotal.toFixed(2))
  };
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

    const url = `https://auth.mercadolibre.com.br/authorization?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256&scope=offline_access`;

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
    // Carrega SKUs do Firestore (para enriquecer se necessário)
    const skusSnap = await db.collection('users').doc(uid).collection('skus').limit(1000).get();
    const normalizeSku = sku => (sku || '').toString().trim().toUpperCase();
    const skusMap = {};
    skusSnap.forEach(doc => {
      const data = doc.data();
      if (data.sku) {
        skusMap[normalizeSku(data.sku)] = data;
      }
    });

    // Carrega vendas do Firestore
    const vendasFirestoreSnap = await db.collection('users').doc(uid).collection('mlVendas').limit(1000).get();
    let vendasFirestore = [];
    let idsFirestore = new Set();
    vendasFirestoreSnap.forEach(doc => {
      const venda = doc.data();
      vendasFirestore.push({ ...venda, _firestoreId: doc.id });
      const id = venda.id?.toString() || venda.order_id?.toString() || doc.id;
      idsFirestore.add(id);
    });
    if (vendasFirestoreSnap.size === 1000) {
      return res.status(429).json({
        error: 'Limite de vendas atingido para consulta. Reduza o volume de dados ou filtre por período.',
        detalhe: 'O sistema limita a leitura a 1000 vendas por vez.'
      });
    }
    console.log('[ML API] Vendas já salvas no Firestore:', vendasFirestore.length);

    // Carrega contas Mercado Livre conectadas
    const contasSnap = await db.collection('users').doc(uid).collection('mercadoLivre').get();
    if (contasSnap.empty) {
      console.warn('[ML API] Nenhuma conta Mercado Livre conectada para o usuário:', uid);
      return res.json([]);
    }

    // Função para buscar detalhes completos de uma venda na API do Mercado Livre
    async function fetchOrderDetails(orderId, access_token) {
      try {
        const orderRes = await fetch(`https://api.mercadolibre.com/orders/${orderId}`, {
          headers: { Authorization: `Bearer ${access_token}` }
        });
        const orderData = await orderRes.json();
        if (!orderRes.ok) {
          console.warn(`[ML API] Falha ao buscar detalhes da order ${orderId}:`, orderData);
          return null;
        }
        // Busca detalhes de envio se houver
        let shipmentDetails = {};
        if (orderData.shipping?.id) {
          try {
            const shipmentRes = await fetch(`https://api.mercadolibre.com/shipments/${orderData.shipping.id}`, {
              headers: { Authorization: `Bearer ${access_token}` }
            });
            shipmentDetails = await shipmentRes.json();
          } catch (err) {
            shipmentDetails = {};
          }
        }
        // Busca descontos se houver
        let discounts = null;
        try {
          const discountsRes = await fetch(`https://api.mercadolibre.com/orders/${orderId}/discounts`, {
            headers: { Authorization: `Bearer ${access_token}` }
          });
          if (discountsRes.ok) {
            discounts = await discountsRes.json();
          }
        } catch (err) {
          discounts = null;
        }
        // Busca feedback se houver
        let feedback = null;
        try {
          const feedbackRes = await fetch(`https://api.mercadolibre.com/orders/${orderId}/feedback`, {
            headers: { Authorization: `Bearer ${access_token}` }
          });
          if (feedbackRes.ok) {
            feedback = await feedbackRes.json();
          }
        } catch (err) {
          feedback = null;
        }
        // Busca taxas reais se houver
        let ml_fee_real = null;
        try {
          const feesRes = await fetch(`https://api.mercadolibre.com/orders/${orderId}/fees`, {
            headers: { Authorization: `Bearer ${access_token}` }
          });
          if (feesRes.ok) {
            const feesData = await feesRes.json();
            if (typeof feesData.total_fee === 'number') {
              ml_fee_real = feesData.total_fee;
            }
          }
        } catch (err) {
          ml_fee_real = null;
        }
        // Enriquecer order_items com tipo de anúncio e taxas
        if (Array.isArray(orderData.order_items)) {
          orderData.order_items = await Promise.all(orderData.order_items.map(async item => {
            const sku = normalizeSku(item.item?.seller_sku || item.sku || item.SKU || null);
            const precoUnit = item.unit_price || 0;
            let listingType = item.listing_type_id || item.tipo_anuncio || item.listing_type || '-';

            // Buscar listing_type_id se ausente
            if ((!listingType || listingType === '-') && item.item?.id) {
              try {
                const itRes = await fetch(`https://api.mercadolibre.com/items/${item.item.id}?attributes=listing_type_id`, {
                  headers: { Authorization: `Bearer ${access_token}` }
                });
                const itemData = await itRes.json();
                listingType = itemData.listing_type_id || '-';
              } catch {
                listingType = '-';
              }
            }

            // Mapear tipo de anúncio e taxas
            const tipoAnuncio = mapearTipoAnuncio(listingType);

            // Cálculo detalhado da taxa da plataforma
            const taxaDetalhada = calcularTaxaPlataformaMercadoLivre({
              tipoAnuncio,
              precoUnit,
              quantidade: item.quantity || 1
            });

            return {
              ...item,
              listing_type_id: listingType,
              tipo_anuncio: tipoAnuncio,
              faixa_comissao: taxaDetalhada.faixaComissao,
              comissao_percentual: taxaDetalhada.comissaoPercentual,
              custo_fixo: taxaDetalhada.custoFixo,
              taxa_plataforma_calculada: taxaDetalhada.taxaTotal,
              sku_info: sku && skusMap[sku] ? {
                hierarquia1: skusMap[sku].hierarquia1 || null,
                hierarquia2: skusMap[sku].hierarquia2 || null,
                custoUnitario: skusMap[sku].custoUnitario || null,
                quantidadeSkuFilho: skusMap[sku].quantidadeSkuFilho || null,
                skuFilhos: skusMap[sku].skuFilhos || null
              } : undefined
            };
          }));
        }

        // Corrige taxa_plataforma_total para usar payments se disponível e envia formatada
        if (orderData.payments && Array.isArray(orderData.payments) && orderData.payments.length > 0) {
          orderData.taxa_plataforma_total = calcularTaxaPayments(orderData.payments);
          orderData.taxa_payments_formatada = formatarTaxaPayments(orderData.payments);
        } else if (orderData.order_items && Array.isArray(orderData.order_items)) {
          orderData.taxa_plataforma_total = orderData.order_items.reduce((acc, item) => acc + (item.taxa_plataforma_calculada || 0), 0);
          orderData.taxa_payments_formatada = orderData.taxa_plataforma_total.toFixed(2).replace('.', ',');
        }

        // Retorna todos os dados detalhados
        return {
          ...orderData,
          shipping_details: shipmentDetails,
          discounts,
          feedback,
          ml_fee_real
        };
      } catch (err) {
        console.warn(`[ML API] Falha ao buscar detalhes completos da order ${orderId}:`, err.message);
        return null;
      }
    }

    // Monta um map de user_id -> access_token
    const contasTokens = {};
    contasSnap.forEach(doc => {
      const conta = doc.data();
      if (conta.user_id && conta.access_token) {
        contasTokens[conta.user_id] = conta.access_token;
      }
    });

    // Para cada venda do Firestore, busca detalhes completos se necessário
    const vendasDetalhadas = await Promise.all(
      vendasFirestore.map(async venda => {
        const orderId = venda.id?.toString() || venda.order_id?.toString() || venda._firestoreId;
        const user_id = venda.seller?.id || venda.seller_id || venda.sellerId || venda.seller || null;
        // Tenta pegar o access_token da conta correspondente
        let access_token = null;
        // Busca pelo seller_id, se não, pega o primeiro token disponível
        if (user_id && contasTokens[user_id]) {
          access_token = contasTokens[user_id];
        } else if (Object.values(contasTokens).length > 0) {
          access_token = Object.values(contasTokens)[0];
        }
        // Se já tem todos os campos detalhados (order_items, payments, buyer, seller, shipping, etc), retorna direto
        if (
          venda.order_items && Array.isArray(venda.order_items) &&
          venda.payments && Array.isArray(venda.payments) &&
          venda.buyer && venda.seller && venda.shipping
        ) {
          // Adiciona ml_fee_real se não existir
          if (venda.ml_fee_real === undefined && access_token) {
            const details = await fetchOrderDetails(orderId, access_token);
            if (details && details.ml_fee_real !== undefined) {
              return { ...venda, ml_fee_real: details.ml_fee_real };
            }
          }
          return venda;
        }
        // Se não, busca detalhes completos na API
        if (access_token) {
          const details = await fetchOrderDetails(orderId, access_token);
          if (details) {
            // Mescla dados do Firestore com os detalhados da API
            return { ...venda, ...details };
          }
        }
        // Se não conseguir buscar detalhes, retorna o que tem
        return venda;
      })
    );

    res.json(vendasDetalhadas);
  } catch (error) {
    console.error('[ML API] Erro ao buscar vendas Mercado Livre:', error.message, error.stack);
    res.status(500).json({ error: 'Erro ao buscar vendas do Mercado Livre', detalhe: error.message });
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

module.exports = router;
module.exports.NGROK = NGROK;