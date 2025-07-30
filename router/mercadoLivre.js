const express = require('express');
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
const router = express.Router();
const { db } = require('../firebase'); 
const { FieldPath } = require('firebase-admin/firestore');
const { NGROK } = require('./sharedState'); 

const CLIENT_ID = '4762241412857004';
const CLIENT_SECRET = 'yBJNREOR3izbhIGRJtUP8P4FsGNXLIvB';
const AXIOS_TIMEOUT = 30000;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
        chunks.push(array.slice(i, i + size));
    }
    return chunks;
}

function cleanObject(obj) {
    if (typeof obj !== 'object' || obj === null) {
        return obj;
    }
    if (Array.isArray(obj)) {
        return obj.map(item => cleanObject(item));
    }
    return Object.keys(obj).reduce((acc, key) => {
        const value = obj[key];
        if (value !== undefined) {
            acc[key] = cleanObject(value);
        }
        return acc;
    }, {});
}

async function refreshTokenML(uid, contaId, contaData) {
  try {
    const tokenResponse = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: CLIENT_ID, client_secret: CLIENT_SECRET, refresh_token: contaData.refresh_token }),
    });
    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok) throw new Error(tokenData.message || 'Falha ao renovar o token');
    const { access_token, refresh_token, expires_in } = tokenData;
    const novaContaData = { ...contaData, access_token, refresh_token, expires_in, updatedAt: new Date().toISOString(), lastTokenRefresh: new Date().toISOString(), status: 'ativo' };
    await db.collection('users').doc(uid).collection('mercadoLivre').doc(contaId).set(novaContaData, { merge: true });
    return access_token;
  } catch (error) {
    await db.collection('users').doc(uid).collection('mercadoLivre').doc(contaId).update({ status: 'reauth_required', lastError: `Falha ao renovar token: ${error.message}` });
    throw error;
  }
}
async function getValidTokenML(uid, contaId) {
    const contaRef = db.collection('users').doc(uid).collection('mercadoLivre').doc(contaId);
    const contaSnap = await contaRef.get();
    if (!contaSnap.exists) throw new Error(`Conta ML ${contaId} não encontrada.`);
    const contaData = contaSnap.data();
    if (contaData.status === 'reauth_required') throw new Error(`Conta ${contaId} (${contaData.nickname}) precisa ser reautenticada.`);
    const tokenCreationTime = new Date(contaData.lastTokenRefresh || contaData.updatedAt).getTime();
    const expiresInMilliseconds = (contaData.expires_in - 300) * 1000;
    if (Date.now() - tokenCreationTime > expiresInMilliseconds) {
        return await refreshTokenML(uid, contaId, contaData);
    }
    return contaData.access_token;
}

router.get('/auth', (req, res) => {
    const { uid } = req.query;
    if (!uid) return res.status(400).send('UID do usuário é obrigatório.');

    const finalRedirectUrl = req.headers.referer || 'http://localhost:8080/contas'; 
    const state = {
        uid: uid,
        finalRedirectUrl: finalRedirectUrl
    };
    const encodedState = Buffer.from(JSON.stringify(state)).toString('base64');
    const backendUrl = NGROK.url || 'https://econtazoom-backend.onrender.com';
    const redirectUri = `${backendUrl}/ml/callback`;
    const authUrl = new URL('https://auth.mercadolibre.com/authorization');
    authUrl.searchParams.append('response_type', 'code');
    authUrl.searchParams.append('client_id', CLIENT_ID);
    authUrl.searchParams.append('redirect_uri', redirectUri);
    authUrl.searchParams.append('state', encodedState);
    res.redirect(authUrl.toString());
});

