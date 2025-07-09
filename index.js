// index.js (ajuste no seu arquivo atual)

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const ngrok = require('ngrok');
const { NGROK } = require('./router/mercadoLivre');
const mercadoLivreRouter = require('./router/mercadoLivre');
const blingRouter = require('./router/bling');
const shopeeRouter = require('./router/shopee'); // ADICIONADO
const { db } = require('./firebase');

const app = express();

app.use(cors());
app.use(bodyParser.json({ limit: '20mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '20mb' }));

const PORT = process.env.PORT || 3001;
const NGROK_AUTHTOKEN = process.env.NGROK_AUTHTOKEN || '1oqB3iP42FXti1LBFru5iA0KMoL_3L1XTqcUwsjXbccgXYxdz';

const allowedOrigins = [
  'http://localhost:8080',
  'http://localhost:3000',
  'https://econtazoom.vercel.app',
  'https://econtazoom-backend.onrender.com',
  'https://econtazoom.com.br'
];
app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin) || (origin && origin.includes('ngrok'))) return callback(null, true);
      return callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type']
  })
);

app.use(express.json());
app.use('/ml', mercadoLivreRouter);
app.use('/bling', blingRouter);
app.use('/shopee', shopeeRouter);

app.use((req, res, next) => {
  console.log(`[Express] ${req.method} ${req.url} - Body:`, req.body, '- Query:', req.query);
  next();
});

app.get('/api/ngrok-url', (req, res) => {
  const ngrokUrl = req.app.locals.ngrokUrl || 'http://localhost:3001';
  res.json({ url: ngrokUrl });
});

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

db.collection('test')
  .limit(1)
  .get()
  .then(() => {
    console.log('Firestore autenticado com sucesso!');
  })
  .catch(err => {
    console.error('Erro ao autenticar no Firestore:', err);
  });

let ngrokUrl = null;

async function startServer() {
  try {
    const server = app.listen(PORT, () => {});

    if (process.env.NODE_ENV !== 'production' && !process.env.DISABLE_NGROK) {
      await ngrok.authtoken(NGROK_AUTHTOKEN);
      ngrokUrl = await ngrok.connect({
        addr: PORT,
        authtoken: NGROK_AUTHTOKEN,
        proto: 'http'
      });
      if (ngrokUrl.endsWith('/')) ngrokUrl = ngrokUrl.slice(0, -1);
      app.locals.ngrokUrl = ngrokUrl;
      NGROK.url = ngrokUrl;
      console.log('Servidor rodando!');
      console.log('Acesse via ngrok:', ngrokUrl);
    } else {
      ngrokUrl = null;
      app.locals.ngrokUrl = null;
      NGROK.url = null;
      console.log('Servidor rodando!');
      console.log('Acesse localmente em http://localhost:' + PORT);
    }

    server.on('error', err => {
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