const express = require('express');
const axios = require('axios');
const qs = require('querystring');
const router = express.Router();
const { db, admin } = require('../firebase'); // Ajuste o caminho se necessário

const BLING_CLIENT_ID = process.env.BLING_CLIENT_ID || '57f339b6be5fdc0d986c1170b709b8d82ece3a76';
const BLING_CLIENT_SECRET = process.env.BLING_CLIENT_SECRET || '5f59f5f4610f20bfd74984f151bcca343cb1375d68cc27216c4b2bc8a97d';
const BLING_SCOPES = process.env.BLING_SCOPES || 'vendas+contas+cadastros';

// --- FUNÇÕES AUXILIARES DE AUTENTICAÇÃO E CONFIGURAÇÃO ---
function getRedirectUri(req) {
    if (process.env.NODE_ENV === 'production' || !req.app.locals.ngrokUrl) {
        return 'https://econtazoom-backend.onrender.com/bling/callback';
    }
    return `${req.app.locals.ngrokUrl}/bling/callback`;
}

function getFrontendUrl() {
    if (process.env.NODE_ENV === 'production') {
        return 'https://econtazoom.com.br/contas';
    }
    return 'http://localhost:8080/contas';
}

// --- NOVA FUNÇÃO AUXILIAR PARA NOMES DE COLEÇÃO ---
/**
 * Retorna o nome da coleção do Firestore para um determinado tipo de dados do Bling.
 * @param {string} dataType - O tipo de dado (ex: 'contas-pagar', 'categorias').
 * @returns {string|null} O nome da coleção ou null se o tipo for inválido.
 */
