const express = require('express');
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
const crypto = require('crypto');
const router = express.Router();
const { db } = require('../firebase'); // Importar o db corretamente

const CLIENT_ID = '4762241412857004';
const CLIENT_SECRET = 'yBJNREOR3izbhIGRJtUP8P4FsGNXLIvB';
const NGROK = { url: null };

const codeVerifiers = new Map();

// --- FUNÇÕES DE AUTENTICAÇÃO E TOKEN (COM ADIÇÃO DE REFRESH TOKEN) ---

/**
 * Renova o access_token do Mercado Livre usando o refresh_token.
 * @param {string} uid - O UID do usuário no Firebase.
 * @param {string} contaId - O ID da conta do Mercado Livre (user_id).
 * @param {object} contaData - Os dados atuais da conta contendo o refresh_token.
 * @returns {Promise<string>} O novo access_token.
 */
async function refreshTokenML(uid, contaId, contaData) {
  console.log(`[ML Token Refresh] Solicitando novo token para conta: ${contaId}`);
  try {
    const tokenResponse = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: contaData.refresh_token,
      }),
    });

    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok) {
      throw new Error(tokenData.message || 'Falha ao renovar o token');
    }

    const { access_token, refresh_token, expires_in } = tokenData;
    
    const novaContaData = {
      ...contaData,
      access_token,
      refresh_token, // O ML pode retornar um novo refresh_token
      expires_in,
      updatedAt: new Date().toISOString(),
      lastTokenRefresh: new Date().toISOString()
    };
    
    await db.collection('users').doc(uid).collection('mercadoLivre').doc(contaId).set(novaContaData, { merge: true });

    console.log(`[ML Token Refresh] Token para conta ${contaId} atualizado com sucesso.`);
    return access_token;

  } catch (error) {
    console.error(`[ML Token Refresh] FALHA ao atualizar token para conta ${contaId}:`, error.message);
    await db.collection('users').doc(uid).collection('mercadoLivre').doc(contaId).update({ status: 'reauth_required' });
    throw error;
  }
}

/**
 * Obtém um token de acesso válido, verificando a expiração e renovando se necessário.
 * @param {string} uid - O UID do usuário no Firebase.
 * @param {string} contaId - O ID da conta do Mercado Livre (user_id).
 * @returns {Promise<string>} Um access_token válido.
 */
async function getValidTokenML(uid, contaId) {
    const contaRef = db.collection('users').doc(uid).collection('mercadoLivre').doc(contaId);
    const contaSnap = await contaRef.get();
    
    if (!contaSnap.exists) {
        throw new Error(`Conta Mercado Livre ${contaId} não encontrada.`);
    }

    const contaData = contaSnap.data();
    if (!contaData.access_token || !contaData.refresh_token) {
        await contaRef.update({ status: 'reauth_required', status_detail: 'Tokens ausentes.' });
        throw new Error('Conta sem tokens de acesso ou de refresh. Reautenticação necessária.');
    }

    const tokenCreationTime = new Date(contaData.updatedAt || contaData.createdAt).getTime();
    const expiresInMilliseconds = (contaData.expires_in - 300) * 1000; // 5 minutos de margem de segurança

    if (Date.now() - tokenCreationTime > expiresInMilliseconds) {
        console.log(`[ML Token Check] Token para conta ${contaId} expirado. Renovando...`);
        return await refreshTokenML(uid, contaId, contaData);
    }
    
    return contaData.access_token;
}


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

    const url = `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256&scope=read write offline_access`;
    
    console.log('Iniciando autenticação com:', { redirectUri, state, codeChallenge, scope: 'read write offline_access' });
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

    const { access_token, refresh_token, user_id, expires_in } = tokenData;
    console.log('Tokens recebidos:', { user_id, access_token: '***', refresh_token: '***', expires_in });

    if (!refresh_token) {
      console.warn('Nenhum refresh_token retornado pelo Mercado Livre. Verifique as permissões (scope) do aplicativo.');
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
      updatedAt: new Date().toISOString(), // Usado para controle de expiração do token
      expires_in,
    }, { merge: true });

    codeVerifiers.delete(state);
    console.log('Conta conectada com sucesso, redirecionando para o frontend.');
    res.redirect(getFrontendUrl());
  } catch (error) {
    console.error('Erro no callback:', error.message, error.stack);
    res.redirect(getFrontendUrl(false));
  }
});

