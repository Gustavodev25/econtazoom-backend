const express = require('express');
const cors = require('cors');
const ngrok = require('ngrok');
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

app.get('/api/ngrok-url', (req, res) => {
  if (!ngrokUrl) {
    return res.status(503).json({ error: 'ngrok ainda não inicializado' });
  }
  res.json({ url: ngrokUrl });
});

// Endpoint de debug para saber se está usando ngrok/local
app.get('/api/ngrok-debug', (req, res) => {
  res.json({
    ngrokUrl,
    node_env: process.env.NODE_ENV,
    usandoNgrok: !!ngrokUrl,
    mensagem: ngrokUrl
      ? 'ngrok ativo e backend acessível externamente.'
      : 'ngrok NÃO está ativo. Backend só acessível localmente.'
  });
});

app.get('/', (req, res) => {
  res.send('Backend Express rodando!');
});

async function startServer() {
  try {
    const server = app.listen(PORT, () => {
      console.log(`Servidor Express rodando na porta ${PORT}`);
    });

    // Só inicia o ngrok se não estiver em produção
    if (process.env.NODE_ENV !== 'production' && !process.env.DISABLE_NGROK) {
      await ngrok.authtoken(NGROK_AUTHTOKEN);
      ngrokUrl = await ngrok.connect({
        addr: PORT,
        authtoken: NGROK_AUTHTOKEN,
        onStatusChange: status => console.log(`ngrok status: ${status}`),
        onLogEvent: data => console.log(`ngrok log: ${data}`)
      });
      app.locals.ngrokUrl = ngrokUrl;
      require('./router/mercadoLivre').NGROK.url = ngrokUrl; // <-- Aqui atualiza para as rotas do Mercado Livre
      console.log(`ngrok rodando: ${ngrokUrl}`);
    } else {
      ngrokUrl = null;
      app.locals.ngrokUrl = null;
      require('./router/mercadoLivre').NGROK.url = null;
      console.log('Rodando sem ngrok (produção)');
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