function getFirestoreCollectionName(dataType) {
    const map = {
        'contas-pagar': 'blingContasPagar',
        'contas-receber': 'blingContasReceber',
        'categorias': 'blingCategorias',
        'formas-pagamentos': 'blingFormasPagamentos'
    };
    return map[dataType] || null;
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
                headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${basicAuth}` },
            }
        );
        const { access_token, refresh_token, expires_in } = refreshRes.data;
        const newBlingData = {
            ...bling,
            access_token,
            refresh_token,
            expires_in,
            connectedAt: new Date().toISOString()
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

async function getValidToken(uid) {
    const docSnap = await db.collection('users').doc(uid).get();
    const bling = docSnap.data()?.bling;
    if (!bling?.access_token) {
        throw new Error('Conta Bling não conectada');
    }
    const tokenCreationTime = new Date(bling.connectedAt).getTime();
    const expiresInMilliseconds = (bling.expires_in - 300) * 1000;
    if (Date.now() - tokenCreationTime > expiresInMilliseconds) {
        console.log(`[Token Check] Token para UID ${uid} expirado pelo tempo. Atualizando...`);
        return await refreshToken(bling, uid);
    }
    return bling.access_token;
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const blingRequestQueue = [];
let isProcessingQueue = false;

async function processBlingQueue() {
    if (isProcessingQueue) return;
    isProcessingQueue = true;
    while (blingRequestQueue.length > 0) {
        const { resolve, reject, url, config, accessToken, debugId } = blingRequestQueue.shift();
        try {
            await delay(350);
            const fullConfig = {
                ...config,
                headers: { ...config.headers, Authorization: `Bearer ${accessToken}`, 'Accept': 'application/json' }
            };
            console.log(`[Bling Queue] Attempting to request: '${url}' (ID: ${debugId})`);
            const response = await axios.get(url, fullConfig);
            resolve(response);
        } catch (error) {
            console.error(`[Bling Queue] Erro na requisição para '${url}' (ID: ${debugId}):`, error.response?.data || error.message);
            reject(error);
        }
    }
    isProcessingQueue = false;
}

async function makeBlingRequestQueued(url, config, accessToken, debugId) {
    return new Promise((resolve, reject) => {
        blingRequestQueue.push({ resolve, reject, url, config, accessToken, debugId });
        if (!isProcessingQueue) {
            processBlingQueue();
        }
    });
}

// --- ROTAS DE AUTENTICAÇÃO (sem alterações) ---
router.get('/auth', (req, res) => {
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
    const redirectUri = getRedirectUri(req);
    const state = Buffer.from(JSON.stringify({ uid })).toString('base64');
    const url = `https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=${BLING_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&scope=${BLING_SCOPES}`;
    res.redirect(url);
});
router.get('/callback', async (req, res) => {
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).json({ error: 'Code e state obrigatórios' });
    const redirectUri = getRedirectUri(req);
    try {
        const { uid } = JSON.parse(Buffer.from(state, 'base64').toString());
        const basicAuth = Buffer.from(`${BLING_CLIENT_ID}:${BLING_CLIENT_SECRET}`).toString('base64');
        const tokenRes = await axios.post(
            'https://www.bling.com.br/Api/v3/oauth/token',
            qs.stringify({ grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': `Basic ${basicAuth}` } }
        );
        const { access_token, refresh_token, expires_in } = tokenRes.data;
        await db.collection('users').doc(uid).set(
            { bling: { access_token, refresh_token, expires_in, connectedAt: new Date().toISOString() } },
            { merge: true }
        );
        res.redirect(getFrontendUrl() + '?bling=success');
    } catch (err) {
        res.redirect(getFrontendUrl() + `?bling=error&msg=${encodeURIComponent(err.response?.data?.error_description || err.message || 'Erro desconhecido')}`);
    }
});
router.post('/logout', async (req, res) => {
    const { uid } = req.body;
    if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
    try {
        await db.collection('users').doc(uid).update({ bling: admin.firestore.FieldValue.delete() });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Erro ao remover conta Bling' });
    }
});
router.get('/status', async (req, res) => {
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
    const docSnap = await db.collection('users').doc(uid).get();
    const bling = docSnap.data()?.bling;
    res.json({ connected: !!bling, bling });
});

// --- ROTAS DE LISTAGEM DO BLING (MODIFICADAS PARA FILTRAR POR PERÍODO FIXO) ---
router.get('/contas-pagar', async (req, res) => {
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
    try {
        const accessToken = await getValidToken(uid);
        // Remover limitador de 100 e buscar até 1941 registros
        const params = {
            ...req.query,
            dataPagamentoInicial: '2025-01-01',
            dataPagamentoFinal: '2025-06-30',
            limit: 1941 // Bling aceita o parâmetro 'limit'
        };
        const listUrl = 'https://www.bling.com.br/Api/v3/contas/pagar'.trim();
        const listResponse = await makeBlingRequestQueued(listUrl, { params }, accessToken, 'list-contas-pagar');
        res.json({ data: listResponse.data?.data });
    } catch (err) {
        res.status(500).json({ error: err.response?.data?.error_description || err.message || 'Erro ao buscar lista de contas a pagar' });
    }
});

router.get('/contas-receber', async (req, res) => {
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
    try {
        const accessToken = await getValidToken(uid);
        const params = {
            ...req.query,
            dataPagamentoInicial: '2025-01-01',
            dataPagamentoFinal: '2025-06-30'
        };
        const listUrl = 'https://www.bling.com.br/Api/v3/contas/receber'.trim();
        const listResponse = await makeBlingRequestQueued(listUrl, { params }, accessToken, 'list-contas-receber');
        res.json({ data: listResponse.data?.data });
    } catch (err) {
        res.status(500).json({ error: err.response?.data?.error_description || err.message || 'Erro ao buscar lista de contas a receber' });
    }
});

// Adicione o filtro de período para categorias e formas de pagamento, se a API aceitar parâmetros de data
router.get('/categorias/receitas-despesas', async (req, res) => {
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
    try {
        const accessToken = await getValidToken(uid);
        // Adiciona filtro de período se a API do Bling aceitar (caso contrário, não faz mal)
        const params = {
            ...req.query,
            dataInicial: '2025-01-01',
            dataFinal: '2025-06-30'
        };
        const listUrl = 'https://www.bling.com.br/Api/v3/categorias/receitas-despesas'.trim();
        const listResponse = await makeBlingRequestQueued(listUrl, { params }, accessToken, 'list-categorias');
        res.json({ data: listResponse.data?.data });
    } catch (err) {
        res.status(500).json({ error: err.response?.data?.error_description || err.message || 'Erro ao buscar categorias' });
    }
});

router.get('/formas-pagamentos', async (req, res) => {
    const { uid } = req.query;
    if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
    try {
        const accessToken = await getValidToken(uid);
        // Adiciona filtro de período se a API do Bling aceitar (caso contrário, não faz mal)
        const params = {
            ...req.query,
            dataInicial: '2025-01-01',
            dataFinal: '2025-06-30'
        };
        const listUrl = 'https://www.bling.com.br/Api/v3/formas-pagamentos'.trim();
        const listResponse = await makeBlingRequestQueued(listUrl, { params }, accessToken, 'list-formas-pagamento');
        res.json({ data: listResponse.data?.data });
    } catch (err) {
        res.status(500).json({ error: err.response?.data?.error_description || err.message || 'Erro ao buscar formas de pagamento' });
    }
});

// --- ROTAS DE DETALHES DO BLING (SALVAM NO FIRESTORE, SEM ALTERAÇÃO) ---

router.get('/contas-pagar-detalhe/:id', async (req, res) => {
    const { uid } = req.query;
    const { id } = req.params;
    if (!uid || !id) return res.status(400).json({ error: 'UID e ID da conta são obrigatórios' });
    try {
        const accessToken = await getValidToken(uid);
        const detailUrl = `https://www.bling.com.br/Api/v3/contas/pagar/${id}`.trim();
        const detailResponse = await makeBlingRequestQueued(detailUrl, {}, accessToken, `detail-pagar-${id}`);
        
        const detailData = detailResponse.data?.data;
        if (detailData) {
            const collectionName = getFirestoreCollectionName('contas-pagar');
            await db.collection('users').doc(uid).collection(collectionName).doc(String(id)).set(detailData, { merge: true });
        }

        res.json({ data: detailData });
    } catch (err) {
        if (err.response?.status === 429) {
             return res.status(429).json({ error: 'Limite de requisições Bling atingido.', details: err.response.data });
        }
        res.status(500).json({ error: err.response?.data?.error_description || err.message || 'Erro ao buscar detalhes da conta a pagar' });
    }
});

