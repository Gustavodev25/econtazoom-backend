const admin = require('firebase-admin');
let serviceAccount;

try {
  if (process.env.FIREBASE_CONFIG) {
    const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
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