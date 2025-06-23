const express = require('express');
const cors = require('cors');
const ngrok = require('ngrok');
const mercadoLivreRouter = require('./router/mercadoLivre');
const blingRouter = require('./router/bling'); 

const app = express();
const PORT = process.env.PORT || 3001;
const NGROK_AUTHTOKEN = process.env.NGROK_AUTHTOKEN || '1oqB3iP42FXti1LBFru5iA0KMoL_3L1XTqcUwsjXbccgXYxdz';

let ngrokUrl = null;

app.use(cors({
  origin: 'http://localhost:8080',
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

app.get('/', (req, res) => {
  res.send('Backend Express rodando!');
});

async function startServer() {
  try {
    const server = app.listen(PORT, () => {
      console.log(`Servidor Express rodando na porta ${PORT}`);
    });

    await ngrok.authtoken(NGROK_AUTHTOKEN);
    ngrokUrl = await ngrok.connect({
      addr: PORT,
      authtoken: NGROK_AUTHTOKEN,
      onStatusChange: status => console.log(`ngrok status: ${status}`),
      onLogEvent: data => console.log(`ngrok log: ${data}`)
    });

    app.locals.ngrokUrl = ngrokUrl; // <-- Adicione esta linha

    require('./router/mercadoLivre').NGROK.url = ngrokUrl;
    console.log(`ngrok rodando: ${ngrokUrl}`);

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
  await ngrok.disconnect();
  process.exit(0);
});

startServer();