router.get('/callback', async (req, res) => {
    const { code, state: encodedState } = req.query;
    let uid;
    let finalRedirectUrl;
    try {
        if (!code || !encodedState) {
            return res.status(400).send('Parâmetros de callback ausentes (código ou estado).');
        }
        const decodedState = JSON.parse(Buffer.from(encodedState, 'base64').toString('utf8'));
        uid = decodedState.uid;
        finalRedirectUrl = decodedState.finalRedirectUrl;
        if (!uid) {
            throw new Error('UID não encontrado no estado de autenticação.');
        }
        const backendUrl = NGROK.url || 'https://econtazoom-backend.onrender.com';
        const redirectUri = `${backendUrl}/ml/callback`;
        const tokenResponse = await fetch('https://api.mercadolibre.com/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                client_id: CLIENT_ID,
                client_secret: CLIENT_SECRET,
                code,
                redirect_uri: redirectUri,
            }),
        });
        const tokenData = await tokenResponse.json();
        if (!tokenResponse.ok) {
            throw new Error(tokenData.message || 'Falha ao obter o token de acesso.');
        }
        const { access_token, refresh_token, expires_in, user_id } = tokenData;
        const userResponse = await fetch(`https://api.mercadolibre.com/users/${user_id}`, {
            headers: { Authorization: `Bearer ${access_token}` },
        });
        const userData = await userResponse.json();
        if (!userResponse.ok) {
            throw new Error(userData.message || 'Falha ao obter dados do usuário.');
        }
        const { nickname } = userData;
        const contaId = user_id.toString();
        await db.collection('users').doc(uid).collection('mercadoLivre').doc(contaId).set({
            access_token,
            refresh_token,
            expires_in,
            user_id: contaId,
            nickname,
            status: 'ativo',
            updatedAt: new Date().toISOString(),
            lastTokenRefresh: new Date().toISOString(),
            lastSyncTimestamp: null,
        }, { merge: true });
        res.redirect(finalRedirectUrl);
    } catch (error) {
        console.error('Erro no callback do Mercado Livre:', error);
        if (finalRedirectUrl) {
            const errorRedirectUrl = new URL(finalRedirectUrl);
            errorRedirectUrl.searchParams.append('auth_error', 'ml_failed');
            errorRedirectUrl.searchParams.append('auth_message', error.message);
            res.redirect(errorRedirectUrl.toString());
        } else {
            res.status(500).send(`Erro durante a autenticação: ${error.message}. Não foi possível redirecionar de volta.`);
        }
    }
});

router.get('/contas', async (req, res) => {
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
    try {
        const contasSnap = await db.collection('users').doc(uid).collection('mercadoLivre').get();
        const contas = contasSnap.docs
            .filter(doc => doc.id !== 'sync_status')
            .map(doc => {
                const data = doc.data();
                return {
                    id: doc.id,
                    nome: data.nickname || `Conta ${doc.id}`,
                    status: data.status || 'desconhecido'
                };
            });
        res.json(contas);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar contas do Mercado Livre', detalhe: error.message });
    }
});

router.get('/vendas-paginadas', async (req, res) => {
  const { uid, lastDocId, pageSize = 20, sortBy = 'date_created', sortOrder = 'desc', status, nomeConta } = req.query;
  if (!uid) return res.status(400).json({ error: 'UID do usuário é obrigatório.' });
  const pageSizeNum = parseInt(pageSize, 10);
  try {
    let queryRef = db.collection('users').doc(uid).collection('mlVendas');
    const statusFiltro = status && status !== 'todos' ? status.toLowerCase() : null;
    if (statusFiltro) queryRef = queryRef.where('status', '==', statusFiltro);
    if (nomeConta && nomeConta !== 'todos') queryRef = queryRef.where('nomeConta', '==', nomeConta);
    queryRef = queryRef.orderBy(sortBy, sortOrder);
    if (lastDocId) {
      const lastDocSnapshot = await db.collection('users').doc(uid).collection('mlVendas').doc(lastDocId).get();
      if (!lastDocSnapshot.exists) return res.status(404).json({ error: 'Documento de referência não encontrado.' });
      queryRef = queryRef.startAfter(lastDocSnapshot);
    }
    const snapshot = await queryRef.limit(pageSizeNum + 1).get();
    const vendas = snapshot.docs.slice(0, pageSizeNum).map(doc => ({ id: doc.id, ...doc.data() }));
    const hasMore = snapshot.docs.length > pageSizeNum;
    const newLastDocId = vendas.length > 0 ? snapshot.docs[vendas.length - 1].id : null;
    res.json({ vendas, pagination: { pageSize: pageSizeNum, lastDocId: newLastDocId, hasMore } });
  } catch (error) { res.status(500).json({ error: `Erro no servidor: ${error.message}` }); }
});

