const express = require('express');
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
const crypto = require('crypto');
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
    const backendUrl = NGROK.url || 'https://econtazoom-backend.onrender.com';
    const redirectUri = `${backendUrl}/ml/callback`;
    const authUrl = new URL('https://auth.mercadolibre.com.br/authorization');
    authUrl.searchParams.append('response_type', 'code');
    authUrl.searchParams.append('client_id', CLIENT_ID);
    authUrl.searchParams.append('redirect_uri', redirectUri);
    authUrl.searchParams.append('state', uid);
    res.redirect(authUrl.toString());
});

router.get('/callback', async (req, res) => {
    const { code, state: uid } = req.query;
    if (!code || !uid) {
        return res.status(400).send('Parâmetros de callback ausentes (código ou estado).');
    }
    try {
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
        res.send('<script>window.close();</script><h1>Autenticação concluída! Pode fechar esta janela.</h1>');
    } catch (error) {
        console.error('Erro no callback do Mercado Livre:', error);
        res.status(500).send(`Erro durante a autenticação: ${error.message}`);
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

const updateSyncStatus = async (uid, message, progress = null, isError = false, accountName = '') => {
    const statusRef = db.collection('users').doc(uid).collection('mercadoLivre').doc('sync_status');
    const statusUpdate = { message, lastUpdate: new Date().toISOString(), isError, accountName };
    if (progress !== null) statusUpdate.progress = progress;
    await statusRef.set(statusUpdate, { merge: true });
};

async function getNewlyCreatedOrderIds(uid, accountId, lastSyncTimestamp) {
    if (!lastSyncTimestamp) return [];
    const token = await getValidTokenML(uid, accountId);
    const dateFrom = new Date(lastSyncTimestamp * 1000);
    dateFrom.setMinutes(dateFrom.getMinutes() - 20); 
    const dateTo = new Date();
    return await fetchOrderIdsForDateRange(token, accountId, dateFrom, dateTo, 'last_updated');
}

router.get('/check-updates', async (req, res) => {
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
    try {
        const contasSnap = await db.collection('users').doc(uid).collection('mercadoLivre').where('status', '==', 'ativo').get();
        if (contasSnap.empty) return res.json([]);

        const statusPromises = contasSnap.docs.map(async (doc) => {
            const conta = { id: doc.id, ...doc.data() };
            const accountId = parseInt(conta.id, 10);
            const accountName = conta.nickname;

            try {
                const vendasCheckRef = db.collection('users').doc(uid).collection('mlVendas').where('seller.id', '==', accountId).limit(1);
                const vendasCheckSnap = await vendasCheckRef.get();
                
                if (vendasCheckSnap.empty) {
                    return { id: conta.id, nome: accountName, status: 'unsynced', newOrdersCount: 0 };
                }

                const newlyCreatedIds = await getNewlyCreatedOrderIds(uid, conta.id, conta.lastSyncTimestamp);

                if (newlyCreatedIds.length === 0) {
                    return { id: conta.id, nome: accountName, status: 'synced', newOrdersCount: 0 };
                }

                const vendasRef = db.collection('users').doc(uid).collection('mlVendas');
                const idChunks = chunkArray(newlyCreatedIds.map(id => id.toString()), 30);
                const existingIds = new Set();

                for (const chunk of idChunks) {
                    if (chunk.length === 0) continue;
                    const querySnapshot = await vendasRef.where(FieldPath.documentId(), 'in', chunk).get();
                    querySnapshot.forEach(doc => existingIds.add(doc.id));
                }

                const newOrdersCount = newlyCreatedIds.length - existingIds.size;
                
                return { 
                    id: conta.id, 
                    nome: accountName, 
                    status: newOrdersCount > 0 ? 'needs_update' : 'synced', 
                    newOrdersCount 
                };

            } catch (error) {
                console.error(`Erro ao verificar conta ${accountName}:`, error);
                return { id: conta.id, nome: accountName, status: 'error', newOrdersCount: 0, error: error.message };
            }
        });
        res.json(await Promise.all(statusPromises));
    } catch (error) { 
        res.status(500).json({ error: 'Erro ao verificar contas ML', detalhe: error.message, status: 'error' }); 
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
    let conta, accountName;

    try {
        const contaSnap = await contaRef.get();
        if (!contaSnap.exists || contaSnap.data().status !== 'ativo') {
            throw new Error(`Conta ${singleAccountId} não encontrada ou está inativa.`);
        }
        conta = { id: contaSnap.id, ...contaSnap.data() };
        accountName = conta.nickname || `Conta ${conta.id}`;
        
        const vendasCheckRef = db.collection('users').doc(uid).collection('mlVendas').where('seller.id', '==', parseInt(conta.id, 10)).limit(1);
        const vendasCheckSnap = await vendasCheckRef.get();
        const isFirstSync = vendasCheckSnap.empty;

        const syncStartTime = Math.floor(Date.now() / 1000);

        await updateSyncStatus(uid, `Iniciando...`, 0, false, accountName);
        
        const orderIdList = await getAllOrderIdsForAccount(uid, conta.id, isFirstSync ? null : conta.lastSyncTimestamp);

        if (orderIdList.length === 0) {
            await contaRef.update({ lastSyncTimestamp: syncStartTime });
            await updateSyncStatus(uid, `Nenhum pedido novo ou histórico encontrado.`, 100, false, accountName);
            return;
        }

        await updateSyncStatus(uid, `Encontrados ${orderIdList.length} IDs de vendas. Buscando detalhes...`, 20, false, accountName);
        const allVendasComDetalhes = await getOrderDetailsInParallel(uid, conta.id, orderIdList, (progress) => {
            const prog = 20 + Math.floor(progress * 70);
            updateSyncStatus(uid, `Processando detalhes... (${Math.round(progress * orderIdList.length)} de ${orderIdList.length})`, prog, false, accountName);
        });
        
        const firestoreBatchChunks = chunkArray(allVendasComDetalhes, 250);
        let savedCount = 0;
        let chunkIndex = 0;

        for (const batchChunk of firestoreBatchChunks) {
            chunkIndex++;
            const savingProgress = 90 + Math.floor((chunkIndex / firestoreBatchChunks.length) * 9);
            const message = `Salvando lote ${chunkIndex}/${firestoreBatchChunks.length} (${savedCount + batchChunk.length}/${allVendasComDetalhes.length} vendas)`;
            await updateSyncStatus(uid, message, savingProgress, false, accountName);

            const batch = db.batch();
            for (const venda of batchChunk) {
                if (venda && venda.id) {
                    const vendaDocRef = db.collection('users').doc(uid).collection('mlVendas').doc(venda.id.toString());
                    const finalVendaData = { ...venda, nomeConta: accountName };
                    batch.set(vendaDocRef, finalVendaData, { merge: true });
                }
            }
            await batch.commit();
            savedCount += batchChunk.length;
        }

        await contaRef.update({ lastSyncTimestamp: syncStartTime });
        await updateSyncStatus(uid, `Sincronização concluída!`, 100, false, accountName);

    } catch (error) {
        console.error(`[ML Sync BG] Erro ao sincronizar ${accountName || singleAccountId}:`, error);
        const finalAccountName = accountName || `Conta ${singleAccountId}`;
        await updateSyncStatus(uid, `Erro: ${error.message}`, 100, true, finalAccountName);
    }
}

async function fetchOrderIdsForDateRange(token, sellerId, dateFrom, dateTo, filterField) {
    const ids = new Set();
    let offset = 0;
    const limit = 50;
    while (true) {
        const dateQuery = `&order.${filterField}.from=${dateFrom.toISOString()}&order.${filterField}.to=${dateTo.toISOString()}`;
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
            if (offset >= 10000) break;
            await delay(250);
        } catch (error) {
            console.error(`[ML Fetch Chunk] Falha de rede: ${error.message}`);
            break;
        }
    }
    return Array.from(ids);
}

async function getAllOrderIdsForAccount(uid, accountId, lastSyncTimestamp) {
    const token = await getValidTokenML(uid, accountId);
    const allOrderIds = new Set();
    const isInitialSync = !lastSyncTimestamp;

    if (isInitialSync) {
        console.log(`[ML Sync] Sincronização Inicial para conta ${accountId}. Buscando todo o histórico via paginação.`);
        let offset = 0;
        const limit = 50;

        while (true) {
            const url = `https://api.mercadolibre.com/orders/search?seller=${accountId}&sort=date_desc&offset=${offset}&limit=${limit}`;
            console.log(`[ML Sync] Buscando vendas... offset: ${offset}`);
            
            try {
                const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, timeout: AXIOS_TIMEOUT });
                if (!response.ok) {
                    const errorData = await response.json();
                    console.error(`[ML Sync] Erro na API do ML ao buscar histórico: ${errorData.message}`);
                    break; 
                }

                const data = await response.json();
                if (!data.results || data.results.length === 0) {
                    console.log("[ML Sync] Fim do histórico de vendas encontrado.");
                    break; 
                }

                data.results.forEach(order => allOrderIds.add(order.id));
                offset += limit;

                if (offset >= 10000) {
                    console.warn(`[ML Sync] Atingido o limite de offset da API (10000). A busca pode não incluir vendas mais antigas que isso.`);
                    break;
                }

                await delay(300);
            } catch (error) {
                console.error(`[ML Sync] Falha de rede ao buscar histórico: ${error.message}`);
                break;
            }
        }
    } else {
        console.log(`[ML Sync] Atualização para conta ${accountId}.`);
        const dateFrom = new Date(lastSyncTimestamp * 1000);
        dateFrom.setMinutes(dateFrom.getMinutes() - 30);
        const dateTo = new Date();
        const updatedOrders = await fetchOrderIdsForDateRange(token, accountId, dateFrom, dateTo, 'last_updated');
        updatedOrders.forEach(id => allOrderIds.add(id));
    }
    return Array.from(allOrderIds);
}


async function getOrderDetailsInParallel(uid, accountId, orderIdList, onProgress) {
    const token = await getValidTokenML(uid, accountId);
    let allVendasCompletas = [];
    let processedCount = 0;

    const chunks = chunkArray(orderIdList, 20);

    for (const chunk of chunks) {
        const promises = chunk.map(orderId => {
            if (!orderId) return Promise.resolve(null);
            
            const url = `https://api.mercadolibre.com/orders/${orderId}`;
            return fetch(url, { 
                headers: { Authorization: `Bearer ${token}` }, 
                timeout: AXIOS_TIMEOUT 
            })
            .then(res => {
                if (!res.ok) {
                    console.warn(`[ML Detail] Falha ao buscar detalhe do pedido ${orderId}. Status: ${res.status}`);
                    return null;
                }
                return res.json();
            })
            .catch(err => {
                console.warn(`[ML Detail] Erro de rede ao buscar pedido ${orderId}: ${err.message}`);
                return null;
            });
        });

        const results = await Promise.all(promises);
        
        const validDetails = results.filter(r => r !== null);
        
        const processedDetails = await Promise.all(validDetails.map(order => processSingleOrderDetail(uid, accountId, token, order)));
        allVendasCompletas.push(...processedDetails.filter(Boolean));
        
        processedCount += chunk.length;
        if (onProgress) onProgress(processedCount / orderIdList.length);

        await delay(333);
    }
    return allVendasCompletas;
}


async function processSingleOrderDetail(uid, accountId, token, orderDetails) {
    try {
        if (!orderDetails || !orderDetails.id) {
            console.warn('[ML Process] Recebido um item inválido no processamento de detalhes.');
            return null;
        }

        let shipmentDetails = {};
        if (orderDetails.shipping?.id) {
            const shipmentRes = await fetch(`https://api.mercadolibre.com/shipments/${orderDetails.shipping.id}`, { 
                headers: { Authorization: `Bearer ${token}` } 
            });
            if (shipmentRes.ok) shipmentDetails = await shipmentRes.json();
        }

        const shippingCost = calcularFreteAdjust(orderDetails, shipmentDetails);
        const orderItems = Array.isArray(orderDetails.order_items) ? orderDetails.order_items : [];
        const saleFee = orderItems.reduce((acc, item) => acc + (item.sale_fee || 0), 0);
        const cliente = orderDetails.buyer?.nickname || `${orderDetails.buyer?.first_name || ''} ${orderDetails.buyer?.last_name || ''}`.trim() || 'Desconhecido';

        const vendaParaSalvar = {
            id: orderDetails.id?.toString(),
            idVendaMarketplace: orderDetails.id?.toString(),
            canalVenda: 'Mercado Livre',
            status: orderDetails.status,
            dataHora: orderDetails.date_created, // Mantido para referência
            date_created: orderDetails.date_created,
            // *** CORREÇÃO ADICIONADA AQUI ***
            // O campo 'date_closed' é essencial para os filtros de data no frontend.
            date_closed: orderDetails.date_closed,
            cliente: cliente,
            nomeProdutoVendido: orderItems[0]?.item?.title || '-',
            valorTotalVenda: Number(orderDetails.total_amount || 0),
            txPlataforma: saleFee,
            custoFrete: shippingCost,
            seller: { id: orderDetails.seller?.id, nickname: orderDetails.seller?.nickname },
            order_items: orderItems.map(item => ({
                item: {
                    id: item.item?.id,
                    title: item.item?.title,
                    seller_sku: item.item?.seller_sku,
                },
                quantity: item.quantity,
                unit_price: item.unit_price,
                sale_fee: item.sale_fee,
            })),
            payments: (orderDetails.payments || []).map(p => ({
                id: p.id,
                status: p.status,
                transaction_amount: p.transaction_amount,
                payment_method_id: p.payment_method_id,
                payment_type: p.payment_type,
            })),
            buyer: {
                id: orderDetails.buyer?.id,
                nickname: orderDetails.buyer?.nickname,
                first_name: orderDetails.buyer?.first_name,
                last_name: orderDetails.buyer?.last_name,
            },
            shipping: {
                id: orderDetails.shipping?.id,
                status: orderDetails.shipping?.status,
                logistic_type: orderDetails.shipping?.logistic_type,
            },
            shipping_details: {
                id: shipmentDetails.id,
                status: shipmentDetails.status,
                logistic_type: shipmentDetails.logistic_type,
                shipping_option: shipmentDetails.shipping_option,
                tracking_number: shipmentDetails.tracking_number,
                receiver_address: {
                    address_line: shipmentDetails.receiver_address?.address_line,
                    city: shipmentDetails.receiver_address?.city?.name,
                    state: shipmentDetails.receiver_address?.state?.name,
                    zip_code: shipmentDetails.receiver_address?.zip_code,
                }
            }
        };

        return cleanObject(vendaParaSalvar);

    } catch (error) {
        console.warn(`[ML Process] Erro ao processar venda ${orderDetails.id}: ${error.message}`);
        return null;
    }
}


function calcularFreteAdjust(orderDetails, shippingDetails) {
    const logisticType = shippingDetails?.logistic_type;
    const shippingOption = shippingDetails?.shipping_option;
    const unitPrice = Number(orderDetails.order_items?.[0]?.unit_price || 0);

    const listCost = Number(shippingOption?.list_cost || 0);
    const buyerCost = Number(shippingOption?.cost || 0);
    const baseCost = Number(shippingOption?.base_cost || 0);

    let custoBruto = 0;
    let finalCost = 0;

    switch (logisticType) {
        case 'self_service':
            custoBruto = (unitPrice < 79) ? baseCost : (baseCost - listCost);
            finalCost = -custoBruto; 
            break;

        case 'drop_off':
        case 'xd_drop_off':
            custoBruto = listCost - buyerCost;
            finalCost = Math.max(0, custoBruto);
            break;

        case 'fulfillment':
        case 'cross_docking': 
            custoBruto = listCost;
            finalCost = Math.max(0, custoBruto);
            break;

        default:
            finalCost = 0;
            break;
    }

    return parseFloat(finalCost.toFixed(2));
}

module.exports = router;
