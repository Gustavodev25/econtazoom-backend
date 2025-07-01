const admin = require('firebase-admin');
let serviceAccount;

if (process.env.FIREBASE_CONFIG) {
  // Ambiente de produção (Render) - inicializa com FIREBASE_CONFIG
  const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(firebaseConfig)
    });
  }
} else {
  // Ambiente local - inicializa com arquivo JSON
  serviceAccount = require('./econtazoom-teste-firebase-adminsdk-fbsvc-990ec49930.json');
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }
}
const db = admin.firestore();
module.exports = { db, admin };