const express = require('express');
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
const crypto = require('crypto');
const router = express.Router();

const CLIENT_ID = '3824907447184431';
const CLIENT_SECRET = '43I19nlTO0OLK5tw3K0rEeYiDObENV5z';
const NGROK = { url: null };

const codeVerifiers = new Map();

const db = require('../firebase').db;

function base64urlEncode(str) {
  return str
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function generatePKCE() {
  const codeVerifier = crypto.randomBytes(32).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const codeChallenge = base64urlEncode(
    crypto.createHash('sha256').update(codeVerifier).digest('base64')
  );
  return { codeVerifier, codeChallenge };
}

function getRedirectUri() {
  if (process.env.NODE_ENV === 'production' || !NGROK.url) {
    return 'https://econtazoom-backend.onrender.com/ml/callback';
  }
  return `${NGROK.url}/ml/callback`;
}

function getFrontendUrl(success = true) {
  const baseUrl = process.env.NODE_ENV === 'production'
    ? 'https://econtazoom.com.br/contas'
    : 'http://localhost:8080/contas';
  const query = success
    ? 'success=Conta%20conectada%20com%20sucesso'
    : 'error=Erro%20na%20conex%C3%A3o%20com%20Mercado%20Livre';
  return `${baseUrl}?${query}`;
}

router.get('/auth', async (req, res) => {
  const { uid } = req.query;
  if (!uid) {
    console.error('UID não fornecido');
    return res.status(400).json({ error: 'UID obrigatório' });
  }
  const redirectUri = getRedirectUri();
  if (!redirectUri) {
    console.error('ngrok não inicializado');
    return res.status(503).json({ error: 'ngrok ainda não inicializado' });
  }

  try {
    const { codeVerifier, codeChallenge } = generatePKCE();
    const state = Buffer.from(JSON.stringify({ uid })).toString('base64');

    codeVerifiers.set(state, codeVerifier);

    const url = `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256`;
    
    console.log('Iniciando autenticação com:', { redirectUri, state, codeChallenge });
    res.redirect(url);
  } catch (error) {
    console.error('Erro ao iniciar autenticação:', error.message);
    res.status(500).json({ error: 'Erro ao iniciar autenticação' });
  }
});

router.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) {
    console.error('Parâmetros code ou state ausentes:', { code, state });
    return res.redirect(getFrontendUrl(false));
  }

  try {
    const decodedState = JSON.parse(Buffer.from(state, 'base64').toString());
    const uid = decodedState.uid;
    const redirectUri = getRedirectUri();
    const codeVerifier = codeVerifiers.get(state);
    if (!codeVerifier) {
      console.error('code_verifier não encontrado para o state:', state);
      throw new Error('code_verifier não encontrado para o state fornecido');
    }

    console.log('Callback chamado com:', { code, state, redirectUri, client_id: CLIENT_ID, codeVerifier });

    const tokenResponse = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
        code_verifier: codeVerifier
      })
    });

    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok) {
      console.error('Erro na requisição de token:', {
        status: tokenResponse.status,
        data: tokenData
      });
      throw new Error(tokenData.message || 'Erro ao obter token');
    }

    const { access_token, refresh_token, user_id } = tokenData;
    console.log('Tokens recebidos:', { user_id, access_token, refresh_token });

    const userResponse = await fetch(`https://api.mercadolibre.com/users/${user_id}`, {
      headers: { Authorization: `Bearer ${access_token}` }
    });
    const userData = await userResponse.json();
    if (!userResponse.ok) {
      console.error('Erro ao obter dados do usuário:', userData);
      throw new Error(userData.message || 'Erro ao obter dados do usuário');
    }

    const nickname = userData.nickname || '';

    await db.collection('users').doc(uid).collection('mercadoLivre').doc(user_id.toString()).set({
      user_id,
      nickname,
      access_token,
      refresh_token,
      status: 'ativo',
      createdAt: new Date().toISOString(),
      phoneNumbers: [],
      phoneNumbersStatus: {},
      phoneNumbersNames: {}
    }, { merge: true });

    codeVerifiers.delete(state);
    console.log('Conta conectada com sucesso, redirecionando para:', getFrontendUrl());
    res.redirect(getFrontendUrl());
  } catch (error) {
    console.error('Erro no callback:', error.message);
    res.redirect(getFrontendUrl(false));
  }
});

router.get('/contas', async (req, res) => {
  const { uid } = req.query;
  if (!uid) {
    console.error('UID não fornecido');
    return res.status(400).json({ error: 'UID obrigatório' });
  }

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
  } catch (error) {
    console.error('Erro ao buscar contas:', error.message);
    res.status(500).json({ error: 'Erro ao buscar contas' });
  }
});

module.exports = router;
module.exports.NGROK = NGROK;