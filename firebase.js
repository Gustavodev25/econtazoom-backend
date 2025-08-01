const admin = require('firebase-admin');

if (process.env.FIREBASE_CONFIG) {
  const firebaseConfig = JSON.parse(process.env.FIREBASE_CONFIG);
  firebaseConfig.private_key = firebaseConfig.private_key.replace(/\\n/g, '\n');
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(firebaseConfig)
    });
  }
} else {
  const serviceAccount = require('./econtazoom-9c5d8-firebase-adminsdk-fbsvc-37ff7302c1.json');
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
  }
}

const db = admin.firestore();
module.exports = { db, admin };
