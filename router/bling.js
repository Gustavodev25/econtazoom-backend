const express = require('express');
const axios = require('axios');
const qs = require('querystring');
const router = express.Router();
const { db, admin } = require('../firebase');
const multer = require('multer');

// --- CONFIGURAÇÃO DE UPLOAD ---
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

// --- CONSTANTES BLING ---
const BLING_CLIENT_ID = process.env.BLING_CLIENT_ID || '57f339b6be5fdc0d986c1170b709b8d82ece3a76';
const BLING_CLIENT_SECRET = process.env.BLING_CLIENT_SECRET || '5f59f5f4610f20bfd74984f151bcca343cb1375d68cc27216c4b2bc8a97d';

// --- FUNÇÕES AUXILIARES DE AUTENTICAÇÃO ---

async function getValidToken(uid) {
    const userDoc = await db.collection('users').doc(uid).get();
    const bling = userDoc.data()?.bling;

    if (!bling?.access_token) {
        throw new Error('Conta Bling não conectada. Por favor, autorize o acesso.');
    }

    const tokenCreationTime = new Date(bling.connectedAt).getTime();
    const expiresInMilliseconds = (bling.expires_in - 300) * 1000;

    if (Date.now() - tokenCreationTime > expiresInMilliseconds) {
        console.log(`[Token Check] Token para UID ${uid} expirado. Atualizando...`);
        return await refreshToken(bling, uid);
    }

    return bling.access_token;
}

async function refreshToken(bling, uid) {
    try {
        console.log(`[Token Refresh] Solicitando novo token para UID: ${uid}`);
        const basicAuth = Buffer.from(`${BLING_CLIENT_ID}:${BLING_CLIENT_SECRET}`).toString('base64');
        const refreshRes = await axios.post(
            'https://www.bling.com.br/Api/v3/oauth/token',
            qs.stringify({
                grant_type: 'refresh_token',
                refresh_token: bling.refresh_token,
            }),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Authorization': `Basic ${basicAuth}`,
                },
            }
        );

        const { access_token, refresh_token, expires_in } = refreshRes.data;
        const newBlingData = {
            ...bling,
            access_token,
            refresh_token,
            expires_in,
            connectedAt: new Date().toISOString(),
        };

        await db.collection('users').doc(uid).set({ bling: newBlingData }, { merge: true });
        console.log(`[Token Refresh] Token para UID ${uid} atualizado com sucesso.`);
        return access_token;
    } catch (refreshErr) {
        console.error(`[Token Refresh] FALHA ao atualizar token para UID ${uid}:`, refreshErr.response?.data || refreshErr.message);
        await db.collection('users').doc(uid).update({ bling: admin.firestore.FieldValue.delete() });
        throw new Error('Sua conexão com o Bling expirou. Por favor, conecte-se novamente.');
    }
}

// --- ROTAS PARA BUSCAR DADOS DO FIRESTORE ---

async function getFirestoreData(req, res, collectionName) {
    const { uid } = req.query;
    if (!uid) {
        return res.status(400).json({ success: false, error: 'UID é obrigatório' });
    }
    try {
        let query = db.collection('users').doc(uid).collection(collectionName);
        if (collectionName === 'blingContasPagar' || collectionName === 'blingContasReceber') {
            query = query.orderBy('vencimento', 'desc');
        }
        const snapshot = await query.get();
        const data = snapshot.empty ? [] : snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        res.status(200).json({ success: true, data });
    } catch (error) {
        console.error(`[Firestore GET] Erro ao buscar dados de ${collectionName} para o UID ${uid}:`, error);
        res.status(500).json({ success: false, error: `Falha ao buscar dados de ${collectionName}` });
    }
}

router.get('/firestore/contas-pagar', (req, res) => getFirestoreData(req, res, 'blingContasPagar'));
router.get('/firestore/contas-receber', (req, res) => getFirestoreData(req, res, 'blingContasReceber'));
router.get('/firestore/categorias', (req, res) => getFirestoreData(req, res, 'blingCategorias'));
router.get('/firestore/formas-pagamentos', (req, res) => getFirestoreData(req, res, 'blingFormasPagamentos'));

