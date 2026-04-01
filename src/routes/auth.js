// Auth Routes — Registration, Login, Profile
// POST /api/auth/register — Create user account + profile
// POST /api/auth/login — Update login tracking
// GET /api/auth/me — Get current user + profile data
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { User, InfluencerProfile, BrandProfile } = require('../models');
const notify = require('../services/notifications');
const { startTrial } = require('../services/trial');

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
        const brandProfile = await BrandProfile.create({
          userId: user._id,
          referralCode,
        });
        // Start 14-day free trial (Pro-level access, no CC required)
        await startTrial(brandProfile);
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
        const brandProfile = await BrandProfile.create({
          userId: user._id,
          referralCode,
        });
        // Start 14-day free trial (Pro-level access, no CC required)
        await startTrial(brandProfile);
        user.hasBrandProfile = true;
        user.activeProfile = 'brand';
        await user.save();
      }
    }

    if (!isExistingUser) {
      console.log(`✅ New user registered: ${email} (${profileType || 'no profile'})`);

      // Fire welcome notification (non-blocking — never fail registration on notify error)
      try {
        if (profileType === 'influencer') {
          notify.influencerWelcome({ user }).catch(e => console.error('[auth/register] influencerWelcome error:', e.message));
        } else {
          // brand or no profile type — send generic account created email
          notify.accountCreated({ user, brandName: null }).catch(e => console.error('[auth/register] accountCreated error:', e.message));
        }
      } catch (notifyErr) {
        console.error('[auth/register] welcome notify error:', notifyErr.message);
      }
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
        firebaseUid: user.firebaseUid,
        legalFirstName: user.legalFirstName,
        legalLastName: user.legalLastName,
        activeProfile: user.activeProfile,
        hasInfluencerProfile: user.hasInfluencerProfile,
        hasBrandProfile: user.hasBrandProfile,
        onboardingComplete: user.onboardingComplete,
      },
      // Return as both keys so older client versions still work
      profile: profileData,
      influencerProfile: user.activeProfile === 'influencer' ? profileData : null,
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
        onboardingComplete: user.onboardingComplete,
        onboardingSteps: user.onboardingSteps || [],
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

// PUT /api/auth/me — Update influencer profile fields (displayName, bio, avatarUrl, socialLinks)
// This is the primary profile-update endpoint used by the Flutter app.
router.put('/me', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const { displayName, bio, avatarUrl, socialLinks } = req.body;

    // Update the user's top-level avatarUrl as well (used in some views)
    if (avatarUrl !== undefined) {
      user.avatarUrl = avatarUrl;
      await user.save();
    }

    // Find and update the influencer profile
    let influencerProfile = await InfluencerProfile.findOne({ userId: user._id });
    if (!influencerProfile) {
      return res.status(404).json({ error: 'Influencer profile not found' });
    }

    if (displayName !== undefined) influencerProfile.displayName = displayName;
    if (bio !== undefined) influencerProfile.bio = bio;
    if (avatarUrl !== undefined) influencerProfile.avatarUrl = avatarUrl;
    if (socialLinks !== undefined) influencerProfile.socialLinks = socialLinks;

    await influencerProfile.save();

    res.json({ success: true, influencerProfile });
  } catch (err) {
    console.error('PUT /me error:', err.message);
    res.status(500).json({ error: 'Failed to update profile' });
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

// POST /api/auth/complete-onboarding — Mark onboarding as complete
// Called by onboarding.html when user finishes all steps
router.post('/complete-onboarding', requireAuth, async (req, res) => {
  try {
    req.user.onboardingComplete = true;
    await req.user.save();
    res.json({ success: true, message: 'Onboarding complete' });
  } catch (err) {
    console.error('Complete onboarding error:', err.message);
    res.status(500).json({ error: 'Could not update onboarding status' });
  }
});

// POST /api/auth/onboarding-step — Save individual onboarding step completion
// Persists step progress to MongoDB so users don't restart on new devices/browsers
router.post('/onboarding-step', requireAuth, async (req, res) => {
  try {
    const { step } = req.body; // step = 0-indexed step number
    if (step === undefined || step < 0 || step > 4) {
      return res.status(400).json({ error: 'step must be 0–4' });
    }
    const user = req.user;
    if (!user.onboardingSteps.includes(step)) {
      user.onboardingSteps.push(step);
      await user.save();
    }
    res.json({ success: true, onboardingSteps: user.onboardingSteps });
  } catch (err) {
    console.error('Onboarding step error:', err.message);
    res.status(500).json({ error: 'Could not save onboarding step' });
  }
});

// ── Branded Auth Emails (Password Reset + Email Verification) ──────
// Uses Firebase Admin SDK to generate action links, then sends via SendGrid
// with KUP-branded templates instead of Firebase's default emails.

const admin = require('../config/firebase');
const { sendEmail } = require('../config/email');

// POST /api/auth/send-reset-email — Send KUP-branded password reset email
// No auth required (user is locked out)
router.post('/send-reset-email', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const APP_URL = process.env.APP_URL || 'https://keepuspostd.com';

    // Generate Firebase password reset link with custom action URL
    const actionCodeSettings = {
      url: `${APP_URL}/pages/auth-action.html`,
      handleCodeInApp: false,
    };

    const resetLink = await admin.auth().generatePasswordResetLink(email, actionCodeSettings);

    // Send branded email via SendGrid
    await sendEmail({
      to: email,
      subject: 'Reset Your KeepUsPostd Password',
      headline: 'Reset Your Password',
      preheader: 'You requested a password reset for your KeepUsPostd account.',
      bodyHtml: `
        <p style="margin: 0 0 16px;">We received a request to reset the password for your KeepUsPostd account.</p>
        <p style="margin: 0 0 16px;">Click the button below to create a new password. This link expires in 1 hour.</p>
        <p style="margin: 24px 0 0; font-size: 13px; color: #999;">If you didn't request this, you can safely ignore this email. Your password won't be changed.</p>
      `,
      ctaText: 'Reset Password',
      ctaUrl: resetLink,
      variant: 'brand',
    });

    console.log(`🔑 Branded reset email sent to ${email}`);
    res.json({ message: 'Password reset email sent' });
  } catch (error) {
    console.error('Send reset email error:', error.message);
    // Don't reveal whether the email exists (security best practice)
    if (error.code === 'auth/user-not-found') {
      return res.json({ message: 'Password reset email sent' });
    }
    res.status(500).json({ error: 'Could not send reset email' });
  }
});

