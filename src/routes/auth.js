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
const { sendPushToUser } = require('../config/push');

// POST /api/auth/register
// Called after Firebase client-side auth succeeds
// Creates the MongoDB user + optional profile
router.post('/register', async (req, res) => {
  try {
    const { email, firebaseUid, displayName, firstName, lastName, profileType, referredByCode } = req.body;

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
        const infDisplayName = displayName || `${firstName || ''} ${lastName || ''}`.trim() || user.legalFirstName || user.email.split('@')[0];
        const infHandle = sanitizeHandle(infDisplayName) || sanitizeHandle(user.email?.split('@')[0]) || `user${Date.now()}`;
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
        let referredById = null;
        if (referredByCode) {
          const referrer = await BrandProfile.findOne({ referralCode: referredByCode.toUpperCase() });
          if (referrer) referredById = referrer._id;
        }
        const brandProfile = await BrandProfile.create({
          userId: user._id,
          referralCode,
          referredBy: referredById,
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
        // Legal name stays null at sign-up — collected during PayPal onboarding
        legalFirstName: firstName || null,
        legalLastName: lastName || null,
        lastLoginAt: new Date(),
        loginCount: 1,
      });

      // Create the requested profile type
      // RULE: Every influencer must have displayName + handle. No "Unknown" creators.
      if (profileType === 'influencer') {
        const referralCode = 'INF-' + Math.random().toString(36).substring(2, 8).toUpperCase();
        const newDisplayName = displayName || `${firstName || ''} ${lastName || ''}`.trim() || email.split('@')[0];
        const newHandle = sanitizeHandle(newDisplayName) || sanitizeHandle(email.split('@')[0]) || `user${Date.now()}`;
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
        let referredById = null;
        if (referredByCode) {
          const referrer = await BrandProfile.findOne({ referralCode: referredByCode.toUpperCase() });
          if (referrer) referredById = referrer._id;
        }
        const brandProfile = await BrandProfile.create({
          userId: user._id,
          referralCode,
          referredBy: referredById,
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
          notify.accountCreated({ user, brandName: user.legalFirstName || 'there' }).catch(e => console.error('[auth/register] accountCreated error:', e.message));
        }
      } catch (notifyErr) {
        console.error('[auth/register] welcome notify error:', notifyErr.message);
      }

      // Notify admin of new signup (non-blocking)
      try {
        const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);
        if (adminEmails.length > 0) {
          const isCreator = profileType === 'influencer';
          const typeLabel = isCreator ? 'Creator' : 'Brand';
          const panelLink = isCreator
            ? 'https://keepuspostd.com/pages/admin/creators.html'
            : 'https://keepuspostd.com/pages/admin/users.html';
          for (const adminEmail of adminEmails) {
            sendEmail({
              to: adminEmail,
              subject: `New ${typeLabel} signed up — ${email}`,
              headline: `New ${typeLabel} Account`,
              preheader: `${email} just joined KUP as a ${typeLabel.toLowerCase()}`,
              bodyHtml: `
                <p>A new ${typeLabel.toLowerCase()} just created an account on KUP.</p>
                <p><strong>Email:</strong> ${email}</p>
                <p><strong>Name:</strong> ${[user.legalFirstName, user.legalLastName].filter(Boolean).join(' ') || 'Not provided'}</p>
                <p><strong>Account type:</strong> ${typeLabel}</p>
                <p><strong>Joined:</strong> ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT</p>
              `,
              ctaText: `View in Admin Panel`,
              ctaUrl: panelLink,
              variant: 'brand',
            }).catch(e => console.error(`[auth/register] admin notify error: ${e.message}`));
          }
        }
      } catch (adminNotifyErr) {
        console.error('[auth/register] admin notify error:', adminNotifyErr.message);
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
    // req.body values — re-read here since the try-block const bindings are out of scope in catch
    const { email: _email, firebaseUid: _uid, firstName: _first, lastName: _last, profileType: _ptype } = req.body || {};

    // Log full details so Railway shows us the real failure line
    console.error('Registration error:', error.message, '| code:', error.code, '| name:', error.name);
    if (error.stack) console.error('Registration stack:', error.stack.split('\n').slice(0, 4).join(' | '));

    // MongoDB duplicate key — handle gracefully instead of returning 500
    if (error.code === 11000) {
      const keyStr = JSON.stringify(error.keyPattern || error.keyValue || {});

      // Duplicate email — existing account, link the new Firebase UID (e.g. re-install / Apple re-auth)
      if (keyStr.includes('email') && _email) {
        try {
          const existingUser = await User.findOne({ email: _email.toLowerCase().trim() });
          if (existingUser) {
            existingUser.firebaseUid = _uid;
            await existingUser.save();

            // If they requested a brand profile and already have one (from prior signup):
            // restart the trial IF it expired and they never subscribed.
            // This covers fresh-signup attempts where the email was seen before.
            if (_ptype === 'brand' && existingUser.hasBrandProfile) {
              const existingBrandProfile = await BrandProfile.findOne({ userId: existingUser._id });
              if (
                existingBrandProfile &&
                existingBrandProfile.trialExpired &&
                !existingBrandProfile.paypalSubscriptionId
              ) {
                await startTrial(existingBrandProfile);
                console.log(`🔄 Restarted trial for re-registering user ${existingUser.email}`);
              }
            }

            // If they requested a brand profile but don't have one yet, create it + start trial
            if (_ptype === 'brand' && !existingUser.hasBrandProfile) {
              const referralCode = 'BRD-' + Math.random().toString(36).substring(2, 8).toUpperCase();
              const newBrandProfile = await BrandProfile.create({
                userId: existingUser._id,
                referralCode,
              });
              await startTrial(newBrandProfile);
              existingUser.hasBrandProfile = true;
              existingUser.activeProfile = 'brand';
              await existingUser.save();
              console.log(`✅ Added brand profile + trial to linked user ${existingUser.email}`);
            }

            const profile = existingUser.hasInfluencerProfile
              ? await InfluencerProfile.findOne({ userId: existingUser._id })
              : null;
            console.log(`🔗 Linked new Firebase UID to existing user ${existingUser.email}`);
            return res.status(201).json({
              message: 'Account linked successfully',
              user: {
                id: existingUser._id,
                email: existingUser.email,
                activeProfile: existingUser.activeProfile,
                hasInfluencerProfile: existingUser.hasInfluencerProfile,
                hasBrandProfile: existingUser.hasBrandProfile,
              },
              influencerProfile: profile || null,
            });
          }
        } catch (linkErr) {
          console.error('Registration duplicate-email link failed:', linkErr.message);
        }
      }

      // Duplicate referralCode — regenerate and retry once (very rare collision)
      if (keyStr.includes('referralCode') && _uid) {
        try {
          const userForRef = await User.findOne({ firebaseUid: _uid });
          if (userForRef) {
            const prefix = (_ptype === 'brand') ? 'BRD' : 'INF';
            const newCode = `${prefix}-` + Math.random().toString(36).substring(2, 10).toUpperCase();
            await InfluencerProfile.findOneAndUpdate(
              { userId: userForRef._id },
              { $set: { referralCode: newCode } },
            );
            console.log(`🔧 Referral code collision resolved for ${_email}`);
            return res.status(201).json({
              message: 'Account created successfully',
              user: {
                id: userForRef._id,
                email: userForRef.email,
                activeProfile: userForRef.activeProfile,
                hasInfluencerProfile: userForRef.hasInfluencerProfile,
                hasBrandProfile: userForRef.hasBrandProfile,
              },
            });
          }
        } catch (refRetryErr) {
          console.error('Registration referralCode-retry failed:', refRetryErr.message);
        }
      }

      // Duplicate handle — append random suffix and retry once
      if (keyStr.includes('handle') && _uid && _email) {
        try {
          const socialDisplayName = `${_first || ''} ${_last || ''}`.trim() || _email.split('@')[0];
          const baseHandle = sanitizeHandle(socialDisplayName) || sanitizeHandle(_email.split('@')[0]);
          const uniqueHandle = `${baseHandle.substring(0, 15)}_${Math.random().toString(36).substring(2, 6)}`;
          const newUser = await User.findOne({ firebaseUid: _uid });
          if (newUser) {
            await InfluencerProfile.create({
              userId: newUser._id,
              displayName: socialDisplayName,
              handle: uniqueHandle,
              referralCode: 'INF-' + Math.random().toString(36).substring(2, 8).toUpperCase(),
            });
            newUser.hasInfluencerProfile = true;
            newUser.activeProfile = 'influencer';
            await newUser.save();
            console.log(`🔧 Handle conflict resolved — assigned ${uniqueHandle} to ${newUser.email}`);
            return res.status(201).json({
              message: 'Account created successfully',
              user: {
                id: newUser._id,
                email: newUser.email,
                activeProfile: newUser.activeProfile,
                hasInfluencerProfile: newUser.hasInfluencerProfile,
                hasBrandProfile: newUser.hasBrandProfile,
              },
            });
          }
        } catch (retryErr) {
          console.error('Registration handle-retry failed:', retryErr.message);
        }
      }
    }

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

    // Parallelize profile queries for speed
    let [influencerProfile, brandProfile] = await Promise.all([
      user.hasInfluencerProfile ? InfluencerProfile.findOne({ userId: user._id }) : null,
      user.hasBrandProfile ? BrandProfile.findOne({ userId: user._id }).populate('ownedBrandIds') : null,
    ]);

    // Safety net: any brandProfile that still lacks a referralCode (from
    // pre-referral-system signups) gets one minted now so the referral page
    // never falls back to a placeholder.
    if (brandProfile && !brandProfile.referralCode) {
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const code = 'BRD-' + Math.random().toString(36).substring(2, 8).toUpperCase();
          try {
            brandProfile.referralCode = code;
            await brandProfile.save();
            break;
          } catch (err) {
            if (err && err.code === 11000) continue; // collision — regenerate
            throw err;
          }
        }
      } catch (refErr) {
        console.warn('referralCode mint-on-fetch failed:', refErr.message);
      }
    }
    // Same safety net for influencer profiles
    if (influencerProfile && !influencerProfile.referralCode) {
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const code = 'INF-' + Math.random().toString(36).substring(2, 8).toUpperCase();
          try {
            influencerProfile.referralCode = code;
            await influencerProfile.save();
            break;
          } catch (err) {
            if (err && err.code === 11000) continue;
            throw err;
          }
        }
      } catch (refErr) {
        console.warn('influencer referralCode mint-on-fetch failed:', refErr.message);
      }
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

// ── Handle Utilities ─────────────────────────────────────────
const RESERVED_HANDLES = new Set([
  'admin', 'support', 'help', 'keepuspostd', 'kup', 'postd', 'official',
  'moderator', 'mod', 'staff', 'team', 'system', 'null', 'undefined',
  'api', 'app', 'www', 'test', 'demo', 'root', 'user',
]);

function sanitizeHandle(input) {
  return (input || '').toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9_]/g, '').substring(0, 20);
}