router.get('/status', async (req, res) => {
    const { uid } = req.query;
    if (!uid) {
        return res.status(400).json({ success: false, error: 'UID é obrigatório' });
    }
    try {
        const userDoc = await db.collection('users').doc(uid).get();
        const blingData = userDoc.data()?.bling;
        res.status(200).json({
            success: true,
            connected: !!(blingData && blingData.access_token),
            connectedAt: blingData?.connectedAt || null,
        });
    } catch (error) {
        res.status(500).json({ success: false, connected: false, error: 'Erro ao verificar status.' });
    }
});

// --- LÓGICA DE SINCRONIZAÇÃO COM O BLING ---

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function requestWithRetry(url, headers, maxRetries = 5) {
    let retries = 0;
    while (retries < maxRetries) {
        try {
            console.log(`[RequestWithRetry] Tentando acessar: ${url} (Tentativa ${retries + 1})`);
            const response = await axios.get(url, { headers, timeout: 30000 });
            console.log(`[RequestWithRetry] Sucesso: ${url}`);
            return response;
        } catch (error) {
            if (error.code === 'ECONNABORTED') {
                console.error(`[RequestWithRetry] Timeout na requisição: ${url}`);
            }
            if (error.response?.status === 429) {
                retries++;
                const waitTime = Math.min(Math.pow(2, retries) * 1000, 10000);
                console.warn(`[Rate Limit] Limite da API atingido. Tentando novamente em ${waitTime / 1000}s...`);
                await delay(waitTime);
            } else {
                throw error;
            }
        }
    }
    throw new Error(`[Rate Limit] Falha após ${maxRetries} tentativas.`);
}

async function fetchAllLookups(accessToken) {
    const lookups = {
        categoriasMap: new Map(),
        formasPagamentoMap: new Map(),
    };
    const configs = [
        { name: 'categorias', path: '/categorias/receitas-despesas', map: lookups.categoriasMap },
        { name: 'formas-pagamentos', path: '/formas-pagamentos', map: lookups.formasPagamentoMap },
    ];

    for (const config of configs) {
        let pagina = 1;
        let hasMoreData = true;
        while (hasMoreData) {
            const url = `https://www.bling.com.br/Api/v3${config.path}?pagina=${pagina}&limite=100`;
            try {
                const response = await requestWithRetry(url, { 'Authorization': `Bearer ${accessToken}` });
                const items = response.data?.data || [];
                items.forEach(item => config.map.set(String(item.id), item));
                hasMoreData = items.length === 100;
                pagina++;
                if (hasMoreData) await delay(200);
            } catch (error) {
                console.error(`[Lookups] Erro ao buscar ${config.name}:`, error.message);
                hasMoreData = false;
            }
        }
        console.log(`[Lookups] Total de ${config.map.size} ${config.name} encontradas.`);
    }
    return lookups;
}

function mapBlingToFirestore(item, dataType, lookups = {}) {
    const baseData = {
        id: String(item.id),
        origem: 'bling',
        lastSyncedAt: new Date().toISOString(),
    };

    if (dataType === 'categorias') {
        return {
            ...baseData,
            descricao: item.descricao || 'Sem descrição',
            tipo: item.tipo ?? null,
        };
    }
    if (dataType === 'formas-pagamentos') {
        return {
            ...baseData,
            descricao: item.descricao || 'Sem descrição',
        };
    }

    const tipoLancamento = dataType === 'contas-pagar' ? 'despesa' : 'receita';
    const categoriaId = item.categoria?.id ? String(item.categoria.id) : null;
    const categoriaInfo = categoriaId ? lookups.categoriasMap?.get(categoriaId) : null;
    const finalCategoriaDescricao = categoriaInfo?.descricao || 'Sem Categoria';

    const formaPagamentoId = item.formaPagamento?.id ?? item.portador?.id ?? null;
    const formaPagamentoInfo = formaPagamentoId ? lookups.formasPagamentoMap?.get(String(formaPagamentoId)) : null;
    let portadorDescricao = formaPagamentoInfo?.descricao || item.formaPagamento?.descricao || item.portador?.descricao || 'N/A';
    if (portadorDescricao === 'N/A') {
        portadorDescricao = dataType === 'contas-pagar' ? 'Conta a pagar' : 'Conta a receber';
    }

    return {
        ...baseData,
        vencimento: item.vencimento || null,
        valor: item.valor || 0,
        situacao: item.situacao || 'N/A',
        vendedor: item.contato?.nome || 'N/A',
        descricao: item.historico || '',
        portador: portadorDescricao,
        categoria: {
            id: categoriaId || '',
            descricao: finalCategoriaDescricao,
        },
        dataPagamento: (item.situacao === 2 || item.situacao === 3) ? (item.dataPagamento || item.vencimento || null) : null,
        tipo: tipoLancamento,
    };
}