const updateSyncStatus = async (uid, message, progress = null, isError = false, accountName = '', salesProcessed = null) => {
    const statusRef = db.collection('users').doc(uid).collection('mercadoLivre').doc('sync_status');
    const statusUpdate = { message, lastUpdate: new Date().toISOString(), isError, accountName };
    if (progress !== null) statusUpdate.progress = progress;
    if (salesProcessed !== null && !isNaN(salesProcessed)) {
        statusUpdate.salesProcessed = salesProcessed;
    }
    await statusRef.set(statusUpdate, { merge: true });
};

router.get('/check-updates', async (req, res) => {
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
    try {
        const contasSnap = await db.collection('users').doc(uid).collection('mercadoLivre').where('status', '==', 'ativo').get();
        if (contasSnap.empty) return res.json([]);

        const statusPromises = contasSnap.docs.map(async (doc) => {
            const conta = { id: doc.id, ...doc.data() };
            const accountId = conta.id;
            const accountName = conta.nickname;

            if (!conta.lastSyncTimestamp) {
                return { id: accountId, nome: accountName, status: 'unsynced', newOrdersCount: 0 };
            }

            try {
                const updatedOrderIds = await getUpdatedOrderIds(uid, accountId, conta.lastSyncTimestamp);
                if (updatedOrderIds.length > 0) {
                    return { id: accountId, nome: accountName, status: 'needs_update', newOrdersCount: updatedOrderIds.length };
                } else {
                    return { id: accountId, nome: accountName, status: 'synced', newOrdersCount: 0 };
                }
            } catch (error) {
                console.error(`Erro ao verificar conta ${accountName}:`, error);
                return { id: accountId, nome: accountName, status: 'error', newOrdersCount: 0, error: error.message };
            }
        });
        res.json(await Promise.all(statusPromises));
    } catch (error) { 
        res.status(500).json({ error: 'Erro ao verificar contas ML', detalhe: error.message }); 
    }
});


router.post('/sync-single-shop', (req, res) => {
    const { uid, accountId } = req.body;
    if (!uid || !accountId) return res.status(400).json({ message: 'UID e accountId são obrigatórios.' });
    res.status(202).json({ message: `Sincronização para a conta ${accountId} iniciada.` });
    runFullMercadoLivreSync(uid, accountId).catch(error => {
        console.error(`[ML Sync BG] Erro fatal não capturado para ${accountId}:`, error);
        updateSyncStatus(uid, `Erro fatal na sincronização: ${error.message}`, 100, true, accountId);
    });
});