router.get('/contas-receber-detalhe/:id', async (req, res) => {
    const { uid } = req.query;
    const { id } = req.params;
    if (!uid || !id) return res.status(400).json({ error: 'UID e ID da conta são obrigatórios' });
    try {
        const accessToken = await getValidToken(uid);
        const detailUrl = `https://www.bling.com.br/Api/v3/contas/receber/${id}`.trim();
        const detailResponse = await makeBlingRequestQueued(detailUrl, {}, accessToken, `detail-receber-${id}`);

        const detailData = detailResponse.data?.data;
        if (detailData) {
            const collectionName = getFirestoreCollectionName('contas-receber');
            await db.collection('users').doc(uid).collection(collectionName).doc(String(id)).set(detailData, { merge: true });
        }

        res.json({ data: detailData });
    } catch (err) {
        if (err.response?.status === 429) {
             return res.status(429).json({ error: 'Limite de requisições Bling atingido.', details: err.response.data });
        }
        res.status(500).json({ error: err.response?.data?.error_description || err.message || 'Erro ao buscar detalhes da conta a receber' });
    }
});

router.get('/categorias/receitas-despesas/:idCategoria', async (req, res) => {
    const { uid } = req.query;
    const { idCategoria } = req.params;
    if (!uid || !idCategoria) return res.status(400).json({ error: 'UID e ID da categoria são obrigatórios' });
    try {
        const accessToken = await getValidToken(uid);
        const detailUrl = `https://www.bling.com.br/Api/v3/categorias/receitas-despesas/${idCategoria}`.trim();
        const detailResponse = await makeBlingRequestQueued(detailUrl, {}, accessToken, `detail-categoria-${idCategoria}`);

        const detailData = detailResponse.data?.data;
        if (detailData) {
            const collectionName = getFirestoreCollectionName('categorias');
            await db.collection('users').doc(uid).collection(collectionName).doc(String(idCategoria)).set(detailData, { merge: true });
        }

        res.json({ data: detailData });
    } catch (err) {
        if (err.response?.status === 429) {
             return res.status(429).json({ error: 'Limite de requisições Bling atingido.', details: err.response.data });
        }
        res.status(500).json({ error: err.response?.data?.error_description || err.message || 'Erro ao buscar detalhes da categoria' });
    }
});

router.get('/formas-pagamentos/:idFormaPagamento', async (req, res) => {
    const { uid } = req.query;
    const { idFormaPagamento } = req.params;
    if (!uid || !idFormaPagamento) return res.status(400).json({ error: 'UID e ID da forma de pagamento são obrigatórios' });
    try {
        const accessToken = await getValidToken(uid);
        const detailUrl = `https://www.bling.com.br/Api/v3/formas-pagamentos/${idFormaPagamento}`.trim();
        const detailResponse = await makeBlingRequestQueued(detailUrl, {}, accessToken, `detail-forma-pagamento-${idFormaPagamento}`);

        const detailData = detailResponse.data?.data;
        if (detailData) {
            const collectionName = getFirestoreCollectionName('formas-pagamentos');
            await db.collection('users').doc(uid).collection(collectionName).doc(String(idFormaPagamento)).set(detailData, { merge: true });
        }

        res.json({ data: detailData });
    } catch (err) {
        if (err.response?.status === 429) {
             return res.status(429).json({ error: 'Limite de requisições Bling atingido.', details: err.response.data });
        }
        res.status(500).json({ error: err.response?.data?.error_description || err.message || 'Erro ao buscar detalhes da forma de pagamento' });
    }
});


