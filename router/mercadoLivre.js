const express = require('express');
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
const router = express.Router();
const { db } = require('../firebase'); 
const { FieldPath } = require('firebase-admin/firestore');
const { NGROK } = require('./sharedState'); 

// --- CONFIGURAÇÕES GLOBAIS ---
const CLIENT_ID = '4762241412857004';
const CLIENT_SECRET = 'yBJNREOR3izbhIGRJtUP8P4FsGNXLIvB';
const AXIOS_TIMEOUT = 30000; // Timeout para chamadas à API do ML

// --- FUNÇÕES UTILITÁRIAS ---

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

// ====================================================================================
// FUNÇÃO DE CÁLCULO DE FRETE CENTRALIZADA E CORRIGIDA
// Esta é a única fonte da verdade para o cálculo de frete.
// ====================================================================================
function calcularFreteAdjust({
  shipment_logistic_type,
  base_cost,
  shipment_list_cost,
  shipment_cost,
  order_cost,
  quantity
}) {
  const unit_price = quantity ? order_cost / quantity : 0;

  // Valor padrão para o fallback (caso 'outros' com preço >= 79).
  let frete = 999;

  // --- Lógica para FLEX (self_service) ---
  if (shipment_logistic_type === 'self_service') {
    const diff = +(base_cost ?? 0) - +(shipment_list_cost ?? 0);
    const arredondado = Math.round(diff * 100) / 100;

    if (arredondado === 0) {
      // Aplica regra de incentivo se o cálculo original for zero.
      frete = unit_price < 79 ? 15.90 : 1.59;
    } else {
      // Usa o resultado do cálculo se for diferente de zero.
      frete = diff;
    }

    // Sinal POSITIVO para FLEX
    return Math.round(frete * 100) / 100;
  }

  // --- Lógica para outros tipos de entrega (Correios, Agência, FULL, Coleta) ---
  if (unit_price >= 79 && ['drop_off', 'xd_drop_off', 'fulfillment', 'cross_docking'].includes(shipment_logistic_type)) {
    // Para preço >= 79, calcula a diferença de custo.
    frete = +(shipment_list_cost ?? 0) - +(shipment_cost ?? 0);
  } else if (unit_price < 79) {
    // Para preço < 79, o frete é zerado (aplica-se a todos os não-FLEX).
    frete = 0;
  }
  // Se nenhuma condição acima for atendida (ex: tipo 'outros' e preço >= 79), 'frete' permanece 999.

  // Sinal NEGATIVO para todos os casos não-FLEX.
  return Math.round(frete * -100) / 100;
}


// --- LÓGICA DE AUTENTICAÇÃO E TOKEN ---

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
    const expiresInMilliseconds = (contaData.expires_in - 300) * 1000; // 5 minutos de margem
    if (Date.now() - tokenCreationTime > expiresInMilliseconds) {
        return await refreshTokenML(uid, contaId, contaData);
    }
    return contaData.access_token;
}

// --- ROTAS DA API ---

