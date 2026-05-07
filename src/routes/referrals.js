// Referral Routes — Influencer + Brand referral programs
// GET /api/referrals — Influencer referral stats + recent activity
// GET /api/referrals/brand — Brand referral stats + recent activity
// POST /api/referrals/use — Apply a referral code (called at signup)
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { User, InfluencerProfile, BrandProfile } = require('../models');

// Referral rewards by plan tier — must match REFERRAL_REWARD in billing.js
const REFERRAL_REWARD = { growth: 50, pro: 75, agency: 100, enterprise: 100 };
const PAID_PLANS = ['growth', 'pro', 'agency', 'enterprise'];
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// Lazy disbursal helper — mirrors the one in billing.js.
// Called when the referral stats page is loaded so any earned-but-not-yet-disbursed
// rewards get paid out without needing a background job.
async function disburseReferralRewardIfEligible(referredBrandProfile) {
  if (!referredBrandProfile.referredBy) return false;
  if (referredBrandProfile.referralRewardDisbursed) return false;
  if (!referredBrandProfile.paidPlanActivatedAt) return false;

  const tier = (referredBrandProfile.planTier || '').toLowerCase();
  if (!PAID_PLANS.includes(tier)) return false;

  if (Date.now() - new Date(referredBrandProfile.paidPlanActivatedAt).getTime() < THIRTY_DAYS_MS) {
    return false; // Hold period not yet elapsed
  }

  const referrerProfile = await BrandProfile.findById(referredBrandProfile.referredBy);
  if (!referrerProfile) return false;

  const rewardAmount = REFERRAL_REWARD[tier] || 0;
  if (rewardAmount === 0) return false;

  referrerProfile.accountCredit = (referrerProfile.accountCredit || 0) + rewardAmount;
  await referrerProfile.save();

  referredBrandProfile.referralRewardDisbursed = true;
  await referredBrandProfile.save();

  console.log(
    `💰 [referrals/brand] Referral reward disbursed: $${rewardAmount} → referrer ${referrerProfile._id}` +
    ` (referred brand ${referredBrandProfile._id}, plan: ${tier})`
  );
  return true;
}

// GET /api/referrals/brand — Referral stats for the logged-in brand owner
// Returns: referralCode, stats (signedUp, qualified, totalEarned, accountCredit), recentActivity
router.get('/brand', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    // Fetch as a mutable document (not lean) so we can save disbursal updates
    const myBrand = await BrandProfile.findOne({ userId: user._id });

    if (!myBrand) {
      return res.status(404).json({ error: 'Brand profile not found' });
    }

    // Find all brands referred by this brand (mutable, not lean — disbursal may save)
    const referredBrands = await BrandProfile.find({ referredBy: myBrand._id })
      .populate('userId', 'email createdAt');

    const signedUp = referredBrands.length;

    // Lazy disbursal: fire for each referred brand that may now be past the 30-day hold.
    // Non-blocking per brand; errors logged but do not fail the response.
    let newlyDisbursed = 0;
    for (const referredBrand of referredBrands) {
      try {
        const disbursed = await disburseReferralRewardIfEligible(referredBrand);
        if (disbursed) newlyDisbursed++;
      } catch (disbErr) {
        console.error(`[referrals/brand] disbursal error for brand ${referredBrand._id}:`, disbErr.message);
      }
    }

    // Re-fetch myBrand if any rewards were just disbursed (accountCredit was updated)
    const freshBrand = newlyDisbursed > 0
      ? await BrandProfile.findById(myBrand._id).lean()
      : myBrand.toObject ? myBrand.toObject() : myBrand;

    // Qualified = referred brands currently on a paid plan
    const qualifiedBrands = referredBrands.filter(b =>
      PAID_PLANS.includes((b.planTier || '').toLowerCase())
    );
    const qualified = qualifiedBrands.length;

    // pendingReward = brands that have activated a paid plan but haven't passed the 30-day hold yet
    const pendingRewardBrands = qualifiedBrands.filter(b =>
      !b.referralRewardDisbursed &&
      b.paidPlanActivatedAt &&
      Date.now() - new Date(b.paidPlanActivatedAt).getTime() < THIRTY_DAYS_MS
    );

    // totalEarned = actual account credit accumulated from referral rewards
    const totalEarned = freshBrand.accountCredit || 0;

    // pendingEarnings = rewards that will be paid once the 30-day hold clears
    const pendingEarnings = pendingRewardBrands.reduce((sum, b) => {
      return sum + (REFERRAL_REWARD[(b.planTier || '').toLowerCase()] || 0);
    }, 0);

    // Recent activity (last 10 referrals)
    const recentActivity = referredBrands.slice(0, 10).map(b => {
      const tier = (b.planTier || '').toLowerCase();
      const isPaid = PAID_PLANS.includes(tier);
      const isDisbursed = !!b.referralRewardDisbursed;
      const isPending = isPaid && !isDisbursed && b.paidPlanActivatedAt &&
        Date.now() - new Date(b.paidPlanActivatedAt).getTime() < THIRTY_DAYS_MS;

      let status = 'signed_up';
      if (isDisbursed) status = 'rewarded';
      else if (isPending) status = 'qualifying'; // paid but in 30-day hold
      else if (isPaid) status = 'qualified';

      return {
        joinedAt: b.createdAt,
        email: b.userId ? b.userId.email.replace(/(.{2}).+(@.+)/, '$1***$2') : 'unknown',
        plan: b.planTier || 'starter',
        status,
        rewardAmount: isPaid ? (REFERRAL_REWARD[tier] || 0) : 0,
        disbursed: isDisbursed,
      };
    });

    res.json({
      referralCode: freshBrand.referralCode,
      referralLink: `https://keepuspostd.com/signup?ref=${freshBrand.referralCode || ''}`,
      stats: {
        linksShared: signedUp, // proxy — we don't track clicks, only actual signups
        signedUp,
        qualified,
        totalEarned,       // actual account credit balance ($USD) — paid out rewards
        pendingEarnings,   // earnings in the 30-day qualification hold
      },
      accountCredit: totalEarned,
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
          status: 'approved',
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
