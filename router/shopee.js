const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const { db } = require('../firebase');
const { NGROK } = require('./sharedState');

const CLIENT_ID = process.env.SHOPEE_CLIENT_ID || '2011925';
const CLIENT_SECRET = process.env.SHOPEE_CLIENT_SECRET || 'shpk6b594c726471596464645a4a436b437867576462567a5758687647617448';
const SHOPEE_BASE_URL = 'https://openplatform.shopee.com.br';
const AXIOS_TIMEOUT = 30000;

// Helper function to generate the HMAC-SHA256 signature for API calls
function generateSign(path, partner_id, timestamp, access_token = '', shop_id = '') {
    const baseString = `${partner_id}${path}${timestamp}${access_token}${shop_id}`;
    return crypto.createHmac('sha256', CLIENT_SECRET).update(baseString).digest('hex');
}

// Helper function to introduce a delay
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Helper function to split an array into smaller chunks
function chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

// Helper function to remove null or undefined properties from an object
function cleanObject(obj) {
    const newObj = {};
    for (const key in obj) {
        if (obj[key] !== undefined && obj[key] !== null) {
            newObj[key] = obj[key];
        }
    }
    return newObj;
}


// Refreshes the Shopee access token if it's expired or close to expiring
async function refreshTokenShopee(uid, shopId, accountData, forceRefresh = false) {
    try {
        if (!forceRefresh) {
            const lastRefresh = new Date(accountData.lastTokenRefresh || accountData.connectedAt).getTime();
            const expireMs = (accountData.expire_in - 300) * 1000; // Refresh 5 minutes before expiry
            if (Date.now() < lastRefresh + expireMs) {
                return accountData.access_token;
            }
        }
        const path = '/api/v2/auth/access_token/get';
        const timestamp = Math.floor(Date.now() / 1000);
        const sign = generateSign(path, CLIENT_ID, timestamp);
        const response = await axios.post(`${SHOPEE_BASE_URL}${path}`, {
            refresh_token: accountData.refresh_token,
            partner_id: parseInt(CLIENT_ID, 10),
            shop_id: parseInt(shopId, 10)
        }, {
            headers: { 'Content-Type': 'application/json' },
            params: { partner_id: parseInt(CLIENT_ID, 10), timestamp, sign },
            timeout: AXIOS_TIMEOUT
        });
        if (response.data.error) throw new Error(`Erro ao renovar token: ${response.data.message}`);
        const { access_token, refresh_token, expire_in } = response.data;
        await db.collection('users').doc(uid).collection('shopee').doc(shopId).set({
            ...accountData, access_token, refresh_token, expire_in,
            lastTokenRefresh: new Date().toISOString(), status: 'ativo',
            lastError: null, lastErrorTimestamp: null
        }, { merge: true });
        return access_token;
    } catch (error) {
        await db.collection('users').doc(uid).collection('shopee').doc(shopId).update({
            status: 'reauth_required',
            lastError: `Erro de comunicação ao renovar: ${error.message}`,
            lastErrorTimestamp: new Date().toISOString()
        });
        throw error;
    }
}

// Gets a valid access token, refreshing it if necessary
async function getValidTokenShopee(uid, shopId, forceRefresh = false) {
    const snap = await db.collection('users').doc(uid).collection('shopee').doc(shopId).get();
    if (!snap.exists) throw new Error(`Conta Shopee ${shopId} não encontrada.`);
    const data = snap.data();
    if (data.status === 'reauth_required') throw new Error(`Conta ${shopId} (${data.shop_name}) precisa ser reautenticada.`);
    return await refreshTokenShopee(uid, shopId, data, forceRefresh);
}

