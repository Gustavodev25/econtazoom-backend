const admin = require('firebase-admin');
let serviceAccount;

function fixPrivateKey(key) {
  // Corrige problemas de \n na chave privada
  if (typeof key === 'string') {
    return key.replace(/\\n/g, '\n');
  }
  return key;
}

if (process.env.FIREBASE_CONFIG) {
  // Ambiente de produção (Render) - inicializa com FIREBASE_CONFIG
  const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
  if (firebaseConfig.private_key) {
    firebaseConfig.private_key = fixPrivateKey(firebaseConfig.private_key);
  }
  if (!admin.apps.length) {
    try {
      admin.initializeApp({
        credential: admin.credential.cert(firebaseConfig)
      });
    } catch (err) {
      console.error('[firebase.js] Erro ao inicializar Firebase Admin:', err);
      throw err;
    }
  }
} else {
  // Ambiente local - inicializa com arquivo JSON
  serviceAccount = require('./econtazoom-teste-firebase-adminsdk-fbsvc-9eb7a86b68.json');
  if (serviceAccount.private_key) {
    serviceAccount.private_key = fixPrivateKey(serviceAccount.private_key);
  }
  if (!admin.apps.length) {
    try {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
    } catch (err) {
      console.error('[firebase.js] Erro ao inicializar Firebase Admin:', err);
      throw err;
    }
  }
}
const db = admin.firestore();
module.exports = { db, admin };