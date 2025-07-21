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
            bling: blingData || null
        });
    } catch (error) {
        res.status(500).json({ success: false, connected: false, error: 'Erro ao verificar status.' });
    }
});

// --- LÓGICA DE SINCRONIZAÇÃO COM O BLING ---

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function requestWithRetry(url, headers, maxRetries = 5) {
    let lastError = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            console.log(`[RequestWithRetry] Tentando acessar: ${url} (Tentativa ${attempt}/${maxRetries})`);
            const response = await axios.get(url, { headers, timeout: 30000 });
            console.log(`[RequestWithRetry] Sucesso: ${url}`);
            return response;
        } catch (error) {
            lastError = error;
            const retryableErrorCodes = ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'];
            const isNetworkError = retryableErrorCodes.includes(error.code);
            const isRateLimitError = error.response?.status === 429;

            if (isNetworkError || isRateLimitError) {
                if (attempt === maxRetries) {
                    break; 
                }
                const waitTime = Math.min(Math.pow(2, attempt) * 1000, 15000); 
                const reason = isRateLimitError ? `Limite da API (429)` : `Erro de rede (${error.code})`;
                
                console.warn(`[RequestWithRetry] ${reason}. Tentando novamente em ${waitTime / 1000}s...`);
                await delay(waitTime);
            } else {
                console.error(`[RequestWithRetry] Erro não recuperável em ${url}:`, error.message);
                throw error;
            }
        }
    }
    console.error(`[RequestWithRetry] Falha final após ${maxRetries} tentativas para ${url}. Último erro:`, lastError.message);
    throw new Error(`Falha ao acessar ${url} após ${maxRetries} tentativas. Último erro: ${lastError.message}`);
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

async function updateSyncStatus(uid, payload) {
    if (!uid) return;
    try {
        const statusRef = db.collection('users').doc(uid).collection('syncStatus').doc('bling');
        if (payload === null) {
            await statusRef.delete();
        } else {
            await statusRef.set({
                ...payload,
                timestamp: new Date().toISOString(),
            });
        }
    } catch (error) {
        console.error('[Sync Status] Erro ao atualizar status:', error);
    }
}