// Route to initiate Shopee authentication
router.get('/auth', (req, res) => {
    const { uid } = req.query;
    if (!uid) return res.status(400).send('UID do usuário é obrigatório.');
    const backendUrl = NGROK.url || 'https://econtazoom-backend.onrender.com';
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

// Callback route after Shopee authentication
router.get('/callback', async (req, res) => {
    const { code, shop_id, uid } = req.query;
    if (!code || !shop_id || !uid) return res.status(400).send('Parâmetros de callback ausentes.');
    try {
        const timestamp = Math.floor(Date.now() / 1000);
        const path = '/api/v2/auth/token/get';
        const sign = generateSign(path, CLIENT_ID, timestamp);
        const tokenResponse = await axios.post(`${SHOPEE_BASE_URL}${path}`, { code, shop_id: parseInt(shop_id, 10), partner_id: parseInt(CLIENT_ID, 10) }, { headers: { 'Content-Type': 'application/json' }, params: { partner_id: parseInt(CLIENT_ID, 10), timestamp, sign }, timeout: AXIOS_TIMEOUT });
        if (tokenResponse.data.error) throw new Error(`Erro ao buscar token: ${tokenResponse.data.message}`);
        const { access_token, refresh_token, expire_in } = tokenResponse.data;
        const pathShop = '/api/v2/shop/get_shop_info';
        const timestampShop = Math.floor(Date.now() / 1000);
        const signShop = generateSign(pathShop, CLIENT_ID, timestampShop, access_token, shop_id);
        const shopInfoResponse = await axios.get(`${SHOPEE_BASE_URL}${pathShop}`, { params: { partner_id: parseInt(CLIENT_ID, 10), timestamp: timestampShop, access_token, shop_id: parseInt(shop_id, 10), sign: signShop }, timeout: AXIOS_TIMEOUT });
        if (shopInfoResponse.data.error) throw new Error('Falha ao obter os detalhes da loja.');
        const { shop_name, region } = shopInfoResponse.data;
        await db.collection('users').doc(uid).collection('shopee').doc(shop_id).set({ access_token, refresh_token, expire_in, shop_id, status: 'ativo', shop_name, region, connectedAt: new Date().toISOString(), lastSyncTimestamp: null, lastError: null }, { merge: true });
        res.send('<script>window.close();</script><h1>Autenticação concluída! Pode fechar esta janela.</h1>');
    } catch (error) { res.status(500).send(`Erro durante a autenticação: ${error.message}`); }
});

// Route to get all linked Shopee accounts for a user (fast, reads from DB only)
router.get('/contas', async (req, res) => {
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
    try {
        const contasSnap = await db.collection('users').doc(uid).collection('shopee').get();
        const contas = contasSnap.docs
            .filter(doc => /^\d+$/.test(doc.id)) // Garante que o ID do documento é uma string de números.
            .map(doc => { 
                const data = doc.data(); 
                return { id: doc.id, nome: data.shop_name || `Loja ${doc.id}`, status: data.status || 'desconhecido' }; 
            });
        res.json(contas);
    } catch (error) { res.status(500).json({ error: 'Erro ao buscar contas Shopee', detalhe: error.message }); }
});

// Route to check the status of a SINGLE account
router.post('/check-status', async (req, res) => {
    const { uid, shopId } = req.body;
    if (!uid || !shopId) {
        return res.status(400).json({ error: 'UID e Shop ID são obrigatórios.' });
    }

    try {
        const doc = await db.collection('users').doc(uid).collection('shopee').doc(shopId).get();
        if (!doc.exists) {
            return res.status(404).json({ status: 'error', error: 'Conta não encontrada.' });
        }

        const conta = { id: doc.id, ...doc.data() };
        const shopName = conta.shop_name || `Loja ${shopId}`;

        if (!conta.status) {
             return res.json({ id: shopId, nome: shopName, status: 'error', error: 'Status da conta inválido.' });
        }

        if (conta.status !== 'ativo') {
            return res.json({
                id: shopId,
                nome: shopName,
                status: conta.status,
                newOrdersCount: 0,
                error: conta.lastError || `Conta com status '${conta.status}'`
            });
        }

        // *** LÓGICA DE STATUS CORRIGIDA ***
        const isFirstSync = !conta.lastSyncTimestamp;

        if (isFirstSync) {
            // Para uma conta nunca sincronizada, o status é sempre 'unsynced'.
            // Isso evita a chamada desnecessária à API e mostra o botão correto no frontend.
            return res.json({ id: shopId, nome: shopName, status: 'unsynced', newOrdersCount: 0 });
        } else {
            // Para contas já sincronizadas, faz uma verificação rápida por novas vendas.
            const newOrders = await getAllOrderSnForShop(uid, shopId, conta.lastSyncTimestamp, Math.floor(Date.now() / 1000), true);

            if (newOrders.length > 0) {
                // Se encontrar novas vendas, o status é 'needs_update'.
                res.json({ id: shopId, nome: shopName, status: 'needs_update', newOrdersCount: newOrders.length });
            } else {
                // Se não, a conta está 'synced'.
                res.json({ id: shopId, nome: shopName, status: 'synced', newOrdersCount: 0 });
            }
        }

    } catch (error) {
        res.status(500).json({
            id: shopId,
            nome: `Loja ${shopId}`,
            status: 'error',
            newOrdersCount: 0,
            error: `Falha na verificação: ${error.message}`
        });
    }
});


// Route to fetch sales with pagination and filtering
router.get('/vendas', async (req, res) => {
  const { uid, lastDocId, pageSize = 20, sortBy = 'create_time', sortOrder = 'desc', status, nomeConta } = req.query;
  if (!uid) return res.status(400).json({ error: 'UID do usuário é obrigatório.' });
  const pageSizeNum = parseInt(pageSize, 10);
  try {
    let queryRef = db.collection('users').doc(uid).collection('shopeeVendas');
    const statusFiltro = status && status !== 'todos' ? status.toUpperCase() : null;
    if (statusFiltro) queryRef = queryRef.where('status', '==', statusFiltro);
    if (nomeConta && nomeConta !== 'todos') queryRef = queryRef.where('nomeConta', '==', nomeConta);
    queryRef = queryRef.orderBy(sortBy, sortOrder);
    if (lastDocId) {
      const lastDocSnapshot = await db.collection('users').doc(uid).collection('shopeeVendas').doc(lastDocId).get();
      if (!lastDocSnapshot.exists) return res.status(404).json({ error: 'O documento de referência (lastDocId) não foi encontrado.' });
      queryRef = queryRef.startAfter(lastDocSnapshot);
    }
    const snapshot = await queryRef.limit(pageSizeNum).get();
    const vendas = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const newLastDocId = snapshot.docs.length > 0 ? snapshot.docs[snapshot.docs.length - 1].id : null;
    const hasMore = snapshot.docs.length === pageSizeNum;
    res.json({ vendas: vendas, pagination: { pageSize: pageSizeNum, lastDocId: newLastDocId, hasMore: hasMore } });
  } catch (error) { res.status(500).json({ error: `Erro no servidor: A consulta ao banco de dados falhou. Detalhes: ${error.message}` }); }
});

// Route to trigger a sync for a single shop in the background
router.post('/sync-single-shop', (req, res) => {
    const { uid, shopId } = req.body;
    if (!uid || !shopId) return res.status(400).json({ message: 'UID e shopId são obrigatórios.' });
    res.status(202).json({ message: `Sincronização para a loja ${shopId} iniciada em background.` });
    runFullShopeeSync(uid, shopId).catch(error => {
        console.error(`[Shopee Sync BG] Erro não capturado no runFullShopeeSync para ${shopId}:`, error);
        updateSyncStatus(uid, `Erro fatal na loja ${shopId}: ${error.message}`, 100, true, shopId);
    });
});

// Updates the global sync status in Firestore for frontend feedback
const updateSyncStatus = async (uid, message, progress = null, isError = false, shopName = '', salesProcessed = null) => {
    const statusRef = db.collection('users').doc(uid).collection('shopee').doc('sync_status');
    const statusUpdate = { message, lastUpdate: new Date().toISOString(), isError, shopName };
    if (progress !== null) statusUpdate.progress = progress;
    if (salesProcessed !== null && !isNaN(salesProcessed)) {
        statusUpdate.salesProcessed = salesProcessed;
    }
    await statusRef.set(statusUpdate, { merge: true });
};

// Main synchronization logic
async function runFullShopeeSync(uid, singleShopId = null) {
    let contas = [];
    if (singleShopId) {
        const docSnap = await db.collection('users').doc(uid).collection('shopee').doc(singleShopId).get();
        if (docSnap.exists && docSnap.data().status === 'ativo') {
            contas.push({ id: docSnap.id, ...docSnap.data() });
        }
    } else {
        const querySnap = await db.collection('users').doc(uid).collection('shopee').where('status', '==', 'ativo').get();
        contas = querySnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    }

    if (contas.length === 0) {
        const message = singleShopId ? `Loja ${singleShopId} não encontrada ou inativa.` : 'Nenhuma conta Shopee ativa encontrada.';
        await updateSyncStatus(uid, message, 100, false, singleShopId || 'Sistema');
        return;
    }

    for (const conta of contas) {
        const shopId = conta.id;
        const shopName = conta.shop_name || `Loja ${shopId}`;
        const shopRef = db.collection('users').doc(uid).collection('shopee').doc(shopId);
        
        let lastSyncTimestamp = conta.lastSyncTimestamp || null;
        let isInitialSync = !lastSyncTimestamp;

        if (!isInitialSync) { 
            const vendasQuery = await db.collection('users').doc(uid).collection('shopeeVendas').where('shop_id', '==', shopId).limit(1).get();
            if (vendasQuery.empty) {
                console.log(`[Shopee Sync] Conta ${shopName} (${shopId}) está presa. Forçando re-sincronização completa.`);
                isInitialSync = true;
                lastSyncTimestamp = null;
            }
        }

        try {
            const syncExecutionTime = Math.floor(Date.now() / 1000);
            await updateSyncStatus(uid, `Iniciando...`, 0, false, shopName);
            
            // Para a sincronização real, sempre faz a busca completa (quickCheck = false).
            const orderSnList = await getAllOrderSnForShop(uid, shopId, lastSyncTimestamp, syncExecutionTime, false);
            
            if (orderSnList.length === 0) {
                 const message = isInitialSync
                    ? 'Nenhuma venda encontrada nos últimos 90 dias.'
                    : 'Nenhuma venda nova ou atualização encontrada.';
                
                 if (!isInitialSync) {
                    await shopRef.update({ lastSyncTimestamp: syncExecutionTime });
                 }

                 await updateSyncStatus(uid, message, 100, false, shopName, 0);
                 await delay(1500);
                 continue;
            }

            await updateSyncStatus(uid, `Buscando ${orderSnList.length} vendas...`, 20, false, shopName);
            const allVendasComDetalhes = await getOrderDetailsInParallel(uid, shopId, orderSnList, (progress) => {
                updateSyncStatus(uid, `Processando detalhes...`, 20 + Math.floor(progress * 70), false, shopName);
            });
            
            const salesAddedCount = allVendasComDetalhes.length;
            await updateSyncStatus(uid, `Salvando ${salesAddedCount} vendas...`, 95, false, shopName);
            
            if (salesAddedCount > 0) {
                const firestoreBatchChunks = chunkArray(allVendasComDetalhes, 400);
                for (const batchChunk of firestoreBatchChunks) {
                    const batch = db.batch();
                    for (const venda of batchChunk) {
                        if (venda && venda.order_sn) {
                            const vendaDocRef = db.collection('users').doc(uid).collection('shopeeVendas').doc(venda.order_sn);
                            const finalVendaData = cleanObject({ ...venda, nomeConta: shopName });
                            batch.set(vendaDocRef, finalVendaData, { merge: true });
                        }
                    }
                    await batch.commit();
                }
            }

            await shopRef.update({ lastSyncTimestamp: syncExecutionTime });

            await updateSyncStatus(uid, `Sincronização concluída!`, 100, false, shopName, salesAddedCount);
            await delay(1500);
        } catch (error) {
            console.error(`[Shopee Sync BG] Erro ao sincronizar ${shopName}:`, error);
            await updateSyncStatus(uid, `Erro: ${error.message}`, 100, true, shopName);
            await delay(1500);
            continue;
        }
    }
    await updateSyncStatus(uid, `Processo finalizado.`, 100, false, 'Sistema');
}

// Fetches all order serial numbers for a given shop and time range
async function getAllOrderSnForShop(uid, shopId, lastSyncTimestamp, syncExecutionTime, quickCheck = false) {
    const allOrderSn = new Set();
    const path = '/api/v2/order/get_order_list';
    const isInitialSync = !lastSyncTimestamp;
    
    if (isInitialSync) {
        const time_range_field = 'create_time';
        // Para a sincronização inicial completa, busca os últimos 90 dias.
        const totalLookbackDays = 90;
        for (let i = 0; i < totalLookbackDays / 15; i++) {
            const time_to = syncExecutionTime - (i * 15 * 24 * 60 * 60);
            const time_from = time_to - (15 * 24 * 60 * 60);
            if (time_from < 0) break;
            await fetchOrderListChunk(uid, shopId, path, time_from, time_to, time_range_field, allOrderSn, false);
             // Se for uma verificação rápida, para após a primeira busca.
            if (quickCheck) break;
        }
    } else {
        const time_range_field = 'update_time';
        const time_from = lastSyncTimestamp - (60 * 10); // 10-minute overlap
        await fetchOrderListChunk(uid, shopId, path, time_from, syncExecutionTime, time_range_field, allOrderSn, quickCheck);
    }
    
    return Array.from(allOrderSn);
}

// Fetches a single page (chunk) of orders from the Shopee API
async function fetchOrderListChunk(uid, shopId, path, time_from, time_to, time_range_field, allOrderSn, quickCheck = false) {
    let token = await getValidTokenShopee(uid, shopId);
    let cursor = "";

    do {
        const timestamp = Math.floor(Date.now() / 1000);
        const sign = generateSign(path, CLIENT_ID, timestamp, token, shopId);
        const params = {
            partner_id: parseInt(CLIENT_ID),
            shop_id: parseInt(shopId),
            timestamp,
            access_token: token,
            sign,
            time_range_field,
            time_from: Math.floor(time_from),
            time_to: Math.floor(time_to),
            page_size: quickCheck ? 5 : 100, // Pede poucos itens na verificação rápida
            cursor
        };
        
        const response = await axios.get(`${SHOPEE_BASE_URL}${path}`, { params, timeout: AXIOS_TIMEOUT });

        if (response.data.error) {
            throw new Error(`Erro da API Shopee ao buscar lista de pedidos: ${response.data.message} (código: ${response.data.error})`);
        }
        
        const orderList = response.data.response?.order_list || [];
        orderList.forEach(order => allOrderSn.add(order.order_sn));
        
        cursor = response.data.response?.next_cursor || "";

        // Se for uma verificação rápida, para após a primeira página para ser mais rápido.
        if (quickCheck) {
            cursor = "";
        }

        if (cursor) {
           await delay(333);
        }
    } while (cursor);
}


// Fetches detailed information for a chunk of orders
async function getDetailsForChunk(uid, shopId, token, orderSnChunk) {
    try {
        const pathDetail = '/api/v2/order/get_order_detail';
        const timestamp = Math.floor(Date.now() / 1000);
        const sign = generateSign(pathDetail, CLIENT_ID, timestamp, token, shopId);
        const params = {
            partner_id: parseInt(CLIENT_ID),
            shop_id: parseInt(shopId),
            timestamp,
            access_token: token,
            sign,
            order_sn_list: orderSnChunk.join(','),
            response_optional_fields: 'buyer_user_id,buyer_username,recipient_address,item_list,payment_method,shipping_carrier,package_list,order_status'
        };

        const response = await axios.get(`${SHOPEE_BASE_URL}${pathDetail}`, { params, timeout: AXIOS_TIMEOUT });
        
        if (!response.data.response || !response.data.response.order_list) {
            if(response.data.error) {
                console.warn(`[Shopee Detail] API retornou erro para o chunk de pedidos: ${response.data.message}`);
            }
            return [];
        }

        const ordersFromApi = response.data.response.order_list;
        const promises = ordersFromApi.map(async (order) => {
            try {
                const escrowPath = '/api/v2/payment/get_escrow_detail';
                const escrowTimestamp = Math.floor(Date.now() / 1000);
                const escrowSign = generateSign(escrowPath, CLIENT_ID, escrowTimestamp, token, shopId);
                const escrowResponse = await axios.get(`${SHOPEE_BASE_URL}${escrowPath}`, { params: { partner_id: parseInt(CLIENT_ID), shop_id: parseInt(shopId), order_sn: order.order_sn, sign: escrowSign, timestamp: escrowTimestamp, access_token: token }, timeout: AXIOS_TIMEOUT });
                
                const escrow_detail = (!escrowResponse.data.error && escrowResponse.data.response) ? escrowResponse.data.response : null;
                const incomeDetails = escrow_detail?.order_income || {};
                
                const txPlataforma = Math.abs(incomeDetails.commission_fee || 0) + Math.abs(incomeDetails.service_fee || 0);
                const custoFrete = Math.abs(escrow_detail?.shipping_fee_info?.shipping_fee_seller_spend || incomeDetails.original_shipping_fee || 0);
                const valorTotalVenda = (order.item_list || []).reduce((sum, it) => (sum + (parseFloat(it.model_discounted_price || it.model_original_price || 0) * parseInt(it.model_quantity_purchased || 0, 10))), 0);
                
                return {
                    order_sn: order.order_sn,
                    order_status: order.order_status || 'UNKNOWN',
                    create_time: order.create_time || 0,
                    update_time: order.update_time || 0,
                    item_list: order.item_list || [],
                    package_list: order.package_list || [],
                    payment_method: order.payment_method || 'UNKNOWN',
                    shipping_carrier: order.shipping_carrier || 'UNKNOWN',
                    recipient_address: order.recipient_address || {},
                    buyer_username: order.buyer_username || null,
                    escrow_detail: escrow_detail,
                    status: (order.order_status || 'UNKNOWN').toUpperCase(),
                    idVendaMarketplace: order.order_sn,
                    canalVenda: 'Shopee',
                    shop_id: shopId,
                    dataHora: new Date((order.create_time || 0) * 1000).toISOString(),
                    cliente: order.recipient_address?.name || order.buyer_username || 'Desconhecido',
                    nomeProdutoVendido: order.item_list?.[0]?.item_name || '-',
                    valorTotalVenda: valorTotalVenda,
                    tracking_number: order.package_list?.[0]?.tracking_number || 'N/A',
                    txPlataforma: txPlataforma,
                    custoFrete: custoFrete,
                    tipoAnuncio: 'Padrão',
                    tipoEntrega: order.shipping_carrier || 'Não informado',
                };
            } catch (escrowError) {
                console.warn(`[Shopee Escrow] Não foi possível buscar detalhes de pagamento para a venda ${order.order_sn}. Erro: ${escrowError.message}`);
                const valorTotalVenda = (order.item_list || []).reduce((sum, it) => (sum + (parseFloat(it.model_discounted_price || it.model_original_price || 0) * parseInt(it.model_quantity_purchased || 0, 10))), 0);
                return {
                    ...order,
                    escrow_detail: null,
                    txPlataforma: 0,
                    custoFrete: 0,
                    valorTotalVenda: valorTotalVenda,
                    canalVenda: 'Shopee',
                    shop_id: shopId,
                    dataHora: new Date((order.create_time || 0) * 1000).toISOString(),
                 };
            }
        });
        return await Promise.all(promises);
    } catch (error) {
        console.error(`[Shopee Detail] Erro crítico ao buscar detalhes do chunk:`, error);
        return [];
    }
}

// Fetches order details in parallel batches for efficiency
async function getOrderDetailsInParallel(uid, shopId, orderSnList, onProgress) {
    const token = await getValidTokenShopee(uid, shopId);
    const detailChunks = chunkArray(orderSnList, 50);
    const CONCURRENCY_LEVEL = 4;
    let allVendasCompletas = [];
    for (let i = 0; i < detailChunks.length; i += CONCURRENCY_LEVEL) {
        const batchOfChunks = detailChunks.slice(i, i + CONCURRENCY_LEVEL);
        const promises = batchOfChunks.map(chunk => getDetailsForChunk(uid, shopId, token, chunk));
        const resultsFromBatch = await Promise.all(promises);
        resultsFromBatch.flat().filter(Boolean).forEach(venda => allVendasCompletas.push(venda));
        if (onProgress) onProgress(allVendasCompletas.length / orderSnList.length);
        await delay(333);
    }
    return allVendasCompletas;
}

module.exports = router;