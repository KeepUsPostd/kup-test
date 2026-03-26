// Auth Routes — Registration, Login, Profile
// POST /api/auth/register — Create user account + profile
// POST /api/auth/login — Update login tracking
// GET /api/auth/me — Get current user + profile data
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { User, InfluencerProfile, BrandProfile } = require('../models');

// POST /api/auth/register
// Called after Firebase client-side auth succeeds
// Creates the MongoDB user + optional profile
router.post('/register', async (req, res) => {
  try {
    const { email, firebaseUid, firstName, lastName, profileType } = req.body;

    // Validate required fields
    if (!email || !firebaseUid) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'Email and Firebase UID are required.',
      });
    }

    // Check if user already exists
    let user = await User.findOne({ firebaseUid });
    if (user) {
      return res.status(409).json({
        error: 'User already exists',
        message: 'An account with this Firebase UID already exists.',
        user: { id: user._id, email: user.email },
      });
    }

    // Create the user
    user = await User.create({
      email: email.toLowerCase().trim(),
      firebaseUid,
      legalFirstName: firstName || null,
      legalLastName: lastName || null,
      lastLoginAt: new Date(),
      loginCount: 1,
    });

    // Create the requested profile type
    if (profileType === 'influencer') {
      const referralCode = 'INF-' + Math.random().toString(36).substring(2, 8).toUpperCase();
      await InfluencerProfile.create({
        userId: user._id,
        displayName: `${firstName || ''} ${lastName || ''}`.trim() || null,
        referralCode,
      });
      user.hasInfluencerProfile = true;
      user.activeProfile = 'influencer';
      await user.save();
    } else if (profileType === 'brand') {
      const referralCode = 'BRD-' + Math.random().toString(36).substring(2, 8).toUpperCase();
      await BrandProfile.create({
        userId: user._id,
        referralCode,
      });
      user.hasBrandProfile = true;
      user.activeProfile = 'brand';
      await user.save();
    }

    console.log(`✅ New user registered: ${email} (${profileType || 'no profile'})`);

    res.status(201).json({
      message: 'Account created successfully',
      user: {
        id: user._id,
        email: user.email,
        activeProfile: user.activeProfile,
        hasInfluencerProfile: user.hasInfluencerProfile,
        hasBrandProfile: user.hasBrandProfile,
      },
    });
  } catch (error) {
    console.error('Registration error:', error.message);
    res.status(500).json({
      error: 'Registration failed',
      message: 'Something went wrong. Please try again.',
    });
  }
});

// POST /api/auth/login
// Called on each Firebase login to update tracking
router.post('/login', requireAuth, async (req, res) => {
  try {
    const user = req.user;

    // Update login tracking
    user.lastLoginAt = new Date();
    user.loginCount += 1;
    await user.save();

    // Fetch profile data
    let profileData = null;
    if (user.activeProfile === 'influencer' && user.hasInfluencerProfile) {
      profileData = await InfluencerProfile.findOne({ userId: user._id });
    } else if (user.activeProfile === 'brand' && user.hasBrandProfile) {
      profileData = await BrandProfile.findOne({ userId: user._id }).populate('ownedBrandIds');
    }

    res.json({
      message: 'Login successful',
      user: {
        id: user._id,
        email: user.email,
        firstName: user.legalFirstName,
        lastName: user.legalLastName,
        activeProfile: user.activeProfile,
        hasInfluencerProfile: user.hasInfluencerProfile,
        hasBrandProfile: user.hasBrandProfile,
      },
      profile: profileData,
    });
  } catch (error) {
    console.error('Login tracking error:', error.message);
    res.status(500).json({ error: 'Login tracking failed' });
  }
});

// GET /api/auth/me
// Returns current user + active profile data
router.get('/me', requireAuth, async (req, res) => {
  try {
    const user = req.user;

    let influencerProfile = null;
    let brandProfile = null;

    if (user.hasInfluencerProfile) {
      influencerProfile = await InfluencerProfile.findOne({ userId: user._id });
    }
    if (user.hasBrandProfile) {
      brandProfile = await BrandProfile.findOne({ userId: user._id }).populate('ownedBrandIds');
    }

    res.json({
      user: {
        id: user._id,
        email: user.email,
        firstName: user.legalFirstName,
        lastName: user.legalLastName,
        activeProfile: user.activeProfile,
        hasInfluencerProfile: user.hasInfluencerProfile,
        hasBrandProfile: user.hasBrandProfile,
        status: user.status,
        lastLoginAt: user.lastLoginAt,
        createdAt: user.createdAt,
      },
      influencerProfile,
      brandProfile,
    });
  } catch (error) {
    console.error('Get profile error:', error.message);
    res.status(500).json({ error: 'Could not fetch profile' });
  }
});

module.exports = router;
