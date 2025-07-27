const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const { db } = require('../firebase'); // Assumindo que seu admin do Firebase já foi inicializado

// --- Configurações da API Shopee ---
const CLIENT_ID = process.env.SHOPEE_CLIENT_ID || '2011925';
const CLIENT_SECRET = process.env.SHOPEE_CLIENT_SECRET || 'shpk6b594c726471596464645a4a436b437867576462567a5758687647617448';
const SHOPEE_BASE_URL = 'https://openplatform.shopee.com.br';
const AXIOS_TIMEOUT = 30000; // 30 segundos de timeout para requisições

// --- Funções Auxiliares ---

function generateSign(path, partner_id, timestamp, access_token = '', shop_id = '') {
    const baseString = `${partner_id}${path}${timestamp}${access_token}${shop_id}`;
    return crypto.createHmac('sha256', CLIENT_SECRET).update(baseString).digest('hex');
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}


// --- Gerenciamento de Token ---

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

        const response = await axios.post(`${SHOPEE_BASE_URL}${path}`, {
            refresh_token: accountData.refresh_token,
            partner_id: parseInt(CLIENT_ID, 10),
            shop_id: parseInt(shopId, 10)
        }, {
            headers: { 'Content-Type': 'application/json' },
            params: { partner_id: parseInt(CLIENT_ID, 10), timestamp, sign },
            timeout: AXIOS_TIMEOUT
        });

        if (response.data.error) {
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


// --- Rotas de Autenticação e Configuração (sem alterações) ---
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
            lastSyncTimestamp: null,
        });
        
        res.send('<script>window.close();</script><h1>Autenticação concluída! Pode fechar esta janela.</h1>');
    } catch (error) {
        console.error(`[Shopee Callback] Erro: ${error.message}`);
        res.status(500).send(`Erro durante a autenticação: ${error.message}`);
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


// --- Rota de Exibição de Dados (Paginado) ---

router.get('/vendas', async (req, res) => {
    const { uid, page = 1, pageSize = 7, sortBy = 'create_time', sortOrder = 'desc', status } = req.query;

    if (!uid) {
        return res.status(400).json({ error: 'UID do usuário é obrigatório.' });
    }
    
    const pageNum = parseInt(page, 10);
    const pageSizeNum = parseInt(pageSize, 10);

    try {
        let query = db.collection('users').doc(uid).collection('shopeeVendas');
        
        const statusFiltro = status && status !== 'todos' ? status.toUpperCase() : null;
        if (statusFiltro) {
            query = query.where('status', '==', statusFiltro);
        }

        const countSnapshot = await query.count().get();
        const totalItems = countSnapshot.data().count;
        const totalPages = Math.ceil(totalItems / pageSizeNum);

        let dataQuery = query.orderBy(sortBy, sortOrder);

        if (pageNum > 1) {
            const offset = (pageNum - 1) * pageSizeNum;
            dataQuery = dataQuery.offset(offset);
        }
        dataQuery = dataQuery.limit(pageSizeNum);

        const snapshot = await dataQuery.get();
        const vendasDaPagina = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

        res.json({
            vendas: vendasDaPagina,
            pagination: { currentPage: pageNum, pageSize: pageSizeNum, totalPages, totalItems },
        });
    } catch (error) {
        console.error(`[Firestore Query Error] Falha ao buscar vendas. Verifique se o índice composto necessário existe. Detalhes: ${error.message}`);
        res.status(500).json({
            error: `Erro no servidor: A consulta ao banco de dados falhou. Provavelmente, um índice composto do Firestore está ausente.`
        });
    }
});


// --- ARQUITETURA DE SINCRONIZAÇÃO INTELIGENTE ---

const updateSyncStatus = async (uid, message, progress = null) => {
    const statusRef = db.collection('users').doc(uid).collection('shopee').doc('sync_status');
    const statusUpdate = { message, lastUpdate: new Date().toISOString() };
    if (progress !== null) {
        statusUpdate.progress = progress;
    }
    await statusRef.set(statusUpdate, { merge: true });
};

router.post('/sync-orders', (req, res) => {
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ message: 'UID é obrigatório.' });

    res.status(202).json({ message: 'Sincronização em background iniciada.' });

    runFullShopeeSync(uid).catch(error => {
        console.error(`[Shopee Sync BG] Erro fatal na sincronização para o UID ${uid}:`, error.message);
        updateSyncStatus(uid, `Erro fatal: ${error.message}`, 100);
    });
});

