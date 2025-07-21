const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const { db } = require('../firebase');

const CLIENT_ID = process.env.SHOPEE_CLIENT_ID || '2011925';
const CLIENT_SECRET = process.env.SHOPEE_CLIENT_SECRET || 'shpk6b594c726471596464645a4a436b437867576462567a5758687647617448';
const SHOPEE_BASE_URL = 'https://openplatform.shopee.com.br';
const AXIOS_TIMEOUT = 30000; 

function generateSign(path, partner_id, timestamp, access_token = '', shop_id = '') {
    const baseString = `${partner_id}${path}${timestamp}${access_token}${shop_id}`;
    return crypto.createHmac('sha256', CLIENT_SECRET).update(baseString).digest('hex');
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function refreshTokenShopee(uid, shopId, accountData, forceRefresh = false) {
    try {
        if (!forceRefresh) {
            const lastRefresh = new Date(accountData.lastTokenRefresh || accountData.connectedAt).getTime();
            const expireMs = (accountData.expire_in - 300) * 1000;
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
                params: { partner_id: parseInt(CLIENT_ID, 10), timestamp, sign },
                timeout: AXIOS_TIMEOUT
            }
        );

        if (response.data.error) {
            await db.collection('users').doc(uid).collection('shopee').doc(shopId).update({
                status: 'reauth_required',
                lastError: `Falha na renovação: ${response.data.message}`,
                lastErrorTimestamp: new Date().toISOString()
            });
            throw new Error(`Erro ao renovar token: ${response.data.message}`);
        }

        const { access_token, refresh_token, expire_in } = response.data;
        await db.collection('users').doc(uid).collection('shopee').doc(shopId).set({
            ...accountData, access_token, refresh_token, expire_in,
            lastTokenRefresh: new Date().toISOString(), status: 'ativo',
            lastError: null, lastErrorTimestamp: null
        }, { merge: true });

        console.log(`[Shopee Token] Token renovado com sucesso para loja ${shopId}`);
        return access_token;
    } catch (error) {
        console.error(`[Shopee Token] Erro crítico ao renovar token para loja ${shopId}:`, error.message);
        await db.collection('users').doc(uid).collection('shopee').doc(shopId).update({
            status: 'reauth_required',
            lastError: `Erro de comunicação ao renovar: ${error.message}`,
            lastErrorTimestamp: new Date().toISOString()
        });
        throw error;
    }
}

async function getValidTokenShopee(uid, shopId, forceRefresh = false) {
    const snap = await db.collection('users').doc(uid).collection('shopee').doc(shopId).get();
    if (!snap.exists) throw new Error(`Conta Shopee ${shopId} não encontrada.`);
    const data = snap.data();

    if (data.status === 'reauth_required') {
        throw new Error(`Conta ${shopId} (${data.shop_name}) precisa ser reautenticada.`);
    }

    try {
        return await refreshTokenShopee(uid, shopId, data, forceRefresh);
    } catch (error) {
        console.error(`[Shopee Token] Falha final ao obter token para ${shopId}:`, error.message);
        throw error;
    }
}

router.get('/auth', (req, res) => {
    const { uid } = req.query;
    if (!uid) return res.status(400).send('UID do usuário é obrigatório.');
    
    const backendUrl = 'https://econtazoom-backend.onrender.com';
    const redirectUri = `${backendUrl}/shopee/callback?uid=${uid}`;
    
    const timestamp = Math.floor(Date.now() / 1000);
    const path = '/api/v2/shop/auth_partner';
    const sign = generateSign(path, CLIENT_ID, timestamp);
    
    const authUrl = new URL(`${SHOPEE_BASE_URL}${path}`);
    authUrl.searchParams.append('partner_id', CLIENT_ID);
    authUrl.searchParams.append('timestamp', timestamp);
    authUrl.searchParams.append('sign', sign);
    authUrl.searchParams.append('redirect', redirectUri);
    
    res.redirect(authUrl.toString());
});