async function runFullMercadoLivreSync(uid, singleAccountId) {
    const contaRef = db.collection('users').doc(uid).collection('mercadoLivre').doc(singleAccountId);
    let accountName = `Conta ${singleAccountId}`;

    try {
        const contaSnap = await contaRef.get();
        if (!contaSnap.exists || contaSnap.data().status !== 'ativo') {
            throw new Error(`Conta ${singleAccountId} não encontrada ou está inativa.`);
        }
        const conta = { id: contaSnap.id, ...contaSnap.data() };
        accountName = conta.nickname || accountName;
        
        const isFirstSync = !conta.lastSyncTimestamp;
        const syncStartTime = Math.floor(Date.now() / 1000);

        await updateSyncStatus(uid, `Iniciando...`, 0, false, accountName);
        
        const orderIdList = await getAllOrderIdsForAccount(uid, conta.id, isFirstSync ? null : conta.lastSyncTimestamp);

        if (orderIdList.length === 0) {
            await contaRef.update({ lastSyncTimestamp: syncStartTime });
            await updateSyncStatus(uid, `Nenhuma venda nova ou atualização encontrada.`, 100, false, accountName, 0);
            return;
        }

        await updateSyncStatus(uid, `Encontrados ${orderIdList.length} IDs de vendas. Buscando detalhes...`, 20, false, accountName);
        const allVendasComDetalhes = await getOrderDetailsInParallel(uid, conta.id, orderIdList, (progress, processed, total) => {
            const prog = 20 + Math.floor(progress * 70);
            updateSyncStatus(uid, `Processando detalhes... (${processed} de ${total})`, prog, false, accountName);
        });
        
        const salesAddedCount = allVendasComDetalhes.length;
        if (salesAddedCount > 0) {
            await updateSyncStatus(uid, `Salvando ${salesAddedCount} vendas...`, 95, false, accountName);
            const firestoreBatchChunks = chunkArray(allVendasComDetalhes, 400);
            for (const batchChunk of firestoreBatchChunks) {
                const batch = db.batch();
                for (const venda of batchChunk) {
                    if (venda && venda.id) {
                        const vendaDocRef = db.collection('users').doc(uid).collection('mlVendas').doc(venda.id.toString());
                        const finalVendaData = { ...venda, nomeConta: accountName };
                        batch.set(vendaDocRef, cleanObject(finalVendaData), { merge: true });
                    }
                }
                await batch.commit();
            }
        }

        await contaRef.update({ lastSyncTimestamp: syncStartTime });
        await updateSyncStatus(uid, `Sincronização concluída!`, 100, false, accountName, salesAddedCount);

    } catch (error) {
        console.error(`[ML Sync BG] Erro ao sincronizar ${accountName}:`, error);
        await updateSyncStatus(uid, `Erro: ${error.message}`, 100, true, accountName);
    }
}

async function fetchOrderIdsForDateRange(token, sellerId, dateFrom, dateTo) {
    const ids = new Set();
    let offset = 0;
    const limit = 50;
    const dateQuery = `&order.last_updated_date=${dateFrom.toISOString().slice(0, -5)}Z,${dateTo.toISOString().slice(0, -5)}Z`;
    
    while (true) {
        const url = `https://api.mercadolibre.com/orders/search?seller=${sellerId}&sort=date_desc&offset=${offset}&limit=${limit}${dateQuery}`;
        try {
            const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, timeout: AXIOS_TIMEOUT });
            if (!response.ok) {
                const errorData = await response.json();
                console.error(`[ML Fetch Chunk] Erro da API ML: ${errorData.message}`);
                break; 
            }
            const data = await response.json();
            if (!data.results || data.results.length === 0) break; 
            data.results.forEach(order => ids.add(order.id));
            offset += limit;
            if (offset >= data.paging.total || offset >= 10000) break;
            await delay(250);
        } catch (error) {
            console.error(`[ML Fetch Chunk] Falha de rede: ${error.message}`);
            break;
        }
    }
    return Array.from(ids);
}

async function getUpdatedOrderIds(uid, accountId, lastSyncTimestamp) {
    const token = await getValidTokenML(uid, accountId);
    const dateFrom = new Date(lastSyncTimestamp * 1000);
    dateFrom.setMinutes(dateFrom.getMinutes() - 30); // Margem de segurança
    const dateTo = new Date();
    return await fetchOrderIdsForDateRange(token, accountId, dateFrom, dateTo);
}