router.get('/contas', async (req, res) => {
    const { uid } = req.query;
    if (!uid) {
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
      console.error('Erro ao buscar contas do ML:', error.message);
      res.status(500).json({ error: 'Erro ao buscar contas' });
    }
});

/**
 * ROTA DE CACHE: Lê as vendas JÁ SALVAS no Firestore.
 * Usada para popular a tabela instantaneamente com dados antigos.
 */
router.get('/vendas', async (req, res) => {
    const { uid } = req.query;
    if (!uid) {
        return res.status(400).json({ error: 'UID obrigatório' });
    }
    try {
        const snapshot = await db.collection('users').doc(uid).collection('mlVendas').orderBy('date_created', 'desc').get();
        const todasAsVendas = snapshot.docs.map(doc => doc.data());
        console.log(`[ML Cache Read] Retornando ${todasAsVendas.length} vendas do Firestore para o UID ${uid}.`);
        res.json(todasAsVendas);
    } catch (error) {
        console.error('[ML Cache Read] Erro ao buscar vendas do Firestore:', error.message);
        res.status(500).json({ error: 'Erro ao buscar vendas do cache', detalhe: error.message });
    }
});

/**
 * NOVA ROTA DE LISTA: Busca TODAS as vendas da API do ML com paginação PARA TODAS AS CONTAS.
 * Não salva nada, apenas retorna a lista completa para o frontend orquestrar.
 */
router.get('/vendas/list', async (req, res) => {
    const { uid } = req.query;
    if (!uid) {
        return res.status(400).json({ error: 'UID obrigatório' });
    }

    try {
        const contasSnap = await db.collection('users').doc(uid).collection('mercadoLivre').get();
        if (contasSnap.empty) {
            return res.json({ results: [] });
        }

        let allResults = [];
        // Removido o limitador de vendas
        let totalFetched = 0;

        for (const contaDoc of contasSnap.docs) {
            const contaData = contaDoc.data();
            const contaId = contaDoc.id;
            const user_id = contaData.user_id;

            console.log(`[ML List] Iniciando busca de vendas para a conta: ${contaData.nickname} (${user_id})`);
            
            try {
                const access_token = await getValidTokenML(uid, contaId);
                let offset = 0;
                const limit = 50;

                while (true) {
                    const url = `https://api.mercadolibre.com/orders/search?seller=${user_id}&order.status=paid&sort=date_desc&offset=${offset}&limit=${limit}`;
                    const vendasRes = await fetch(url, { headers: { Authorization: `Bearer ${access_token}` } });

                    if (!vendasRes.ok) {
                        const errorData = await vendasRes.json();
                        console.error(`[ML List] Erro na API do ML para a conta ${user_id}:`, errorData.message);
                        break;
                    }

                    const vendasData = await vendasRes.json();
                    
                    if (vendasData.results && vendasData.results.length > 0) {
                        const vendasComSeller = vendasData.results.map(v => ({
                            ...v,
                            seller_account_id: user_id 
                        }));
                        allResults.push(...vendasComSeller);
                        totalFetched += vendasComSeller.length;

                        offset += limit;
                        console.log(`[ML List] Conta ${user_id}: Página ${offset / limit} buscada. Total de vendas até agora: ${allResults.length}`);
                    } else {
                        break;
                    }
                }
            } catch (contaError) {
                console.error(`[ML List] Erro ao processar a conta ${contaData.nickname}:`, contaError.message);
                continue;
            }
        }
        
        console.log(`[ML List] Busca finalizada. Retornando lista de ${allResults.length} vendas de todas as contas para o frontend.`);
        res.json({ results: allResults });

    } catch (error) {
        console.error('[ML List] Erro geral ao buscar lista de vendas:', error);
        res.status(500).json({ error: 'Erro ao buscar lista de vendas', detalhe: error.message });
    }
});

