// Kiosk Routes — Guest review capture + instant rewards
// Public endpoints (no auth required for kiosk display/session)
// Authenticated endpoints for kiosk config management
// Ref: KIOSK_MODE_SPEC.md → Display Loop, Record & Reward, Guest Reviewers
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { requireAuth } = require('../middleware/auth');
const { Brand, GuestReviewer, KioskReward, ContentSubmission } = require('../models');

// Plan-based kiosk location limits
const KIOSK_LIMITS = {
  starter: 0,
  growth: 1,
  pro: 5,
  agency: 25,
  enterprise: Infinity,
};

// ── Helper: Generate reward code (KUP-XXXXXX) ──
function generateRewardCode() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `KUP-${code}`;
}

// ══════════════════════════════════════════════
// PUBLIC ENDPOINTS (no auth — used by kiosk device)
// ══════════════════════════════════════════════

// GET /api/kiosk/display/:brandCode — Load brand kiosk config for display
// Called by kiosk-display.html to load brand data
// NOTE: Must use /display/ prefix — bare /:brandCode would swallow /config, /guests, etc.
router.get('/display/:brandCode', async (req, res) => {
  try {
    const brand = await Brand.findOne({
      kioskBrandCode: req.params.brandCode,
      kioskEnabled: true,
      status: 'active',
    });

    if (!brand) {
      return res.status(404).json({
        error: 'Kiosk not found',
        message: 'This kiosk is not active or the brand code is invalid.',
      });
    }

    // Return only public-safe kiosk config (no internal IDs exposed unnecessarily)
    res.json({
      kiosk: {
        brandId: brand._id,
        brandName: brand.name,
        brandInitials: brand.initials || (brand.name.trim().split(/\s+/).length === 1 ? brand.name.charAt(0).toUpperCase() : brand.name.trim().split(/\s+/).map(w => w.charAt(0)).join('').toUpperCase().substring(0, 3)),
        brandLogo: brand.kioskBrandingLogo || brand.logoUrl,
        brandColor: brand.kioskBrandingColor || '#FF6B35',
        offerTitle: brand.kioskOfferTitle || 'Leave a review, get a reward!',
        rewardType: brand.kioskRewardType || 'discount_percent',
        rewardValue: brand.kioskRewardValue || '10% Off',
        recordingLimit: brand.kioskRecordingLimit || 60,
        requireSmsVerify: brand.kioskRequireSmsVerify || false,
      },
    });
  } catch (error) {
    console.error('Load kiosk config error:', error.message);
    res.status(500).json({ error: 'Could not load kiosk configuration' });
  }
});

