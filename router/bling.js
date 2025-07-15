const express = require('express');
const axios = require('axios');
const qs = require('querystring');
const router = express.Router();
const { db, admin } = require('../firebase');
const multer = require('multer');

// --- CONFIGURAÇÃO DE UPLOAD ---
const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const BLING_CLIENT_ID = process.env.BLING_CLIENT_ID || '57f339b6be5fdc0d986c1170b709b8d82ece3a76';
const BLING_CLIENT_SECRET = process.env.BLING_CLIENT_SECRET || '5f59f5f4610f20bfd74984f151bcca343cb1375d68cc27216c4b2bc8a97d';
const BLING_SCOPES = process.env.BLING_SCOPES || 'vendas+contas+cadastros';

// --- FUNÇÕES AUXILIARES ---
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
            const response = await axios.get(url, fullConfig);
            resolve(response);
        } catch (error) {
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

async function uploadFileToStorage(file, uid) {
    const bucket = admin.storage().bucket();
    const fileName = `comprovantes/${uid}/${Date.now()}_${file.originalname.replace(/\s/g, '_')}`;
    const fileUpload = bucket.file(fileName);
    const blobStream = fileUpload.createWriteStream({
        metadata: {
            contentType: file.mimetype
        }
    });
    return new Promise((resolve, reject) => {
        blobStream.on('error', (error) => reject('Algo deu errado ao fazer upload do arquivo.'));
        blobStream.on('finish', async () => {
            try {
                await fileUpload.makePublic();
                const publicUrl = `https://storage.googleapis.com/${bucket.name}/${fileName}`;
                resolve(publicUrl);
            } catch (error) {
                reject('Erro ao obter a URL pública do arquivo.');
            }
        });
        blobStream.end(file.buffer);
    });
}

// --- ROTAS DE AUTENTICAÇÃO BLING ---
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

// --- ROTA DE LEITURA DO CACHE FIRESTORE ---
router.get('/firestore/:dataType', async (req, res) => {
    const { uid } = req.query;
    const { dataType } = req.params;
    if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
    const collectionName = getFirestoreCollectionName(dataType);
    if (!collectionName) return res.status(400).json({ error: 'Tipo de dado inválido' });
    try {
        const snapshot = await db.collection('users').doc(uid).collection(collectionName).get();
        const data = snapshot.docs.map(doc => doc.data());
        res.json({ data });
    } catch (e) {
        res.status(500).json({ error: 'Erro ao ler dados do cache do Firestore' });
    }
});

// --- ROTAS DE CRUD PARA CATEGORIAS ---
router.post('/firestore/categorias', async (req, res) => {
    const { uid, categoria } = req.body;
    if (!uid || !categoria || !categoria.descricao || !categoria.tipo) {
        return res.status(400).json({ error: 'Dados incompletos.' });
    }
    try {
        const id = 'manual_' + Date.now();
        const novaCategoria = { id, descricao: categoria.descricao, tipo: parseInt(categoria.tipo, 10), origem: 'manual' };
        await db.collection('users').doc(uid).collection('blingCategorias').doc(id).set(novaCategoria);
        res.json({ success: true, data: novaCategoria });
    } catch (e) {
        res.status(500).json({ error: 'Erro ao salvar categoria', details: e.message });
    }
});

router.put('/firestore/categorias/:id', async (req, res) => {
    const { uid, categoriaData } = req.body;
    const { id } = req.params;
    if (!uid || !categoriaData || !id) return res.status(400).json({ error: 'Dados incompletos.' });
    try {
        await db.collection('users').doc(uid).collection('blingCategorias').doc(id).update(categoriaData);
        res.json({ success: true, data: { ...categoriaData, id } });
    } catch (e) {
        res.status(500).json({ error: 'Erro ao atualizar categoria', details: e.message });
    }
});

router.delete('/firestore/categorias/:id', async (req, res) => {
    const { uid } = req.body;
    const { id } = req.params;
    if (!uid || !id) return res.status(400).json({ error: 'Dados incompletos.' });
    try {
        await db.collection('users').doc(uid).collection('blingCategorias').doc(id).delete();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Erro ao excluir categoria', details: e.message });
    }
});

// --- ROTAS DE CRUD PARA FORMAS DE PAGAMENTO ---
router.post('/firestore/formas-pagamentos', async (req, res) => {
    const { uid, formaPagamento } = req.body;
    if (!uid || !formaPagamento || !formaPagamento.descricao) return res.status(400).json({ error: 'Dados incompletos.' });
    try {
        const id = 'manual_' + Date.now();
        const novaForma = { id, descricao: formaPagamento.descricao, origem: 'manual' };
        await db.collection('users').doc(uid).collection('blingFormasPagamentos').doc(id).set(novaForma);
        res.json({ success: true, data: novaForma });
    } catch (e) {
        res.status(500).json({ error: 'Erro ao salvar forma de pagamento', details: e.message });
    }
});

router.put('/firestore/formas-pagamentos/:id', async (req, res) => {
    const { uid, formaPagamentoData } = req.body;
    const { id } = req.params;
    if (!uid || !formaPagamentoData || !id) return res.status(400).json({ error: 'Dados incompletos.' });
    try {
        await db.collection('users').doc(uid).collection('blingFormasPagamentos').doc(id).update(formaPagamentoData);
        res.json({ success: true, data: { ...formaPagamentoData, id } });
    } catch (e) {
        res.status(500).json({ error: 'Erro ao atualizar forma de pagamento', details: e.message });
    }
});

router.delete('/firestore/formas-pagamentos/:id', async (req, res) => {
    const { uid } = req.body;
    const { id } = req.params;
    if (!uid || !id) return res.status(400).json({ error: 'Dados incompletos.' });
    try {
        await db.collection('users').doc(uid).collection('blingFormasPagamentos').doc(id).delete();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Erro ao excluir forma de pagamento', details: e.message });
    }
});

// --- ROTAS DE CRUD PARA LANÇAMENTOS (CONTAS A PAGAR/RECEBER) ---
const handleLancamento = (collectionName) => async (req, res) => {
    const uid = req.get('uid');
    const { id } = req.params;
    const conta = JSON.parse(req.body.conta);

    if (!uid || !conta) return res.status(400).json({ error: 'UID e dados da conta são obrigatórios.' });
    let comprovanteUrl = conta.comprovanteUrl || null;

    try {
        if (req.file) {
            comprovanteUrl = await uploadFileToStorage(req.file, uid);
        }
        const dadosParaSalvar = { ...conta, valor: parseFloat(conta.valor) || 0, comprovanteUrl };

        if (req.method === 'POST') {
            const newId = 'manual_' + Date.now();
            dadosParaSalvar.id = newId;
            dadosParaSalvar.origem = 'manual';
            dadosParaSalvar.situacao = 2;
            await db.collection('users').doc(uid).collection(collectionName).doc(newId).set(dadosParaSalvar);
            res.json({ success: true, data: dadosParaSalvar });
        } else if (req.method === 'PUT') {
            if (!id) return res.status(400).json({ error: 'ID do lançamento é obrigatório.' });
            await db.collection('users').doc(uid).collection(collectionName).doc(id).update(dadosParaSalvar);
            res.json({ success: true, data: dadosParaSalvar });
        }
    } catch (e) {
        res.status(500).json({ error: 'Erro ao salvar lançamento.', details: e.message });
    }
};

const handleExcluirLancamento = (collectionName) => async (req, res) => {
    const { uid } = req.body;
    const { id } = req.params;
    if (!uid || !id) return res.status(400).json({ error: 'Dados incompletos.' });
    try {
        await db.collection('users').doc(uid).collection(collectionName).doc(id).delete();
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ error: 'Erro ao excluir lançamento', details: e.message });
    }
};

