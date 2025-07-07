const express = require('express');
const fetch = (...args) => import('node-fetch').then(m => m.default(...args));
const crypto = require('crypto');
const router = express.Router();
const { db } = require('../firebase'); // Importar o db corretamente

const CLIENT_ID = '4762241412857004';
const CLIENT_SECRET = 'yBJNREOR3izbhIGRJtUP8P4FsGNXLIvB';
const NGROK = { url: null };

const codeVerifiers = new Map();

// --- FUNÇÕES DE AUTENTICAÇÃO E TOKEN (COM ADIÇÃO DE REFRESH TOKEN) ---

/**
 * Renova o access_token do Mercado Livre usando o refresh_token.
 * @param {string} uid - O UID do usuário no Firebase.
 * @param {string} contaId - O ID da conta do Mercado Livre (user_id).
 * @param {object} contaData - Os dados atuais da conta contendo o refresh_token.
 * @returns {Promise<string>} O novo access_token.
 */
async function refreshTokenML(uid, contaId, contaData) {
  console.log(`[ML Token Refresh] Solicitando novo token para conta: ${contaId}`);
  try {
    const tokenResponse = await fetch('https://api.mercadolibre.com/oauth/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        refresh_token: contaData.refresh_token,
      }),
    });

    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok) {
      throw new Error(tokenData.message || 'Falha ao renovar o token');
    }

    const { access_token, refresh_token, expires_in } = tokenData;
    
    const novaContaData = {
      ...contaData,
      access_token,
      refresh_token, // O ML pode retornar um novo refresh_token
      expires_in,
      updatedAt: new Date().toISOString(),
      lastTokenRefresh: new Date().toISOString()
    };
    
    await db.collection('users').doc(uid).collection('mercadoLivre').doc(contaId).set(novaContaData, { merge: true });

    console.log(`[ML Token Refresh] Token para conta ${contaId} atualizado com sucesso.`);
    return access_token;

  } catch (error) {
    console.error(`[ML Token Refresh] FALHA ao atualizar token para conta ${contaId}:`, error.message);
    await db.collection('users').doc(uid).collection('mercadoLivre').doc(contaId).update({ status: 'reauth_required' });
    throw error;
  }
}

/**
 * Obtém um token de acesso válido, verificando a expiração e renovando se necessário.
 * @param {string} uid - O UID do usuário no Firebase.
 * @param {string} contaId - O ID da conta do Mercado Livre (user_id).
 * @returns {Promise<string>} Um access_token válido.
 */
async function getValidTokenML(uid, contaId) {
    const contaRef = db.collection('users').doc(uid).collection('mercadoLivre').doc(contaId);
    const contaSnap = await contaRef.get();
    
    if (!contaSnap.exists) {
        throw new Error(`Conta Mercado Livre ${contaId} não encontrada.`);
    }

    const contaData = contaSnap.data();
    if (!contaData.access_token || !contaData.refresh_token) {
        await contaRef.update({ status: 'reauth_required', status_detail: 'Tokens ausentes.' });
        throw new Error('Conta sem tokens de acesso ou de refresh. Reautenticação necessária.');
    }

    const tokenCreationTime = new Date(contaData.updatedAt || contaData.createdAt).getTime();
    const expiresInMilliseconds = (contaData.expires_in - 300) * 1000; // 5 minutos de margem de segurança

    if (Date.now() - tokenCreationTime > expiresInMilliseconds) {
        console.log(`[ML Token Check] Token para conta ${contaId} expirado. Renovando...`);
        return await refreshTokenML(uid, contaId, contaData);
    }
    
    return contaData.access_token;
}


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

    const url = `https://auth.mercadolivre.com.br/authorization?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}&code_challenge=${codeChallenge}&code_challenge_method=S256&scope=read write offline_access`;
    
    console.log('Iniciando autenticação com:', { redirectUri, state, codeChallenge, scope: 'read write offline_access' });
    res.redirect(url);
  } catch (error) {
    console.error('Erro ao iniciar autenticação:', error.message);
    res.status(500).json({ error: 'Erro ao iniciar autenticação' });
  }
});

router.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    console.error('Erro retornado pelo Mercado Livre:', error);
    return res.redirect(getFrontendUrl(false));
  }
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
      throw new Error('code_verifier não encontrado');
    }

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

    const { access_token, refresh_token, user_id, expires_in } = tokenData;
    console.log('Tokens recebidos:', { user_id, access_token: '***', refresh_token: '***', expires_in });

    if (!refresh_token) {
      console.warn('Nenhum refresh_token retornado pelo Mercado Livre. Verifique as permissões (scope) do aplicativo.');
    }

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
      refresh_token: refresh_token || null,
      status: 'ativo',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(), // Usado para controle de expiração do token
      expires_in,
    }, { merge: true });

    codeVerifiers.delete(state);
    console.log('Conta conectada com sucesso, redirecionando para o frontend.');
    res.redirect(getFrontendUrl());
  } catch (error) {
    console.error('Erro no callback:', error.message, error.stack);
    res.redirect(getFrontendUrl(false));
  }
});

