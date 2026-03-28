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
    let isExistingUser = false;

    if (user) {
      isExistingUser = true;

      // User exists — check if they're requesting a profile type they don't have yet
      const wantsInfluencer = profileType === 'influencer' && !user.hasInfluencerProfile;
      const wantsBrand = profileType === 'brand' && !user.hasBrandProfile;

      if (wantsInfluencer) {
        // Add influencer profile to existing account
        // RULE: Every influencer must have displayName + handle. No "Unknown" creators.
        const referralCode = 'INF-' + Math.random().toString(36).substring(2, 8).toUpperCase();
        const infDisplayName = `${firstName || ''} ${lastName || ''}`.trim() || user.legalFirstName || user.email.split('@')[0];
        const infHandle = user.email.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '_').substring(0, 20);
        await InfluencerProfile.create({
          userId: user._id,
          displayName: infDisplayName,
          handle: infHandle,
          referralCode,
        });
        user.hasInfluencerProfile = true;
        user.activeProfile = 'influencer';
        await user.save();
        console.log(`✅ Added influencer profile to existing user: ${user.email}`);
      } else if (wantsBrand) {
        // Add brand profile to existing account
        const referralCode = 'BRD-' + Math.random().toString(36).substring(2, 8).toUpperCase();
        await BrandProfile.create({
          userId: user._id,
          referralCode,
        });
        user.hasBrandProfile = true;
        user.activeProfile = 'brand';
        await user.save();
        console.log(`✅ Added brand profile to existing user: ${user.email}`);
      } else {
        // They already have this profile type — just return success
        console.log(`ℹ️ User ${user.email} already has ${profileType} profile`);
      }
    } else {
      // Brand new user — create account
      user = await User.create({
        email: email.toLowerCase().trim(),
        firebaseUid,
        legalFirstName: firstName || null,
        legalLastName: lastName || null,
        lastLoginAt: new Date(),
        loginCount: 1,
      });

      // Create the requested profile type
      // RULE: Every influencer must have displayName + handle. No "Unknown" creators.
      if (profileType === 'influencer') {
        const referralCode = 'INF-' + Math.random().toString(36).substring(2, 8).toUpperCase();
        const newDisplayName = `${firstName || ''} ${lastName || ''}`.trim() || email.split('@')[0];
        const newHandle = email.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '_').substring(0, 20);
        await InfluencerProfile.create({
          userId: user._id,
          displayName: newDisplayName,
          handle: newHandle,
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
    }

    if (!isExistingUser) {
      console.log(`✅ New user registered: ${email} (${profileType || 'no profile'})`);
    }

    res.status(201).json({
      message: isExistingUser ? 'Profile added successfully' : 'Account created successfully',
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
        avatarUrl: user.avatarUrl,
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

// PUT /api/auth/profile — Update user profile
router.put('/profile', requireAuth, async (req, res) => {
  try {
    const user = req.user;

    const { firstName, lastName, avatarUrl } = req.body;
    if (firstName !== undefined) user.legalFirstName = firstName;
    if (lastName !== undefined) user.legalLastName = lastName;
    if (avatarUrl !== undefined) user.avatarUrl = avatarUrl;

    await user.save();

    res.json({
      success: true,
      user: {
        id: user._id,
        email: user.email,
        firstName: user.legalFirstName,
        lastName: user.legalLastName,
        avatarUrl: user.avatarUrl,
      },
    });
  } catch (err) {
    console.error('Profile update error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ── PayPal Onboarding Routes ──────────────────────────────

// PUT /api/auth/paypal-connect — Connect influencer's PayPal email
router.put('/paypal-connect', requireAuth, async (req, res) => {
  try {
    const { paypalEmail } = req.body;

    if (!paypalEmail) {
      return res.status(400).json({ error: 'paypalEmail is required' });
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(paypalEmail)) {
      return res.status(400).json({ error: 'Invalid email format' });
    }

    const influencer = await InfluencerProfile.findOne({ userId: req.user._id });
    if (!influencer) {
      return res.status(404).json({ error: 'Influencer profile not found' });
    }

    influencer.paypalEmail = paypalEmail;
    influencer.paypalConnectedAt = new Date();
    await influencer.save();

    console.log(`🔗 PayPal connected for ${influencer.displayName}: ${paypalEmail}`);

    res.json({
      message: 'PayPal account connected successfully',
      paypalEmail: influencer.paypalEmail,
      connectedAt: influencer.paypalConnectedAt,
    });
  } catch (error) {
    console.error('PayPal connect error:', error.message);
    res.status(500).json({ error: 'Could not connect PayPal account' });
  }
});

// DELETE /api/auth/paypal-disconnect — Remove PayPal email
router.delete('/paypal-disconnect', requireAuth, async (req, res) => {
  try {
    const influencer = await InfluencerProfile.findOne({ userId: req.user._id });
    if (!influencer) {
      return res.status(404).json({ error: 'Influencer profile not found' });
    }

    influencer.paypalEmail = null;
    influencer.paypalConnectedAt = null;
    await influencer.save();

    console.log(`🔗 PayPal disconnected for ${influencer.displayName}`);

    res.json({ message: 'PayPal account disconnected' });
  } catch (error) {
    console.error('PayPal disconnect error:', error.message);
    res.status(500).json({ error: 'Could not disconnect PayPal account' });
  }
});

// GET /api/auth/paypal-status — Check if PayPal is connected
router.get('/paypal-status', requireAuth, async (req, res) => {
  try {
    const influencer = await InfluencerProfile.findOne({ userId: req.user._id });
    if (!influencer) {
      return res.status(404).json({ error: 'Influencer profile not found' });
    }

    const connected = !!influencer.paypalEmail;
    let maskedEmail = null;

    if (influencer.paypalEmail) {
      const parts = influencer.paypalEmail.split('@');
      const name = parts[0];
      const domain = parts[1];
      const visible = name.length <= 2 ? name : name.substring(0, 2);
      maskedEmail = `${visible}${'*'.repeat(Math.max(name.length - 2, 0))}@${domain}`;
    }

    res.json({
      connected,
      email: maskedEmail,
      connectedAt: connected ? influencer.paypalConnectedAt : null,
    });
  } catch (error) {
    console.error('PayPal status error:', error.message);
    res.status(500).json({ error: 'Could not check PayPal status' });
  }
});

module.exports = router;
