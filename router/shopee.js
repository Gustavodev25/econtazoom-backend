const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const { db } = require('../firebase');

const CLIENT_ID = process.env.SHOPEE_CLIENT_ID || '2011938';
const CLIENT_SECRET = process.env.SHOPEE_CLIENT_SECRET || 'shpk527477684f57526b554d567743746d766e51795778465974447565734c52';
const SHOPEE_BASE_URL = 'https://openplatform.shopee.com.br';

/**
 * Gera a URL de redirecionamento correta (produção ou ngrok)
 * @param {object} req - O objeto de requisição do Express.
 * @returns {string} A URL de callback completa e limpa.
 */
function getRedirectUri(req) {
    const productionUrl = 'https://econtazoom-backend.onrender.com/shopee/callback';
    const ngrokUrl = req.app.locals.ngrokUrl;

    if (process.env.NODE_ENV === 'production' || !ngrokUrl) {
        return productionUrl;
    }
    
    return `${ngrokUrl}/shopee/callback`;
}

function generateSign(path, partner_id, timestamp, access_token = '', shop_id = '') {
    const baseString = `${partner_id}${path}${timestamp}${access_token}${shop_id}`;
    return crypto.createHmac('sha256', CLIENT_SECRET).update(baseString).digest('hex');
}

// ROTA DE AUTENTICAÇÃO CORRIGIDA PARA USAR 'STATE' (SOLUÇÃO DEFINITIVA)
router.get('/auth', (req, res) => {
    const { uid } = req.query;
    if (!uid) {
        return res.status(400).send('UID do usuário é obrigatório.');
    }

    // 1. A URL de callback deve ser LIMPA, sem nenhum parâmetro.
    const redirectUri = getRedirectUri(req);
    
    // 2. O UID é codificado e passado no parâmetro 'state', que é a forma correta.
    const state = Buffer.from(JSON.stringify({ uid })).toString('base64');
    
    const timestamp = Math.floor(Date.now() / 1000);
    const path = '/api/v2/shop/auth_partner';
    const sign = generateSign(path, CLIENT_ID, timestamp);

    const authUrl = new URL(`${SHOPEE_BASE_URL}${path}`);
    authUrl.searchParams.append('partner_id', CLIENT_ID);
    authUrl.searchParams.append('timestamp', timestamp);
    authUrl.searchParams.append('sign', sign);
    authUrl.searchParams.append('redirect', redirectUri); // <-- URL Limpa, exatamente como no painel Shopee
    authUrl.searchParams.append('state', state);         // <-- UID vai aqui, de forma segura
    
    console.log(`[Shopee Auth] Redirecionando para autenticação. Callback: ${redirectUri}, State: ${state}`);
    res.redirect(authUrl.toString());
});