async function updateSyncStatus(uid, message) {
    if (!uid) return;
    try {
        await db.collection('users').doc(uid).collection('syncStatus').doc('bling').set({
            message,
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        console.error('[Sync Status] Erro ao atualizar status:', error);
    }
}

async function saveItemsInBatches(uid, items, collectionName, dataType, lookups) {
    const batchSize = 500; // Firestore batch limit
    const batches = [];
    for (let i = 0; i < items.length; i += batchSize) {
        const batch = db.batch();
        const chunk = items.slice(i, i + batchSize);
        chunk.forEach(item => {
            const mappedData = mapBlingToFirestore(item, dataType, lookups);
            const docRef = db.collection('users').doc(uid).collection(collectionName).doc(mappedData.id);
            batch.set(docRef, mappedData, { merge: true });
        });
        batches.push(batch.commit());
    }
    await Promise.all(batches);
    console.log(`[Sync Save] ${batches.length} lotes para ${collectionName} salvos (${items.length} itens).`);
}

async function syncDataType(uid, accessToken, dataType, apiPath, collectionName, lookups = {}) {
    const nomeAmigavel = dataType.replace('-', ' ');
    console.log(`[Sync] Iniciando sincronização de ${nomeAmigavel} para UID: ${uid}`);
    let pagina = 1;
    let hasMoreData = true;
    const allItems = [];
    const limitePorPagina = 100;

    while (hasMoreData) {
        try {
            await updateSyncStatus(uid, `Sincronização: Buscando ${nomeAmigavel}, página ${pagina}...`);
            const listUrl = `https://www.bling.com.br/Api/v3${apiPath}?pagina=${pagina}&limite=${limitePorPagina}`;
            const listResponse = await requestWithRetry(listUrl, { 'Authorization': `Bearer ${accessToken}` });
            const items = listResponse.data?.data || [];
            allItems.push(...items);
            hasMoreData = items.length === limitePorPagina;
            pagina++;
            if (hasMoreData) await delay(200);
        } catch (error) {
            console.error(`[Sync Fetch] Erro ao buscar página ${pagina} de ${nomeAmigavel}:`, error.message);
            await updateSyncStatus(uid, `Erro ao buscar ${nomeAmigavel} na página ${pagina}.`);
            throw error;
        }
    }

    if (allItems.length === 0) {
        console.log(`[Sync] Nenhum item encontrado para ${nomeAmigavel}.`);
        return;
    }

    const isAccountSync = dataType === 'contas-pagar' || dataType === 'contas-receber';
    if (!isAccountSync) {
        await saveItemsInBatches(uid, allItems, collectionName, dataType, lookups);
        return;
    }

    // Process details with controlled concurrency and incremental saves
    console.log(`[Sync Detail] Processando detalhes para ${allItems.length} itens de ${nomeAmigavel}...`);
    const CONCURRENCY_LIMIT = 15;
    const BATCH_SAVE_SIZE = 100; // Save after every 100 items
    const queue = [...allItems];
    let itemsProcessed = 0;
    const totalItems = allItems.length;
    let batchItems = [];

    async function worker() {
        while (queue.length > 0) {
            const item = queue.shift();
            if (!item) continue;
            try {
                const response = await requestWithRetry(`https://www.bling.com.br/Api/v3${apiPath}/${item.id}`, { 'Authorization': `Bearer ${accessToken}` });
                if (response?.data?.data) {
                    batchItems.push(response.data.data);
                }
            } catch (error) {
                console.error(`[Sync Detail] Erro ao buscar detalhe do item ${item.id}:`, error.message);
            }
            itemsProcessed++;
            if (batchItems.length >= BATCH_SAVE_SIZE || itemsProcessed === totalItems) {
                if (batchItems.length > 0) {
                    await updateSyncStatus(uid, `Sincronização: Salvando lote de ${batchItems.length} registros de ${nomeAmigavel} (${itemsProcessed}/${totalItems})...`);
                    await saveItemsInBatches(uid, batchItems, collectionName, dataType, lookups);
                    console.log(`[Sync Detail] Lote de ${batchItems.length} itens salvo (${itemsProcessed}/${totalItems}).`);
                    batchItems = []; // Clear batch after saving
                }
            }
            if (itemsProcessed % 100 === 0 || itemsProcessed === totalItems) {
                await updateSyncStatus(uid, `Sincronização: Processando ${itemsProcessed}/${totalItems} de ${nomeAmigavel}...`);
            }
        }
    }

    const workers = Array.from({ length: CONCURRENCY_LIMIT }, () => worker());
    await Promise.all(workers);

    // Save any remaining items
    if (batchItems.length > 0) {
        await updateSyncStatus(uid, `Sincronização: Salvando lote final de ${batchItems.length} registros de ${nomeAmigavel}...`);
        await saveItemsInBatches(uid, batchItems, collectionName, dataType, lookups);
        console.log(`[Sync Detail] Lote final de ${batchItems.length} itens salvo.`);
    }

    console.log(`[Sync Detail] Processamento concluído. ${itemsProcessed} itens processados.`);
}

const syncConfig = {
    'contas-pagar': { path: '/contas/pagar', collection: 'blingContasPagar' },
    'contas-receber': { path: '/contas/receber', collection: 'blingContasReceber' },
    'categorias': { path: '/categorias/receitas-despesas', collection: 'blingCategorias' },
    'formas-pagamentos': { path: '/formas-pagamentos', collection: 'blingFormasPagamentos' },
};

async function startSingleSync(uid, dataType) {
    const nomeAmigavel = dataType.replace('-', ' ');
    console.log(`[Sync] Requisição de sincronização para ${dataType} (UID: ${uid})`);
    try {
        await updateSyncStatus(uid, `Iniciando sincronização de ${nomeAmigavel}...`);
        const accessToken = await getValidToken(uid);
        let lookups = {};

        const isFullSync = dataType === 'contas-pagar' || dataType === 'contas-receber';
        if (isFullSync) {
            await updateSyncStatus(uid, 'Sincronização: Carregando categorias e formas de pagamento...');
            lookups = await fetchAllLookups(accessToken);
            await Promise.all([
                syncDataType(uid, accessToken, 'categorias', syncConfig['categorias'].path, syncConfig['categorias'].collection, {}),
                syncDataType(uid, accessToken, 'formas-pagamentos', syncConfig['formas-pagamentos'].path, syncConfig['formas-pagamentos'].collection, {}),
            ]);
        }

        const config = syncConfig[dataType];
        if (!config) throw new Error(`Tipo de dado desconhecido: ${dataType}`);

        await syncDataType(uid, accessToken, dataType, config.path, config.collection, lookups);

        let finalMessage = `Sincronização de ${nomeAmigavel} concluída!`;
        if (dataType === 'contas-pagar') {
            const receberConfig = syncConfig['contas-receber'];
            await syncDataType(uid, accessToken, 'contas-receber', receberConfig.path, receberConfig.collection, lookups);
            finalMessage = 'Sincronização de Contas a Pagar e a Receber concluída!';
        }

        await updateSyncStatus(uid, finalMessage);
        setTimeout(() => updateSyncStatus(uid, null), 8000);
    } catch (error) {
        console.error(`[Sync] Erro na sincronização de ${dataType} para UID ${uid}:`, error.message);
        await updateSyncStatus(uid, `Erro na sincronização de ${nomeAmigavel}.`);
        setTimeout(() => updateSyncStatus(uid, null), 10000);
        throw error;
    }
}

router.post('/sync/single', async (req, res) => {
    const { uid, dataType } = req.body;
    if (!uid || !dataType) {
        return res.status(400).json({ error: 'UID e dataType são obrigatórios' });
    }

    startSingleSync(uid, dataType).catch(err => {
        console.error(`[Sync Route] Erro na sincronização de ${dataType} (UID: ${uid}):`, err);
    });

    res.status(202).json({
        success: true,
        message: `Sincronização de ${dataType} iniciada. Dados serão atualizados em breve.`,
    });
});

module.exports = router;