// --- NOVAS ROTAS PARA LER DADOS DO CACHE DO FIRESTORE ---

router.get('/firestore/:dataType', async (req, res) => {
    const { uid } = req.query;
    const { dataType } = req.params;

    if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
    
    const collectionName = getFirestoreCollectionName(dataType);
    if (!collectionName) return res.status(400).json({ error: 'Tipo de dado inválido' });

    try {
        const snapshot = await db.collection('users').doc(uid).collection(collectionName).get();
        if (snapshot.empty) {
            return res.json({ data: [] });
        }
        const data = snapshot.docs.map(doc => doc.data());
        res.json({ data });
    } catch (e) {
        console.error(`[Firestore Cache] Erro ao ler cache para ${collectionName}:`, e);
        res.status(500).json({ error: 'Erro ao ler dados do cache do Firestore' });
    }
});

// NOVA ROTA PARA IMPORTAÇÃO DE CONTAS A PAGAR VIA EXCEL
router.post('/firestore/contas-pagar/import', async (req, res) => {
    const { uid, conta } = req.body;
    if (!uid || !conta) return res.status(400).json({ error: 'UID e conta obrigatórios' });

    // Gera um ID aleatório se não vier do frontend
    let id = conta.id;
    if (!id) {
        id = 'excel_' + Date.now() + '_' + Math.floor(Math.random() * 1000000);
        conta.id = id;
    }

    // Se vier categoria como string, salva também na coleção de categorias se ainda não existir
    if (conta.categoria && typeof conta.categoria === 'string') {
        const categoriaId = conta.categoria.trim();
        if (categoriaId) {
            const categoriaRef = db.collection('users').doc(uid).collection('blingCategorias').doc(categoriaId);
            const catSnap = await categoriaRef.get();
            if (!catSnap.exists) {
                await categoriaRef.set({
                    id: categoriaId,
                    descricao: categoriaId,
                    tipo: 1
                }, { merge: true });
            }
            conta.categoria = { id: categoriaId, descricao: categoriaId, tipo: 1 };
        }
    }

    try {
        await db.collection('users').doc(uid).collection('blingContasPagar').doc(String(id)).set(conta, { merge: true });
        res.json({ success: true, id });
    } catch (e) {
        res.status(500).json({ error: 'Erro ao importar conta a pagar', details: e.message });
    }
});

// NOVA ROTA PARA IMPORTAÇÃO EM LOTE (IMPORTAR TODOS DE UMA VEZ)
router.post('/firestore/contas-pagar/import-lote', async (req, res) => {
    const { uid, contas } = req.body;
    if (!uid || !Array.isArray(contas) || contas.length === 0) {
        return res.status(400).json({ error: 'UID e contas obrigatórios' });
    }

    const batch = db.batch();
    const categoriasSet = new Set();

    contas.forEach((conta, idx) => {
        let id = conta.id;
        if (!id) {
            id = 'excel_' + Date.now() + '_' + Math.floor(Math.random() * 1000000) + '_' + idx;
            conta.id = id;
        }

        // Categoria: salva para criar depois
        if (conta.categoria && typeof conta.categoria === 'string') {
            categoriasSet.add(conta.categoria.trim());
            conta.categoria = { id: conta.categoria.trim(), descricao: conta.categoria.trim(), tipo: 1 };
        }

        const ref = db.collection('users').doc(uid).collection('blingContasPagar').doc(String(id));
        batch.set(ref, conta, { merge: true });
    });

    // Salva categorias básicas em lote
    const categoriasPromises = Array.from(categoriasSet).map(async (catId) => {
        if (!catId) return;
        const categoriaRef = db.collection('users').doc(uid).collection('blingCategorias').doc(catId);
        const catSnap = await categoriaRef.get();
        if (!catSnap.exists) {
            await categoriaRef.set({
                id: catId,
                descricao: catId,
                tipo: 1
            }, { merge: true });
        }
    });

    try {
        await Promise.all(categoriasPromises);
        await batch.commit();
        res.json({ success: true, count: contas.length });
    } catch (e) {
        res.status(500).json({ error: 'Erro ao importar contas a pagar em lote', details: e.message });
    }
});


module.exports = router;