// ROTA DE CALLBACK CORRIGIDA PARA LER 'STATE' (SOLUÇÃO DEFINITIVA)
router.get('/callback', async (req, res) => {
    // 1. Lemos 'code', 'shop_id' e 'state'. O 'uid' não vem mais direto na query.
    const { code, shop_id, state } = req.query;
    if (!code || !shop_id || !state) {
        console.error('[Shopee Callback] Falha: Parâmetros de callback ausentes.', req.query);
        return res.status(400).send('Parâmetros de callback ausentes ou inválidos. Por favor, tente novamente.');
    }

    let uid;
    try {
        // 2. Decodificamos o 'state' para recuperar o UID do usuário.
        const decodedState = JSON.parse(Buffer.from(state, 'base64').toString('utf-8'));
        uid = decodedState.uid;
        if (!uid) throw new Error('UID não encontrado no state.');

    } catch (error) {
        console.error('[Shopee Callback] Erro ao decodificar o state:', error);
        return res.status(400).send('State (parâmetro de segurança) inválido.');
    }
    
    try {
        const timestamp = Math.floor(Date.now() / 1000);
        const path = '/api/v2/auth/token/get';
        const sign = generateSign(path, CLIENT_ID, timestamp);
        const tokenResponse = await axios.post(`${SHOPEE_BASE_URL}${path}`, {
            code, shop_id: parseInt(shop_id, 10), partner_id: parseInt(CLIENT_ID, 10)
        }, {
            headers: { 'Content-Type': 'application/json' },
            params: { partner_id: parseInt(CLIENT_ID, 10), timestamp, sign }
        });

        if (tokenResponse.data.error) {
            throw new Error(`Erro ao buscar token da Shopee: ${tokenResponse.data.message || tokenResponse.data.error}`);
        }

        const { access_token, refresh_token, expire_in } = tokenResponse.data;

        const pathShop = '/api/v2/shop/get_shop_info';
        const timestampShop = Math.floor(Date.now() / 1000);
        const signShop = generateSign(pathShop, CLIENT_ID, timestampShop, access_token, shop_id);
        const shopInfoResponse = await axios.get(`${SHOPEE_BASE_URL}${pathShop}`, {
            params: { 
                partner_id: parseInt(CLIENT_ID, 10), 
                timestamp: timestampShop, 
                access_token, 
                shop_id: parseInt(shop_id, 10), 
                sign: signShop 
            }
        });

        if (shopInfoResponse.data.error) {
            throw new Error('Falha ao obter os detalhes da loja da Shopee.');
        }
        const { shop_name, region } = shopInfoResponse.data.response;

        await db.collection('users').doc(uid).collection('shopee').doc(shop_id.toString()).set({
            access_token, 
            refresh_token, 
            expire_in, 
            shop_id: parseInt(shop_id, 10), 
            status: 'ativo',
            shop_name: shop_name || `Loja ${shop_id}`,
            region,
            connectedAt: new Date().toISOString(),
            lastTokenRefresh: new Date().toISOString()
        }, { merge: true });

        console.log(`[Shopee Callback] Sucesso! Conta ${shop_id} conectada para o UID ${uid}.`);
        // Script para recarregar a página principal e fechar o pop-up
        res.send('<script>window.opener && window.opener.location.reload(true); window.close();</script><h1>Autenticação concluída!</h1><p>Você pode fechar esta janela.</p>');

    } catch (error) {
        console.error(`[Shopee Callback] Erro CRÍTICO para o UID ${uid}:`, error.message);
        res.status(500).send(`Erro durante a autenticação: ${error.message}. Por favor, tente novamente.`);
    }
});


// --- DEMAIS FUNÇÕES E ROTAS (INTOCADAS) ---

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function refreshTokenShopee(uid, shopId, accountData, forceRefresh = false) {
    try {
        if (!forceRefresh) {
            const lastRefresh = new Date(accountData.lastTokenRefresh || accountData.connectedAt).getTime();
            const expireMs = (accountData.expire_in - 3600) * 1000; // 1 hora de margem
            if (Date.now() < lastRefresh + expireMs) {
                return accountData.access_token;
            }
        }

        console.log(`[Shopee Token] Renovando token para loja ${shopId}`);
        
        const path = '/api/v2/auth/access_token/get';
        const timestamp = Math.floor(Date.now() / 1000);
        const sign = generateSign(path, CLIENT_ID, timestamp);

        const response = await axios.post(
            `${SHOPEE_BASE_URL}${path}`,
            {
                refresh_token: accountData.refresh_token,
                partner_id: parseInt(CLIENT_ID, 10),
                shop_id: parseInt(shopId, 10)
            },
            {
                headers: { 'Content-Type': 'application/json' },
                params: { partner_id: parseInt(CLIENT_ID, 10), timestamp, sign }
            }
        );

        if (response.data.error) {
            await db.collection('users').doc(uid).collection('shopee').doc(shopId).update({
                status: 'reauth_required',
                lastError: response.data.message,
                lastErrorTimestamp: new Date().toISOString()
            });
            throw new Error(`Erro ao renovar token: ${response.data.message}`);
        }

        const { access_token, refresh_token, expire_in } = response.data;
        const newData = {
            ...accountData,
            access_token,
            refresh_token,
            expire_in,
            lastTokenRefresh: new Date().toISOString(),
            status: 'ativo',
            lastError: null,
            lastErrorTimestamp: null
        };

        await db.collection('users').doc(uid).collection('shopee').doc(shopId).set(newData, { merge: true });
        console.log(`[Shopee Token] Token renovado com sucesso para loja ${shopId}`);
        return access_token;
    } catch (error) {
        console.error(`[Shopee Token] Erro ao renovar token para loja ${shopId}:`, error.message);
        throw error;
    }
}