/**
 * FUNÇÃO DE CÁLCULO DO FRETE AJUSTADO - LÓGICA FINAL
 * Calcula o valor do frete, diferenciando CUSTO de RECEITA.
 * @param {object} orderDetails - Detalhes do pedido da API (/orders/{id}).
 * @param {object} shippingDetails - Detalhes do envio da API (/shipments/{id}).
 * @returns {number} Valor do frete. Positivo para CUSTO, Negativo para RECEITA.
 */
function calcularFreteAdjust(orderDetails, shippingDetails) {
    const logisticType = shippingDetails?.logistic_type;
    const shippingOption = shippingDetails?.shipping_option;
    const totalAmount = Number(orderDetails?.total_amount) || 0;

    if (logisticType === 'self_service') {
        if (totalAmount > 79) {
            const flexRevenue = 1.59; // Valor fixo mencionado pelo usuário.
            console.log(`[Frete ML] Envio FLEX > R$79 detectado. Receita: ${flexRevenue}`);
            return flexRevenue; // Valor positivo para modalidade FLEX
        }
        const flexRevenueUnder79 = Number(shippingOption?.cost) || 0;
        console.log(`[Frete ML] Envio FLEX <= R$79 detectado. Receita: ${flexRevenueUnder79}`);
        return flexRevenueUnder79; // Valor positivo para modalidade FLEX
    }

    const listCost = Number(shippingOption?.list_cost) || 0;
    const buyerCost = Number(shippingOption?.cost) || 0;

    if (listCost === 0) {
        console.log(`[Frete ML] Custo de tabela (list_cost) é 0. Custo do frete para o vendedor é 0.`);
        return 0;
    }

    const sellerCost = listCost - buyerCost;
    console.log(`[Frete ML - Custo] Custo Tabela (${listCost}) - Custo Comprador (${buyerCost}) = ${sellerCost}`);
    return parseFloat(Math.max(0, sellerCost).toFixed(2)); // Valor positivo para custos
}


/**
 * ROTA DE DETALHE: Busca detalhes de UMA venda, salva no Firestore e retorna.
 * Adiciona o campo `frete_adjust` antes de salvar com a nova lógica de cálculo.
 */
router.get('/vendas/detail/:orderId', async (req, res) => {
    const { uid, sellerId } = req.query;
    const { orderId } = req.params;
    if (!uid || !orderId || !sellerId) {
        return res.status(400).json({ error: 'UID, Order ID e Seller ID são obrigatórios' });
    }

    try {
        const access_token = await getValidTokenML(uid, sellerId.toString());

        const detailsRes = await fetch(`https://api.mercadolibre.com/orders/${orderId}`, { headers: { Authorization: `Bearer ${access_token}` } });
        if (!detailsRes.ok) {
            const errorData = await detailsRes.json();
            console.error(`Erro ao buscar detalhes do pedido ${orderId}:`, errorData);
            throw new Error(`Falha ao buscar detalhes do pedido ${orderId}: ${errorData.message}`);
        }
        
        const orderDetails = await detailsRes.json();
        
        let shipmentDetails = {};
        if (orderDetails.shipping?.id) {
            const shipmentRes = await fetch(`https://api.mercadolibre.com/shipments/${orderDetails.shipping.id}`, { headers: { Authorization: `Bearer ${access_token}` } });
            if (shipmentRes.ok) {
                shipmentDetails = await shipmentRes.json();
            } else {
                console.warn(`Não foi possível buscar detalhes do envio para o pedido ${orderId}. O envio pode não existir ou a API retornou um erro.`);
            }
        }
        
        const finalData = { 
            ...orderDetails, 
            shipping_details: shipmentDetails, 
            updatedAt: new Date().toISOString() 
        };
        
        // Adiciona o campo calculado usando a função FINAL
        finalData.frete_adjust = calcularFreteAdjust(orderDetails, shipmentDetails);

        const vendaDocRef = db.collection('users').doc(uid).collection('mlVendas').doc(orderId);
        await vendaDocRef.set(finalData, { merge: true });
        
        console.log(`[ML Detail] Detalhes da venda ${orderId} (Vendedor: ${sellerId}) salvos com frete_adjust: ${finalData.frete_adjust}.`);
        res.json(finalData);

    } catch (error) {
        console.error(`[ML Detail] Erro ao processar venda ${orderId}:`, error);
        res.status(500).json({ error: `Erro ao processar venda ${orderId}`, detalhe: error.message });
    }
});
  