async function getAllOrderIdsForAccount(uid, accountId, lastSyncTimestamp) {
    const token = await getValidTokenML(uid, accountId);
    const isInitialSync = !lastSyncTimestamp;

    if (isInitialSync) {
        console.log(`[ML Sync] Sincronização Inicial para conta ${accountId}. Buscando todo o histórico.`);
        const allOrderIds = new Set();
        let offset = 0;
        const limit = 50;
        while (true) {
            const url = `https://api.mercadolibre.com/orders/search?seller=${accountId}&sort=date_desc&offset=${offset}&limit=${limit}`;
            try {
                const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, timeout: AXIOS_TIMEOUT });
                if (!response.ok) {
                    const errorData = await response.json();
                    console.error(`[ML Sync] Erro na API do ML ao buscar histórico: ${errorData.message}`);
                    break; 
                }
                const data = await response.json();
                if (!data.results || data.results.length === 0) break; 
                data.results.forEach(order => allOrderIds.add(order.id));
                offset += limit;
                if (offset >= data.paging.total || offset >= 10000) break;
                await delay(300);
            } catch (error) {
                console.error(`[ML Sync] Falha de rede ao buscar histórico: ${error.message}`);
                break;
            }
        }
        return Array.from(allOrderIds);
    } else {
        console.log(`[ML Sync] Buscando atualizações para conta ${accountId}.`);
        return await getUpdatedOrderIds(uid, accountId, lastSyncTimestamp);
    }
}


async function getOrderDetailsInParallel(uid, accountId, orderIdList, onProgress) {
    const token = await getValidTokenML(uid, accountId);
    let allVendasCompletas = [];
    let processedCount = 0;
    const totalCount = orderIdList.length;

    const chunks = chunkArray(orderIdList, 20);

    for (const chunk of chunks) {
        const promises = chunk.map(orderId => {
            if (!orderId) return Promise.resolve(null);
            const url = `https://api.mercadolibre.com/orders/${orderId}`;
            return fetch(url, { headers: { Authorization: `Bearer ${token}` }, timeout: AXIOS_TIMEOUT })
                .then(res => res.ok ? res.json() : null)
                .catch(() => null);
        });

        const results = await Promise.all(promises);
        const validDetails = results.filter(r => r !== null);
        
        const processedDetails = await Promise.all(validDetails.map(order => processSingleOrderDetail(token, order)));
        allVendasCompletas.push(...processedDetails.filter(Boolean));
        
        processedCount += chunk.length;
        if (onProgress) onProgress(processedCount / totalCount, processedCount, totalCount);

        await delay(333);
    }
    return allVendasCompletas;
}