// POST /api/auth/send-verification-email — Send KUP-branded email verification
// Requires auth (user is logged in but unverified)
router.post('/send-verification-email', requireAuth, async (req, res) => {
  try {
    const email = req.user.email;
    const APP_URL = process.env.APP_URL || 'https://keepuspostd.com';

    const actionCodeSettings = {
      url: `${APP_URL}/pages/auth-action.html`,
      handleCodeInApp: false,
    };

    const verifyLink = await admin.auth().generateEmailVerificationLink(email, actionCodeSettings);

    await sendEmail({
      to: email,
      subject: 'Verify Your KeepUsPostd Email',
      headline: 'Verify Your Email Address',
      preheader: 'One quick step to activate your KeepUsPostd account.',
      bodyHtml: `
        <p style="margin: 0 0 16px;">Welcome to KeepUsPostd! Please verify your email address to activate your account.</p>
        <p style="margin: 0 0 16px;">Click the button below to confirm your email. This link expires in 24 hours.</p>
      `,
      ctaText: 'Verify Email',
      ctaUrl: verifyLink,
      variant: 'brand',
    });

    console.log(`📧 Branded verification email sent to ${email}`);
    res.json({ message: 'Verification email sent' });
  } catch (error) {
    console.error('Send verification email error:', error.message);
    res.status(500).json({ error: 'Could not send verification email' });
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

    // 📧 Notify influencer: PayPal connected
    const maskedEmail = paypalEmail.replace(/^(.{2})(.*)(@.*)$/, '$1***$3');
    notify.paypalConnected({
      influencer: { ...influencer.toObject(), email: req.user.email, userId: req.user._id },
      maskedEmail,
    }).catch(() => {});

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

// ── Push Notification Token Management ──────────────────

// POST /api/auth/push-token — Register a device for push notifications
// Called by the native app on startup after requesting notification permission.
router.post('/push-token', requireAuth, async (req, res) => {
  try {
    const { token, device, platform } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'token is required' });
    }

    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Remove existing entry for this token (in case of re-register)
    user.fcmTokens = (user.fcmTokens || []).filter(t => t.token !== token);

    // Add new token
    user.fcmTokens.push({
      token,
      device: device || null,
      platform: platform || null,
      registeredAt: new Date(),
    });

    // Cap at 10 devices per user (remove oldest if exceeded)
    if (user.fcmTokens.length > 10) {
      user.fcmTokens = user.fcmTokens.slice(-10);
    }

    await user.save();

    console.log(`📱 Push token registered for ${user.email} (${platform || 'unknown'} — ${device || 'unknown device'})`);

    res.json({
      message: 'Push token registered',
      deviceCount: user.fcmTokens.length,
    });
  } catch (error) {
    console.error('Push token register error:', error.message);
    res.status(500).json({ error: 'Could not register push token' });
  }
});

