const admin = require('firebase-admin');
let serviceAccount;

// Para deploy no Render, defina a variável de ambiente FIREBASE_CONFIG com o conteúdo do JSON da conta de serviço do Firebase.
try {
  if (process.env.FIREBASE_CONFIG) {
    const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
    // Corrige a chave privada para conter quebras de linha reais
    if (firebaseConfig.private_key) {
      firebaseConfig.private_key = firebaseConfig.private_key.replace(/\\n/g, '\n');
    }
    if (!admin.apps.length) {
      console.log('[firebase.js] Inicializando Firebase Admin com FIREBASE_CONFIG');
      admin.initializeApp({
        credential: admin.credential.cert(firebaseConfig)
      });
    }
  } else {
    const path = require('path');
    const credPath = path.resolve(__dirname, './econtazoom-9c5d8-firebase-adminsdk-fbsvc-07cfa1de34.json');
    console.log('[firebase.js] Inicializando Firebase Admin com arquivo:', credPath);
    serviceAccount = require(credPath);
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
    }
  }
} catch (err) {
  console.error('[firebase.js] Erro ao inicializar Firebase Admin:', err);
  throw err;
}

const db = admin.firestore();
module.exports = { db, admin };