router.get('/contas', async (req, res) => {
    const { uid } = req.query;
    if (!uid) {
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
      console.error('Erro ao buscar contas do ML:', error.message);
      res.status(500).json({ error: 'Erro ao buscar contas' });
    }
});

/**
 * ROTA OTIMIZADA: Lê as vendas diretamente do cache do Firestore.
 * Esta rota será rápida e usada pelo frontend para popular a tabela.
 */
router.get('/vendas', async (req, res) => {
    const { uid } = req.query;
    if (!uid) {
        return res.status(400).json({ error: 'UID obrigatório' });
    }
    try {
        const snapshot = await db.collection('users').doc(uid).collection('mlVendas').orderBy('date_created', 'desc').get();
        const todasAsVendas = snapshot.docs.map(doc => doc.data());
        console.log(`[ML Firestore Read] Retornando ${todasAsVendas.length} vendas do Firestore para o UID ${uid}.`);
        res.json(todasAsVendas);
    } catch (error) {
        console.error('[ML API] Erro ao buscar vendas do Firestore:', error.message);
        res.status(500).json({ error: 'Erro ao buscar vendas do cache', detalhe: error.message });
    }
});

/**
 * ROTA DE SINCRONIZAÇÃO: Inicia a busca completa das vendas e salva no Firestore.
 * Esta rota agora realiza a lógica de paginação e salvamento que antes estava em /vendas.
 */
router.get('/vendas/sync', async (req, res) => {
    const { uid } = req.query;
    if (!uid) {
      return res.status(400).json({ error: 'UID obrigatório' });
    }

    // Responde imediatamente ao cliente para que ele não fique esperando
    res.json({ success: true, message: 'Sincronização iniciada em segundo plano.' });

    // --- O restante da função executa em segundo plano ---
    console.log(`[ML Sync] Sincronização em segundo plano iniciada para o UID: ${uid}`);
    try {
      const contasSnap = await db.collection('users').doc(uid).collection('mercadoLivre').get();
      if (contasSnap.empty) {
        console.log(`[ML Sync] Nenhuma conta ML para sincronizar para o UID: ${uid}`);
        return;
      }
  
      for (const docConta of contasSnap.docs) {
        const contaId = docConta.id;
        try {
            const access_token = await getValidTokenML(uid, contaId);
            const user_id = docConta.data().user_id;
            let offset = 0;
            const limit = 50;
            let totalSincronizadas = 0;

            while (true) {
                const url = `https://api.mercadolibre.com/orders/search?seller=${user_id}&order.status=paid&sort=date_desc&offset=${offset}&limit=${limit}`;
                const vendasRes = await fetch(url, { headers: { Authorization: `Bearer ${access_token}` } });
                
                if (!vendasRes.ok) {
                    console.error(`[ML Sync] Erro ao buscar lista de vendas para conta ${user_id}. Status: ${vendasRes.status}`);
                    break;
                }

                const vendasData = await vendasRes.json();
                if (!vendasData.results || vendasData.results.length === 0) {
                    break; // Fim das vendas
                }
                
                // Pula o salvamento de placeholders se a venda já existir com dados completos
                const existingVendasSnap = await db.collection('users').doc(uid).collection('mlVendas')
                  .where('id', 'in', vendasData.results.map(v => v.id))
                  .get();
                const existingVendasIds = new Set(existingVendasSnap.docs.map(doc => doc.data().id.toString()));

                const newVendas = vendasData.results.filter(venda => !existingVendasIds.has(venda.id.toString()));

                if (newVendas.length > 0) {
                    // Salva placeholders primeiro para dar feedback visual rápido no frontend
                    const placeholders = newVendas.map(venda => {
                        const orderId = venda.id.toString();
                        const vendaDocRef = db.collection('users').doc(uid).collection('mlVendas').doc(orderId);
                        return vendaDocRef.set({ 
                            id: orderId, 
                            status: 'syncing', // Status para o frontend identificar o loader
                            date_created: venda.date_created, // Data para ordenação
                            placeholder: true 
                        }, { merge: true });
                    });
                    await Promise.all(placeholders);
                }


                // Agora, busca os detalhes completos e atualiza cada venda
                await Promise.all(vendasData.results.map(async (venda) => {
                    const orderId = venda.id.toString();
                    const vendaDocRef = db.collection('users').doc(uid).collection('mlVendas').doc(orderId);

                    const detailsRes = await fetch(`https://api.mercadolibre.com/orders/${orderId}`, { headers: { Authorization: `Bearer ${access_token}` } });
                    if (!detailsRes.ok) {
                        console.warn(`[ML Sync] Falha ao buscar detalhes do pedido ${orderId}.`);
                        await vendaDocRef.update({ status: 'sync_error', status_detail: 'Falha ao buscar detalhes' });
                        return;
                    }
                    const orderDetails = await detailsRes.json();
                    
                    let shipmentDetails = {};
                    if (orderDetails.shipping?.id) {
                        const shipmentRes = await fetch(`https://api.mercadolibre.com/shipments/${orderDetails.shipping.id}`, { headers: { Authorization: `Bearer ${access_token}` } });
                        if(shipmentRes.ok) shipmentDetails = await shipmentRes.json();
                    }

                    await vendaDocRef.set({ ...orderDetails, shipping: shipmentDetails, updatedAt: new Date().toISOString() }, { merge: true });
                    console.log(`[ML Sync] Venda ${orderId} salva/atualizada no Firestore.`);
                    totalSincronizadas++;
                }));

                offset += limit;
            }
            console.log(`[ML Sync] Sincronização concluída para a conta ${contaId}. Total de ${totalSincronizadas} vendas processadas.`);
        } catch (error) {
            console.error(`[ML Sync] Falha ao processar vendas para a conta ${contaId}:`, error.message);
            continue; // Continua para a próxima conta
        }
      }
      console.log(`[ML Sync] Processo de sincronização em segundo plano finalizado para o UID: ${uid}`);
    } catch (error) {
      console.error('[ML Sync] Erro fatal no processo de sincronização:', error.message);
    }
});
  