router.get('/check-updates', async (req, res) => {
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ error: 'UID obrigatório' });

    try {
        let totalNewSales = 0;
        const contasSnap = await db.collection('users').doc(uid).collection('shopee').where('status', '==', 'ativo').get();
        if (contasSnap.empty) {
            return res.json({ newSalesCount: 0 });
        }

        const contas = contasSnap.docs.map(doc => doc.data());
        for (const conta of contas) {
            if (conta.lastSyncTimestamp) {
                const newSales = await getAllOrderSnForShop(uid, conta.shop_id, conta.lastSyncTimestamp);
                totalNewSales += newSales.length;
            }
        }
        res.json({ newSalesCount: totalNewSales });
    } catch (error) {
        console.error(`[Shopee Check Updates] Erro ao verificar novas vendas para UID ${uid}:`, error.message);
        res.status(500).json({ error: 'Falha ao verificar atualizações.' });
    }
});


async function runFullShopeeSync(uid) {
    await updateSyncStatus(uid, 'Iniciando sincronização de contas Shopee...', 0);
    
    const contasSnap = await db.collection('users').doc(uid).collection('shopee').where('status', '==', 'ativo').get();
    if (contasSnap.empty) {
        await updateSyncStatus(uid, 'Nenhuma conta Shopee ativa encontrada para sincronizar.', 100);
        return;
    }
    const contas = contasSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const totalContas = contas.length;

    let contasSincronizadas = 0;

    for (const [index, conta] of contas.entries()) {
        const shopId = conta.id;
        const shopRef = db.collection('users').doc(uid).collection('shopee').doc(shopId);
        
        try {
            const progressBase = (index / totalContas) * 100;
            await updateSyncStatus(uid, `Iniciando verificação da loja ${conta.shop_name || shopId} (${index + 1}/${totalContas})...`, progressBase);

            let lastSync = conta.lastSyncTimestamp;
            const vendasCountSnap = await db.collection('users').doc(uid).collection('shopeeVendas').where('shop_id', '==', shopId).limit(1).get();
            if (lastSync && vendasCountSnap.empty) {
                console.warn(`[Shopee Sync BG] Detectada sincronização incompleta para a loja ${shopId}. Forçando busca completa.`);
                await updateSyncStatus(uid, `Refazendo busca completa para ${conta.shop_name || shopId}...`, progressBase + 5);
                lastSync = null;
            }

            await updateSyncStatus(uid, `[${conta.shop_name}] Buscando lista de pedidos...`, progressBase + 10);
            const orderSnList = await getAllOrderSnForShop(uid, shopId, lastSync);
            
            if (orderSnList.length === 0) {
                 await shopRef.update({ lastSyncTimestamp: Math.floor(Date.now() / 1000) });
                 console.log(`[Shopee Sync BG] Nenhum pedido novo para a loja ${conta.shop_name || shopId}.`);
                 await updateSyncStatus(uid, `[${conta.shop_name}] Nenhum pedido novo encontrado.`, progressBase + 90 / totalContas);
                 contasSincronizadas++;
                 continue; 
            }

            await updateSyncStatus(uid, `[${conta.shop_name}] Encontrados ${orderSnList.length} pedidos. Buscando detalhes...`, progressBase + 20);
            const allVendasComDetalhes = await getOrderDetailsInParallel(uid, shopId, orderSnList, (progress) => {
                const stepProgress = 20 + (progress * 60); // Mapeia 0-1 para 20-80
                updateSyncStatus(uid, `[${conta.shop_name}] Processando detalhes... ${Math.round(progress * 100)}%`, progressBase + (stepProgress / totalContas));
            });
            
            await updateSyncStatus(uid, `[${conta.shop_name}] Salvando ${allVendasComDetalhes.length} vendas no banco de dados...`, progressBase + 85);
            
            // =================================================================================
            // CORREÇÃO DEFINITIVA: Dividir o batch em pedaços de 200 para evitar o erro de tamanho.
            // =================================================================================
            const firestoreBatchChunks = chunkArray(allVendasComDetalhes, 200); 
            for (const [chunkIndex, batchChunk] of firestoreBatchChunks.entries()) {
                const batch = db.batch();
                for (const venda of batchChunk) {
                    if (venda && venda.order_sn) {
                        const vendaRef = db.collection('users').doc(uid).collection('shopeeVendas').doc(venda.order_sn);
                        batch.set(vendaRef, { ...venda, nomeConta: conta.shop_name || `Loja ${shopId}` }, { merge: true });
                    }
                }
                await batch.commit(); // Salva um pacote de cada vez
                console.log(`[Shopee Sync BG] Pacote ${chunkIndex + 1}/${firestoreBatchChunks.length} (${batchChunk.length} vendas) para a loja ${shopId} salvo com sucesso.`);
            }

            await shopRef.update({ lastSyncTimestamp: Math.floor(Date.now() / 1000) });
            console.log(`[Shopee Sync BG] Sincronização da loja ${shopId} concluída.`);
            contasSincronizadas++;

        } catch (error) {
            console.error(`[Shopee Sync BG] Falha ao sincronizar a loja ${shopId}. Erro: ${error.message}`);
            // Atualiza o status para informar o erro, mas não para o progresso em 100%
            await updateSyncStatus(uid, `Erro na loja ${conta.shop_name || shopId}: ${error.message}. Continuando...`, null);
            continue; // Garante que o loop continue para a próxima conta
        }
    }
    
    await updateSyncStatus(uid, `Sincronização concluída! ${contasSincronizadas} de ${totalContas} contas foram processadas.`, 100);
}