// DELETE /api/auth/push-token — Unregister a device (e.g., on logout)
router.delete('/push-token', requireAuth, async (req, res) => {
  try {
    const { token } = req.body;

    if (!token) {
      return res.status(400).json({ error: 'token is required' });
    }

    await User.updateOne(
      { _id: req.user._id },
      { $pull: { fcmTokens: { token } } }
    );

    console.log(`📱 Push token removed for ${req.user.email}`);
    res.json({ message: 'Push token removed' });
  } catch (error) {
    console.error('Push token remove error:', error.message);
    res.status(500).json({ error: 'Could not remove push token' });
  }
});

// ── Notification Preferences ────────────────────────────

// GET /api/auth/notification-prefs — Get current preferences
router.get('/notification-prefs', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id, { notificationPrefs: 1 });
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({ prefs: user.notificationPrefs || {} });
  } catch (error) {
    console.error('Get notification prefs error:', error.message);
    res.status(500).json({ error: 'Could not fetch preferences' });
  }
});

// PUT /api/auth/notification-prefs — Update preferences
// Body: { email: { content: true, campaigns: false }, push: { rewards: true } }
// Security & payments email can never be disabled (enforced server-side)
router.put('/notification-prefs', requireAuth, async (req, res) => {
  try {
    const { email, push } = req.body;
    const user = await User.findById(req.user._id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (!user.notificationPrefs) {
      user.notificationPrefs = { email: {}, push: {} };
    }

    // Merge email prefs (enforce security + payments always on)
    if (email && typeof email === 'object') {
      const allowed = ['content', 'campaigns', 'rewards', 'referrals', 'platformUpdates'];
      for (const key of allowed) {
        if (key in email) {
          user.notificationPrefs.email[key] = Boolean(email[key]);
        }
      }
      // Force these always on
      user.notificationPrefs.email.security = true;
      user.notificationPrefs.email.payments = true;
    }

    // Merge push prefs (enforce security always on)
    if (push && typeof push === 'object') {
      const allowed = ['content', 'campaigns', 'rewards', 'payments', 'referrals', 'platformUpdates'];
      for (const key of allowed) {
        if (key in push) {
          user.notificationPrefs.push[key] = Boolean(push[key]);
        }
      }
      // Force security always on
      user.notificationPrefs.push.security = true;
    }

    user.markModified('notificationPrefs');
    await user.save();

    res.json({
      message: 'Notification preferences updated',
      prefs: user.notificationPrefs,
    });
  } catch (error) {
    console.error('Update notification prefs error:', error.message);
    res.status(500).json({ error: 'Could not update preferences' });
  }
});

// ─── Social Verification ─────────────────────────────────────────────────────

/**
 * Tier thresholds — matches platform-config.js tierRates exactly.
 * Follower count → influenceTier key → display name + pay rates.
 */
const TIER_THRESHOLDS = [
  { key: 'celebrity',   min: 5_000_000, displayName: 'Celebrity',  range: '5M+',         video: 45, image: 23 },
  { key: 'premium',     min: 1_000_000, displayName: 'Mega',        range: '1M–5M',       video: 33, image: 15 },
  { key: 'established', min: 500_000,   displayName: 'Macro',       range: '500K–1M',     video: 25, image: 12 },
  { key: 'rising',      min: 50_000,    displayName: 'Mid',         range: '50K–500K',    video: 18, image: 9  },
  { key: 'micro',       min: 10_000,    displayName: 'Micro',       range: '10K–50K',     video: 11, image: 6  },
  { key: 'nano',        min: 5_000,     displayName: 'Nano',        range: '5K–10K',      video: 8,  image: 4  },
  { key: 'unverified',  min: 0,         displayName: 'Startup',     range: '0–5K',        video: 4,  image: 2  },
];

function tierFromFollowers(count) {
  return TIER_THRESHOLDS.find(t => count >= t.min) || TIER_THRESHOLDS[TIER_THRESHOLDS.length - 1];
}

/**
 * POST /api/auth/social-verify
 * Stores social handles and calculates influence tier from follower count.
 *
 * Body: {
 *   handles: { instagram?: string, tiktok?: string, youtube?: string, twitter?: string },
 *   followerCount: number,          // self-reported total across platforms
 *   engagementRate?: number         // optional, 0–100 (e.g. 4.2 = 4.2%)
 * }
 *
 * TODO: Replace followerCount self-report with real Instagram/TikTok API calls
 * once Meta and TikTok developer apps are approved.
 */
router.post('/social-verify', requireAuth, async (req, res) => {
  try {
    const { handles, followerCount, engagementRate } = req.body;

    if (!handles || typeof handles !== 'object' || Object.keys(handles).length === 0) {
      return res.status(400).json({ error: 'At least one social handle is required' });
    }

    const count = parseInt(followerCount, 10);
    if (isNaN(count) || count < 0) {
      return res.status(400).json({ error: 'followerCount must be a non-negative number' });
    }

    const influencer = await InfluencerProfile.findOne({ userId: req.user._id });
    if (!influencer) {
      return res.status(404).json({ error: 'Influencer profile not found' });
    }

    const tier = tierFromFollowers(count);

    // Save social handles — merge with any existing
    const currentLinks = influencer.socialLinks ? Object.fromEntries(influencer.socialLinks) : {};
    const updatedLinks = { ...currentLinks, ...handles };
    influencer.socialLinks = updatedLinks;

    // Update influence data
    influencer.influenceTier = tier.key;
    influencer.realFollowerCount = count;
    influencer.isVerified = true;
    influencer.verifiedAt = influencer.verifiedAt || new Date();
    influencer.lastVerificationAt = new Date();
    if (engagementRate != null) {
      influencer.engagementRate = parseFloat(engagementRate);
    }

    await influencer.save();

    // Notify: social influence verified
    try {
      await notify.socialInfluenceVerified({
        userId: req.user._id,
        email: req.user.email,
        displayName: influencer.displayName,
        tier: tier.displayName,
        followerCount: count,
      });
    } catch (notifErr) {
      console.warn('⚠️  Social verify notification failed:', notifErr.message);
    }

    const platformCount = Object.keys(updatedLinks).length;
    const engRate = influencer.engagementRate;

    res.json({
      verified: true,
      tier: tier.displayName,
      tierKey: tier.key,
      tierRange: tier.range,
      realFollowers: count,
      engagementRate: engRate,
      platforms: platformCount,
      realFollowersPct: 92,   // Placeholder until real API analysis
      suspiciousPct: 5,
      inactivePct: 3,
      payRates: { video: tier.video, image: tier.image },
      verifiedAt: influencer.lastVerificationAt,
    });
  } catch (error) {
    console.error('Social verify error:', error.message);
    res.status(500).json({ error: 'Could not complete verification' });
  }
});

/**
 * GET /api/auth/social-verify/status
 * Returns current verification status and results for the logged-in influencer.
 */
router.get('/social-verify/status', requireAuth, async (req, res) => {
  try {
    const influencer = await InfluencerProfile.findOne({ userId: req.user._id });
    if (!influencer) {
      return res.status(404).json({ error: 'Influencer profile not found' });
    }

    if (!influencer.isVerified) {
      return res.json({ verified: false });
    }

    const tier = TIER_THRESHOLDS.find(t => t.key === influencer.influenceTier)
      || TIER_THRESHOLDS[TIER_THRESHOLDS.length - 1];

    const links = influencer.socialLinks ? Object.fromEntries(influencer.socialLinks) : {};

    res.json({
      verified: true,
      tier: tier.displayName,
      tierKey: tier.key,
      tierRange: tier.range,
      realFollowers: influencer.realFollowerCount,
      engagementRate: influencer.engagementRate,
      platforms: Object.keys(links).length,
      socialLinks: links,
      realFollowersPct: 92,
      suspiciousPct: 5,
      inactivePct: 3,
      payRates: { video: tier.video, image: tier.image },
      verifiedAt: influencer.lastVerificationAt,
    });
  } catch (error) {
    console.error('Social verify status error:', error.message);
    res.status(500).json({ error: 'Could not retrieve verification status' });
  }
});

module.exports = router;
