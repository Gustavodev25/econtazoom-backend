const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const { db } = require('../firebase');

const CLIENT_ID = process.env.SHOPEE_CLIENT_ID || '2011938';
const CLIENT_SECRET = process.env.SHOPEE_CLIENT_SECRET || 'shpk527477684f57526b554d567743746d766e51795778465974447565734c52';
const SHOPEE_BASE_URL = 'https://openplatform.shopee.com.br';

const NGROK = { url: null }; // Adicionado para armazenar a URL do ngrok

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

function getRedirectUri() {
    if (process.env.NODE_ENV === 'production' || !NGROK.url) {
        return 'https://econtazoom-backend.onrender.com/shopee/callback';
    }
    return `${NGROK.url}/shopee/callback`;
}

router.get('/auth', (req, res) => {
    const { uid } = req.query;
    if (!uid) return res.status(400).send('UID do usuário é obrigatório.');
    const redirectUri = getRedirectUri();
    if (!redirectUri) return res.status(500).send('Erro no servidor: URL de redirecionamento não criada.');
    const finalRedirectUri = `${redirectUri}?uid=${uid}`;
    const timestamp = Math.floor(Date.now() / 1000);
    const path = '/api/v2/shop/auth_partner';
    const sign = generateSign(path, CLIENT_ID, timestamp);
    const authUrl = new URL(`${SHOPEE_BASE_URL}${path}`);
    authUrl.searchParams.append('partner_id', CLIENT_ID);
    authUrl.searchParams.append('timestamp', timestamp);
    authUrl.searchParams.append('sign', sign);
    authUrl.searchParams.append('redirect', finalRedirectUri);
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
            code: code, shop_id: parseInt(shop_id, 10), partner_id: parseInt(CLIENT_ID, 10)
        }, {
            headers: { 'Content-Type': 'application/json' },
            params: { partner_id: parseInt(CLIENT_ID, 10), timestamp: timestamp, sign: sign }
        });
        if (tokenResponse.data.error) throw new Error(`Erro ao buscar token: ${tokenResponse.data.message}`);

        const { access_token, refresh_token, expire_in } = tokenResponse.data;

        const pathShop = '/api/v2/shop/get_shop_info';
        const timestampShop = Math.floor(Date.now() / 1000);
        const signShop = generateSign(pathShop, CLIENT_ID, timestampShop, access_token, shop_id);
        const shopInfoResponse = await axios.get(`${SHOPEE_BASE_URL}${pathShop}`, {
            params: { partner_id: parseInt(CLIENT_ID, 10), timestamp: timestampShop, access_token, shop_id: parseInt(shop_id, 10), sign: signShop }
        });

        if (shopInfoResponse.data.error) throw new Error('Falha ao obter os detalhes da loja.');
        const { shop_name, region } = shopInfoResponse.data;

        await db.collection('users').doc(uid).collection('shopee').doc(shop_id).set({
            access_token, refresh_token, expire_in, shop_id, status: 'ativo',
            shop_name, region,
            connectedAt: new Date().toISOString(),
        });
        res.send('<script>window.close();</script><h1>Autenticação concluída!</h1>');
    } catch (error) {
        console.error(`[Shopee Callback] Erro: ${error.message}`);
        res.status(500).send(`Erro durante a autenticação: ${error.message}`);
    }
});

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

        // 1. Obter detalhes do pedido
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

        // 2. Obter detalhes financeiros (escrow)
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
                order_sn: orderSn // A API de escrow usa 'order_sn' e não 'order_sn_list'
            };
            const escrowResponse = await axios.get(`${SHOPEE_BASE_URL}${escrowPath}`, { params: escrowParams });
            
            // CORREÇÃO: A resposta não é uma lista, é um objeto direto.
            if (!escrowResponse.data.error && escrowResponse.data.response) {
                escrow_detail = escrowResponse.data.response;
                console.log(`[Shopee Detail] Detalhes financeiros (escrow) obtidos para o pedido ${orderSn}.`);
            } else {
                console.warn(`[Shopee Detail] Não foi possível obter detalhes financeiros para o pedido ${orderSn}. Motivo: ${escrowResponse.data.message || 'Resposta vazia'}`);
            }
        } catch (escrowError) {
            console.error(`[Shopee Detail] Erro ao buscar detalhes de escrow para o pedido ${orderSn}:`, escrowError.message);
        }

        // 3. Consolidar e salvar os dados
        const clienteFinal = order.recipient_address?.name || order.buyer_username || 'Desconhecido';
        const productSubtotal = order.item_list.reduce((sum, it) => sum + (parseFloat(it.model_discounted_price || 0) * parseInt(it.model_quantity_purchased || 0, 10)), 0);
        
        let totalFees = 0;
        let netIncome = 0;

        if (escrow_detail && escrow_detail.order_income) {
            const income = escrow_detail.order_income;
            // Soma todas as taxas relevantes que são custos para o vendedor
            totalFees = (income.commission_fee || 0) + 
                        (income.service_fee || 0) + 
                        (income.seller_transaction_fee || 0) +
                        (income.campaign_fee || 0) +
                        (income.escrow_tax || 0);
            netIncome = parseFloat(income.escrow_amount || 0);
        } else {
            // Fallback para cálculo antigo se o escrow falhar
            const commissionFee = productSubtotal * 0.185;
            const transactionFee = 3.51;
            const serviceFee = 4.00;
            totalFees = commissionFee + transactionFee + serviceFee;
            netIncome = productSubtotal - totalFees;
        }

        const venda = {
            ...order,
            escrow_detail, // Salva o objeto de escrow completo
            cliente: clienteFinal,
            nomeProdutoVendido: order.item_list[0]?.item_name || '-',
            productSubtotal,
            txPlataforma: totalFees,
            netIncome,
            valorTotalVenda: productSubtotal,
            dataHora: new Date((order.create_time || 0) * 1000).toISOString(),
            tracking_number: order.package_list?.[0]?.tracking_number || 'N/A',
            canalVenda: 'Shopee',
            idVendaMarketplace: order.order_sn,
            status: order.order_status || 'UNKNOWN',
            shop_id: shopId
        };
        
        await db.collection('users').doc(uid).collection('shopeeVendas').doc(orderSn).set(venda, { merge: true });
        console.log(`[Shopee Detail] Venda ${orderSn} salva no Firestore com detalhes de escrow.`);
        
        await validarECorrigirVenda(uid, venda);
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

        const vendasCorrigidasPromises = snapshot.docs.map(async (doc) => {
            const venda = { id: doc.id, ...doc.data() };
            const correcoes = await validarECorrigirVenda(uid, venda);
            return { ...venda, ...correcoes };
        });

        const todasAsVendasCorrigidas = await Promise.all(vendasCorrigidasPromises);

        console.log(`[Shopee Cache Read] Retornando ${todasAsVendasCorrigidas.length} vendas (após validação) para o UID ${uid}.`);
        res.json(todasAsVendasCorrigidas);
    } catch (error) {
        console.error('[Shopee Cache Read] Erro ao buscar vendas do Firestore:', error.message);
        res.status(500).json({ error: 'Erro ao buscar vendas do cache', detalhe: error.message });
    }
});