router.get('/callback', async (req, res) => {
    const { code, shop_id, uid } = req.query;
    if (!code || !shop_id || !uid) return res.status(400).send('Parâmetros de callback ausentes.');

    try {
        const timestamp = Math.floor(Date.now() / 1000);
        const path = '/api/v2/auth/token/get';
        const sign = generateSign(path, CLIENT_ID, timestamp);
        const tokenResponse = await axios.post(`${SHOPEE_BASE_URL}${path}`, {
            code, shop_id: parseInt(shop_id, 10), partner_id: parseInt(CLIENT_ID, 10)
        }, {
            headers: { 'Content-Type': 'application/json' },
            params: { partner_id: parseInt(CLIENT_ID, 10), timestamp, sign },
            timeout: AXIOS_TIMEOUT
        });

        if (tokenResponse.data.error) throw new Error(`Erro ao buscar token: ${tokenResponse.data.message}`);
        const { access_token, refresh_token, expire_in } = tokenResponse.data;

        const pathShop = '/api/v2/shop/get_shop_info';
        const timestampShop = Math.floor(Date.now() / 1000);
        const signShop = generateSign(pathShop, CLIENT_ID, timestampShop, access_token, shop_id);
        const shopInfoResponse = await axios.get(`${SHOPEE_BASE_URL}${pathShop}`, {
            params: { partner_id: parseInt(CLIENT_ID, 10), timestamp: timestampShop, access_token, shop_id: parseInt(shop_id, 10), sign: signShop },
            timeout: AXIOS_TIMEOUT
        });

        if (shopInfoResponse.data.error) throw new Error('Falha ao obter os detalhes da loja.');
        const { shop_name, region } = shopInfoResponse.data;

        await db.collection('users').doc(uid).collection('shopee').doc(shop_id).set({
            access_token, refresh_token, expire_in, shop_id, status: 'ativo',
            shop_name, region, connectedAt: new Date().toISOString(),
        });
        
        res.send('<script>window.close();</script><h1>Autenticação concluída! Pode fechar esta janela.</h1>');
    } catch (error) {
        console.error(`[Shopee Callback] Erro: ${error.message}`);
        res.status(500).send(`Erro durante a autenticação: ${error.message}`);
    }
});

router.get('/vendas/list_for_shop', async (req, res) => {
    const { uid, shopId } = req.query;
    if (!uid || !shopId) return res.status(400).json({ message: 'UID e shopId são obrigatórios.' });

    console.log(`[Shopee List For Shop] Buscando vendas para a loja: ${shopId}`);
    
    try {
        const access_token = await getValidTokenShopee(uid, shopId);
        const path = '/api/v2/order/get_order_list';
        const shopOrders = [];
        
        const totalLookbackDays = 90;
        const daysPerChunk = 15;
        const now = Math.floor(Date.now() / 1000);
        let token_renovado = access_token;

        for (let i = 0; i < totalLookbackDays / daysPerChunk; i++) {
            const time_to = now - (i * daysPerChunk * 24 * 60 * 60);
            const time_from = time_to - (daysPerChunk * 24 * 60 * 60);
            let cursor = "";
            let hasMore = true;
            let page_count = 0;

            while (hasMore && page_count < 50) {
                page_count++;
                try {
                    const timestamp = Math.floor(Date.now() / 1000);
                    const sign = generateSign(path, CLIENT_ID, timestamp, token_renovado, shopId);
                    
                    await delay(500);
                    const response = await axios.get(`${SHOPEE_BASE_URL}${path}`, {
                        params: {
                            partner_id: parseInt(CLIENT_ID), shop_id: parseInt(shopId), timestamp,
                            access_token: token_renovado, sign, time_range_field: 'create_time',
                            time_from, time_to, page_size: 100, cursor,
                            response_optional_fields: 'order_status'
                        },
                        timeout: AXIOS_TIMEOUT
                    });

                    if (response.data.error) {
                        if (response.data.error === 'error_auth' || response.data.error === 'invalid_access_token') {
                            console.warn(`[Shopee List For Shop] Token inválido para loja ${shopId}. Forçando renovação...`);
                            token_renovado = await getValidTokenShopee(uid, shopId, true);
                            continue;
                        }
                        throw new Error(response.data.message || 'Erro da API Shopee');
                    }

                    if (response.data.response && Array.isArray(response.data.response.order_list)) {
                        response.data.response.order_list.forEach(order => {
                            shopOrders.push({ ...order, shop_id: shopId });
                        });
                        cursor = response.data.response.next_cursor;
                        hasMore = response.data.response.more;
                    } else {
                        hasMore = false;
                    }

                } catch (apiError) {
                    console.error(`[Shopee List For Shop] Erro na paginação para a loja ${shopId}:`, apiError.message);
                    hasMore = false;
                }
            }
        }
        
        console.log(`[Shopee List For Shop] Busca finalizada para ${shopId}. Retornando ${shopOrders.length} identificadores.`);
        res.json(shopOrders);

    } catch (error) {
        console.error(`[Shopee List For Shop] Erro geral ao carregar vendas da loja ${shopId}:`, error.message);
        res.status(500).json({ message: `Erro ao carregar vendas da loja ${shopId}: ${error.message}` });
    }
});

