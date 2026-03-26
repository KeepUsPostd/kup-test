// Firebase Auth Middleware
// Verifies the Firebase ID token from the Authorization header
// and attaches the MongoDB User document to req.user
const admin = require('../config/firebase');
const { User } = require('../models');

// requireAuth — blocks request if not authenticated (401)
const requireAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Authentication required',
        message: 'Please log in to access this resource.',
      });
    }

    const token = authHeader.split('Bearer ')[1];

    // Verify the Firebase ID token
    const decodedToken = await admin.auth().verifyIdToken(token);

    // Find or create the User in MongoDB
    let user = await User.findOne({ firebaseUid: decodedToken.uid });

    if (!user) {
      // Auto-create user on first API call (they registered via Firebase client SDK)
      user = await User.create({
        email: decodedToken.email,
        firebaseUid: decodedToken.uid,
        authProvider: decodedToken.firebase.sign_in_provider === 'google.com' ? 'google' : 'email',
        legalFirstName: decodedToken.name ? decodedToken.name.split(' ')[0] : null,
        legalLastName: decodedToken.name ? decodedToken.name.split(' ').slice(1).join(' ') : null,
        lastLoginAt: new Date(),
        loginCount: 1,
      });
    }

    // Attach user to request
    req.user = user;
    req.firebaseUser = decodedToken;
    next();
  } catch (error) {
    console.error('Auth middleware error:', error.message);

    if (error.code === 'auth/id-token-expired') {
      return res.status(401).json({
        error: 'Token expired',
        message: 'Your session has expired. Please log in again.',
      });
    }

    return res.status(401).json({
      error: 'Invalid token',
      message: 'Authentication failed. Please log in again.',
    });
  }
};

// optionalAuth — attaches user if token present, continues either way
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split('Bearer ')[1];
      const decodedToken = await admin.auth().verifyIdToken(token);
      const user = await User.findOne({ firebaseUid: decodedToken.uid });

      if (user) {
        req.user = user;
        req.firebaseUser = decodedToken;
      }
    }
  } catch (error) {
    // Silently continue — optional auth shouldn't block
    console.warn('Optional auth failed:', error.message);
  }

  next();
};

module.exports = { requireAuth, optionalAuth };
