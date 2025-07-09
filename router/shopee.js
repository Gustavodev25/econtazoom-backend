const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const axios = require('axios');
const { db } = require('../firebase');

// Suas credenciais - é recomendado o uso de variáveis de ambiente
const CLIENT_ID = process.env.SHOPEE_CLIENT_ID || '1280873'; // Substitua se não estiver usando .env
const CLIENT_SECRET = process.env.SHOPEE_CLIENT_SECRET || '7353637345634f4349716b71654e454872724a4d4c6750675a4d677650496c59'; // Substitua se não estiver usando .env

const SHOPEE_BASE_URL = 'https://partner.test-stable.shopeemobile.com';

/**
 * Gera a assinatura para as requisições da API Shopee.
 * A baseString é a concatenação de: partner_id + path + timestamp + access_token + shop_id
 * @param {string} path O caminho da API (ex: /api/v2/shop/auth_partner)
 * @param {string} partner_id Seu ID de parceiro
 * @param {number} timestamp Timestamp UNIX em segundos
 * @param {string} [access_token=''] O token de acesso (se aplicável)
 * @param {string} [shop_id=''] O ID da loja (se aplicável)
 * @returns {string} A assinatura HMAC-SHA256
 */
function generateSign(path, partner_id, timestamp, access_token = '', shop_id = '') {
  const baseString = partner_id.toString() + path + timestamp.toString() + access_token.toString() + shop_id.toString();
  return crypto.createHmac('sha256', CLIENT_SECRET).update(baseString).digest('hex');
}

/**
 * Monta a URL de redirecionamento para o callback.
 * @param {object} req O objeto de requisição do Express
 * @returns {string} A URL de callback completa
 */
function getRedirectUri(req) {
  const baseUrl = req.app?.locals?.ngrokUrl || 'http://localhost:3001';
  return `${baseUrl}/shopee/callback`;
}

// Rota para iniciar a autorização
router.get('/auth', (req, res) => {
  const { uid } = req.query;
  if (!uid) {
    return res.status(400).send('O parâmetro "uid" do usuário é obrigatório.');
  }

  const partner_id = CLIENT_ID.toString();
  const timestamp = Math.floor(Date.now() / 1000);
  const path = '/api/v2/shop/auth_partner';
  
  // Para esta rota, a assinatura não precisa de access_token ou shop_id
  const sign = generateSign(path, partner_id, timestamp);
  
  const redirect_uri = encodeURIComponent(getRedirectUri(req) + `?uid=${uid}`);

  const authUrl = `${SHOPEE_BASE_URL}${path}?partner_id=${partner_id}&timestamp=${timestamp}&sign=${sign}&redirect=${redirect_uri}`;
  res.redirect(authUrl);
});

// Rota de callback após autorização do usuário
router.get('/callback', async (req, res) => {
  const { code, shop_id, uid } = req.query;
  if (!code || !shop_id || !uid) {
    return res.status(400).send('Parâmetros ausentes na URL de callback (code, shop_id, uid).');
  }

  try {
    const partner_id = CLIENT_ID.toString();
    const timestamp = Math.floor(Date.now() / 1000);
    const path = '/api/v2/auth/token/get';
    const shop_id_str = shop_id.toString();

    // --- CORREÇÃO 1: Geração da Assinatura ---
    // A baseString para esta rota é apenas `partner_id + path + timestamp`.
    // Não inclua access_token ou shop_id na assinatura aqui.
    const sign = generateSign(path, partner_id, timestamp);

    // --- CORREÇÃO 2: Estrutura da Requisição ---
    // Os parâmetros `code` e `shop_id` devem ser enviados no CORPO (body) da requisição POST.
    const requestBody = {
      code,
      shop_id: parseInt(shop_id_str, 10), // A API espera que shop_id seja um número no body
      partner_id: parseInt(partner_id, 10) // A API também espera o partner_id no body
    };

    // A URL da requisição POST contém apenas os parâmetros comuns da API
    const requestUrl = `${SHOPEE_BASE_URL}${path}?partner_id=${partner_id}&timestamp=${timestamp}&sign=${sign}`;
    
    // Faça a requisição POST com o corpo (body) formatado em JSON
    const response = await axios.post(requestUrl, requestBody, {
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    // A API retorna um campo 'error' com valor string vazio em caso de sucesso
    if (response.data.error) {
        throw new Error(`[${response.data.error}] ${response.data.message}` || 'Erro na resposta da API Shopee');
    }

    const { access_token, refresh_token, expire_in } = response.data;

    await db.collection('users').doc(uid).collection('shopee').doc(shop_id_str).set({
      shop_id: shop_id_str,
      access_token: access_token,
      refresh_token: refresh_token || null,
      expire_in,
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'ativo',
    }, { merge: true });

    res.send('<script>window.close(); if(window.opener) { window.opener.location.reload(); }</script>Conta Shopee conectada com sucesso! Esta janela pode ser fechada.');
  } catch (error) {
    // Log detalhado do erro para depuração
    const errorData = error.response?.data || { message: error.message };
    console.error('Erro detalhado ao obter token Shopee:', JSON.stringify(errorData, null, 2));
    res.status(500).send(`Erro ao conectar com a Shopee: ${errorData.message || 'Erro desconhecido'}`);
  }
});

module.exports = router;