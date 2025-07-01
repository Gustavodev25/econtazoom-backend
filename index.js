const express = require('express');
const cors = require('cors');
const ngrok = require('ngrok');
const { NGROK } = require('./router/mercadoLivre');
const mercadoLivreRouter = require('./router/mercadoLivre');
const blingRouter = require('./router/bling');

const app = express();
const PORT = process.env.PORT || 3001;
const NGROK_AUTHTOKEN = process.env.NGROK_AUTHTOKEN || '1oqB3iP42FXti1LBFru5iA0KMoL_3L1XTqcUwsjXbccgXYxdz';

let ngrokUrl = null;

// Permitir CORS para localhost, produção e ngrok
const allowedOrigins = [
  'http://localhost:8080',
  'http://localhost:3000',
  'https://econtazoom.vercel.app',
  'https://econtazoom-backend.onrender.com',
  'https://econtazoom.com.br', // Adicionado domínio de produção
];
app.use(cors({
  origin: function(origin, callback) {
    // Permite requisições sem origin (ex: mobile, curl)
    if (!origin) return callback(null, true);
    if (allowedOrigins.includes(origin) || origin.includes('ngrok')) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));

app.use(express.json());
app.use('/ml', mercadoLivreRouter);
app.use('/bling', blingRouter);

// Força o log de todas as requisições recebidas e erros não tratados
app.use((req, res, next) => {
  console.log(`[Express] ${req.method} ${req.url} - Body:`, req.body, '- Query:', req.query);
  next();
});

app.get('/api/ngrok-url', (req, res) => {
  res.json({ url: NGROK.url });
});

// Endpoint de debug para saber se está usando ngrok/local
app.get('/api/ngrok-debug', (req, res) => {
  res.json({
    ngrokUrl,
    node_env: process.env.NODE_ENV,
    usandoNgrok: !!ngrokUrl,
    mensagem: ngrokUrl
      ? 'ngrok ATIVO. Backend acessível externamente.'
      : 'ngrok NÃO está ativo. Backend só acessível localmente.'
  });
});

app.get('/', (req, res) => {
  res.send('Backend Express rodando!');
});

async function startServer() {
  try {
    const server = app.listen(PORT, () => {
      // Não mostrar logs detalhados, apenas mensagem simples
    });

    // Só inicia o ngrok se não estiver em produção
    if (process.env.NODE_ENV !== 'production' && !process.env.DISABLE_NGROK) {
      await ngrok.authtoken(NGROK_AUTHTOKEN);
      ngrokUrl = await ngrok.connect({
        addr: PORT,
        authtoken: NGROK_AUTHTOKEN,
        proto: 'http'
      });
      if (ngrokUrl.endsWith('/')) ngrokUrl = ngrokUrl.slice(0, -1);
      app.locals.ngrokUrl = ngrokUrl;
      NGROK.url = ngrokUrl; // <-- importante para o router/mercadoLivre.js
      console.log('Servidor rodando!');
      console.log('Acesse via ngrok:', ngrokUrl);
    } else {
      ngrokUrl = null;
      app.locals.ngrokUrl = null;
      NGROK.url = null;
      console.log('Servidor rodando!');
      console.log('Acesse localmente em http://localhost:' + PORT);
    }

    server.on('error', (err) => {
      console.error('Erro no servidor:', err);
      process.exit(1);
    });

  } catch (err) {
    console.error('Erro ao iniciar o servidor/ngrok:', err);
    process.exit(1);
  }
}

process.on('SIGTERM', async () => {
  console.log('Recebido SIGTERM. Desligando...');
  if (ngrokUrl) await ngrok.disconnect();
  process.exit(0);
});

startServer();