// GET /api/auth/check-handle/:handle — Real-time handle uniqueness check
router.get('/check-handle/:handle', async (req, res) => {
  try {
    const handle = sanitizeHandle(req.params.handle);
    if (handle.length < 3) return res.json({ available: false, handle, reason: 'Must be at least 3 characters' });
    if (RESERVED_HANDLES.has(handle)) return res.json({ available: false, handle, reason: 'This name is reserved' });
    const taken = await InfluencerProfile.findOne({ handle }).select('_id').lean();
    res.json({ available: !taken, handle });
  } catch (err) {
    res.status(500).json({ available: false, reason: 'Check failed' });
  }
});

// PUT /api/auth/me — Update influencer profile fields (displayName, handle, bio, avatarUrl, socialLinks)
// This is the primary profile-update endpoint used by the Flutter app.
// displayName and handle stay in sync: updating one auto-updates the other.
router.put('/me', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const { displayName, handle, bio, avatarUrl, socialLinks } = req.body;

    // Update the user's top-level avatarUrl as well (used in some views)
    if (avatarUrl !== undefined) {
      user.avatarUrl = avatarUrl;
      await user.save();
    }

    // Find or auto-create the influencer profile (brand-only accounts need one too)
    let influencerProfile = await InfluencerProfile.findOne({ userId: user._id });
    if (!influencerProfile) {
      const baseHandle = sanitizeHandle(user.email?.split('@')[0]) || `user${Date.now()}`;
      influencerProfile = await InfluencerProfile.create({
        userId: user._id,
        displayName: `${user.firstName || ''} ${user.lastName || ''}`.trim() || baseHandle,
        handle: baseHandle,
      });
      await User.findByIdAndUpdate(user._id, { hasInfluencerProfile: true });
    }

    // Handle + displayName sync logic:
    // If displayName provided, derive handle from it (unless handle also explicitly provided)
    // If handle provided alone, update handle and set displayName to the handle value
    if (displayName !== undefined) {
      influencerProfile.displayName = displayName;
      const derivedHandle = sanitizeHandle(displayName);
      if (derivedHandle.length >= 3 && derivedHandle !== influencerProfile.handle) {
        // Check uniqueness before auto-syncing
        const taken = await InfluencerProfile.findOne({ handle: derivedHandle, _id: { $ne: influencerProfile._id } }).select('_id').lean();
        if (!taken && !RESERVED_HANDLES.has(derivedHandle)) {
          influencerProfile.handle = derivedHandle;
        }
      }
    }
    if (handle !== undefined) {
      const cleanHandle = sanitizeHandle(handle);
      if (cleanHandle.length >= 3 && cleanHandle !== influencerProfile.handle) {
        const taken = await InfluencerProfile.findOne({ handle: cleanHandle, _id: { $ne: influencerProfile._id } }).select('_id').lean();
        if (taken) return res.status(409).json({ error: 'Handle already taken', handle: cleanHandle });
        if (RESERVED_HANDLES.has(cleanHandle)) return res.status(400).json({ error: 'Handle is reserved', handle: cleanHandle });
        influencerProfile.handle = cleanHandle;
        // If displayName wasn't explicitly provided, update it to match the new handle
        if (displayName === undefined) {
          influencerProfile.displayName = handle; // preserve original casing from request
        }
      }
    }

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

    // Sync avatarUrl to InfluencerProfile too (content manager reads from there)
    if (avatarUrl !== undefined) {
      const { InfluencerProfile } = require('../models');
      await InfluencerProfile.findOneAndUpdate(
        { userId: user._id },
        { avatarUrl },
      ).catch(() => {});
    }

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

    // Fire brand published welcome email (non-blocking)
    try {
      const { BrandProfile, Brand } = require('../models');
      const brandProfile = await BrandProfile.findOne({ userId: req.user._id });
      let brandName = null;
      if (brandProfile && brandProfile.primaryBrandId) {
        const brand = await Brand.findById(brandProfile.primaryBrandId);
        if (brand) brandName = brand.name;
      }
      notify.brandPublished({ user: req.user, brand: brand || { name: brandName || 'your brand' } })
        .catch(e => console.error('[complete-onboarding] brandPublished error:', e.message));
    } catch (notifyErr) {
      console.error('[complete-onboarding] notify error:', notifyErr.message);
    }

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
// Two connection methods:
// 1. PPCP Merchant Onboarding: enables direct brand→influencer routing (required for CPA/PostdPay)
// 2. PayPal Email (legacy): used for Payouts API cashouts (KUP→influencer bonuses/withdrawals)

const paypal = require('../config/paypal');

// GET /api/auth/paypal-onboard — Initiate PPCP merchant onboarding
// Returns an onboardingUrl for the influencer to open in a browser/WebView.
// After completing, PayPal redirects to our /return URL with merchantIdInPayPal.
router.get('/paypal-onboard', requireAuth, async (req, res) => {
  try {
    // Guard: PAYPAL_PARTNER_ID is required for PPCP onboarding — surface this clearly
    if (!process.env.PAYPAL_PARTNER_ID) {
      console.error('[paypal-onboard] PAYPAL_PARTNER_ID env var is not set');
      return res.status(500).json({ error: 'PayPal onboarding is not configured on this server. Contact support.', detail: 'PAYPAL_PARTNER_ID missing' });
    }

    const influencer = await InfluencerProfile.findOne({ userId: req.user._id });
    if (!influencer) {
      return res.status(404).json({ error: 'Influencer profile not found' });
    }

    // If already completed, return current status
    if (influencer.paypalOnboardingStatus === 'completed' && influencer.paypalMerchantId) {
      return res.json({
        status: 'completed',
        merchantId: influencer.paypalMerchantId,
        message: 'PayPal Business account already connected.',
      });
    }

    // Generate a unique tracking ID for this onboarding session
    const trackingId = `KUP_INF_${influencer._id}_${Date.now()}`;
    const baseUrl = process.env.APP_URL || process.env.BASE_URL || 'http://localhost:3001';
    const returnUrl = `${baseUrl}/api/auth/paypal-onboard/return?influencerId=${influencer._id}`;

    const { actionUrl, referralId } = await paypal.createPartnerReferral(trackingId, returnUrl);

    if (!actionUrl) {
      return res.status(500).json({ error: 'Could not generate PayPal onboarding URL' });
    }

    // Store tracking ID so we can match the webhook/return URL back to this influencer
    influencer.paypalTrackingId = trackingId;
    influencer.paypalOnboardingStatus = 'pending';
    await influencer.save();

    console.log(`🔗 PPCP onboarding initiated for ${influencer.displayName}: trackingId=${trackingId}`);

    res.json({
      status: 'pending',
      onboardingUrl: actionUrl,
      trackingId,
      message: 'Open this URL in a browser to connect your PayPal Business account.',
    });
  } catch (error) {
    console.error('PayPal onboard initiate error:', error.message);
    // Log full PayPal response if available to diagnose partner API issues
    if (error.paypalResponse) console.error('PayPal response:', JSON.stringify(error.paypalResponse));
    res.status(500).json({ error: 'Could not initiate PayPal onboarding', detail: error.message });
  }
});

// GET /api/auth/paypal-onboard/return — PayPal redirects here after onboarding completes
// PayPal appends: ?merchantIdInPayPal=xxx&permissionsGranted=true&accountStatus=BUSINESS_ACCOUNT
// No auth required — browser redirect from PayPal (uses influencerId from our returnUrl)
router.get('/paypal-onboard/return', async (req, res) => {
  const baseUrl = process.env.APP_URL || process.env.BASE_URL || 'http://localhost:3001';
  try {
    const { influencerId, merchantIdInPayPal, permissionsGranted, accountStatus } = req.query;

    // influencerId is always required — without it we can't find the user
    if (!influencerId) {
      console.warn('[paypal-onboard/return] Missing influencerId');
      return res.redirect(`${baseUrl}/app/influencer-earn.html?paypal=error&reason=missing_params`);
    }

    // PayPal sandbox sometimes sends permissionsGranted=false or omits it entirely.
    // Treat any explicit false/canceled as a user cancellation. Missing = proceed.
    if (permissionsGranted === 'false') {
      return res.redirect(`${baseUrl}/app/influencer-earn.html?paypal=canceled`);
    }

    const influencer = await InfluencerProfile.findById(influencerId);
    if (!influencer) {
      return res.redirect(`${baseUrl}/app/influencer-earn.html?paypal=error&reason=not_found`);
    }

    // Store merchant ID if PayPal included it (may be absent in sandbox — webhook will fill it in later)
    if (merchantIdInPayPal) {
      influencer.paypalMerchantId = merchantIdInPayPal;
      console.log(`✅ PPCP onboarding complete for ${influencer.displayName}: merchantId=${merchantIdInPayPal}`);
    } else {
      // No merchantId yet — mark as completed anyway; webhook MERCHANT.ONBOARDING.COMPLETED
      // will provide the merchantId once PayPal finishes processing on their side.
      console.log(`✅ PPCP onboarding return for ${influencer.displayName}: no merchantId yet (pending webhook)`);
    }

    influencer.paypalOnboardingStatus = 'completed';
    influencer.paypalConnectedAt = new Date();
    await influencer.save();

    // 📧 Notify influencer: PayPal Business connected
    notify.paypalConnected({
      influencer: { ...influencer.toObject(), email: influencer.paypalEmail || '', userId: influencer.userId },
      maskedEmail: 'PayPal Business Account',
    }).catch(() => {});

    res.redirect(`${baseUrl}/app/influencer-earn.html?paypal=connected`);
  } catch (error) {
    console.error('PayPal onboard return error:', error.message);
    res.redirect(`${baseUrl}/app/influencer-earn.html?paypal=error&reason=server_error`);
  }
});

// GET /api/auth/paypal-onboard/status — Check PPCP onboarding status
// If our DB says 'pending' but PayPal says the merchant completed onboarding,
// we update our record. This handles the case where PayPal doesn't fire the
// return URL redirect (common in sandbox, occasional in production).
router.get('/paypal-onboard/status', requireAuth, async (req, res) => {
  try {
    const influencer = await InfluencerProfile.findOne({ userId: req.user._id });
    if (!influencer) {
      return res.status(404).json({ error: 'Influencer profile not found' });
    }

    // If status is pending and we have a tracking ID, ask PayPal directly
    if (influencer.paypalOnboardingStatus === 'pending' && influencer.paypalTrackingId) {
      try {
        const ppResult = await paypal.getMerchantStatusByTrackingId(influencer.paypalTrackingId);
        if (ppResult && ppResult.merchant_id) {
          // PayPal confirms onboarding is done — update our record
          influencer.paypalMerchantId = ppResult.merchant_id;
          influencer.paypalOnboardingStatus = 'completed';
          influencer.paypalConnectedAt = new Date();
          await influencer.save();
          console.log(`✅ PPCP onboarding confirmed via status poll for ${influencer.displayName}: merchantId=${ppResult.merchant_id}`);
        }
      } catch (pollErr) {
        console.warn('[paypal-onboard/status] Could not poll PayPal by trackingId:', pollErr.message);
      }
    }

    // If we have a merchantId, verify with PayPal that it's still active
    let paypalVerified = null;
    if (influencer.paypalMerchantId) {
      try {
        const status = await paypal.getMerchantStatus(influencer.paypalMerchantId);
        paypalVerified = {
          paymentsReceivable: status.payments_receivable,
          primaryEmailConfirmed: status.primary_email_confirmed,
          oauthThirdParty: status.oauth_third_party || [],
        };
      } catch (verifyErr) {
        console.warn('[paypal-onboard/status] Could not verify with PayPal:', verifyErr.message);
      }
    }

    res.json({
      onboardingStatus: influencer.paypalOnboardingStatus,
      merchantId: influencer.paypalMerchantId || null,
      connectedAt: influencer.paypalConnectedAt || null,
      paypalVerified,
    });
  } catch (error) {
    console.error('PayPal onboard status error:', error.message);
    res.status(500).json({ error: 'Could not check PayPal status' });
  }
});

// POST /api/auth/paypal-connect — Connect PayPal email (used for cashouts / Payouts API)
// This is separate from PPCP onboarding — both can coexist on the same account.
router.post('/paypal-connect', requireAuth, async (req, res) => {
  try {
    const { paypalEmail, legalFirstName, legalLastName } = req.body;

    if (!paypalEmail) {
      return res.status(400).json({ error: 'paypalEmail is required' });
    }

    // Save legal name to User record if provided (used for PayPal payouts + tax)
    if (legalFirstName || legalLastName) {
      await User.findByIdAndUpdate(req.user._id, {
        ...(legalFirstName && { legalFirstName: legalFirstName.trim() }),
        ...(legalLastName && { legalLastName: legalLastName.trim() }),
      });
    }

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

    console.log(`🔗 PayPal email connected for ${influencer.displayName}: ${paypalEmail}`);

    const maskedEmail = paypalEmail.replace(/^(.{2})(.*)(@.*)$/, '$1***$3');
    notify.paypalConnected({
      influencer: { ...influencer.toObject(), email: req.user.email, userId: req.user._id },
      maskedEmail,
    }).catch(() => {});

    res.json({
      message: 'PayPal email connected successfully',
      paypalEmail: influencer.paypalEmail,
      connectedAt: influencer.paypalConnectedAt,
    });
  } catch (error) {
    console.error('PayPal connect error:', error.message);
    res.status(500).json({ error: 'Could not connect PayPal account' });
  }
});

// DELETE /api/auth/paypal-disconnect — Remove PayPal email (cashout email only)
router.delete('/paypal-disconnect', requireAuth, async (req, res) => {
  try {
    const influencer = await InfluencerProfile.findOne({ userId: req.user._id });
    if (!influencer) {
      return res.status(404).json({ error: 'Influencer profile not found' });
    }

    influencer.paypalEmail = null;
    influencer.paypalConnectedAt = null;
    await influencer.save();

    console.log(`🔗 PayPal email disconnected for ${influencer.displayName}`);

    res.json({ message: 'PayPal account disconnected' });
  } catch (error) {
    console.error('PayPal disconnect error:', error.message);
    res.status(500).json({ error: 'Could not disconnect PayPal account' });
  }
});

// DELETE /api/auth/paypal-reset — Full reset: clears PPCP merchant + email so influencer can re-onboard
router.delete('/paypal-reset', requireAuth, async (req, res) => {
  try {
    const influencer = await InfluencerProfile.findOne({ userId: req.user._id });
    if (!influencer) return res.status(404).json({ error: 'Influencer profile not found' });

    const oldMerchant = influencer.paypalMerchantId;
    const oldEmail = influencer.paypalEmail;
    influencer.paypalEmail = null;
    influencer.paypalConnectedAt = null;
    influencer.paypalMerchantId = null;
    influencer.paypalOnboardingStatus = null;
    await influencer.save();

    console.log(`🔄 PayPal FULL RESET for ${influencer.displayName}: cleared merchantId=${oldMerchant}, email=${oldEmail}`);
    res.json({ message: 'PayPal fully reset. You can now re-onboard with a different PayPal account.' });
  } catch (error) {
    console.error('PayPal reset error:', error.message);
    res.status(500).json({ error: 'Could not reset PayPal' });
  }
});

// GET /api/auth/paypal-status — Combined PayPal connection status
// Returns both PPCP onboarding status AND email connection status
router.get('/paypal-status', requireAuth, async (req, res) => {
  try {
    const influencer = await InfluencerProfile.findOne({ userId: req.user._id });
    if (!influencer) {
      return res.status(404).json({ error: 'Influencer profile not found' });
    }

    let maskedEmail = null;
    if (influencer.paypalEmail) {
      const parts = influencer.paypalEmail.split('@');
      const name = parts[0];
      const domain = parts[1];
      const visible = name.length <= 2 ? name : name.substring(0, 2);
      maskedEmail = `${visible}${'*'.repeat(Math.max(name.length - 2, 0))}@${domain}`;
    }

    res.json({
      // Email connection (cashouts)
      connected: !!influencer.paypalEmail,
      email: maskedEmail,
      paypalEmail: maskedEmail,
      connectedAt: influencer.paypalConnectedAt || null,

      // PPCP merchant onboarding (direct payments)
      onboardingStatus: influencer.paypalOnboardingStatus,
      merchantId: influencer.paypalMerchantId || null,
      ppccReady: influencer.paypalOnboardingStatus === 'completed' && !!influencer.paypalMerchantId,
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

    let influencer = await InfluencerProfile.findOne({ userId: req.user._id });
    if (!influencer) {
      // Auto-create influencer profile if user only has a brand profile
      const user = req.user;
      const autoName = `${user.legalFirstName || ''} ${user.legalLastName || ''}`.trim() || (user.email || '').split('@')[0];
      const baseHandle = sanitizeHandle(autoName) || `user${Date.now()}`;
      const referralCode = 'INF-' + Math.random().toString(36).substring(2, 8).toUpperCase();

      // Handle uniqueness: try base handle, fall back to base+random suffix
      let finalHandle = baseHandle;
      const existingHandle = await InfluencerProfile.findOne({ handle: baseHandle }).select('_id').lean();
      if (existingHandle) {
        finalHandle = baseHandle.substring(0, 15) + '_' + Math.random().toString(36).substring(2, 5);
      }

      influencer = await InfluencerProfile.create({
        userId: user._id,
        displayName: autoName,
        handle: finalHandle,
        referralCode,
      });
      await User.findByIdAndUpdate(user._id, { hasInfluencerProfile: true });
      console.log(`✅ Auto-created influencer profile for ${user.email} during social verify`);
    }

    // 60-day cooldown: if already verified, enforce wait period before re-verification
    const REVERIFY_COOLDOWN_DAYS = 60;
    if (influencer.isVerified && influencer.lastVerificationAt) {
      const daysSince = Math.floor((Date.now() - new Date(influencer.lastVerificationAt).getTime()) / (1000 * 60 * 60 * 24));
      if (daysSince < REVERIFY_COOLDOWN_DAYS) {
        const eligibleDate = new Date(new Date(influencer.lastVerificationAt).getTime() + REVERIFY_COOLDOWN_DAYS * 24 * 60 * 60 * 1000);
        return res.status(429).json({
          error: 'cooldown_active',
          message: `Re-verification available in ${REVERIFY_COOLDOWN_DAYS - daysSince} days`,
          eligibleDate: eligibleDate.toISOString(),
          daysSince,
          cooldownDays: REVERIFY_COOLDOWN_DAYS,
        });
      }
    }

    // Save social handles — merge with any existing
    const currentLinks = influencer.socialLinks ? Object.fromEntries(influencer.socialLinks) : {};
    const updatedLinks = { ...currentLinks, ...handles };
    influencer.socialLinks = updatedLinks;

    // Mark as pending review instead of instantly verifying
    influencer.verificationPending = true;
    influencer.verificationPendingAt = new Date();
    influencer.pendingVerificationData = {
      handles,
      followerCount: count,
      engagementRate: engagementRate || null,
    };
    // Do NOT change isVerified or influenceTier here — admin approves those

    await influencer.save();

    // Push-notify + email all admin users about new verification request
    try {
      const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
      if (adminEmails.length > 0) {
        const adminUsers = await User.find({ email: { $in: adminEmails } }).select('_id').lean();
        const firstHandle = Object.values(handles)[0];
        // Push
        await Promise.allSettled(
          adminUsers.map(adminUser =>
            sendPushToUser(adminUser._id, {
              title: '🔔 New Verification Request',
              body: `${influencer.displayName} (@${firstHandle}) submitted for review`,
              data: { type: 'verification_pending', influencerProfileId: influencer._id.toString() },
            })
          )
        );
        // Email
        const handleList = Object.entries(handles)
          .map(([platform, handle]) => `${platform}: @${handle}`)
          .join(', ');
        for (const adminEmail of adminEmails) {
          sendEmail({
            to: adminEmail,
            subject: `Verification request — ${influencer.displayName} (@${firstHandle})`,
            headline: 'New Verification Request',
            preheader: `${influencer.displayName} submitted handles for tier review`,
            bodyHtml: `
              <p><strong>${influencer.displayName}</strong> (@${firstHandle}) submitted a verification request.</p>
              <p><strong>Handles:</strong> ${handleList}</p>
              <p><strong>Claimed followers:</strong> ${followerCount?.toLocaleString() || 'Not provided'}</p>
              ${engagementRate ? `<p><strong>Engagement rate:</strong> ${engagementRate}%</p>` : ''}
              <p>Log in to the admin panel to review and approve or reject.</p>
            `,
            ctaText: 'Review in Admin Panel',
            ctaUrl: 'https://keepuspostd.com/pages/admin/verifications.html',
            variant: 'brand',
          }).catch(e => console.error('[social-verify] admin email error:', e.message));
        }
      }
    } catch (pushErr) {
      console.warn('⚠️  Admin push/email notification failed:', pushErr.message);
    }

    res.json({
      pending: true,
      message: 'Your verification is under review. We\'ll notify you once approved.',
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
      return res.json({ verified: false });
    }

    if (!influencer.isVerified) {
      if (influencer.verificationPending) {
        return res.json({ verified: false, pending: true });
      }
      return res.json({ verified: false });
    }

    const tier = TIER_THRESHOLDS.find(t => t.key === influencer.influenceTier)
      || TIER_THRESHOLDS[TIER_THRESHOLDS.length - 1];

    const links = influencer.socialLinks ? Object.fromEntries(influencer.socialLinks) : {};

    // Calculate re-verification eligibility (60-day cooldown)
    const REVERIFY_COOLDOWN_DAYS = 60;
    let canReverify = true;
    let reverifyEligibleDate = null;
    let daysUntilReverify = 0;
    if (influencer.lastVerificationAt) {
      const daysSince = Math.floor((Date.now() - new Date(influencer.lastVerificationAt).getTime()) / (1000 * 60 * 60 * 24));
      if (daysSince < REVERIFY_COOLDOWN_DAYS) {
        canReverify = false;
        daysUntilReverify = REVERIFY_COOLDOWN_DAYS - daysSince;
        reverifyEligibleDate = new Date(new Date(influencer.lastVerificationAt).getTime() + REVERIFY_COOLDOWN_DAYS * 24 * 60 * 60 * 1000).toISOString();
      }
    }

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
      canReverify,
      daysUntilReverify,
      reverifyEligibleDate,
      cooldownDays: REVERIFY_COOLDOWN_DAYS,
    });
  } catch (error) {
    console.error('Social verify status error:', error.message);
    res.status(500).json({ error: 'Could not retrieve verification status' });
  }
});

// ── Account Deletion ────────────────────────────────────
// Required by App Store guideline 5.1.1(v) — apps with account creation must offer deletion

// DELETE /api/auth/account — Permanently delete user account and all associated data
router.delete('/account', requireAuth, async (req, res) => {
  try {
    const userId = req.user._id;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Delete all associated data in parallel
    const ContentSubmission = require('../models/ContentSubmission');
    const Partnership = require('../models/Partnership');
    const SavedContent = require('../models/SavedContent');

    const Notification = require('../models/Notification');
    const Transaction = require('../models/Transaction');
    const BrandMember = require('../models/BrandMember');

    // Get influencer profile IDs before deletion (for cascading cleanup)
    const influencerProfileIds = await InfluencerProfile.find({ userId }).distinct('_id');

    await Promise.allSettled([
      InfluencerProfile.deleteMany({ userId }),
      BrandProfile.deleteMany({ userId }),
      ContentSubmission.deleteMany({ influencerProfileId: { $in: influencerProfileIds } }),
      Partnership.deleteMany({ influencerProfileId: { $in: influencerProfileIds } }),
      SavedContent.deleteMany({ userId }),
      Notification.deleteMany({ userId }),
      Transaction.updateMany({ payeeInfluencerId: { $in: influencerProfileIds } }, { $set: { payeeDeleted: true } }),
      BrandMember.deleteMany({ userId }),
    ]);

    // Send confirmation email before deleting user record
    try {
      await notify.sendEmail({
        to: user.email,
        subject: 'Your KeepUsPostd account has been deleted',
        headline: 'Account Deleted',
        preheader: 'Your account and data have been permanently removed.',
        bodyHtml: `
          <p>Hi ${user.firstName || 'there'},</p>
          <p>Your KeepUsPostd account and all associated data have been permanently deleted as requested.</p>
          <p>We're sorry to see you go. If you change your mind, you're always welcome to create a new account.</p>
        `,
        ctaText: null,
      });
    } catch (_) { /* Email failure should not block deletion */ }

    // Delete the user record last
    await User.deleteOne({ _id: userId });

    console.log(`🗑️ Account permanently deleted: ${user.email}`);
    res.json({ message: 'Account permanently deleted' });

  } catch (error) {
    console.error('[DELETE /account]', error.message);
    res.status(500).json({ error: 'Account deletion failed. Please try again or contact support.' });
  }
});

// POST /api/auth/web-token — Generate a Firebase custom token for web auto-login
// Used by the Flutter app to open the brand dashboard in a browser without
// requiring the user to log in again. The custom token is appended to the URL.
router.post('/web-token', requireAuth, async (req, res) => {
  try {
    const admin = require('../config/firebase');
    const customToken = await admin.auth().createCustomToken(req.user.firebaseUid);
    res.json({ customToken });
  } catch (error) {
    console.error('[web-token]', error.message);
    res.status(500).json({ error: 'Could not generate web token' });
  }
});

module.exports = router;
