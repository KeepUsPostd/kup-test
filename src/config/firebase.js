// Firebase Admin SDK Configuration
// This connects your backend to Firebase for user authentication
// Requires FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY
// in environment variables. Falls back to projectId-only dev mode if
// service account vars are missing (server boots but action links won't work).
const admin = require('firebase-admin');

let appConfig;

const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKeyRaw = process.env.FIREBASE_PRIVATE_KEY;

if (clientEmail && privateKeyRaw) {
  // Production mode: full service account — required for password reset + email verification links
  const privateKey = privateKeyRaw.replace(/\\n/g, '\n');
  appConfig = {
    credential: admin.credential.cert({ projectId, clientEmail, privateKey }),
    projectId,
  };
  console.log('[Firebase] Initialized with service account credentials');
} else {
  // Dev fallback: no credentials — server boots but generatePasswordResetLink etc. will fail
  console.warn(
    '[Firebase] WARNING: FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY not set. ' +
    'Password reset and email verification links will not work. ' +
    'Add service account vars to your environment.'
  );
  appConfig = { projectId };
}

admin.initializeApp(appConfig);

module.exports = admin;