async function getValidTokenShopee(uid, shopId, retryCount = 0) {
    try {
        const snap = await db.collection('users').doc(uid).collection('shopee').doc(shopId).get();
        if (!snap.exists) throw new Error(`Conta Shopee ${shopId} não encontrada.`);
        const data = snap.data();

        if (data.status === 'reauth_required') {
            throw new Error('Conta precisa ser reautenticada');
        }

        try {
            return await refreshTokenShopee(uid, shopId, data, retryCount > 0);
        } catch (error) {
            if (retryCount < 3 && (
                error.message.includes('Invalid access_token') ||
                error.message.includes('error_auth') ||
                error.response?.status === 403
            )) {
                console.log(`[Shopee Token] Tentativa ${retryCount + 1} de 3 para loja ${shopId}`);
                await delay(1000 * (retryCount + 1));
                return await getValidTokenShopee(uid, shopId, retryCount + 1);
            }
            throw error;
        }
    } catch (error) {
        console.error(`[Shopee Token] Erro ao obter token válido para loja ${shopId}:`, error.message);
        throw error;
    }
}


router.get('/vendas/list', async (req, res) => {
    console.log("[Shopee List] Rota /vendas/list alcançada.");
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ message: 'UID do usuário é obrigatório.' });
    try {
        const shopeeAccounts = await db.collection('users').doc(uid).collection('shopee').get();
        if (shopeeAccounts.empty) {
            console.log("[Shopee List] Nenhuma conta Shopee encontrada para o UID:", uid);
            return res.json([]);
        }
        const path = '/api/v2/order/get_order_list';
        const allOrders = new Map();
        
        for (const doc of shopeeAccounts.docs) {
            const account = doc.data();
            const shop_id_str = doc.id;
            console.log(`[Shopee List] Buscando vendas para a conta: ${account.shop_name} (${shop_id_str})`);

            let access_token;
            try {
                access_token = await getValidTokenShopee(uid, shop_id_str);
            } catch (tokenError) {
                console.error(`[Shopee List] Erro de token para loja ${shop_id_str}:`, tokenError.message);
                continue;
            }

            const shop_id = parseInt(shop_id_str, 10);
            const totalLookbackDays = 90;
            const daysPerChunk = 15;
            const now = Math.floor(Date.now() / 1000);

            for (let i = 0; i < totalLookbackDays / daysPerChunk; i++) {
                const time_to = now - (i * daysPerChunk * 24 * 60 * 60);
                const time_from = time_to - (daysPerChunk * 24 * 60 * 60);
                let cursor = "";
                let hasMore = true;

                while (hasMore) {
                    try {
                        const timestamp = Math.floor(Date.now() / 1000);
                        const sign = generateSign(path, CLIENT_ID, timestamp, access_token, shop_id_str);
                        
                        await delay(500);
                        const response = await axios.get(`${SHOPEE_BASE_URL}${path}`, {
                            params: {
                                partner_id: parseInt(CLIENT_ID),
                                shop_id,
                                timestamp,
                                access_token,
                                sign,
                                time_range_field: 'create_time',
                                time_from,
                                time_to,
                                page_size: 100,
                                cursor,
                                response_optional_fields: 'order_status'
                            }
                        });

                        if (response.data.error) {
                            if (response.data.error === 'error_auth' || response.data.error === 'invalid_access_token') {
                                access_token = await getValidTokenShopee(uid, shop_id_str, true);
                                continue;
                            }
                            throw new Error(response.data.message || 'Erro da API Shopee');
                        }

                        if (response.data.response && Array.isArray(response.data.response.order_list)) {
                            response.data.response.order_list.forEach(order => {
                                if (!allOrders.has(order.order_sn)) {
                                    allOrders.set(order.order_sn, { ...order, shop_id: shop_id_str });
                                }
                            });
                            cursor = response.data.response.next_cursor;
                            hasMore = response.data.response.more;
                        } else {
                            hasMore = false;
                        }

                    } catch (apiError) {
                        if (apiError.response?.status === 403) {
                            console.error(`[Shopee List] Erro 403 para loja ${shop_id}. Tentando renovar token...`);
                            try {
                                access_token = await getValidTokenShopee(uid, shop_id_str, true);
                                continue;
                            } catch (tokenError) {
                                console.error(`[Shopee List] Falha ao renovar token para loja ${shop_id}:`, tokenError.message);
                                hasMore = false;
                            }
                        } else {
                            console.error(`[Shopee List] Erro ao buscar vendas da loja ${shop_id}:`, apiError.message);
                            hasMore = false;
                        }
                    }
                }
            }
        }
        
        const allOrdersArray = Array.from(allOrders.values());
        const firestoreVendasSnap = await db.collection('users').doc(uid).collection('shopeeVendas').get();
        const firestoreVendasMap = new Map();
        firestoreVendasSnap.forEach(doc => {
            firestoreVendasMap.set(doc.id, doc.data());
        });

        const finalOrders = allOrdersArray.map(order => {
            const cachedVenda = firestoreVendasMap.get(order.order_sn);
            if (cachedVenda) {
                return { ...order, ...cachedVenda };
            }
            return order;
        });

        console.log(`[Shopee List] Busca finalizada. Retornando ${finalOrders.length} vendas (enriquecidas com cache).`);
        res.json(finalOrders);

    } catch (error) {
        console.error('Erro geral ao carregar lista de vendas da Shopee:', error.message);
        res.status(500).json({ message: 'Erro ao carregar lista de vendas da Shopee.' });
    }
});

