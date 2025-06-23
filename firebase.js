const admin = require('firebase-admin');
const serviceAccount = require('./econtazoom-9c5d8-firebase-adminsdk-fbsvc-9a8bf02632.json'); 

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}
const db = admin.firestore();
module.exports = { db };