router.get('/vendas/detail/:orderSn', async (req, res) => {
    const { uid, shopId } = req.query;
    const { orderSn } = req.params;
    if (!uid || !shopId || !orderSn) return res.status(400).json({ message: 'UID, shopId e orderSn são obrigatórios.' });

    try {
        const access_token = await getValidTokenShopee(uid, shopId);

        const contaSnap = await db.collection('users').doc(uid).collection('shopee').doc(shopId).get();
        const nomeConta = contaSnap.exists ? contaSnap.data().shop_name : `Loja ${shopId}`;

        const path = '/api/v2/order/get_order_detail';
        const timestamp = Math.floor(Date.now() / 1000);
        const params = {
            partner_id: parseInt(CLIENT_ID), shop_id: parseInt(shopId, 10), timestamp, access_token,
            sign: generateSign(path, CLIENT_ID, timestamp, access_token, shopId),
            order_sn_list: orderSn,
            response_optional_fields: 'buyer_user_id,buyer_username,recipient_address,item_list,buyer_cpf_id,package_list,payment_method,shipping_carrier'
        };

        const { data } = await axios.get(`${SHOPEE_BASE_URL}${path}`, { params, timeout: AXIOS_TIMEOUT });
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
                partner_id: parseInt(CLIENT_ID), shop_id: parseInt(shopId, 10),
                timestamp: escrowTimestamp, access_token, sign: escrowSign, order_sn: orderSn
            };
            const escrowResponse = await axios.get(`${SHOPEE_BASE_URL}${escrowPath}`, { params: escrowParams, timeout: AXIOS_TIMEOUT });
            
            if (!escrowResponse.data.error && escrowResponse.data.response) {
                escrow_detail = escrowResponse.data.response;
            } else {
                console.warn(`[Shopee Detail] Não foi possível obter detalhes financeiros para o pedido ${orderSn}. Motivo: ${escrowResponse.data.message || 'Resposta vazia'}`);
            }
        } catch (escrowError) {
            console.error(`[Shopee Detail] Erro ao buscar detalhes de escrow para o pedido ${orderSn}:`, escrowError.message);
        }

        const clienteFinal = order.recipient_address?.name || order.buyer_username || 'Desconhecido';
        const productSubtotal = order.item_list.reduce((sum, it) => sum + (parseFloat(it.model_discounted_price || 0) * parseInt(it.model_quantity_purchased || 0, 10)), 0);
        
        const venda = {
            ...order, escrow_detail, cliente: clienteFinal,
            nomeProdutoVendido: order.item_list[0]?.item_name || '-',
            valorTotalVenda: productSubtotal,
            dataHora: new Date((order.create_time || 0) * 1000).toISOString(),
            tracking_number: order.package_list?.[0]?.tracking_number || 'N/A',
            canalVenda: 'Shopee', idVendaMarketplace: order.order_sn,
            status: order.order_status || 'UNKNOWN', 
            shop_id: shopId,
            nomeConta: nomeConta 
        };
        
        await db.collection('users').doc(uid).collection('shopeeVendas').doc(orderSn).set(venda, { merge: true });
        console.log(`[Shopee Detail] Venda ${orderSn} da loja ${shopId} (${nomeConta}) salva no Firestore.`);
        
        res.json(venda);

    } catch (err) {
        console.error(`[Shopee Detail] Erro geral ao processar o pedido ${orderSn} da loja ${shopId}:`, err.message);
        res.status(500).json({ message: err.message });
    }
});

router.get('/vendas', async (req, res) => {
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
    try {
        const vendasRef = db.collection('users').doc(uid).collection('shopeeVendas');
        const snapshot = await vendasRef.orderBy('create_time', 'desc').get();
        const todasAsVendas = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.json(todasAsVendas);
    } catch (error) {
        console.error('[Shopee Cache Read] Erro ao buscar vendas do Firestore:', error.message);
        res.status(500).json({ error: 'Erro ao buscar vendas do cache', detalhe: error.message });
    }
});

router.get('/contas', async (req, res) => {
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
    try {
        const contasSnap = await db.collection('users').doc(uid).collection('shopee').get();
        const contas = contasSnap.docs.map(doc => {
            const data = doc.data();
            return {
                shop_id: doc.id,
                shop_name: data.shop_name || `Loja ${doc.id}`,
                status: data.status || 'desconhecido',
            };
        });
        res.json(contas);
    } catch (error) {
        console.error('[Shopee Contas] Erro ao buscar contas Shopee:', error.message);
        res.status(500).json({ error: 'Erro ao buscar contas Shopee', detalhe: error.message });
    }
});

module.exports = router;