router.post('/firestore/contas-pagar', upload.single('comprovante'), handleLancamento('blingContasPagar'));
router.put('/firestore/contas-pagar/:id', upload.single('comprovante'), handleLancamento('blingContasPagar'));
router.delete('/firestore/contas-pagar/:id', handleExcluirLancamento('blingContasPagar'));

router.post('/firestore/contas-receber', upload.single('comprovante'), handleLancamento('blingContasReceber'));
router.put('/firestore/contas-receber/:id', upload.single('comprovante'), handleLancamento('blingContasReceber'));
router.delete('/firestore/contas-receber/:id', handleExcluirLancamento('blingContasReceber'));

router.post('/firestore/contas-pagar/import-lote', async (req, res) => {
    const { uid, contas } = req.body;
    if (!uid || !Array.isArray(contas) || contas.length === 0) {
        return res.status(400).json({ error: 'UID e um array de contas são obrigatórios.' });
    }

    const batch = db.batch();
    const categoriasParaCriar = new Map();

    contas.forEach(conta => {
        // Assegura que cada conta tenha um ID único
        const docRef = db.collection('users').doc(uid).collection('blingContasPagar').doc(conta.id);

        // Se a categoria for uma string, prepara para criação
        if (conta.categoria && typeof conta.categoria.descricao === 'string' && conta.categoria.descricao.trim() !== '') {
            const catDesc = conta.categoria.descricao.trim();
            if (!categoriasParaCriar.has(catDesc.toLowerCase())) {
                 categoriasParaCriar.set(catDesc.toLowerCase(), {
                    id: `manual_${catDesc.toLowerCase().replace(/\s+/g, '_')}`,
                    descricao: catDesc,
                    tipo: 1, // Despesa por padrão
                    origem: 'manual'
                 });
            }
            // Atualiza o objeto da conta com a referência de ID correta
            conta.categoria.id = categoriasParaCriar.get(catDesc.toLowerCase()).id;
        }

        batch.set(docRef, conta);
    });

    // Cria as novas categorias que não existem
    for (const cat of categoriasParaCriar.values()) {
        const catRef = db.collection('users').doc(uid).collection('blingCategorias').doc(cat.id);
        batch.set(catRef, cat, { merge: true }); // Usa merge para não sobrescrever se já existir
    }

    try {
        await batch.commit();
        res.json({ success: true, count: contas.length });
    } catch (e) {
        console.error('Erro ao importar contas em lote:', e);
        res.status(500).json({ error: 'Erro ao importar contas em lote', details: e.message });
    }
});

module.exports = router;