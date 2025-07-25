const express = require('express');
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
const crypto = require('crypto');
const router = express.Router();
const { db } = require('../firebase'); 

const CLIENT_ID = '4762241412857004';
const CLIENT_SECRET = 'yBJNREOR3izbhIGRJtUP8P4FsGNXLIvB';
const NGROK = { url: null };

const codeVerifiers = new Map();

// --- FUNÇÕES DE AUTENTICAÇÃO E TOKEN ---

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
      refresh_token,
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
    const expiresInMilliseconds = (contaData.expires_in - 300) * 1000; // 5 minutos de margem

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
      updatedAt: new Date().toISOString(),
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

router.get('/vendas/list_for_account', async (req, res) => {
    const { uid, accountId } = req.query;
    if (!uid || !accountId) {
        return res.status(400).json({ error: 'UID e accountId são obrigatórios' });
    }

    try {
        console.log(`[ML List For Account] Iniciando busca de vendas para a conta: ${accountId}`);
        const access_token = await getValidTokenML(uid, accountId);
        let allResults = [];
        let offset = 0;
        const limit = 50;

        while (true) {
            const url = `https://api.mercadolibre.com/orders/search?seller=${accountId}&order.status=paid&sort=date_desc&offset=${offset}&limit=${limit}`;
            const vendasRes = await fetch(url, { headers: { Authorization: `Bearer ${access_token}` } });

            if (!vendasRes.ok) {
                const errorData = await vendasRes.json();
                console.error(`[ML List For Account] Erro na API do ML para a conta ${accountId}:`, errorData.message);
                break;
            }

            const vendasData = await vendasRes.json();
            
            if (vendasData.results && vendasData.results.length > 0) {
                const vendasComSeller = vendasData.results.map(v => ({
                    ...v,
                    seller_account_id: accountId 
                }));
                allResults.push(...vendasComSeller);
                offset += limit;
            } else {
                break;
            }
        }
        
        console.log(`[ML List For Account] Busca finalizada. Retornando lista de ${allResults.length} vendas para a conta ${accountId}.`);
        res.json({ results: allResults });

    } catch (error) {
        console.error(`[ML List For Account] Erro geral ao buscar lista de vendas para a conta ${accountId}:`, error);
        res.status(500).json({ error: `Erro ao buscar lista de vendas para a conta ${accountId}`, detalhe: error.message });
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

    // Lógica para ME FLEX (self_service)
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

    // Lógica para ME2 (drop_off, cross_docking, etc)
    const listCost = Number(shippingOption?.list_cost) || 0;
    const buyerCost = Number(shippingOption?.cost) || 0;

    if (listCost === 0) {
        console.log(`[Frete ML] Custo de tabela (list_cost) é 0. Custo do frete para o vendedor é 0.`);
        return 0;
    }

    const sellerCost = listCost - buyerCost;
    console.log(`[Frete ML - Custo] Custo Tabela (${listCost}) - Custo Comprador (${buyerCost}) = ${sellerCost}`);
    return parseFloat(Math.max(0, sellerCost).toFixed(2)); // Garante que o custo não seja negativo
}


router.get('/vendas/detail/:orderId', async (req, res) => {
    const { uid, sellerId } = req.query;
    const { orderId } = req.params;
    if (!uid || !orderId || !sellerId) {
        return res.status(400).json({ error: 'UID, Order ID e Seller ID são obrigatórios' });
    }

    try {
        const access_token = await getValidTokenML(uid, sellerId.toString());

        const contaSnap = await db.collection('users').doc(uid).collection('mercadoLivre').doc(sellerId).get();
        const nomeConta = contaSnap.exists ? contaSnap.data().nickname : `Conta ${sellerId}`;

        const detailsRes = await fetch(`https://api.mercadolibre.com/orders/${orderId}`, { headers: { Authorization: `Bearer ${access_token}` } });
        if (!detailsRes.ok) {
            const errorData = await detailsRes.json();
            throw new Error(`Falha ao buscar detalhes do pedido ${orderId}: ${errorData.message}`);
        }
        
        const orderDetails = await detailsRes.json();
        
        let shipmentDetails = {};
        let shippingCost = 0;
        if (orderDetails.shipping?.id) {
            try {
                const shipmentRes = await fetch(`https://api.mercadolibre.com/shipments/${orderDetails.shipping.id}`, { headers: { Authorization: `Bearer ${access_token}` } });
                if (shipmentRes.ok) {
                    shipmentDetails = await shipmentRes.json();
                    // A chamada para a função de cálculo agora usa a nova lógica com logs
                    shippingCost = typeof calcularFreteAdjust(orderDetails, shipmentDetails) === 'number' ? calcularFreteAdjust(orderDetails, shipmentDetails) : 0;
                } else {
                    console.warn(`[ML Detail] Não foi possível buscar shipment para venda ${orderId}. Salvando sem frete.`);
                }
            } catch (err) {
                console.warn(`[ML Detail] Erro de rede ao buscar shipment para venda ${orderId}: ${err.message}`);
            }
        }

        // --- PROCESSAMENTO DOS DADOS PARA SALVAR NO FIRESTORE ---
        const orderItems = Array.isArray(orderDetails.order_items) ? orderDetails.order_items : [];
        let custoTotalML = 0;
        orderItems.forEach(item => {
            const sku = item.item?.seller_sku;
            if (sku) custoTotalML += 0; // Pode ser ajustado se houver custo unitário
        });
        const saleFee = orderItems.reduce((acc, item) => acc + (item.sale_fee || 0), 0);
        const cliente = orderDetails.buyer?.nickname || orderDetails.buyer?.first_name || 'Desconhecido';

        const vendaFinal = {
            ...orderDetails,
            shipping_details: shipmentDetails,
            updatedAt: new Date().toISOString(),
            nomeConta: nomeConta,
            frete_adjust: shippingCost,
            canalVenda: 'Mercado Livre',
            idVendaMarketplace: orderDetails.id?.toString() || orderId,
            cliente,
            nomeProdutoVendido: orderItems[0]?.item?.title || '-',
            dataHora: orderDetails.date_created || '-',
            valorTotalVenda: Number(orderDetails.total_amount || 0),
            txPlataforma: saleFee,
            custoFrete: shippingCost,
            custo: custoTotalML
        };

        const vendaDocRef = db.collection('users').doc(uid).collection('mlVendas').doc(orderId);
        await vendaDocRef.set(vendaFinal, { merge: true });
        
        console.log(`[ML Detail] Detalhes da venda ${orderId} (Vendedor: ${sellerId}) salvos com frete_adjust: ${vendaFinal.frete_adjust}.`);
        res.json(vendaFinal);

    } catch (error) {
        console.error(`[ML Detail] Erro ao processar venda ${orderId}:`, error);
        res.status(500).json({ error: `Erro ao processar venda ${orderId}`, detalhe: error.message });
    }
});
  
router.get('/vendas/sync_for_account', async (req, res) => {
    const { uid, accountId } = req.query;
    if (!uid || !accountId) {
        return res.status(400).json({ error: 'UID e accountId são obrigatórios' });
    }

    try {
        const access_token = await getValidTokenML(uid, accountId);
        let allResults = [];
        let offset = 0;
        const limit = 50;

        // Busca todas as vendas pagas
        while (true) {
            const url = `https://api.mercadolibre.com/orders/search?seller=${accountId}&order.status=paid&sort=date_desc&offset=${offset}&limit=${limit}`;
            const vendasRes = await fetch(url, { headers: { Authorization: `Bearer ${access_token}` } });

            if (!vendasRes.ok) {
                const errorData = await vendasRes.json();
                console.error(`[ML Sync For Account] Erro na API do ML para a conta ${accountId}:`, errorData.message);
                break;
            }

            const vendasData = await vendasRes.json();
            if (vendasData.results && vendasData.results.length > 0) {
                allResults.push(...vendasData.results);
                offset += limit;
            } else {
                break;
            }
        }

        // Busca nickname da conta
        const contaSnap = await db.collection('users').doc(uid).collection('mercadoLivre').doc(accountId).get();
        const nomeConta = contaSnap.exists ? contaSnap.data().nickname : `Conta ${accountId}`;

        // Para cada venda, busca detalhes e salva no Firestore
        let salvos = 0;
        for (const venda of allResults) {
            try {
                const detailsRes = await fetch(`https://api.mercadolibre.com/orders/${venda.id}`, { headers: { Authorization: `Bearer ${access_token}` } });
                if (!detailsRes.ok) continue;
                const orderDetails = await detailsRes.json();

                let shipmentDetails = {};
                let shippingCost = 0;
                if (orderDetails.shipping?.id) {
                    try {
                        const shipmentRes = await fetch(`https://api.mercadolibre.com/shipments/${orderDetails.shipping.id}`, { headers: { Authorization: `Bearer ${access_token}` } });
                        if (shipmentRes.ok) {
                            shipmentDetails = await shipmentRes.json();
                            // A chamada para a função de cálculo agora usa a nova lógica com logs
                            shippingCost = typeof calcularFreteAdjust(orderDetails, shipmentDetails) === 'number' ? calcularFreteAdjust(orderDetails, shipmentDetails) : 0;
                        } else {
                            console.warn(`[ML Sync] Não foi possível buscar shipment para venda ${venda.id}. Salvando sem frete.`);
                        }
                    } catch (err) {
                        console.warn(`[ML Sync] Erro de rede ao buscar shipment para venda ${venda.id}: ${err.message}`);
                    }
                }

                // Processa os dados igual ao /vendas/detail/:orderId
                const orderItems = Array.isArray(orderDetails.order_items) ? orderDetails.order_items : [];
                let custoTotalML = 0;
                orderItems.forEach(item => {
                    const sku = item.item?.seller_sku;
                    if (sku) custoTotalML += 0;
                });
                const saleFee = orderItems.reduce((acc, item) => acc + (item.sale_fee || 0), 0);
                const cliente = orderDetails.buyer?.nickname || orderDetails.buyer?.first_name || 'Desconhecido';

                const vendaFinal = {
                    ...orderDetails,
                    shipping_details: shipmentDetails,
                    updatedAt: new Date().toISOString(),
                    nomeConta: nomeConta,
                    frete_adjust: shippingCost,
                    canalVenda: 'Mercado Livre',
                    idVendaMarketplace: orderDetails.id?.toString() || venda.id?.toString(),
                    cliente,
                    nomeProdutoVendido: orderItems[0]?.item?.title || '-',
                    dataHora: orderDetails.date_created || '-',
                    valorTotalVenda: Number(orderDetails.total_amount || 0),
                    txPlataforma: saleFee,
                    custoFrete: shippingCost,
                    custo: custoTotalML,
                    seller_account_id: accountId // <-- identifica a conta da venda
                };

                // Salva SEMPRE em mlVendas, usando o id do pedido como ID do documento
                await db.collection('users').doc(uid).collection('mlVendas').doc(orderDetails.id.toString()).set(vendaFinal, { merge: true });
                salvos++;
            } catch (err) {
                console.error(`[ML Sync For Account] Erro ao salvar venda ${venda.id}:`, err.message);
            }
        }

        res.json({ total: allResults.length, salvos });
    } catch (error) {
        console.error(`[ML Sync For Account] Erro geral ao sincronizar vendas da conta ${accountId}:`, error);
        res.status(500).json({ error: `Erro ao sincronizar vendas da conta ${accountId}`, detalhe: error.message });
    }
});

module.exports = router;
module.exports.NGROK = NGROK;