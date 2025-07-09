// debug-shopee.js
const crypto = require('crypto');
const axios = require('axios');

const PARTNER_ID = 1280873;
const PARTNER_KEY = '7353637345634f4349716b71654e454872724a4d4c6750675a4d677650496c59';
const SHOPEE_API_URL = 'https://partner.test-stable.shopeemobile.com';

function generateSign(path, timestamp) {
  const baseString = `${PARTNER_ID}${path}${timestamp}`;
  const sign = crypto.createHmac('sha256', PARTNER_KEY).update(baseString).digest('hex');
  
  console.log('=== GERAÇÃO DE ASSINATURA ===');
  console.log('Partner ID:', PARTNER_ID);
  console.log('Path:', path);
  console.log('Timestamp:', timestamp);
  console.log('Base String:', baseString);
  console.log('Partner Key:', PARTNER_KEY);
  console.log('Sign gerado:', sign);
  console.log('===============================\n');
  
  return sign;
}

async function testShopeeAPI() {
  try {
    console.log('🔍 TESTE DE CONEXÃO COM A API SHOPEE\n');
    
    const timestamp = Math.floor(Date.now() / 1000);
    const path = '/api/v2/public/get_auth_url';
    const sign = generateSign(path, timestamp);
    
    // Teste com URL simples primeiro
    const redirectUrl = 'https://79e6e50ec6e5.ngrok-free.app';
    
    const params = new URLSearchParams({
      partner_id: PARTNER_ID,
      timestamp: timestamp,
      sign: sign,
      redirect: redirectUrl
    });
    
    const testUrl = `${SHOPEE_API_URL}${path}?${params.toString()}`;
    
    console.log('🌐 URL de teste:', testUrl);
    console.log('📋 Parâmetros:');
    console.log('  - partner_id:', PARTNER_ID);
    console.log('  - timestamp:', timestamp);
    console.log('  - sign:', sign);
    console.log('  - redirect:', redirectUrl);
    console.log('\n');
    
    console.log('📤 Enviando requisição...\n');
    
    const response = await axios.get(testUrl, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'User-Agent': 'Econtazoom/1.0'
      },
      timeout: 15000
    });
    
    console.log('✅ SUCESSO!');
    console.log('Status:', response.status);
    console.log('Headers:', response.headers);
    console.log('Data:', JSON.stringify(response.data, null, 2));
    
  } catch (error) {
    console.error('❌ ERRO NA REQUISIÇÃO');
    console.error('Mensagem:', error.message);
    
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Status Text:', error.response.statusText);
      console.error('Headers:', error.response.headers);
      console.error('Data:', error.response.data);
    } else if (error.request) {
      console.error('Requisição enviada mas sem resposta');
      console.error('Request:', error.request);
    } else {
      console.error('Erro ao configurar requisição:', error.message);
    }
    
    console.error('\n🔍 POSSÍVEIS SOLUÇÕES:');
    console.error('1. Verificar se o Partner ID está correto');
    console.error('2. Verificar se a Partner Key está correta');
    console.error('3. Verificar se o domínio está autorizado na Shopee');
    console.error('4. Verificar se a aplicação está no status correto');
    console.error('5. Verificar conectividade com a API da Shopee');
  }
}

// Função para validar configurações
function validateConfig() {
  console.log('🔧 VALIDAÇÃO DE CONFIGURAÇÕES\n');
  
  console.log('Partner ID:', PARTNER_ID);
  console.log('Partner Key presente:', !!PARTNER_KEY);
  console.log('Partner Key length:', PARTNER_KEY.length);
  console.log('API URL:', SHOPEE_API_URL);
  
  if (!PARTNER_ID || !PARTNER_KEY) {
    console.error('❌ Partner ID ou Partner Key não configurados!');
    return false;
  }
  
  if (PARTNER_KEY.length !== 64) {
    console.error('❌ Partner Key deve ter 64 caracteres!');
    return false;
  }
  
  console.log('✅ Configurações básicas OK\n');
  return true;
}

// Executar testes
async function runTests() {
  console.log('🚀 INICIANDO TESTES DE DEBUG DA SHOPEE\n');
  
  if (!validateConfig()) {
    process.exit(1);
  }
  
  await testShopeeAPI();
}

// Executar se for chamado diretamente
if (require.main === module) {
  runTests();
}

module.exports = { generateSign, testShopeeAPI, validateConfig };