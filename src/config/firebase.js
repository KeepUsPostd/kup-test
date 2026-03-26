// Firebase Admin SDK Configuration
// This connects your backend to Firebase for user authentication
const admin = require('firebase-admin');

// Initialize Firebase Admin (uses environment variables)
admin.initializeApp({
  projectId: process.env.FIREBASE_PROJECT_ID,
});

module.exports = admin;