router.get('/auth', (req, res) => {
    const { uid, redirectUrl } = req.query;
    if (!uid) return res.status(400).send('UID do usuário é obrigatório.');
    const finalRedirectUrl = redirectUrl ? decodeURIComponent(redirectUrl) : (req.headers.referer || 'http://localhost:8080/contas'); 
    const state = { uid, finalRedirectUrl };
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
    let uid, finalRedirectUrl;
    try {
        if (!code || !encodedState) throw new Error('Parâmetros de callback ausentes.');
        const decodedState = JSON.parse(Buffer.from(encodedState, 'base64').toString('utf8'));
        uid = decodedState.uid;
        finalRedirectUrl = decodedState.finalRedirectUrl;
        if (!uid) throw new Error('UID não encontrado no estado de autenticação.');
        
        const backendUrl = NGROK.url || 'https://econtazoom-backend.onrender.com';
        const redirectUri = `${backendUrl}/ml/callback`;

        const tokenResponse = await fetch('https://api.mercadolibre.com/oauth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ grant_type: 'authorization_code', client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, redirect_uri: redirectUri }),
        });
        const tokenData = await tokenResponse.json();
        if (!tokenResponse.ok) throw new Error(tokenData.message || 'Falha ao obter o token de acesso.');
        
        const { access_token, refresh_token, expires_in, user_id } = tokenData;
        const userResponse = await fetch(`https://api.mercadolibre.com/users/${user_id}`, { headers: { Authorization: `Bearer ${access_token}` } });
        const userData = await userResponse.json();
        if (!userResponse.ok) throw new Error(userData.message || 'Falha ao obter dados do usuário.');
        
        const contaId = user_id.toString();
        await db.collection('users').doc(uid).collection('mercadoLivre').doc(contaId).set({
            access_token, refresh_token, expires_in,
            user_id: contaId,
            nickname: userData.nickname,
            status: 'ativo',
            updatedAt: new Date().toISOString(),
            lastTokenRefresh: new Date().toISOString(),
            lastSyncTimestamp: null,
            hasSales: false, // Inicia como false
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
            res.status(500).send(`Erro durante a autenticação: ${error.message}.`);
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
            .map(doc => ({
                id: doc.id,
                nome: doc.data().nickname || `Conta ${doc.id}`,
                status: doc.data().status || 'desconhecido'
            }));
        res.json(contas);
    } catch (error) {
        res.status(500).json({ error: 'Erro ao buscar contas do Mercado Livre', detalhe: error.message });
    }
});

router.get('/vendas-paginadas', async (req, res) => {
  const { uid, lastDocId, pageSize = 20, sortBy = 'date_created', sortOrder = 'desc', status, nomeConta } = req.query;
  if (!uid) return res.status(400).json({ error: 'UID do usuário é obrigatório.' });
  
  try {
    let queryRef = db.collection('users').doc(uid).collection('mlVendas');
    
    const filtros = [];
    if (status && status !== 'todos') filtros.push({ field: 'status', op: '==', value: status });
    if (nomeConta && nomeConta !== 'todos') filtros.push({ field: 'nomeConta', op: '==', value: nomeConta });

    if (filtros.length > 0) {
        filtros.forEach(f => { queryRef = queryRef.where(f.field, f.op, f.value); });
    }
    
    queryRef = queryRef.orderBy(sortBy, sortOrder);

    if (lastDocId) {
      const lastDocSnapshot = await db.collection('users').doc(uid).collection('mlVendas').doc(lastDocId).get();
      if (!lastDocSnapshot.exists) return res.status(404).json({ error: 'Documento de referência não encontrado.' });
      queryRef = queryRef.startAfter(lastDocSnapshot);
    }

    const snapshot = await queryRef.limit(parseInt(pageSize, 10)).get();
    const vendas = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    const newLastDocId = vendas.length > 0 ? snapshot.docs[vendas.length - 1].id : null;
    const hasMore = vendas.length === parseInt(pageSize, 10);

    res.json({ vendas, pagination: { lastDocId: newLastDocId, hasMore } });
  } catch (error) { 
      console.error("Erro ao buscar vendas paginadas:", error);
      res.status(500).json({ error: `Erro no servidor: ${error.message}` }); 
  }
});

// --- LÓGICA DE SINCRONIZAÇÃO ---

const updateSyncStatus = async (uid, message, progress = null, isError = false, accountName = '', salesProcessed = null) => {
    const statusRef = db.collection('users').doc(uid).collection('mercadoLivre').doc('sync_status');
    const statusUpdate = { message, lastUpdate: new Date().toISOString(), isError, accountName };
    if (progress !== null) statusUpdate.progress = progress;
    if (salesProcessed !== null && !isNaN(salesProcessed)) statusUpdate.salesProcessed = salesProcessed;
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
            const hasSales = conta.hasSales || false;

            if (!conta.lastSyncTimestamp) {
                return { id: accountId, nome: accountName, status: 'unsynced', newOrdersCount: 0, hasSales };
            }

            try {
                // Busca IDs de vendas novas via API
                const updatedOrderIds = await getUpdatedOrderIds(uid, accountId, conta.lastSyncTimestamp);

                // Busca TODOS os IDs já salvos no Firestore para esta conta
                const vendasSnap = await db.collection('users').doc(uid).collection('mlVendas')
                    .where('nomeConta', '==', accountName)
                    .get();
                const idsSalvos = vendasSnap.docs.map(d => d.data().idVendaMarketplace?.toString() || d.id);

                // Filtra apenas os IDs realmente novos
                const idsNovos = updatedOrderIds.filter(id => !idsSalvos.includes(id.toString()));

                if (idsNovos.length > 0) {
                    return { id: accountId, nome: accountName, status: 'needs_update', newOrdersCount: idsNovos.length, hasSales };
                } else {
                    return { id: accountId, nome: accountName, status: 'synced', newOrdersCount: 0, hasSales };
                }
            } catch (error) {
                console.error(`Erro ao verificar conta ${accountName}:`, error);
                return { id: accountId, nome: accountName, status: 'error', newOrdersCount: 0, error: error.message, hasSales };
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
        if (!contaSnap.exists || contaSnap.data().status !== 'ativo') throw new Error(`Conta ${singleAccountId} não encontrada ou inativa.`);
        
        const conta = { id: contaSnap.id, ...contaSnap.data() };
        accountName = conta.nickname || accountName;
        const syncStartTime = Math.floor(Date.now() / 1000);

        await updateSyncStatus(uid, `Iniciando...`, 0, false, accountName);
        
        const orderIdList = await getAllOrderIdsForAccount(uid, conta.id, conta.lastSyncTimestamp);
        if (orderIdList.length === 0) {
            await contaRef.update({ lastSyncTimestamp: syncStartTime });
            await updateSyncStatus(uid, `Nenhuma venda nova ou atualização encontrada.`, 100, false, accountName, 0);
            return;
        }

        await updateSyncStatus(uid, `Encontrados ${orderIdList.length} IDs. Buscando detalhes...`, 20, false, accountName);
        const allVendasComDetalhes = await getOrderDetailsInParallel(uid, conta.id, orderIdList, (progress, processed, total) => {
            const prog = 20 + Math.floor(progress * 70);
            updateSyncStatus(uid, `Processando detalhes... (${processed} de ${total})`, prog, false, accountName);
        });
        
        const salesAddedCount = allVendasComDetalhes.length;
        const updateData = { lastSyncTimestamp: syncStartTime };

        if (salesAddedCount > 0) {
            updateData.hasSales = true;
            
            await updateSyncStatus(uid, `Salvando ${salesAddedCount} vendas...`, 95, false, accountName);
            const firestoreBatchChunks = chunkArray(allVendasComDetalhes, 400);
            for (const batchChunk of firestoreBatchChunks) {
                const batch = db.batch();
                batchChunk.forEach(venda => {
                    if (venda && venda.id) {
                        const vendaDocRef = db.collection('users').doc(uid).collection('mlVendas').doc(venda.id.toString());
                        const finalVendaData = { ...venda, nomeConta: accountName };
                        batch.set(vendaDocRef, cleanObject(finalVendaData), { merge: true });
                    }
                });
                await batch.commit();
            }
        }

        await contaRef.update(updateData);
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
    const dateQuery = `&order.date_created=${dateFrom.toISOString().slice(0, -5)}Z,${dateTo.toISOString().slice(0, -5)}Z`;
    
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
    dateFrom.setMinutes(dateFrom.getMinutes() - 60); // Margem de segurança de 1 hora
    const dateTo = new Date();
    return await fetchOrderIdsForDateRange(token, accountId, dateFrom, dateTo);
}

async function getAllOrderIdsForAccount(uid, accountId, lastSyncTimestamp) {
    const isInitialSync = !lastSyncTimestamp;
    if (isInitialSync) {
        console.log(`[ML Sync] Sincronização Inicial para conta ${accountId}. Buscando todo o histórico.`);
        // Para sync inicial, busca os últimos 60 dias para não sobrecarregar a API
        const dateTo = new Date();
        const dateFrom = new Date();
        dateFrom.setDate(dateTo.getDate() - 60);
        const token = await getValidTokenML(uid, accountId);
        return await fetchOrderIdsForDateRange(token, accountId, dateFrom, dateTo);
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

    const chunks = chunkArray(orderIdList, 20); // Processa em lotes de 20

    for (const chunk of chunks) {
        const promises = chunk.map(orderId => {
            if (!orderId) return Promise.resolve(null);
            const url = `https://api.mercadolibre.com/orders/${orderId}`;
            return fetch(url, { headers: { Authorization: `Bearer ${token}` }, timeout: AXIOS_TIMEOUT })
                .then(res => res.ok ? res.json() : null)
                .catch(() => null);
        });

        const results = await Promise.all(promises);
        const validDetails = results.filter(Boolean);
        
        const processedDetails = await Promise.all(validDetails.map(order => processSingleOrderDetail(token, order)));
        allVendasCompletas.push(...processedDetails.filter(Boolean));
        
        processedCount += chunk.length;
        if (onProgress) onProgress(processedCount / totalCount, processedCount, totalCount);

        await delay(333); // Pausa para não sobrecarregar a API
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
        
        const orderItems = Array.isArray(orderDetails.order_items) ? orderDetails.order_items : [];
        const totalQuantity = orderItems.reduce((acc, item) => acc + Number(item.quantity || 0), 0);

        const custoFreteAjustado = calcularFreteAdjust({
            shipment_logistic_type: shipmentDetails?.logistic_type,
            base_cost: shipmentDetails?.base_cost,
            shipment_list_cost: shipmentDetails?.list_cost,
            shipment_cost: shipmentDetails?.cost,
            order_cost: orderDetails?.total_amount,
            quantity: totalQuantity
        });
        
        const saleFee = orderItems.reduce((acc, item) => acc + (item.sale_fee || 0), 0);
        
        const valorTotal = Number(orderDetails.total_amount || 0);
        const custoProduto = 0;
        const margemContribuicao = valorTotal - saleFee - custoFreteAjustado - custoProduto;
        
        const statusFinal = (orderDetails.status === 'paid') ? 'pago' : 'cancelado';

        return {
            id: orderDetails.id?.toString(),
            idVendaMarketplace: orderDetails.id?.toString(),
            canalVenda: 'Mercado Livre',
            status: statusFinal,
            statusOriginal: orderDetails.status,
            dataHora: orderDetails.date_created,
            date_created: orderDetails.date_created,
            date_closed: orderDetails.date_closed,
            cliente: orderDetails.buyer?.nickname || `${orderDetails.buyer?.first_name || ''} ${orderDetails.buyer?.last_name || ''}`.trim() || 'Desconhecido',
            nomeProdutoVendido: orderItems[0]?.item?.title || '-',
            valorTotalVenda: valorTotal,
            txPlataforma: saleFee,
            custoFrete: custoFreteAjustado, 
            custoProduto: custoProduto,
            margemContribuicao: margemContribuicao,
            tipoAnuncio: orderItems[0]?.listing_type_id || 'Não informado',
            tipoEntrega: shipmentDetails.shipping_option?.name || shipmentDetails.logistic_type || 'Não informado',
            seller: { id: orderDetails.seller?.id, nickname: orderDetails.seller?.nickname },
            order_items: orderItems.map(item => ({
                item: { id: item.item?.id, title: item.item?.title, seller_sku: item.item?.seller_sku },
                quantity: item.quantity, unit_price: item.unit_price, sale_fee: item.sale_fee, listing_type_id: item.listing_type_id,
            })),
            payments: (orderDetails.payments || []).map(p => ({ id: p.id, status: p.status, transaction_amount: p.transaction_amount })),
            shipping: { id: orderDetails.shipping?.id, status: orderDetails.shipping?.status, logistic_type: orderDetails.shipping?.logistic_type },
            shipping_details: {
                id: shipmentDetails.id, status: shipmentDetails.status, logistic_type: shipmentDetails.logistic_type,
                base_cost: shipmentDetails.base_cost, list_cost: shipmentDetails.list_cost, cost: shipmentDetails.cost,
            }
        };
    } catch (error) {
        console.warn(`[ML Process] Erro ao processar venda ${orderDetails?.id}: ${error.message}`);
        return null;
    }
}

// ROTA PARA FORÇAR REPROCESSAMENTO DE VENDAS EXISTENTES
router.post('/force-recalc-vendas', async (req, res) => {
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
    
    try {
        const vendasSnap = await db.collection('users').doc(uid).collection('mlVendas').get();
        if (vendasSnap.empty) return res.json({ message: 'Nenhuma venda encontrada para recalcular.' });

        let updatedCount = 0;
        const batchCommits = [];

        const chunks = chunkArray(vendasSnap.docs, 400);

        for (const chunk of chunks) {
            const batch = db.batch();
            for (const doc of chunk) {
                const vendaData = doc.data();
                const shipmentDetails = vendaData.shipping_details || {};
                const orderItems = Array.isArray(vendaData.order_items) ? vendaData.order_items : [];
                const totalQuantity = orderItems.reduce((acc, item) => acc + Number(item.quantity || 0), 0);

                const custoFreteAjustado = calcularFreteAdjust({
                    shipment_logistic_type: shipmentDetails?.logistic_type,
                    base_cost: shipmentDetails?.base_cost,
                    shipment_list_cost: shipmentDetails?.list_cost,
                    shipment_cost: shipmentDetails?.cost,
                    order_cost: vendaData.valorTotalVenda,
                    quantity: totalQuantity
                });

                const valorTotal = Number(vendaData.valorTotalVenda || 0);
                const taxa = Number(vendaData.txPlataforma || 0);
                const custoProduto = Number(vendaData.custoProduto || 0);
                const margemContribuicao = valorTotal - taxa - custoFreteAjustado - custoProduto;

                batch.update(doc.ref, {
                    custoFrete: custoFreteAjustado,
                    margemContribuicao: margemContribuicao,
                    updatedAt: new Date().toISOString()
                });
                updatedCount++;
            }
            batchCommits.push(batch.commit());
        }

        await Promise.all(batchCommits);
        
        res.json({ message: `Vendas recalculadas com sucesso: ${updatedCount}` });
    } catch (error) {
        console.error("Erro ao forçar recálculo de vendas:", error);
        res.status(500).json({ error: 'Erro ao recalcular vendas', detalhe: error.message });
    }
});

module.exports = router;