// POST /api/kiosk/session — Guest registration + reward generation
// Called after guest records a review on the kiosk
router.post('/session', async (req, res) => {
  try {
    const { brandId, firstName, phone, email } = req.body;

    if (!brandId) {
      return res.status(400).json({ error: 'brandId is required' });
    }
    if (!firstName || !firstName.trim()) {
      return res.status(400).json({ error: 'First name is required' });
    }
    if (!phone || !phone.trim()) {
      return res.status(400).json({ error: 'Phone number is required' });
    }

    // Validate brand exists, is active, and has kiosk enabled
    const brand = await Brand.findById(brandId);
    if (!brand) {
      return res.status(404).json({ error: 'Brand not found' });
    }
    if (!brand.kioskEnabled) {
      return res.status(400).json({ error: 'Kiosk mode is not enabled for this brand' });
    }

    // Check daily reward cap
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayRewards = await KioskReward.countDocuments({
      brandId,
      issuedAt: { $gte: todayStart },
    });

    if (todayRewards >= (brand.kioskDailyRewardCap || 50)) {
      return res.status(429).json({
        error: 'Daily reward cap reached',
        message: 'This location has reached its daily reward limit. Please try again tomorrow.',
      });
    }

    // Find or create guest reviewer (upsert on phone + brandId)
    let guest = await GuestReviewer.findOne({ phone: phone.trim(), brandId });

    if (guest) {
      // Returning guest — update info
      guest.totalReviews += 1;
      guest.lastVisitAt = new Date();
      if (email && !guest.email) guest.email = email.trim();
      await guest.save();
    } else {
      // New guest
      guest = await GuestReviewer.create({
        brandId,
        firstName: firstName.trim(),
        phone: phone.trim(),
        email: email ? email.trim() : null,
        totalReviews: 1,
        lastVisitAt: new Date(),
      });
    }

    // Generate unique reward code (retry up to 5 times for uniqueness)
    let code;
    let attempts = 0;
    while (attempts < 5) {
      code = generateRewardCode();
      const exists = await KioskReward.findOne({ code });
      if (!exists) break;
      attempts++;
    }

    // Create the reward
    const reward = await KioskReward.create({
      brandId,
      guestReviewerId: guest._id,
      code,
      rewardType: brand.kioskRewardType || 'discount_percent',
      rewardValue: brand.kioskRewardValue || '10% Off',
      status: 'issued',
      issuedAt: new Date(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
    });

    // Update guest reward count
    guest.totalRewardsEarned += 1;
    await guest.save();

    // Update brand review count
    await Brand.findByIdAndUpdate(brandId, {
      $inc: { totalReviews: 1 },
    });

    console.log(`🎬 Kiosk session: ${guest.firstName} at ${brand.name} → ${reward.code}`);

    res.status(201).json({
      message: 'Review recorded! Here\'s your reward.',
      reward: {
        code: reward.code,
        rewardType: reward.rewardType,
        rewardValue: reward.rewardValue,
        expiresAt: reward.expiresAt,
      },
      guest: {
        id: guest._id,
        firstName: guest.firstName,
        totalReviews: guest.totalReviews,
      },
    });
  } catch (error) {
    // Handle duplicate phone+brand (race condition)
    if (error.code === 11000) {
      return res.status(409).json({
        error: 'Duplicate entry',
        message: 'A guest with this phone number already exists for this brand. Please try again.',
      });
    }
    console.error('Kiosk session error:', error.message);
    res.status(500).json({ error: 'Could not process kiosk session' });
  }
});

// PUT /api/kiosk/redeem — Redeem a reward code
// Called by staff/POS when customer presents their code
router.put('/redeem', async (req, res) => {
  try {
    const { code } = req.body;

    if (!code || !code.trim()) {
      return res.status(400).json({ error: 'Reward code is required' });
    }

    const reward = await KioskReward.findOne({ code: code.trim().toUpperCase() });

    if (!reward) {
      return res.status(404).json({ error: 'Reward code not found' });
    }

    if (reward.status === 'redeemed') {
      return res.status(400).json({
        error: 'Already redeemed',
        message: 'This reward code has already been used.',
        redeemedAt: reward.redeemedAt,
      });
    }

    if (reward.status === 'expired' || reward.expiresAt < new Date()) {
      return res.status(400).json({
        error: 'Expired',
        message: 'This reward code has expired.',
      });
    }

    reward.status = 'redeemed';
    reward.redeemedAt = new Date();
    await reward.save();

    console.log(`✅ Kiosk reward redeemed: ${reward.code} (${reward.rewardValue})`);

    res.json({
      message: 'Reward redeemed successfully!',
      reward: {
        code: reward.code,
        rewardType: reward.rewardType,
        rewardValue: reward.rewardValue,
        redeemedAt: reward.redeemedAt,
      },
    });
  } catch (error) {
    console.error('Redeem reward error:', error.message);
    res.status(500).json({ error: 'Could not redeem reward' });
  }
});

// GET /api/kiosk/verify/:code — Check reward code status (public)
// Staff can check if a code is valid before redeeming
router.get('/verify/:code', async (req, res) => {
  try {
    const reward = await KioskReward.findOne({
      code: req.params.code.toUpperCase(),
    }).populate('guestReviewerId', 'firstName');

    if (!reward) {
      return res.status(404).json({ valid: false, error: 'Code not found' });
    }

    const isExpired = reward.status === 'expired' || reward.expiresAt < new Date();

    res.json({
      valid: reward.status === 'issued' && !isExpired,
      reward: {
        code: reward.code,
        status: isExpired ? 'expired' : reward.status,
        rewardType: reward.rewardType,
        rewardValue: reward.rewardValue,
        guestName: reward.guestReviewerId ? reward.guestReviewerId.firstName : 'Guest',
        expiresAt: reward.expiresAt,
      },
    });
  } catch (error) {
    console.error('Verify reward error:', error.message);
    res.status(500).json({ error: 'Could not verify reward code' });
  }
});

// ══════════════════════════════════════════════
// AUTHENTICATED ENDPOINTS (brand owner manages kiosk)
// ══════════════════════════════════════════════

// PUT /api/kiosk/config/:brandId — Update kiosk settings
// Called by kiosk-mode.html when brand owner saves settings
router.put('/config/:brandId', requireAuth, async (req, res) => {
  try {
    const { brandId } = req.params;
    const {
      kioskEnabled,
      kioskOfferTitle,
      kioskRewardType,
      kioskRewardValue,
      kioskRecordingLimit,
      kioskAutoApprove,
      kioskRequireSmsVerify,
      kioskDailyRewardCap,
      kioskBrandingColor,
      kioskBrandingLogo,
    } = req.body;

    const brand = await Brand.findById(brandId);
    if (!brand) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    // Build update object (only update fields that were sent)
    const updates = {};
    if (kioskEnabled !== undefined) updates.kioskEnabled = kioskEnabled;
    if (kioskOfferTitle !== undefined) updates.kioskOfferTitle = kioskOfferTitle;
    if (kioskRewardType !== undefined) updates.kioskRewardType = kioskRewardType;
    if (kioskRewardValue !== undefined) updates.kioskRewardValue = kioskRewardValue;
    if (kioskRecordingLimit !== undefined) updates.kioskRecordingLimit = kioskRecordingLimit;
    if (kioskAutoApprove !== undefined) updates.kioskAutoApprove = kioskAutoApprove;
    if (kioskRequireSmsVerify !== undefined) updates.kioskRequireSmsVerify = kioskRequireSmsVerify;
    if (kioskDailyRewardCap !== undefined) updates.kioskDailyRewardCap = kioskDailyRewardCap;
    if (kioskBrandingColor !== undefined) updates.kioskBrandingColor = kioskBrandingColor;
    if (kioskBrandingLogo !== undefined) updates.kioskBrandingLogo = kioskBrandingLogo;

    // Auto-generate brand code if enabling kiosk for first time
    if (kioskEnabled && !brand.kioskBrandCode) {
      // Generate a URL-safe brand code from brand name
      let brandCode = brand.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .substring(0, 30);

      // Check uniqueness, append random suffix if needed
      const existing = await Brand.findOne({ kioskBrandCode: brandCode });
      if (existing) {
        brandCode += '-' + crypto.randomBytes(3).toString('hex');
      }
      updates.kioskBrandCode = brandCode;
    }

    const updated = await Brand.findByIdAndUpdate(
      brandId,
      { $set: updates },
      { new: true }
    );

    console.log(`⚙️ Kiosk config updated for ${brand.name}`);

    res.json({
      message: 'Kiosk settings saved',
      kiosk: {
        kioskEnabled: updated.kioskEnabled,
        kioskOfferTitle: updated.kioskOfferTitle,
        kioskRewardType: updated.kioskRewardType,
        kioskRewardValue: updated.kioskRewardValue,
        kioskRecordingLimit: updated.kioskRecordingLimit,
        kioskAutoApprove: updated.kioskAutoApprove,
        kioskRequireSmsVerify: updated.kioskRequireSmsVerify,
        kioskDailyRewardCap: updated.kioskDailyRewardCap,
        kioskBrandingColor: updated.kioskBrandingColor,
        kioskBrandingLogo: updated.kioskBrandingLogo,
        kioskBrandCode: updated.kioskBrandCode,
        kioskActiveLocations: updated.kioskActiveLocations,
      },
    });
  } catch (error) {
    console.error('Update kiosk config error:', error.message);
    res.status(500).json({ error: 'Could not update kiosk settings' });
  }
});

// GET /api/kiosk/config/:brandId — Load kiosk settings for management page
router.get('/config/:brandId', requireAuth, async (req, res) => {
  try {
    const brand = await Brand.findById(req.params.brandId);
    if (!brand) {
      return res.status(404).json({ error: 'Brand not found' });
    }

    // Get kiosk stats
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [totalGuests, totalRewards, todayRewards, redeemedRewards] = await Promise.all([
      GuestReviewer.countDocuments({ brandId: brand._id }),
      KioskReward.countDocuments({ brandId: brand._id }),
      KioskReward.countDocuments({ brandId: brand._id, issuedAt: { $gte: todayStart } }),
      KioskReward.countDocuments({ brandId: brand._id, status: 'redeemed' }),
    ]);

    res.json({
      kiosk: {
        kioskEnabled: brand.kioskEnabled,
        kioskOfferTitle: brand.kioskOfferTitle,
        kioskRewardType: brand.kioskRewardType,
        kioskRewardValue: brand.kioskRewardValue,
        kioskRecordingLimit: brand.kioskRecordingLimit,
        kioskAutoApprove: brand.kioskAutoApprove,
        kioskRequireSmsVerify: brand.kioskRequireSmsVerify,
        kioskDailyRewardCap: brand.kioskDailyRewardCap,
        kioskBrandingColor: brand.kioskBrandingColor,
        kioskBrandingLogo: brand.kioskBrandingLogo,
        kioskBrandCode: brand.kioskBrandCode,
        kioskActiveLocations: brand.kioskActiveLocations,
      },
      stats: {
        totalGuests,
        totalRewards,
        todayRewards,
        redeemedRewards,
        redemptionRate: totalRewards > 0
          ? Math.round((redeemedRewards / totalRewards) * 100)
          : 0,
      },
    });
  } catch (error) {
    console.error('Load kiosk config error:', error.message);
    res.status(500).json({ error: 'Could not load kiosk settings' });
  }
});

// GET /api/kiosk/guests/:brandId — List guest reviewers for a brand
router.get('/guests/:brandId', requireAuth, async (req, res) => {
  try {
    const guests = await GuestReviewer.find({ brandId: req.params.brandId })
      .sort({ lastVisitAt: -1 })
      .limit(100);

    res.json({
      guests,
      total: guests.length,
    });
  } catch (error) {
    console.error('List guests error:', error.message);
    res.status(500).json({ error: 'Could not fetch guest reviewers' });
  }
});

// GET /api/kiosk/rewards/:brandId — List kiosk rewards for a brand
router.get('/rewards/:brandId', requireAuth, async (req, res) => {
  try {
    const { status } = req.query;
    const filter = { brandId: req.params.brandId };
    if (status) filter.status = status;

    const rewards = await KioskReward.find(filter)
      .populate('guestReviewerId', 'firstName phone')
      .sort({ issuedAt: -1 })
      .limit(100);

    res.json({
      rewards,
      total: rewards.length,
    });
  } catch (error) {
    console.error('List kiosk rewards error:', error.message);
    res.status(500).json({ error: 'Could not fetch kiosk rewards' });
  }
});

module.exports = router;