router.delete('/vendas', async (req, res) => {
    const uid = req.query.uid || req.body.uid;
    if (!uid) {
      return res.status(400).json({ error: 'UID obrigatório' });
    }
    try {
      const vendasRef = db.collection('users').doc(uid).collection('mlVendas');
      const snapshot = await vendasRef.limit(500).get();
      
      if (snapshot.empty) {
        return res.json({ success: true, deleted: 0, message: "Nenhuma venda para excluir." });
      }
      
      const batch = db.batch();
      snapshot.docs.forEach(doc => {
        batch.delete(doc.ref);
      });
      await batch.commit();
      
      // Para exclusão em massa, um processo em segundo plano ou fila seria mais robusto.
      // Esta implementação exclui até 500 por vez.
      console.log(`[ML Delete] ${snapshot.size} vendas excluídas para o UID ${uid}`);
      res.json({ success: true, deleted: snapshot.size });

    } catch (err) {
      console.error('[ML Delete] Erro ao excluir vendas:', err);
      res.status(500).json({ error: 'Erro ao excluir vendas do Mercado Livre', detalhe: err.message });
    }
});
  
router.post('/vendas/fake', async (req, res) => {
    const { uid } = req.body;
    if (!uid) {
      return res.status(400).json({ error: 'UID obrigatório' });
    }
    try {
      const fakeVenda = {
        id: 'FAKE_ML_' + Date.now(),
        order_id: 'FAKE_ML_' + Date.now(),
        date_created: new Date().toISOString(),
        date_closed: new Date().toISOString(),
        status: 'paid',
        status_detail: 'payment_received',
        total_amount: 199.99,
        paid_amount: 199.99,
        currency_id: 'BRL',
        buyer: {
          id: '99999999',
          nickname: 'comprador_teste',
          first_name: 'João',
          last_name: 'Silva'
        },
        seller: {
          id: '88888888',
          nickname: 'vendedor_teste'
        },
        order_items: [{
          item: {
            id: 'MLB123456789',
            title: 'Produto Teste Mercado Livre',
            seller_sku: 'SKU-FAKE-ML-01'
          },
          quantity: 2,
          unit_price: 99.99,
        }],
        payments: [{
          id: 'PAYMENT_FAKE_001',
          status: 'approved',
          transaction_amount: 199.99,
          date_approved: new Date().toISOString(),
          payment_method_id: 'credit_card',
          installments: 1,
          marketplace_fee: 22.00,
        }],
        shipping: {
          id: 'SHIP_FAKE_001',
          status: 'shipped',
          delivery_type: 'me2',
          tracking_number: 'TRK123456BR',
          cost: 15.00 
        },
        updatedAt: new Date().toISOString()
      };
  
      await db.collection('users')
        .doc(uid)
        .collection('mlVendas')
        .doc(fakeVenda.id.toString())
        .set(fakeVenda, { merge: true });
  
      res.json({ success: true, venda: fakeVenda });
    } catch (err) {
      console.error('[ML Fake] Erro ao criar venda fake:', err);
      res.status(500).json({ error: 'Erro ao criar venda fake', detalhe: err.message });
    }
});

module.exports = router;
module.exports.NGROK = NGROK;