async function deleteCollectionBatch(db, collectionRef, batchSize) {
    const query = collectionRef.limit(batchSize);
    let deletedCount = 0;

    while (true) {
        const snapshot = await query.get();
        if (snapshot.size === 0) {
            break; 
        }

        const batch = db.batch();
        snapshot.docs.forEach(doc => {
            batch.delete(doc.ref);
        });
        await batch.commit();

        deletedCount += snapshot.size;
        console.log(`[ML Delete] Lote de ${snapshot.size} vendas excluído.`);
    }
    return deletedCount;
}

router.delete('/vendas', (req, res) => {
    const uid = req.query.uid || req.body.uid;
    if (!uid) {
        return res.status(400).json({ error: 'UID obrigatório' });
    }

    res.json({ success: true, message: "A exclusão foi iniciada em segundo plano." });

    console.log(`[ML Delete] Iniciando exclusão em segundo plano para UID: ${uid}`);
    const vendasRef = db.collection('users').doc(uid).collection('mlVendas');
    
    deleteCollectionBatch(db, vendasRef, 200)
        .then(deletedCount => {
            console.log(`[ML Delete] Processo em segundo plano CONCLUÍDO. ${deletedCount} vendas excluídas para o UID ${uid}`);
        })
        .catch(err => {
            console.error(`[ML Delete] Erro FATAL no processo de exclusão em segundo plano para UID ${uid}:`, err);
        });
});
  
router.post('/vendas/fake', async (req, res) => {
    const { uid } = req.body;
    if (!uid) {
      return res.status(400).json({ error: 'UID obrigatório' });
    }
    try {
      const fakeVenda = {
        id: 'FAKE_ML_' + Date.now(),
        order_id: 'FAKE_ML_' + Date.now(),
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
        order_items: [{
          item: {
            id: 'MLB123456789',
            title: 'Produto Teste Mercado Livre',
            seller_sku: 'SKU-FAKE-ML-01'
          },
          quantity: 2,
          unit_price: 99.99,
        }],
        payments: [{
          id: 'PAYMENT_FAKE_001',
          status: 'approved',
          transaction_amount: 199.99,
          date_approved: new Date().toISOString(),
          payment_method_id: 'credit_card',
          installments: 1,
          marketplace_fee: 22.00,
        }],
        shipping: {
          id: 'SHIP_FAKE_001',
          status: 'shipped',
          delivery_type: 'me2',
          tracking_number: 'TRK123456BR',
          cost: 15.00 
        },
        updatedAt: new Date().toISOString()
      };
  
      await db.collection('users')
        .doc(uid)
        .collection('mlVendas')
        .doc(fakeVenda.id.toString())
        .set(fakeVenda, { merge: true });
  
      res.json({ success: true, venda: fakeVenda });
    } catch (err) {
      console.error('[ML Fake] Erro ao criar venda fake:', err);
      res.status(500).json({ error: 'Erro ao criar venda fake', detalhe: err.message });
    }
});

router.post('/ngrok-url', (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL do ngrok é obrigatória.' });
    NGROK.url = url;
    console.log(`[Mercado Livre] URL do ngrok atualizada para: ${url}`);
    res.json({ success: true, url });
});

module.exports = router;
module.exports.NGROK = NGROK;