async function getAllOrderSnForShop(uid, shopId, lastSyncTimestamp) {
    const allOrderSn = new Set();
    const path = '/api/v2/order/get_order_list';
    const now = Math.floor(Date.now() / 1000);
    
    const isResync = !!lastSyncTimestamp;
    const time_range_field = isResync ? 'update_time' : 'create_time';
    
    if (isResync) {
        const time_from = lastSyncTimestamp - 300;
        const time_to = now;
        console.log(`[Shopee List] Modo: Resincronização para ${shopId}. Buscando de ${new Date(time_from * 1000).toLocaleString()} até ${new Date(time_to * 1000).toLocaleString()}`);
        await fetchOrderListChunk(uid, shopId, path, time_from, time_to, time_range_field, allOrderSn);
    } else {
        const totalLookbackDays = 90;
        console.log(`[Shopee List] Modo: Sincronização Inicial para ${shopId}. Buscando últimos ${totalLookbackDays} dias.`);
        for (let i = 0; i < totalLookbackDays / 15; i++) {
            const time_to = now - (i * 15 * 24 * 60 * 60);
            const time_from = time_to - (15 * 24 * 60 * 60);
            await fetchOrderListChunk(uid, shopId, path, time_from, time_to, time_range_field, allOrderSn);
        }
    }
    
    return Array.from(allOrderSn);
}

async function fetchOrderListChunk(uid, shopId, path, time_from, time_to, time_range_field, allOrderSn) {
    let token = await getValidTokenShopee(uid, shopId);
    let cursor = "";
    let hasMore = true;

    while (hasMore) {
        const timestamp = Math.floor(Date.now() / 1000);
        const sign = generateSign(path, CLIENT_ID, timestamp, token, shopId);
        
        const response = await axios.get(`${SHOPEE_BASE_URL}${path}`, {
            params: {
                partner_id: parseInt(CLIENT_ID), shop_id: parseInt(shopId), timestamp,
                access_token: token, sign, time_range_field,
                time_from, time_to, page_size: 100, cursor,
            },
            timeout: AXIOS_TIMEOUT
        });

        if (response.data.error) {
             console.error(`[Shopee List] Erro retornado pela API Shopee: ${response.data.message}`);
             throw new Error(`Erro da API Shopee: ${response.data.message}`);
        }
        
        response.data.response?.order_list?.forEach(order => allOrderSn.add(order.order_sn));
        hasMore = response.data.response?.more;
        cursor = response.data.response?.next_cursor;
        await delay(300);
    }
}