router.get('/vendas/detail/:orderSn', async (req, res) => {
    const { uid, shopId } = req.query;
    const { orderSn } = req.params;
    if (!uid || !shopId || !orderSn) return res.status(400).json({ message: 'UID, shopId e orderSn são obrigatórios.' });

    try {
        const access_token = await getValidTokenShopee(uid, shopId);

        const path = '/api/v2/order/get_order_detail';
        const timestamp = Math.floor(Date.now() / 1000);
        const params = {
            partner_id: parseInt(CLIENT_ID),
            shop_id: parseInt(shopId, 10),
            timestamp,
            access_token,
            sign: generateSign(path, CLIENT_ID, timestamp, access_token, shopId),
            order_sn_list: orderSn,
            response_optional_fields: 'buyer_user_id,buyer_username,recipient_address,item_list,buyer_cpf_id,package_list,payment_method,shipping_carrier'
        };

        const { data } = await axios.get(`${SHOPEE_BASE_URL}${path}`, { params });
        if (data.error || !data.response?.order_list?.length) {
            throw new Error(data.message || 'Pedido não encontrado na API Shopee');
        }
        const order = data.response.order_list[0];

        let escrow_detail = null;
        try {
            const escrowPath = '/api/v2/payment/get_escrow_detail';
            const escrowTimestamp = Math.floor(Date.now() / 1000);
            const escrowSign = generateSign(escrowPath, CLIENT_ID, escrowTimestamp, access_token, shopId);
            const escrowParams = {
                partner_id: parseInt(CLIENT_ID),
                shop_id: parseInt(shopId, 10),
                timestamp: escrowTimestamp,
                access_token,
                sign: escrowSign,
                order_sn: orderSn
            };
            const escrowResponse = await axios.get(`${SHOPEE_BASE_URL}${escrowPath}`, { params: escrowParams });
            
            if (!escrowResponse.data.error && escrowResponse.data.response) {
                escrow_detail = escrowResponse.data.response;
            }
        } catch (escrowError) {
            console.error(`[Shopee Detail] Erro ao buscar detalhes de escrow para o pedido ${orderSn}:`, escrowError.message);
        }

        const clienteFinal = order.recipient_address?.name || order.buyer_username || 'Desconhecido';
        const productSubtotal = order.item_list.reduce((sum, it) => sum + (parseFloat(it.model_discounted_price || 0) * parseInt(it.model_quantity_purchased || 0, 10)), 0);
        
        const venda = {
            ...order,
            escrow_detail,
            cliente: clienteFinal,
            shop_id: shopId
        };
        
        await db.collection('users').doc(uid).collection('shopeeVendas').doc(orderSn).set(venda, { merge: true });
        res.json(venda);

    } catch (err) {
        console.error(`[Shopee Detail] Erro geral ao processar o pedido ${orderSn}:`, err.message);
        if (err.response) console.error('Resposta da API:', err.response.data);
        res.status(500).json({ message: err.message });
    }
});


router.get('/vendas', async (req, res) => {
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
    try {
        const vendasRef = db.collection('users').doc(uid).collection('shopeeVendas');
        const snapshot = await vendasRef.orderBy('create_time', 'desc').get();
        const todasAsVendas = snapshot.docs.map(doc => doc.data());
        res.json(todasAsVendas);
    } catch (error) {
        console.error('[Shopee Cache Read] Erro ao buscar vendas do Firestore:', error.message);
        res.status(500).json({ error: 'Erro ao buscar vendas do cache', detalhe: error.message });
    }
});


module.exports = router;