async function saveItemsInBatches(uid, items, collectionName, dataType, lookups) {
    const batchSize = 500;
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

// FUNÇÃO DE SINCRONIZAÇÃO ATUALIZADA PARA SER RESUMÍVEL
async function syncDataType(uid, accessToken, dataType, apiPath, collectionName, lookups = {}) {
    const nomeAmigavel = dataType.replace('-', ' ');
    console.log(`[Sync] Iniciando sincronização de ${nomeAmigavel} para UID: ${uid}`);

    const isAccountSync = dataType === 'contas-pagar' || dataType === 'contas-receber';

    // 1. Verifica quais IDs já foram salvos no Firestore para este tipo de dado.
    const savedIds = new Set();
    if (isAccountSync) {
        await updateSyncStatus(uid, { syncing: true, message: `Verificando registros de ${nomeAmigavel} já salvos...` });
        try {
            const snapshot = await db.collection('users').doc(uid).collection(collectionName).get();
            snapshot.forEach(doc => savedIds.add(doc.id));
            console.log(`[Sync Check] Encontrados ${savedIds.size} registros de ${nomeAmigavel} pré-existentes.`);
        } catch (e) {
            console.error(`[Sync Check] Erro ao verificar registros existentes para ${collectionName}:`, e);
        }
    }

    // 2. Busca a lista completa de itens do Bling.
    let pagina = 1;
    let hasMoreData = true;
    const allItemsFromList = [];
    while (hasMoreData) {
        try {
            await updateSyncStatus(uid, { syncing: true, message: `Buscando lista de ${nomeAmigavel}, página ${pagina}...` });
            const listUrl = `https://www.bling.com.br/Api/v3${apiPath}?pagina=${pagina}&limite=100`;
            const listResponse = await requestWithRetry(listUrl, { 'Authorization': `Bearer ${accessToken}` });
            const items = listResponse.data?.data || [];
            allItemsFromList.push(...items);
            hasMoreData = items.length === 100;
            pagina++;
            if (hasMoreData) await delay(200);
        } catch (error) {
            console.error(`[Sync Fetch] Erro ao buscar página ${pagina} de ${nomeAmigavel}:`, error.message);
            await updateSyncStatus(uid, { syncing: true, message: `Erro ao buscar ${nomeAmigavel} na página ${pagina}.` });
            throw error;
        }
    }

    // 3. Filtra para obter apenas os itens que ainda não foram salvos.
    const itemsToProcess = allItemsFromList.filter(item => !savedIds.has(String(item.id)));

    if (itemsToProcess.length === 0) {
        console.log(`[Sync] Nenhum item novo de ${nomeAmigavel} para sincronizar.`);
        // Para lookups, mesmo sem itens novos, garantimos que a coleção esteja atualizada.
        if (!isAccountSync) {
             await saveItemsInBatches(uid, allItemsFromList, collectionName, dataType, lookups);
        }
        return;
    }

    console.log(`[Sync] Total de itens na lista do Bling: ${allItemsFromList.length}. Itens novos para processar: ${itemsToProcess.length}.`);

    // Para categorias e formas de pagamento, a lista já contém todos os dados. Salva tudo de uma vez.
    if (!isAccountSync) {
        await saveItemsInBatches(uid, itemsToProcess, collectionName, dataType, lookups);
        return;
    }

    // 4. Para contas, busca os detalhes dos itens novos e salva em lotes contínuos.
    const CONCURRENCY_LIMIT = 10;
    const BATCH_SAVE_SIZE = 50; // Salva no Firestore a cada 50 itens processados.
    const queue = [...itemsToProcess];
    const totalItemsToProcess = itemsToProcess.length;
    let itemsProcessed = 0;
    
    const detailedItemsToSave = [];
    const lock = { isSaving: false }; // Lock para evitar escritas simultâneas no banco.

    const saveBatch = async () => {
        if (lock.isSaving || detailedItemsToSave.length === 0) return;

        lock.isSaving = true;
        const batchToSave = detailedItemsToSave.splice(0, detailedItemsToSave.length);
        
        try {
            await saveItemsInBatches(uid, batchToSave, collectionName, dataType, lookups);
            console.log(`[Sync Save] Lote de ${batchToSave.length} itens de ${nomeAmigavel} salvo.`);
        } catch (e) {
            console.error(`[Sync Save] Erro ao salvar lote:`, e);
            // Devolve os itens para o array para tentar salvar novamente.
            detailedItemsToSave.unshift(...batchToSave);
        } finally {
            lock.isSaving = false;
        }
    };

    async function worker() {
        while (queue.length > 0) {
            const itemFromList = queue.shift();
            if (!itemFromList) continue;
            try {
                const response = await requestWithRetry(`https://www.bling.com.br/Api/v3${apiPath}/${itemFromList.id}`, { 'Authorization': `Bearer ${accessToken}` });
                if (response?.data?.data) {
                    detailedItemsToSave.push(response.data.data);
                }
            } catch (error) {
                console.error(`[Sync Detail] Erro ao buscar detalhe do item ${itemFromList.id}:`, error.message);
            }
            itemsProcessed++;
            await updateSyncStatus(uid, { syncing: true, message: `Processando ${itemsProcessed}/${totalItemsToProcess} de ${nomeAmigavel}...` });

            if (detailedItemsToSave.length >= BATCH_SAVE_SIZE) {
                await saveBatch();
            }
        }
    }

    const workers = Array.from({ length: CONCURRENCY_LIMIT }, () => worker());
    await Promise.all(workers);

    // Garante que o último lote seja salvo.
    await saveBatch();

    console.log(`[Sync Detail] Processamento de ${nomeAmigavel} concluído. ${itemsProcessed} itens processados.`);
}


const syncConfig = {
    'contas-pagar': { path: '/contas/pagar', collection: 'blingContasPagar' },
    'contas-receber': { path: '/contas/receber', collection: 'blingContasReceber' },
    'categorias': { path: '/categorias/receitas-despesas', collection: 'blingCategorias' },
    'formas-pagamentos': { path: '/formas-pagamentos', collection: 'blingFormasPagamentos' },
};

async function startSingleSync(uid, dataType) {
    const nomeAmigavel = dataType.replace(/-/g, ' ');
    console.log(`[Sync] Requisição de sincronização para ${dataType} (UID: ${uid})`);
    try {
        await updateSyncStatus(uid, { syncing: true, message: `Iniciando sincronização de ${nomeAmigavel}...` });
        const accessToken = await getValidToken(uid);
        let lookups = {};

        const isFullSync = dataType === 'contas-pagar' || dataType === 'contas-receber';
        if (isFullSync) {
            await updateSyncStatus(uid, { syncing: true, message: 'Sincronização: Carregando categorias e formas de pagamento...' });
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
            await updateSyncStatus(uid, { syncing: true, message: 'Contas a Pagar concluído. Iniciando Contas a Receber...' });
            const receberConfig = syncConfig['contas-receber'];
            await syncDataType(uid, accessToken, 'contas-receber', receberConfig.path, receberConfig.collection, lookups);
            finalMessage = 'Sincronização de Contas a Pagar e a Receber concluída!';
        }

        await updateSyncStatus(uid, { syncing: false, message: finalMessage, completedAt: new Date().toISOString() });
        setTimeout(() => updateSyncStatus(uid, null), 8000);
    } catch (error) {
        console.error(`[Sync] Erro na sincronização de ${dataType} para UID ${uid}:`, error.message);
        await updateSyncStatus(uid, { syncing: false, message: `Erro na sincronização de ${nomeAmigavel}. Por favor, tente novamente.`, error: true });
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
        console.error(`[Sync Route] Erro na sincronização de ${dataType} (UID: ${uid}):`, err.message);
    });

    res.status(202).json({
        success: true,
        message: `Sincronização de ${dataType} iniciada. O status será atualizado em tempo real.`,
    });
});

module.exports = router;