async function getDetailsForChunk(uid, shopId, token, orderSnChunk) {
    try {
        const pathDetail = '/api/v2/order/get_order_detail';
        const timestamp = Math.floor(Date.now() / 1000);
        const sign = generateSign(pathDetail, CLIENT_ID, timestamp, token, shopId);
        
        const response = await axios.get(`${SHOPEE_BASE_URL}${pathDetail}`, {
            params: {
                partner_id: parseInt(CLIENT_ID), shop_id: parseInt(shopId), timestamp,
                access_token: token, sign,
                order_sn_list: orderSnChunk.join(','),
                response_optional_fields: 'buyer_user_id,buyer_username,recipient_address,item_list,payment_method,shipping_carrier,package_list,order_status'
            },
            timeout: AXIOS_TIMEOUT
        });

        if (!response.data.response || !response.data.response.order_list) {
            console.warn(`[Shopee Worker] Lote de detalhes não retornou dados para: ${orderSnChunk.join(',')}`);
            return [];
        }
        const ordersFromApi = response.data.response.order_list;

        const promises = ordersFromApi.map(async (order) => {
            try {
                const escrowPath = '/api/v2/payment/get_escrow_detail';
                const escrowTimestamp = Math.floor(Date.now() / 1000);
                const escrowSign = generateSign(escrowPath, CLIENT_ID, escrowTimestamp, token, shopId);
                const escrowResponse = await axios.get(`${SHOPEE_BASE_URL}${escrowPath}`, {
                    params: { partner_id: parseInt(CLIENT_ID), shop_id: parseInt(shopId), order_sn: order.order_sn, sign: escrowSign, timestamp: escrowTimestamp, access_token: token },
                    timeout: AXIOS_TIMEOUT
                });
                
                const escrow_detail = (!escrowResponse.data.error && escrowResponse.data.response) ? escrowResponse.data.response : null;
                
                const valorTotalVenda = (order.item_list || []).reduce((sum, it) => (sum + (parseFloat(it.model_discounted_price || it.model_original_price || 0) * parseInt(it.model_quantity_purchased || 0, 10))), 0);

                return {
                    order_sn: order.order_sn, order_status: order.order_status || 'UNKNOWN', create_time: order.create_time || 0, update_time: order.update_time || 0,
                    item_list: order.item_list || [], package_list: order.package_list || [], payment_method: order.payment_method || 'UNKNOWN',
                    shipping_carrier: order.shipping_carrier || 'UNKNOWN', recipient_address: order.recipient_address || {}, buyer_username: order.buyer_username || null,
                    escrow_detail: escrow_detail, status: (order.order_status || 'UNKNOWN').toUpperCase(), idVendaMarketplace: order.order_sn,
                    canalVenda: 'Shopee', shop_id: shopId, dataHora: new Date((order.create_time || 0) * 1000).toISOString(),
                    cliente: order.recipient_address?.name || order.buyer_username || 'Desconhecido', nomeProdutoVendido: order.item_list?.[0]?.item_name || '-',
                    valorTotalVenda: valorTotalVenda, tracking_number: order.package_list?.[0]?.tracking_number || 'N/A'
                };
            } catch (escrowError) {
                console.error(`[Shopee Worker] Falha ao buscar escrow para ${order.order_sn}: ${escrowError.message}`);
                return { ...order, escrow_detail: null }; // Retorna a ordem mesmo sem escrow
            }
        });

        return await Promise.all(promises);
    } catch (error) {
        console.error(`[Shopee Worker] Falha ao processar o lote ${orderSnChunk.join(',')}: ${error.message}`);
        return [];
    }
}

async function getOrderDetailsInParallel(uid, shopId, orderSnList, onProgress) {
    const token = await getValidTokenShopee(uid, shopId);
    const detailChunks = chunkArray(orderSnList, 20); // Chunks de 20 para a API de detalhes
    const CONCURRENCY_LEVEL = 5; // Menor concorrência para evitar rate limiting
    
    let allVendasCompletas = [];
    
    for (let i = 0; i < detailChunks.length; i += CONCURRENCY_LEVEL) {
        const batchOfChunks = detailChunks.slice(i, i + CONCURRENCY_LEVEL);
        
        const promises = batchOfChunks.map(chunk => getDetailsForChunk(uid, shopId, token, chunk));
        
        const resultsFromBatch = await Promise.all(promises);
        allVendasCompletas.push(...resultsFromBatch.flat().filter(Boolean));
        
        const progress = allVendasCompletas.length / orderSnList.length;
        if (onProgress) {
            onProgress(progress);
        }
    }

    return allVendasCompletas;
}

module.exports = router;