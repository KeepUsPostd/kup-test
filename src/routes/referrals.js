// Referral Routes — Influencer + Brand referral programs
// GET /api/referrals — Influencer referral stats + recent activity
// GET /api/referrals/brand — Brand referral stats + recent activity
// POST /api/referrals/use — Apply a referral code (called at signup)
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { User, InfluencerProfile, BrandProfile } = require('../models');

// GET /api/referrals/brand — Referral stats for the logged-in brand owner
// Returns: referralCode, stats (signedUp, qualified, totalEarned), recentActivity
router.get('/brand', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const myBrand = await BrandProfile.findOne({ userId: user._id }).lean();

    if (!myBrand) {
      return res.status(404).json({ error: 'Brand profile not found' });
    }

    // Find all brands referred by this brand
    const referredBrands = await BrandProfile.find({ referredBy: myBrand._id })
      .populate('userId', 'email createdAt')
      .lean();

    const signedUp = referredBrands.length;

    // Qualified = referred brands on a paid plan
    const PAID_PLANS = ['growth', 'pro', 'agency', 'enterprise'];
    const qualifiedBrands = referredBrands.filter(b => PAID_PLANS.includes((b.planTier || '').toLowerCase()));
    const qualified = qualifiedBrands.length;

    // Referral rewards by plan tier (matches the UI reward table)
    const REFERRAL_REWARD = { growth: 50, pro: 75, agency: 100, enterprise: 100 };
    const totalEarned = qualifiedBrands.reduce((sum, b) => {
      return sum + (REFERRAL_REWARD[(b.planTier || '').toLowerCase()] || 25);
    }, 0);

    // Recent activity (last 10 referrals)
    const recentActivity = referredBrands.slice(0, 10).map(b => ({
      joinedAt: b.createdAt,
      email: b.userId ? b.userId.email.replace(/(.{2}).+(@.+)/, '$1***$2') : 'unknown',
      plan: b.planTier || 'starter',
      status: PAID_PLANS.includes((b.planTier || '').toLowerCase()) ? 'qualified' : 'signed_up',
    }));

    res.json({
      referralCode: myBrand.referralCode,
      referralLink: `https://keepuspostd.com/signup?ref=${myBrand.referralCode || ''}`,
      stats: {
        linksShared: signedUp, // proxy — we don't track clicks, only actual signups
        signedUp,
        qualified,
        totalEarned,
      },
      recentActivity,
    });
  } catch (error) {
    console.error('Get brand referral stats error:', error.message);
    res.status(500).json({ error: 'Could not fetch brand referral stats' });
  }
});

// GET /api/referrals — Referral stats for the logged-in influencer
// Returns: referralCode, stats (invitesSent, friendsJoined, completedFirstReview, earnings), recentActivity
router.get('/', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const influencerProfile = await InfluencerProfile.findOne({ userId: user._id });

    if (!influencerProfile) {
      return res.status(404).json({ error: 'Influencer profile not found' });
    }

    const referralCode = influencerProfile.referralCode || null;

    // Find all users referred by this influencer's code
    const referredUsers = await User.find({ referredByCode: referralCode }).lean();
    const referredIds = referredUsers.map(u => u._id);

    // Of those, find how many have an influencer profile (joined + completed signup)
    const friendsJoined = referredIds.length > 0
      ? await InfluencerProfile.countDocuments({ userId: { $in: referredIds } })
      : 0;

    // Of those, find how many have submitted at least one piece of content
    // (proxy for "completed first review")
    let completedFirstReview = 0;
    if (referredIds.length > 0) {
      const { ContentSubmission } = require('../models');
      const referredProfiles = await InfluencerProfile.find({ userId: { $in: referredIds } }).lean();
      const referredProfileIds = referredProfiles.map(p => p._id);
      if (referredProfileIds.length > 0) {
        completedFirstReview = await ContentSubmission.countDocuments({
          influencerProfileId: { $in: referredProfileIds },
        });
      }
    }

    // Build recent activity list (last 10 referrals)
    const recentActivity = referredUsers.slice(0, 10).map(u => ({
      joinedAt: u.createdAt,
      email: u.email.replace(/(.{2}).+(@.+)/, '$1***$2'), // Mask email for privacy
      status: 'joined',
    }));

    // Referral earnings: $5 per friend who completes their first review (placeholder rate)
    const REFERRAL_REWARD = 5;
    const earnings = completedFirstReview * REFERRAL_REWARD;

    res.json({
      referralCode,
      referralLink: `https://keepuspostd.com/ref/${referralCode || 'invite'}`,
      stats: {
        invitesSent: referredUsers.length,
        friendsJoined,
        completedFirstReview,
        earnings,
      },
      recentActivity,
    });
  } catch (error) {
    console.error('Get referral stats error:', error.message);
    res.status(500).json({ error: 'Could not fetch referral stats' });
  }
});

// POST /api/referrals/use — Apply a referral code at signup
// Called when a new user signs up via a referral link
router.post('/use', requireAuth, async (req, res) => {
  try {
    const { referralCode } = req.body;
    if (!referralCode) {
      return res.status(400).json({ error: 'referralCode is required' });
    }

    const user = req.user;

    // Don't allow applying a code if they already used one
    if (user.referredByCode) {
      return res.status(409).json({ error: 'Referral code already applied to this account' });
    }

    // Verify the code exists
    const referrer = await InfluencerProfile.findOne({ referralCode: referralCode.toUpperCase() });
    if (!referrer) {
      return res.status(404).json({ error: 'Invalid referral code' });
    }

    // Prevent self-referral
    if (referrer.userId.toString() === user._id.toString()) {
      return res.status(400).json({ error: 'You cannot use your own referral code' });
    }

    // Save referral code to user
    user.referredByCode = referralCode.toUpperCase();
    await user.save();

    console.log(`🎁 Referral applied: ${user.email} referred by code ${referralCode}`);

    res.json({ success: true, message: 'Referral code applied successfully' });
  } catch (error) {
    console.error('Use referral code error:', error.message);
    res.status(500).json({ error: 'Could not apply referral code' });
  }
});

module.exports = router;
