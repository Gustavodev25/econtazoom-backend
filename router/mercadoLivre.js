const express = require('express');
const axios = require('axios');
const crypto = require('crypto');
const router = express.Router();

const CLIENT_ID = process.env.ML_CLIENT_ID || '3824907447184431';
const CLIENT_SECRET = process.env.ML_CLIENT_SECRET || '43I19nlTO0OLK5tw3K0rEeYiDObENV5z';
const NGROK = { url: null };

const codeVerifiers = new Map(); 

const db = require('../firebase').db;

function generatePKCE() {
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  return { codeVerifier, codeChallenge };
}

function getRedirectUri() {
  if (process.env.NODE_ENV === 'production' || !NGROK.url) {
    return 'https://econtazoom-backend.onrender.com/ml/callback';
  }
  return `${NGROK.url}/ml/callback`;
}

function getFrontendUrl() {
  if (process.env.NODE_ENV === 'production') {
    return 'https://econtazoom.com.br/contas?success=Conta%20conectada%20com%20sucesso';
  }
  return 'http://localhost:8080/contas?success=Conta%20conectada%20com%20sucesso';
}

router.get('/auth', async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
  const redirectUri = getRedirectUri();
  if (!redirectUri) return res.status(503).json({ error: 'ngrok ainda não inicializado' });

  try {
    const { codeVerifier, codeChallenge } = generatePKCE();
    const state = Buffer.from(JSON.stringify({ uid })).toString('base64');

    codeVerifiers.set(state, codeVerifier);

    const url = `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256`;
    
    console.log('Iniciando auth com:', { redirectUri, state, codeChallenge }); 
    res.redirect(url);
  } catch (error) {
    console.error('Erro ao iniciar auth:', error);
    res.status(500).json({ error: 'Erro ao iniciar autenticação' });
  }
});

router.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) return res.status(400).json({ error: 'Code e state obrigatórios' });

  try {
    const decodedState = JSON.parse(Buffer.from(state, 'base64').toString());
    const uid = decodedState.uid;
    const redirectUri = getRedirectUri();
    const codeVerifier = codeVerifiers.get(state); 
    if (!codeVerifier) throw new Error('code_verifier não encontrado para o state fornecido');

    console.log('Callback chamado com:', { code, state, redirectUri, client_id: CLIENT_ID, codeVerifier }); 

    const tokenRes = await axios.post('https://api.mercadolibre.com/oauth/token', null, {
      params: {
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier,
      },
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }).catch(err => {
      console.error('Erro na requisição de token:', {
        status: err.response?.status,
        data: err.response?.data,
        params: {
          grant_type: 'authorization_code',
          client_id: CLIENT_ID,
          redirect_uri: redirectUri,
          code_verifier: codeVerifier,
        },
      });
      throw err;
    });

    const { access_token, refresh_token, user_id } = tokenRes.data;
    console.log('Tokens recebidos:', { user_id, access_token, refresh_token });

    const userRes = await axios.get(`https://api.mercadolivre.com/users/${user_id}`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });

    const nickname = userRes.data.nickname || '';

    await db.collection('users').doc(uid).collection('mercadoLivre').doc(user_id.toString()).set({
      user_id,
      nickname,
      access_token,
      refresh_token,
      status: 'ativo',
      createdAt: new Date().toISOString(),
      phoneNumbers: [],
      phoneNumbersStatus: {},
      phoneNumbersNames: {},
    }, { merge: true });

    codeVerifiers.delete(state);

    res.redirect(getFrontendUrl());
  } catch (err) {
    console.error('Erro no callback:', err.message);
    res.redirect(getFrontendUrl().replace('success=Conta%20conectada%20com%20sucesso', `error=${encodeURIComponent('Erro na conexão com Mercado Livre')}`));
  }
});

router.get('/contas', async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'UID obrigatório' });

  try {
    const snapshot = await db.collection('users').doc(uid).collection('mercadoLivre').get();
    const contas = snapshot.docs.map(doc => {
      const data = doc.data();
      return {
        user_id: data.user_id,
        nickname: data.nickname,
        status: data.status,
        createdAt: data.createdAt
      };
    });
    res.json(contas);
  } catch (err) {
    console.error('Erro ao buscar contas:', err);
    res.status(500).json({ error: 'Erro ao buscar contas' });
  }
});

module.exports = router;
module.exports.NGROK = NGROK;