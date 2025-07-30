// index.js (Corrigido e Otimizado)

const express = require('express');
const cors = require('cors');
const ngrok = require('ngrok');
const { db } = require('./firebase');

// --- Importação das Rotas ---
// É uma boa prática manter as rotas em uma pasta dedicada.
const { NGROK } = require('./router/sharedState'); 
const mercadoLivreRouter = require('./router/mercadoLivre');
const blingRouter = require('./router/bling');
const shopeeRouter = require('./router/shopee'); 

// --- Constantes e Configuração Inicial ---
const app = express();
const PORT = process.env.PORT || 3001;
const NGROK_AUTHTOKEN = process.env.NGROK_AUTHTOKEN || '1oqB3iP42FXti1LBFru5iA0KMoL_3L1XTqcUwsjXbccgXYxdz';

// --- Configuração dos Middlewares (A ORDEM É IMPORTANTE) ---

// 1. Configuração do CORS (Cross-Origin Resource Sharing)
const allowedOrigins = [
  'http://localhost:8080',
  'http://localhost:3000',
  'https://econtazoom.vercel.app',
  'https://econtazoom-backend.onrender.com',
  'https://econtazoom.com.br'
];

const corsOptions = {
  origin: function (origin, callback) {
    // Permite requisições sem 'origin' (ex: Postman, apps mobile) e da lista de permitidos.
    if (!origin || allowedOrigins.includes(origin) || origin.includes('ngrok')) {
      callback(null, true);
    } else {
      callback(new Error('Origem não permitida pelo CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'], // Habilita os métodos que sua API usa
  allowedHeaders: ['Content-Type', 'Authorization'] // Habilita cabeçalhos comuns
};

app.use(cors(corsOptions));

// 2. Middlewares para processar o corpo das requisições (Body Parsers)
// Substituí o 'body-parser' obsoleto pelas funções nativas do Express.
// Isso DEVE vir antes do registro das rotas.
app.use(express.json({ limit: '20mb' })); // Para processar JSON
app.use(express.urlencoded({ extended: true, limit: '20mb' })); // Para processar dados de formulários

// 3. Middleware de Log (Opcional, mas útil para depuração)
// Colocado aqui para registrar todas as requisições que chegam.
app.use((req, res, next) => {
  console.log(`[Express] Recebida: ${req.method} ${req.originalUrl}`);
  next();
});

// --- Registro das Rotas da Aplicação ---
app.use('/ml', mercadoLivreRouter);
app.use('/bling', blingRouter);
app.use('/shopee', shopeeRouter);

// --- Rotas Utilitárias ---
app.get('/', (req, res) => {
  res.send('Backend e-Conta Zoom está rodando!');
});

// Rota para o frontend descobrir a URL pública do backend (ngrok)
app.get('/api/ngrok-url', (req, res) => {
  res.json({ url: NGROK.url || `http://localhost:${PORT}` });
});

// --- Função de Inicialização do Servidor ---
async function startServer() {
  try {
    // Validação da conexão com o Firestore na inicialização
    await db.collection('test').limit(1).get();
    console.log('Firestore autenticado com sucesso!');

    // Inicia o servidor Express
    const server = app.listen(PORT, () => {
      console.log(`Servidor rodando na porta ${PORT}`);
    });

    // Configuração do Ngrok (apenas em ambiente de desenvolvimento)
    if (process.env.NODE_ENV !== 'production' && !process.env.DISABLE_NGROK) {
      await ngrok.authtoken(NGROK_AUTHTOKEN);
      const url = await ngrok.connect({ addr: PORT, proto: 'http' });
      NGROK.url = url.endsWith('/') ? url.slice(0, -1) : url;
      console.log(`Servidor acessível publicamente via Ngrok: ${NGROK.url}`);
    } else {
      console.log(`Acesse localmente em: http://localhost:${PORT}`);
    }

    server.on('error', (err) => {
      console.error('Erro fatal no servidor:', err);
      process.exit(1);
    });

  } catch (err) {
    console.error('Falha ao iniciar o servidor:', err.message);
    process.exit(1);
  }
}

// --- Tratamento de Encerramento do Processo ---
process.on('SIGTERM', async () => {
  console.log('Recebido sinal SIGTERM. Desligando o servidor e o Ngrok...');
  if (NGROK.url) {
    await ngrok.disconnect();
    console.log('Ngrok desconectado.');
  }
  process.exit(0);
});

// Inicia a aplicação
startServer();