async function processSingleOrderDetail(token, orderDetails) {
    try {
        if (!orderDetails || !orderDetails.id) return null;

        let shipmentDetails = {};
        if (orderDetails.shipping?.id) {
            const shipmentRes = await fetch(`https://api.mercadolibre.com/shipments/${orderDetails.shipping.id}`, { headers: { Authorization: `Bearer ${token}` } });
            if (shipmentRes.ok) shipmentDetails = await shipmentRes.json();
        }
        
        // --- INÍCIO DA NOVA LÓGICA DE FRETE (TRADUZIDA DO SQL) ---
        const calcularFreteAjustado = (order, shipment) => {
            // Função auxiliar para garantir que os valores sejam numéricos
            const num = (val) => Number(val || 0);

            // Extração dos dados necessários do pedido e do envio
            const logisticType = shipment?.logistic_type;
            const orderCost = num(order?.total_amount);
            const quantity = (order?.order_items || []).reduce((acc, item) => acc + num(item.quantity), 0);
            
            // Dados extraídos do objeto 'shipment'
            const baseCost = num(shipment?.base_cost);      // SQL: base_cost
            const listCost = num(shipment?.list_cost);      // SQL: shipment_list_cost
            
            // Custo do frete do pedido
            const shippingCost = num(order?.shipping?.cost); // SQL: shipment_cost

            // Evita divisão por zero para calcular o preço por item
            const pricePerItem = quantity > 0 ? orderCost / quantity : 0;

            let freteFinal = 0;

            // Lógica principal baseada no preço por item
            if (pricePerItem < 79) {
                if (logisticType === 'self_service') {
                    freteFinal = baseCost;
                } else {
                    freteFinal = 0;
                }
            } else { // se pricePerItem >= 79
                const logisticTypesPrincipais = ['drop_off', 'xd_drop_off', 'fulfillment', 'cross_docking'];
                if (logisticType === 'self_service') {
                    freteFinal = baseCost - listCost;
                } else if (logisticTypesPrincipais.includes(logisticType)) {
                    freteFinal = listCost - shippingCost;
                } else {
                    freteFinal = 999; // Valor de fallback para casos não mapeados, conforme SQL
                }
            }

            // Aplicação do multiplicador final
            const multiplier = logisticType === 'self_service' ? 1 : -1;
            freteFinal *= multiplier;

            return freteFinal;
        };

        const custoFreteAjustado = calcularFreteAjustado(orderDetails, shipmentDetails);
        // --- FIM DA NOVA LÓGICA DE FRETE ---
        
        // A taxa da plataforma (comissão) é a soma da 'sale_fee' de cada item.
        const saleFee = (orderDetails.order_items || []).reduce((acc, item) => acc + (item.sale_fee || 0), 0);
        
        const cliente = orderDetails.buyer?.nickname || `${orderDetails.buyer?.first_name || ''} ${orderDetails.buyer?.last_name || ''}`.trim() || 'Desconhecido';

        const orderItems = Array.isArray(orderDetails.order_items) ? orderDetails.order_items : [];

        return {
            id: orderDetails.id?.toString(),
            idVendaMarketplace: orderDetails.id?.toString(),
            canalVenda: 'Mercado Livre',
            status: orderDetails.status,
            dataHora: orderDetails.date_created,
            date_created: orderDetails.date_created,
            date_closed: orderDetails.date_closed,
            cliente: cliente,
            nomeProdutoVendido: orderItems[0]?.item?.title || '-',
            valorTotalVenda: Number(orderDetails.total_amount || 0),
            txPlataforma: saleFee,
            custoFrete: custoFreteAjustado, // Usando o novo valor de frete calculado
            tipoAnuncio: orderItems[0]?.listing_type_id || 'Não informado',
            tipoEntrega: shipmentDetails.shipping_option?.name || shipmentDetails.logistic_type || 'Não informado',
            seller: { id: orderDetails.seller?.id, nickname: orderDetails.seller?.nickname },
            order_items: orderItems.map(item => ({
                item: { id: item.item?.id, title: item.item?.title, seller_sku: item.item?.seller_sku },
                quantity: item.quantity, unit_price: item.unit_price, sale_fee: item.sale_fee, listing_type_id: item.listing_type_id,
            })),
            payments: (orderDetails.payments || []).map(p => ({
                id: p.id, status: p.status, transaction_amount: p.transaction_amount, payment_method_id: p.payment_method_id, payment_type: p.payment_type,
            })),
            buyer: { id: orderDetails.buyer?.id, nickname: orderDetails.buyer?.nickname, first_name: orderDetails.buyer?.first_name, last_name: orderDetails.buyer?.last_name },
            shipping: { id: orderDetails.shipping?.id, status: orderDetails.shipping?.status, logistic_type: orderDetails.shipping?.logistic_type },
            shipping_details: {
                id: shipmentDetails.id,
                status: shipmentDetails.status,
                logistic_type: shipmentDetails.logistic_type,
                shipping_option: shipmentDetails.shipping_option,
                tracking_number: shipmentDetails.tracking_number,
                base_cost: shipmentDetails.base_cost, // Adicionado para referência
                list_cost: shipmentDetails.list_cost, // Adicionado para referência
                receiver_address: {
                    address_line: shipmentDetails.receiver_address?.address_line,
                    city: shipmentDetails.receiver_address?.city?.name,
                    state: shipmentDetails.receiver_address?.state?.name,
                    zip_code: shipmentDetails.receiver_address?.zip_code,
                }
            }
        };
    } catch (error) {
        console.warn(`[ML Process] Erro ao processar venda ${orderDetails.id}: ${error.message}`);
        return null;
    }
}

module.exports = router;