async function validarECorrigirVenda(uid, venda) {
    const vendasRef = db.collection('users').doc(uid).collection('shopeeVendas');
    const camposCorrigidos = {};

    if (venda.escrow_detail && venda.escrow_detail.order_income) {
        const income = venda.escrow_detail.order_income;
        const totalFeesFromEscrow = (income.commission_fee || 0) + 
                                   (income.service_fee || 0) + 
                                   (income.seller_transaction_fee || 0) +
                                   (income.campaign_fee || 0) +
                                   (income.escrow_tax || 0);

        const netIncomeFromEscrow = parseFloat(income.escrow_amount || 0);

        if (venda.txPlataforma !== totalFeesFromEscrow) {
            camposCorrigidos.txPlataforma = totalFeesFromEscrow;
        }
        if (venda.netIncome !== netIncomeFromEscrow) {
            camposCorrigidos.netIncome = netIncomeFromEscrow;
        }
    }

    const possibleNames = [
        venda.recipient_address?.name,
        venda.buyer_username
    ].filter(name => name && !name.includes('*') && name.trim() !== '');

    let nomeCorrigido = possibleNames.length > 0 ? possibleNames[0] : 'Desconhecido';
    
    if (nomeCorrigido !== venda.cliente) {
        camposCorrigidos.cliente = nomeCorrigido;
    }

    if (Object.keys(camposCorrigidos).length > 0) {
        await vendasRef.doc(venda.idVendaMarketplace).set(camposCorrigidos, { merge: true });
        console.log(`[Shopee Correção] Venda ${venda.idVendaMarketplace} corrigida com os campos:`, camposCorrigidos);
    }
    
    return camposCorrigidos;
}

// Adicionar rota para atualizar a URL do ngrok dinamicamente
router.post('/ngrok-url', (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL do ngrok é obrigatória.' });
    NGROK.url = url;
    console.log(`[Shopee] URL do ngrok atualizada para: ${url}`);
    res.json({ success: true, url });
});

module.exports = router;
module.exports.NGROK = NGROK;