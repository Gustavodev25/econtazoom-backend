const express = require('express');
const axios = require('axios');
const qs = require('querystring');
const router = express.Router();
const db = require('../firebase').db;
const admin = require('../firebase').admin;

const BLING_CLIENT_ID = process.env.BLING_CLIENT_ID || '57f339b6be5fdc0d986c1170b709b8d82ece3a76';
const BLING_CLIENT_SECRET = process.env.BLING_CLIENT_SECRET || '5f59f5f4610f20bfd74984f151bcca343cb1375d68cc27216c4b2bc8a97d';

function getRedirectUri(req) {
  // Em produção, use a URL do backend de produção
  if (process.env.NODE_ENV === 'production' || !req.app.locals.ngrokUrl) {
    return 'https://econtazoom-backend.onrender.com/bling/callback';
  }
  // Em desenvolvimento, use o ngrok
  return `${req.app.locals.ngrokUrl}/bling/callback`;
}

function getFrontendUrl() {
  // Em produção, use o domínio do frontend de produção
  if (process.env.NODE_ENV === 'production') {
    return 'https://econtazoom.com.br/contas';
  }
  // Em desenvolvimento, use o localhost
  return 'http://localhost:8080/contas';
}

router.get('/auth', (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
  const redirectUri = getRedirectUri(req);
  const state = Buffer.from(JSON.stringify({ uid })).toString('base64');
  const url = `https://www.bling.com.br/Api/v3/oauth/authorize?response_type=code&client_id=${BLING_CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;
  res.redirect(url);
});

// Callback OAuth2 Bling
router.get('/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || !state) {
    console.error('Callback Bling: code ou state ausente', { code, state });
    return res.status(400).json({ error: 'Code e state obrigatórios' });
  }
  const redirectUri = getRedirectUri(req);
  const { uid } = JSON.parse(Buffer.from(state, 'base64').toString());
  try {
    const basicAuth = Buffer.from(`${BLING_CLIENT_ID}:${BLING_CLIENT_SECRET}`).toString('base64');
    const tokenRes = await axios.post(
      'https://www.bling.com.br/Api/v3/oauth/token',
      qs.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri
      }),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Basic ${basicAuth}`
        }
      }
    );
    const { access_token, refresh_token, expires_in } = tokenRes.data;

    let blingAccount = {};
    try {
      const userRes = await axios.get('https://www.bling.com.br/Api/v3/usuarios/me', {
        headers: { Authorization: `Bearer ${access_token}` }
      });
      blingAccount = {
        nome: userRes.data?.nome || userRes.data?.name || '',
        email: userRes.data?.email || '',
        id: userRes.data?.id || '',
        ...userRes.data
      };
    } catch (e) {
      blingAccount = {};
    }

    await db.collection('users').doc(uid).set({
      bling: {
        access_token,
        refresh_token,
        expires_in,
        connectedAt: new Date().toISOString(),
        ...blingAccount
      }
    }, { merge: true });

    console.log('Callback Bling: sucesso, redirecionando para frontend');
    res.redirect(getFrontendUrl() + '?bling=success');
  } catch (err) {
    console.error('Erro no callback Bling:', err.response?.data || err.message || err);
    res.redirect(getFrontendUrl() + `?bling=error&msg=${encodeURIComponent(err.response?.data?.error_description || err.message || 'Erro desconhecido')}`);
  }
});

router.get('/status', async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'UID obrigatório' });
  const docSnap = await db.collection('users').doc(uid).get();
  const bling = docSnap.data()?.bling;
  res.json({ connected: !!bling, bling });
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

router.get('/vendas', async (req, res) => {
  const { uid } = req.query;
  if (!uid) return res.status(400).json({ error: 'UID obrigatório' });

  try {
    const docSnap = await db.collection('users').doc(uid).get();
    const bling = docSnap.data()?.bling;
    if (!bling || !bling.access_token) {
      return res.status(401).json({ error: 'Conta Bling não conectada' });
    }

    const pedidosRes = await axios.get('https://www.bling.com.br/Api/v3/pedidos', {
      headers: {
        Authorization: `Bearer ${bling.access_token}`
      },
      params: { limit: 30 }
    });

    const pedidos = pedidosRes.data?.data || [];
    res.json(pedidos);
  } catch (err) {
    if (
      err.response &&
      err.response.data &&
      err.response.data.error &&
      err.response.data.error.type === 'RESOURCE_NOT_FOUND'
    ) {
      return res.json([]);
    }
    if (err.response && err.response.status === 401) {
      return res.status(401).json({ error: 'Token Bling expirado ou inválido. Refaça a conexão.' });
    }
    console.error('Erro ao buscar vendas do Bling:', err.response?.data || err.message || err);
    res.status(500).json({ error: 'Erro ao buscar vendas do Bling', detalhe: err.response?.data || err.message });
  }
});

module.exports = router;
