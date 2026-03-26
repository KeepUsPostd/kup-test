// Firebase Auth Middleware
// Verifies the Firebase ID token from the Authorization header
// and attaches the MongoDB User document to req.user
const admin = require('../config/firebase');
const { User, InfluencerProfile, BrandProfile } = require('../models');

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
      // Try matching by email (handles case where user was seeded with placeholder UID)
      user = await User.findOne({ email: decodedToken.email?.toLowerCase() });
      if (user) {
        // Link this Firebase UID to the existing MongoDB user
        user.firebaseUid = decodedToken.uid;
        await user.save();
        console.log(`🔗 Linked Firebase UID to existing user: ${user.email}`);
      } else {
        // Auto-create user on first API call (they registered via Firebase client SDK)
        const firstName = decodedToken.name ? decodedToken.name.split(' ')[0] : null;
        const lastName = decodedToken.name ? decodedToken.name.split(' ').slice(1).join(' ') : null;
        user = await User.create({
          email: decodedToken.email,
          firebaseUid: decodedToken.uid,
          authProvider: decodedToken.firebase.sign_in_provider === 'google.com' ? 'google' : 'email',
          legalFirstName: firstName,
          legalLastName: lastName,
          lastLoginAt: new Date(),
          loginCount: 1,
        });

        // Auto-create both profiles so the user can operate as brand or creator
        const displayName = [firstName, lastName].filter(Boolean).join(' ') || decodedToken.email.split('@')[0];
        await InfluencerProfile.create({
          userId: user._id,
          displayName: displayName,
          handle: decodedToken.email.split('@')[0],
          referralCode: 'INF-' + Math.random().toString(36).substring(2, 8).toUpperCase(),
        });
        await BrandProfile.create({
          userId: user._id,
          referralCode: 'BRD-' + Math.random().toString(36).substring(2, 8).toUpperCase(),
        });
        user.hasInfluencerProfile = true;
        user.hasBrandProfile = true;
        user.activeProfile = 'brand';
        await user.save();
        console.log(`✅ Auto-created user + both profiles: ${decodedToken.email}`);
      }
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
