// KUP Admin Panel API — Phase 1 (Launch-Critical)
// Modules: Dashboard KPIs, User Management, Content Moderation, Reviews, Financials, Messages
// Protected by requireAuth + requireAdmin (email-based for now)

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const {
  User, Brand, Campaign, ContentSubmission, Transaction,
  InfluencerProfile, BrandProfile, Subscription, Partnership,
  GuestReviewer, Notification, Reward, Withdrawal, ClaimRequest,
} = require('../models');
const notify = require('../services/notifications');
const { sendEmail } = require('../config/email');
const { sendPushToUser } = require('../config/push');
const { startTrial } = require('../services/trial');

// ── Tier Thresholds (copied from auth.js) ─────────────────
const TIER_THRESHOLDS = [
  { key: 'celebrity',   min: 5_000_000, displayName: 'Celebrity',  range: '5M+',         video: 45, image: 23 },
  { key: 'premium',     min: 1_000_000, displayName: 'Mega',        range: '1M–5M',       video: 33, image: 15 },
  { key: 'established', min: 500_000,   displayName: 'Macro',       range: '500K–1M',     video: 25, image: 12 },
  { key: 'rising',      min: 50_000,    displayName: 'Mid',         range: '50K–500K',    video: 18, image: 9  },
  { key: 'micro',       min: 10_000,    displayName: 'Micro',       range: '10K–50K',     video: 11, image: 6  },
  { key: 'nano',        min: 5_000,     displayName: 'Nano',        range: '5K–10K',      video: 8,  image: 4  },
  { key: 'startup',     min: 0,         displayName: 'Startup',     range: '0–5K',        video: 4,  image: 2  },
];

function tierFromFollowers(count) {
  return TIER_THRESHOLDS.find(t => count >= t.min) || TIER_THRESHOLDS[TIER_THRESHOLDS.length - 1];
}

// ── Admin Auth Middleware ──────────────────────────────────
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase());
  if (adminEmails.includes(req.user.email?.toLowerCase())) return next();
  return res.status(403).json({ error: 'Admin access required' });
}

// Apply auth to all routes
router.use(requireAuth, requireAdmin);

// ═══════════════════════════════════════════════════════════
// MODULE 1: SYSTEM DASHBOARD
// ═══════════════════════════════════════════════════════════

// GET /api/admin-panel/dashboard — All KPIs in one call
router.get('/dashboard', async (req, res) => {
  try {
    const [
      totalBrands,
      activeBrands,
      totalCreators,
      totalCampaigns,
      activeCampaigns,
      totalSubmissions,
      pendingSubmissions,
      totalUsers,
      totalSubscriptions,
      totalTransactions,
      totalPayoutAmount,
      totalReviews,
      recentUsers,
      recentSubmissions,
      healthAlerts,
      userCreatedBrands,
      adminOwnedBrands,
      activePartnerships,
      failedTransactions,
    ] = await Promise.all([
      Brand.countDocuments({ status: 'active' }),
      Brand.countDocuments({ status: 'active', brandType: { $in: ['user', 'admin_claimed'] } }),
      InfluencerProfile.countDocuments(),
      Campaign.countDocuments(),
      Campaign.countDocuments({ status: 'active' }),
      ContentSubmission.countDocuments(),
      ContentSubmission.countDocuments({ status: 'submitted' }),
      User.countDocuments({ status: 'active' }),
      Subscription.countDocuments({ status: 'active' }),
      Transaction.countDocuments(),
      Transaction.aggregate([
        { $match: { status: 'paid' } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      GuestReviewer.aggregate([
        { $group: { _id: null, total: { $sum: '$totalReviews' } } },
      ]),
      // Recent signups (last 7 days)
      User.countDocuments({ createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } }),
      // Recent submissions (last 7 days)
      ContentSubmission.countDocuments({ createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } }),
      // Health alerts
      getHealthAlerts(),
      // Summary table extras
      Brand.countDocuments({ brandType: 'user' }),
      Brand.countDocuments({ brandType: { $in: ['admin', 'admin_unclaimed'] } }),
      Partnership.countDocuments({ status: 'active' }),
      Transaction.countDocuments({ status: 'failed' }),
    ]);

    res.json({
      kpis: {
        totalBrands,
        activeBrands,
        totalCreators,
        totalCampaigns,
        activeCampaigns,
        totalSubmissions,
        pendingSubmissions,
        totalUsers,
        activeSubscriptions: totalSubscriptions,
        totalTransactions,
        totalPayoutAmount: totalPayoutAmount[0]?.total || 0,
        totalReviews: totalReviews[0]?.total || 0,
        recentSignups7d: recentUsers,
        recentSubmissions7d: recentSubmissions,
        // Summary table fields
        userCreatedBrands,
        adminOwnedBrands,
        activePartnerships,
        failedTransactions,
      },
      healthAlerts,
    });
  } catch (error) {
    console.error('Admin dashboard error:', error.message);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

async function getHealthAlerts() {
  const alerts = [];

  // Pending submissions > 10
  const pending = await ContentSubmission.countDocuments({ status: 'submitted' });
  if (pending > 10) alerts.push({ type: 'warning', message: `${pending} content submissions awaiting review` });

  // Failed transactions in last 24h
  const failedTx = await Transaction.countDocuments({
    status: 'failed',
    createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
  });
  if (failedTx > 0) alerts.push({ type: 'error', message: `${failedTx} failed transactions in last 24 hours` });

  // Suspended accounts
  const suspended = await User.countDocuments({ status: 'suspended' });
  if (suspended > 0) alerts.push({ type: 'info', message: `${suspended} suspended user accounts` });

  // Expiring campaigns (next 3 days)
  const expiring = await Campaign.countDocuments({
    status: 'active',
    deadline: { $lte: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000), $gte: new Date() },
  });
  if (expiring > 0) alerts.push({ type: 'warning', message: `${expiring} campaigns expiring in next 3 days` });

  return alerts;
}

// GET /api/admin-panel/dashboard/activity — Recent activity feed
router.get('/dashboard/activity', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 50);

    // Get recent events from multiple collections
    const [recentUsers, recentContent, recentTx] = await Promise.all([
      User.find({}, { email: 1, createdAt: 1, activeProfile: 1 })
        .sort({ createdAt: -1 }).limit(limit).lean(),
      ContentSubmission.find({}, { contentType: 1, status: 1, createdAt: 1, brandId: 1 })
        .sort({ createdAt: -1 }).limit(limit)
        .populate('brandId', 'name').lean(),
      Transaction.find({}, { type: 1, amount: 1, status: 1, createdAt: 1 })
        .sort({ createdAt: -1 }).limit(limit).lean(),
    ]);

    // Merge and sort
    const activity = [
      ...recentUsers.map(u => ({
        type: 'signup',
        message: `New ${u.activeProfile || 'user'} signup: ${u.email}`,
        timestamp: u.createdAt,
      })),
      ...recentContent.map(c => ({
        type: 'content',
        message: `${c.contentType} ${c.status} for ${c.brandId?.name || 'Unknown Brand'}`,
        timestamp: c.createdAt,
      })),
      ...recentTx.map(t => ({
        type: 'transaction',
        message: `${t.type} — $${t.amount?.toFixed(2)} (${t.status})`,
        timestamp: t.createdAt,
      })),
    ].sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);

    res.json({ activity });
  } catch (error) {
    console.error('Activity feed error:', error.message);
    res.status(500).json({ error: 'Failed to load activity' });
  }
});

// GET /api/admin-panel/dashboard/growth — Growth chart data (last 30 days)
router.get('/dashboard/growth', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 30;
    const startDate = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const [userGrowth, contentGrowth, brandGrowth] = await Promise.all([
      User.aggregate([
        { $match: { createdAt: { $gte: startDate } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
      ContentSubmission.aggregate([
        { $match: { createdAt: { $gte: startDate } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
      Brand.aggregate([
        { $match: { createdAt: { $gte: startDate } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]),
    ]);

    res.json({ userGrowth, contentGrowth, brandGrowth });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load growth data' });
  }
});

// ═══════════════════════════════════════════════════════════
// MODULE 2: USER MANAGEMENT
// ═══════════════════════════════════════════════════════════

// GET /api/admin-panel/users — List all users with pagination + filters
router.get('/users', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const skip = (page - 1) * limit;
    const { search, profileType, status, sort } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (profileType === 'influencer') filter.hasInfluencerProfile = true;
    if (profileType === 'brand') filter.hasBrandProfile = true;
    if (search) {
      filter.$or = [
        { email: { $regex: search, $options: 'i' } },
        { legalFirstName: { $regex: search, $options: 'i' } },
        { legalLastName: { $regex: search, $options: 'i' } },
      ];
    }

    const sortOption = sort === 'oldest' ? { createdAt: 1 }
      : sort === 'lastLogin' ? { lastLoginAt: -1 }
      : { createdAt: -1 };

    const [users, total] = await Promise.all([
      User.find(filter, {
        email: 1, legalFirstName: 1, legalLastName: 1, avatarUrl: 1,
        activeProfile: 1, hasInfluencerProfile: 1, hasBrandProfile: 1,
        status: 1, lastLoginAt: 1, loginCount: 1, createdAt: 1,
      }).sort(sortOption).skip(skip).limit(limit).lean(),
      User.countDocuments(filter),
    ]);

    res.json({
      users,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load users' });
  }
});

// GET /api/admin-panel/users/:id — User detail (full profile)
router.get('/users/:id', async (req, res) => {
  try {
    const user = await User.findById(req.params.id).lean();
    if (!user) return res.status(404).json({ error: 'User not found' });

    const [influencer, brandProfile, subscriptions] = await Promise.all([
      user.hasInfluencerProfile
        ? InfluencerProfile.findOne({ userId: user._id }).lean()
        : null,
      user.hasBrandProfile
        ? BrandProfile.findOne({ userId: user._id }).populate('ownedBrandIds').lean()
        : null,
      Subscription.find({ brandProfileId: { $exists: true } }).lean(), // will filter below
    ]);

    // Get owned brands if brand profile exists
    let ownedBrands = [];
    if (brandProfile?.ownedBrandIds) {
      ownedBrands = brandProfile.ownedBrandIds;
    }

    res.json({ user, influencer, brandProfile, ownedBrands });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load user details' });
  }
});

// PUT /api/admin-panel/users/:id/status — Suspend/unsuspend user
router.put('/users/:id/status', async (req, res) => {
  try {
    const { status, reason } = req.body;
    if (!['active', 'suspended'].includes(status)) {
      return res.status(400).json({ error: 'Status must be active or suspended' });
    }

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    user.status = status;
    if (status === 'suspended') {
      console.log(`⚠️ Admin suspended user ${user.email}: ${reason || 'No reason given'}`);
    } else {
      console.log(`✅ Admin reactivated user ${user.email}`);
    }
    await user.save();

    res.json({ message: `User ${status === 'suspended' ? 'suspended' : 'reactivated'}`, user: { id: user._id, status: user.status } });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update user status' });
  }
});

// POST /api/admin-panel/users/:id/reset-trial — Reset a user's 14-day Pro trial
// Use case: fix accounts that never received a trial due to legacy registration bugs,
// or grant a fresh trial to a user whose previous trial expired.
// Refuses if the user has an active paid subscription (would unnecessarily override it).
router.post('/users/:id/reset-trial', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.hasBrandProfile) {
      return res.status(400).json({ error: 'User has no brand profile to reset' });
    }

    const brandProfile = await BrandProfile.findOne({ userId: user._id });
    if (!brandProfile) {
      return res.status(404).json({ error: 'BrandProfile not found' });
    }

    if (brandProfile.paypalSubscriptionId) {
      return res.status(400).json({
        error: 'User has an active paid subscription',
        message: 'Cancel their subscription first, or leave the trial flags as-is.',
      });
    }

    await startTrial(brandProfile);
    console.log(`🔄 Admin ${req.user.email} reset trial for user ${user.email}`);

    res.json({
      message: 'Trial reset — user now has 14 days of Pro access',
      brandProfile: {
        id: brandProfile._id,
        trialActive: brandProfile.trialActive,
        trialTier: brandProfile.trialTier,
        trialStartedAt: brandProfile.trialStartedAt,
        trialEndsAt: brandProfile.trialEndsAt,
        planTier: brandProfile.planTier,
      },
    });
  } catch (error) {
    console.error('Reset trial error:', error.message);
    res.status(500).json({ error: 'Failed to reset trial' });
  }
});

// POST /api/admin-panel/users/:id/grant-plan — Grant a user a plan tier
// without going through PayPal/promo. Used for founder accounts, partnerships,
// support comps, etc. Deactivates any trial and creates a free subscription
// record so downstream code treats them as a paying subscriber.
// Body: { planTier: 'starter' | 'growth' | 'pro' | 'agency' | 'enterprise',
//         billingCycle?: 'monthly' | 'annual' }
router.post('/users/:id/grant-plan', async (req, res) => {
  try {
    const { planTier, billingCycle = 'monthly' } = req.body;
    const validTiers = ['starter', 'growth', 'pro', 'agency', 'enterprise'];
    if (!validTiers.includes(planTier)) {
      return res.status(400).json({ error: `planTier must be one of: ${validTiers.join(', ')}` });
    }

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.hasBrandProfile) {
      return res.status(400).json({ error: 'User has no brand profile' });
    }
    const brandProfile = await BrandProfile.findOne({ userId: user._id });
    if (!brandProfile) {
      return res.status(404).json({ error: 'BrandProfile not found' });
    }

    const cycle = billingCycle === 'annual' ? 'annual' : 'monthly';
    const now = new Date();

    // Cancel any existing active subscription record so there's only one
    await Subscription.updateMany(
      { brandProfileId: brandProfile._id, status: { $in: ['active', 'trialing'] } },
      { $set: { status: 'canceled', canceledAt: now } },
    );

    // Create a free subscription record — no expiry, no PayPal
    const subscription = await Subscription.create({
      brandProfileId: brandProfile._id,
      planTier,
      billingCycle: cycle,
      status: 'active',
      currentPeriodStart: now,
      currentPeriodEnd: null,
      promoCode: 'ADMIN_GRANT',
    });

    brandProfile.planTier = planTier;
    brandProfile.billingCycle = cycle;
    brandProfile.planStartedAt = now;
    brandProfile.planExpiresAt = null;
    brandProfile.trialActive = false;
    brandProfile.trialExpired = false;
    await brandProfile.save();

    console.log(`🎖️ Admin ${req.user.email} granted ${planTier} plan to ${user.email}`);
    res.json({
      message: `Granted ${planTier} plan to ${user.email}`,
      subscription: { id: subscription._id, planTier, status: 'active' },
      brandProfile: { planTier: brandProfile.planTier, trialActive: brandProfile.trialActive },
    });
  } catch (error) {
    console.error('Grant plan error:', error.message);
    res.status(500).json({ error: 'Failed to grant plan', message: error.message });
  }
});

// POST /api/admin-panel/users/:id/override-features — Upgrade a brand's
// feature tier WITHOUT touching their PayPal subscription.
// Use case: partner deals where the brand pays the published Growth price
// ($29/mo) via real PayPal subscription but gets Agency feature access on
// the platform. Unlike grant-plan (which cancels PayPal subs and creates a
// free internal record), this leaves billing untouched — KUP still collects
// real MRR via the existing subscription.
// Body: { planTier: 'starter' | 'growth' | 'pro' | 'agency' | 'enterprise' }
router.post('/users/:id/override-features', async (req, res) => {
  try {
    const { planTier } = req.body;
    const validTiers = ['starter', 'growth', 'pro', 'agency', 'enterprise'];
    if (!validTiers.includes(planTier)) {
      return res.status(400).json({ error: `planTier must be one of: ${validTiers.join(', ')}` });
    }

    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (!user.hasBrandProfile) {
      return res.status(400).json({ error: 'User has no brand profile' });
    }
    const brandProfile = await BrandProfile.findOne({ userId: user._id });
    if (!brandProfile) {
      return res.status(404).json({ error: 'BrandProfile not found' });
    }

    // Find the active PayPal subscription so we can show a meaningful message
    // about the divergence the admin is creating. We do NOT modify the
    // Subscription record — that's the whole point.
    const activeSub = await Subscription.findOne({
      brandProfileId: brandProfile._id,
      status: { $in: ['active', 'trialing'] },
    });

    const previousTier = brandProfile.planTier;
    brandProfile.planTier = planTier;
    brandProfile.planTierLockedByAdmin = true;
    brandProfile.planTierLockedAt = new Date();
    brandProfile.planTierLockedBy = req.user?.email || 'admin';
    await brandProfile.save();

    console.log(`🔓 Admin ${req.user?.email} overrode features for ${user.email}: ${previousTier} → ${planTier} (subscription untouched: ${activeSub?.planTier || 'none'})`);

    res.json({
      message: `Feature tier overridden to ${planTier} for ${user.email}. PayPal subscription unchanged.`,
      brandProfile: {
        planTier: brandProfile.planTier,
        planTierLockedByAdmin: true,
        planTierLockedAt: brandProfile.planTierLockedAt,
      },
      subscription: activeSub ? {
        planTier: activeSub.planTier,
        status: activeSub.status,
        paypalSubscriptionId: activeSub.paypalSubscriptionId,
      } : null,
    });
  } catch (error) {
    console.error('Override features error:', error.message);
    res.status(500).json({ error: 'Failed to override features', message: error.message });
  }
});

// POST /api/admin-panel/users/:id/clear-feature-override — Remove the admin
// feature override and resync planTier to the active subscription's tier.
// Use when a partner deal ends or you want to revert to normal behavior.
router.post('/users/:id/clear-feature-override', async (req, res) => {
  try {
    const user = await User.findById(req.params.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const brandProfile = await BrandProfile.findOne({ userId: user._id });
    if (!brandProfile) return res.status(404).json({ error: 'BrandProfile not found' });

    if (!brandProfile.planTierLockedByAdmin) {
      return res.status(400).json({ error: 'No active feature override on this brand' });
    }

    // Resync planTier to the active subscription tier (or starter if no sub)
    const activeSub = await Subscription.findOne({
      brandProfileId: brandProfile._id,
      status: { $in: ['active', 'trialing'] },
    });
    const previousTier = brandProfile.planTier;
    brandProfile.planTier = activeSub?.planTier || 'starter';
    brandProfile.planTierLockedByAdmin = false;
    brandProfile.planTierLockedAt = null;
    brandProfile.planTierLockedBy = null;
    await brandProfile.save();

    console.log(`🔓 Admin ${req.user?.email} cleared feature override for ${user.email}: ${previousTier} → ${brandProfile.planTier}`);
    res.json({
      message: `Feature override cleared. Tier resynced to ${brandProfile.planTier}.`,
      brandProfile: { planTier: brandProfile.planTier, planTierLockedByAdmin: false },
    });
  } catch (error) {
    console.error('Clear feature override error:', error.message);
    res.status(500).json({ error: 'Failed to clear feature override', message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// MODULE: CREATOR MANAGEMENT
// ═══════════════════════════════════════════════════════════

// GET /api/admin-panel/creators — Paginated list of all creator profiles
router.get('/creators', async (req, res) => {
  try {
    const page  = parseInt(req.query.page)  || 1;
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const skip  = (page - 1) * limit;
    const { search, tier, paypal, verified, sort } = req.query;

    // Build match stage
    const match = {};
    if (tier)     match.influenceTier = tier;
    if (verified === 'true')  match.isVerified = true;
    if (verified === 'false') match.isVerified = false;
    if (paypal === 'connected')    match.paypalEmail = { $ne: null };
    if (paypal === 'missing')      match.paypalEmail = null;

    if (search) {
      match.$or = [
        { handle:      { $regex: search, $options: 'i' } },
        { displayName: { $regex: search, $options: 'i' } },
      ];
    }

    const sortOption = sort === 'oldest'    ? { createdAt: 1 }
      : sort === 'reviews'                  ? { totalReviews: -1 }
      : sort === 'rating'                   ? { averageRating: -1 }
      : sort === 'cash'                     ? { totalCashEarned: -1 }
      : { createdAt: -1 };

    // Fetch profiles + join account email from User
    const [profiles, total] = await Promise.all([
      InfluencerProfile.find(match, {
        userId: 1, displayName: 1, handle: 1, avatarUrl: 1,
        influenceTier: 1, isVerified: 1, verificationPending: 1, creatorTier: 1,
        totalReviews: 1, adminBrandReviews: 1, totalBrandsPartnered: 1,
        totalCashEarned: 1, totalPointsEarned: 1,
        paypalEmail: 1, paypalConnectedAt: 1,
        averageRating: 1, ratingCount: 1,
        realFollowerCount: 1, socialLinks: 1,
        isHidden: 1, createdAt: 1,
      }).sort(sortOption).skip(skip).limit(limit).lean(),
      InfluencerProfile.countDocuments(match),
    ]);

    // Attach account emails in one batch
    const userIds = profiles.map(p => p.userId);
    const users   = await User.find({ _id: { $in: userIds } }, { email: 1 }).lean();
    const emailMap = {};
    users.forEach(u => { emailMap[u._id.toString()] = u.email; });

    const enriched = profiles.map(p => ({
      ...p,
      accountEmail: emailMap[p.userId?.toString()] || null,
    }));

    res.json({
      creators: enriched,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    console.error('Creators list error:', error);
    res.status(500).json({ error: 'Failed to load creators' });
  }
});

// GET /api/admin-panel/creators/:userId — Full creator detail
router.get('/creators/:userId', async (req, res) => {
  try {
    const profile = await InfluencerProfile.findOne({ userId: req.params.userId }).lean();
    if (!profile) return res.status(404).json({ error: 'Creator not found' });

    const [user, recentSubmissions] = await Promise.all([
      User.findById(profile.userId, { email: 1, status: 1, lastLoginAt: 1, createdAt: 1 }).lean(),
      ContentSubmission.find({ influencerId: profile.userId })
        .sort({ createdAt: -1 }).limit(5)
        .select('brandId status contentType createdAt')
        .populate('brandId', 'name')
        .lean(),
    ]);

    res.json({ profile, user, recentSubmissions });
  } catch (error) {
    console.error('Creator detail error:', error);
    res.status(500).json({ error: 'Failed to load creator detail' });
  }
});

// PUT /api/admin-panel/creators/:userId/hide — Toggle isHidden flag
router.put('/creators/:userId/hide', async (req, res) => {
  try {
    const { hidden } = req.body;
    const profile = await InfluencerProfile.findOneAndUpdate(
      { userId: req.params.userId },
      { isHidden: !!hidden },
      { new: true, select: 'isHidden displayName' }
    );
    if (!profile) return res.status(404).json({ error: 'Creator not found' });
    res.json({ success: true, isHidden: profile.isHidden });
  } catch (error) {
    res.status(500).json({ error: 'Failed to update creator' });
  }
});

// GET /api/admin-panel/brands — List all brands with filters
router.get('/brands', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const skip = (page - 1) * limit;
    const { search, brandType, category, status } = req.query;

    const filter = {};
    if (brandType) filter.brandType = brandType;
    if (category) filter.category = category;
    if (status) filter.status = status;
    if (search) {
      filter.name = { $regex: search, $options: 'i' };
    }

    const [brands, total] = await Promise.all([
      Brand.find(filter, {
        name: 1, brandType: 1, category: 1, logoUrl: 1, initials: 1,
        generatedColor: 1, status: 1, claimStatus: 1, totalReviews: 1,
        totalContentPieces: 1, totalInfluencersEngaged: 1, createdAt: 1,
      }).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Brand.countDocuments(filter),
    ]);

    res.json({
      brands,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load brands' });
  }
});

// GET /api/admin-panel/brands/:id — Brand detail
router.get('/brands/:id', async (req, res) => {
  try {
    const brand = await Brand.findById(req.params.id).lean();
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    const [campaigns, partnerships, submissions, rewards] = await Promise.all([
      Campaign.find({ brandId: brand._id }).sort({ createdAt: -1 }).lean(),
      Partnership.countDocuments({ brandId: brand._id, status: 'active' }),
      ContentSubmission.countDocuments({ brandId: brand._id }),
      Reward.find({ brandId: brand._id }).lean(),
    ]);

    res.json({ brand, campaigns, activePartnerships: partnerships, totalSubmissions: submissions, rewards });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load brand details' });
  }
});

// ═══════════════════════════════════════════════════════════
// MODULE 4: CONTENT MODERATION
// ═══════════════════════════════════════════════════════════

// GET /api/admin-panel/content — Content moderation queue
router.get('/content', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const skip = (page - 1) * limit;
    const { status, contentType, brandId } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (contentType) filter.contentType = contentType;
    if (brandId) filter.brandId = brandId;

    const [content, total] = await Promise.all([
      ContentSubmission.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip).limit(limit)
        .populate('brandId', 'name logoUrl')
        .populate('influencerProfileId', 'displayName handle avatarUrl')
        .lean(),
      ContentSubmission.countDocuments(filter),
    ]);

    res.json({
      content,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load content' });
  }
});

// PUT /api/admin-panel/content/:id/moderate — Admin moderate content
router.put('/content/:id/moderate', async (req, res) => {
  try {
    const { action, reason } = req.body;
    if (!['approve', 'reject', 'flag'].includes(action)) {
      return res.status(400).json({ error: 'Action must be approve, reject, or flag' });
    }

    const submission = await ContentSubmission.findById(req.params.id);
    if (!submission) return res.status(404).json({ error: 'Content not found' });

    if (action === 'approve') {
      submission.status = 'approved';
      submission.reviewedAt = new Date();
      submission.reviewedBy = req.user._id;
    } else if (action === 'reject') {
      submission.status = 'rejected';
      submission.rejectionReason = reason || 'Rejected by admin';
      submission.reviewedAt = new Date();
      submission.reviewedBy = req.user._id;
    }
    // flag = keep status but mark for admin review (could add a flag field later)

    await submission.save();
    console.log(`🛡️ Admin ${action}ed content ${submission._id}: ${reason || ''}`);

    if (action === 'approve') {
      // ── Referral bonus: $5 to referrer when referred creator gets first approved review ──
      try {
        const approvedCreator = await InfluencerProfile.findById(submission.influencerProfileId).lean();
        if (approvedCreator) {
          const creatorUser = await User.findById(approvedCreator.userId, { referredByCode: 1 }).lean();
          if (creatorUser?.referredByCode) {
            // Count approved reviews for this creator (including the one we just approved)
            const approvedCount = await ContentSubmission.countDocuments({
              influencerProfileId: approvedCreator._id,
              status: 'approved',
            });
            // Only fire on their FIRST approved review
            if (approvedCount === 1) {
              const referrer = await InfluencerProfile.findOne({ referralCode: creatorUser.referredByCode }).lean();
              if (referrer) {
                await Transaction.create({
                  payerType: 'platform',
                  payeeInfluencerId: referrer._id,
                  type: 'referral_bonus',
                  amount: 5,
                  contentSubmissionId: submission._id,
                  status: 'pending',  // pending until PayPal vault is live
                  paymentRouting: 'vault_kup',
                });
                console.log(`🎁 Referral bonus queued: $5 → referrer ${referrer._id} (referred creator ${approvedCreator._id} got first approval)`);
              }
            }
          }
        }
      } catch (refErr) {
        console.error('Referral bonus check error (non-blocking):', refErr.message);
        // Non-fatal — approval is still saved
      }

      // Fire approval + rating_request notifications to the creator
      try {
        const { createInApp } = require('../services/notifications');

        // Look up the influencer profile and brand
        const [profile, brand] = await Promise.all([
          InfluencerProfile.findById(submission.influencerProfileId).lean(),
          Brand.findById(submission.brandId).lean(),
        ]);

        if (profile && brand) {
          const userId = profile.userId.toString();
          const brandName = brand.name;
          const KUP_LOGO = 'https://keepuspostd.com/images/favicon/apple-touch-icon.png';
          const KUP_COLOR = '#2EA5DD';

          // 1. Approval notification
          await createInApp({
            userId,
            title: `${brandName} approved your content`,
            message: `Your ${submission.contentType || 'video'} for ${brandName} was approved. Keep it up!`,
            type: 'approval',
            link: `/brands/${submission.brandId}`,
            metadata: {
              brandName,
              brandLogoUrl: brand.logoUrl || KUP_LOGO,
              brandColor: brand.generatedColor || KUP_COLOR,
              partnershipId: submission.partnershipId?.toString() || null,
            },
            audience: 'influencer',
          });

          await sendPushToUser(userId, {
            title: `${brandName} approved your content 🎉`,
            body: `Your review was approved. Check your Activity tab.`,
            data: { type: 'approval', brandId: submission.brandId.toString() },
          });

          // 2. Rating request — only send if there's a partnershipId to link back to
          if (submission.partnershipId) {
            await createInApp({
              userId,
              title: `Rate your experience with ${brandName}`,
              message: `How was your partnership with ${brandName}? Rate your experience — it helps improve the platform.`,
              type: 'rating_request',
              link: `/brands/${submission.brandId}`,
              metadata: {
                brandName,
                brandLogoUrl: brand.logoUrl || KUP_LOGO,
                brandColor: brand.generatedColor || KUP_COLOR,
                partnershipId: submission.partnershipId.toString(),
              },
              audience: 'influencer',
            });
          }

          console.log(`📬 Approval + rating notifications sent to userId ${userId} for ${brandName}`);
        }
      } catch (notifyErr) {
        console.error('Approval notification error (non-blocking):', notifyErr.message);
        // Non-fatal — submission is still approved
      }
    }

    if (action === 'reject') {
      // Fire rejection notification to the creator — email + in-app + push
      try {
        const [profile, brand] = await Promise.all([
          InfluencerProfile.findById(submission.influencerProfileId).lean(),
          Brand.findById(submission.brandId).lean(),
        ]);

        if (profile && brand) {
          // Fetch account email so the rejection email goes to the right address
          const creatorUser = await User.findById(profile.userId, { email: 1 }).lean();
          await notify.contentRejected({
            influencer: {
              email: creatorUser?.email || null,
              userId: profile.userId.toString(),
              displayName: profile.displayName || 'Creator',
            },
            brand: {
              name: brand.name,
              logoUrl: brand.logoUrl || brand.avatarUrl || '',
            },
            submission: {
              _id: submission._id,
              contentType: submission.contentType || 'video',
              partnershipId: submission.partnershipId || null,
              posterUrl: submission.posterUrl || null,
              mediaUrls: submission.mediaUrls || [],
            },
            reason: reason || '',
          });
          console.log(`📬 Rejection notification sent to userId ${profile.userId} for ${brand.name}`);
        }
      } catch (notifyErr) {
        console.error('Rejection notification error (non-blocking):', notifyErr.message);
        // Non-fatal — submission is still rejected
      }
    }

    res.json({ message: `Content ${action}ed`, submission: { id: submission._id, status: submission.status } });
  } catch (error) {
    res.status(500).json({ error: 'Failed to moderate content' });
  }
});

// POST /api/admin-panel/content/:id/rate — Rate creator on admin brand submission (no partnershipId)
router.post('/content/:id/rate', async (req, res) => {
  try {
    const { contentQuality, timeliness, communication, briefCompliance, feedback } = req.body;

    const scores = { contentQuality, timeliness, communication, briefCompliance };
    for (const [key, val] of Object.entries(scores)) {
      if (!val || val < 1 || val > 5) {
        return res.status(400).json({ error: `${key} must be between 1 and 5` });
      }
    }

    const submission = await ContentSubmission.findById(req.params.id);
    if (!submission) return res.status(404).json({ error: 'Submission not found' });

    const overall = Math.round((contentQuality + timeliness + communication + briefCompliance) / 4);

    submission.adminRating = {
      contentQuality, timeliness, communication, briefCompliance,
      overall,
      feedback: feedback || null,
      ratedAt: new Date(),
    };
    await submission.save();

    // Roll up to InfluencerProfile — combine Partnership ratings + admin submission ratings
    try {
      const profileId = submission.influencerProfileId;

      const [partnershipRatings, submissionRatings] = await Promise.all([
        Partnership.find(
          { influencerProfileId: profileId, 'brandRating.overall': { $ne: null } },
          'brandRating.overall'
        ).lean(),
        ContentSubmission.find(
          { influencerProfileId: profileId, 'adminRating.overall': { $ne: null } },
          'adminRating.overall'
        ).lean(),
      ]);

      const allOveralls = [
        ...partnershipRatings.map(p => p.brandRating.overall),
        ...submissionRatings.map(s => s.adminRating.overall),
      ];

      const ratingCount   = allOveralls.length;
      const averageRating = ratingCount > 0
        ? Math.round((allOveralls.reduce((sum, v) => sum + v, 0) / ratingCount) * 10) / 10
        : null;

      await InfluencerProfile.findByIdAndUpdate(profileId, { averageRating, ratingCount });
    } catch (rollupErr) {
      console.error('Admin rating rollup error (non-blocking):', rollupErr.message);
    }

    console.log(`⭐ Admin rated creator on submission ${submission._id} → ${overall}/5`);
    res.json({ message: 'Rating saved', overall });
  } catch (error) {
    console.error('Admin content rate error:', error.message);
    res.status(500).json({ error: 'Could not save rating' });
  }
});

// ═══════════════════════════════════════════════════════════
// MODULE 5: FINANCIAL DASHBOARD
// ═══════════════════════════════════════════════════════════

// GET /api/admin-panel/financials — Financial overview
router.get('/financials', async (req, res) => {
  try {
    const [
      totalRevenue,
      totalPayouts,
      pendingPayouts,
      failedTx,
      txByType,
      recentTransactions,
      subscriptionRevenue,
    ] = await Promise.all([
      // MRR from subscriptions (simplified — count active subs * avg price)
      Subscription.countDocuments({ status: 'active' }),
      Transaction.aggregate([
        { $match: { status: 'paid' } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]),
      Transaction.aggregate([
        { $match: { status: 'pending' } },
        { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      Transaction.countDocuments({ status: 'failed' }),
      Transaction.aggregate([
        { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
      Transaction.find()
        .sort({ createdAt: -1 }).limit(20)
        .populate('payerBrandId', 'name')
        .populate('payeeInfluencerId', 'displayName handle')
        .lean(),
      // Subscription count by tier
      Subscription.aggregate([
        { $match: { status: 'active' } },
        { $group: { _id: '$planTier', count: { $sum: 1 } } },
      ]),
    ]);

    res.json({
      activeSubscriptions: totalRevenue,
      totalPaidOut: totalPayouts[0]?.total || 0,
      pendingPayouts: { amount: pendingPayouts[0]?.total || 0, count: pendingPayouts[0]?.count || 0 },
      failedTransactions: failedTx,
      transactionsByType: txByType,
      recentTransactions,
      subscriptionsByTier: subscriptionRevenue,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load financials' });
  }
});

// GET /api/admin-panel/financials/transactions — Full transaction ledger with pagination
router.get('/financials/transactions', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const skip = (page - 1) * limit;
    const { status, type } = req.query;

    const filter = {};
    if (status) filter.status = status;
    if (type) filter.type = type;

    const [transactions, total] = await Promise.all([
      Transaction.find(filter)
        .sort({ createdAt: -1 }).skip(skip).limit(limit)
        .populate('payerBrandId', 'name')
        .populate('payeeInfluencerId', 'displayName handle')
        .lean(),
      Transaction.countDocuments(filter),
    ]);

    res.json({
      transactions,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load transactions' });
  }
});

// ═══════════════════════════════════════════════════════════
// MODULE 4b: REVIEWS (Kiosk guest reviews)
// ═══════════════════════════════════════════════════════════

// GET /api/admin-panel/reviews — All guest reviewers with stats
router.get('/reviews', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const skip = (page - 1) * limit;
    const { brandId } = req.query;

    const filter = {};
    if (brandId) filter.brandId = brandId;

    const [reviewers, total, totalReviewCount] = await Promise.all([
      GuestReviewer.find(filter)
        .sort({ createdAt: -1 }).skip(skip).limit(limit)
        .populate('brandId', 'name logoUrl')
        .lean(),
      GuestReviewer.countDocuments(filter),
      GuestReviewer.aggregate([
        ...(brandId ? [{ $match: { brandId: brandId } }] : []),
        { $group: { _id: null, total: { $sum: '$totalReviews' } } },
      ]),
    ]);

    res.json({
      reviewers,
      totalReviewCount: totalReviewCount[0]?.total || 0,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load reviews' });
  }
});

// ═══════════════════════════════════════════════════════════
// MODULE 11: MESSAGE INBOX (Contact/Support/Claim forms)
// ═══════════════════════════════════════════════════════════

// For MVP, messages are stored in a new Message model.
// If the model doesn't exist yet, we'll create a simple in-memory store
// and add the model in a follow-up.

// For launch, admin messages come through Notification model with type 'system'
// We'll query those + provide a contact form endpoint

// POST /api/admin-panel/messages — Submit a contact/support/claim message (public endpoint moved here for admin view)
// GET /api/admin-panel/messages — List all admin messages

// Using Notification model for now with admin-specific types
router.get('/messages', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 25, 100);
    const skip = (page - 1) * limit;

    // Admin messages are notifications sent to admin users
    const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase());

    // Find admin user IDs by looking up their Firebase UIDs
    const adminUsers = await User.find(
      { email: { $in: adminEmails } },
      { firebaseUid: 1 }
    ).lean();
    const adminUids = adminUsers.map(u => u.firebaseUid).filter(Boolean);

    const filter = { userId: { $in: adminUids } };
    if (req.query.unread === 'true') filter.read = false;

    const [messages, total, unreadCount] = await Promise.all([
      Notification.find(filter)
        .sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      Notification.countDocuments(filter),
      Notification.countDocuments({ ...filter, read: false }),
    ]);

    res.json({
      messages,
      unreadCount,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load messages' });
  }
});

// ═══════════════════════════════════════════════════════════
// QUICK STATS (for admin nav badges)
// ═══════════════════════════════════════════════════════════

router.get('/badges', async (req, res) => {
  try {
    const [pendingContent, pendingPayouts, unreadMessages] = await Promise.all([
      ContentSubmission.countDocuments({ status: 'submitted' }),
      Transaction.countDocuments({ status: 'pending' }),
      // Simplified — count recent system notifications
      Notification.countDocuments({
        type: 'system',
        read: false,
        createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      }),
    ]);

    res.json({ pendingContent, pendingPayouts, unreadMessages });
  } catch (error) {
    res.json({ pendingContent: 0, pendingPayouts: 0, unreadMessages: 0 });
  }
});

// ═══════════════════════════════════════════════════════════
// ADMIN BRAND MANAGEMENT — Create, Edit, Bulk Create
// ═══════════════════════════════════════════════════════════

// Helper: generate color from brand name (deterministic)
function generateBrandColor(name) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash % 360);
  return `hsl(${h}, 65%, 45%)`;
}

// Helper: generate initials from brand name
function generateInitials(name) {
  const words = name.trim().split(/\s+/);
  if (words.length === 1) return words[0].substring(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

// POST /api/admin-panel/brands/create — Create a single admin brand
router.post('/brands/create', async (req, res) => {
  try {
    const {
      name, category, subcategory, description, location,
      city, state, zip, websiteUrl, tags, categoryIcon,
      lat, lon, // optional: decimal coordinates for geo discover filter
    } = req.body;

    if (!name) return res.status(400).json({ error: 'Brand name is required' });

    // Check for duplicate name
    const existing = await Brand.findOne({
      name: { $regex: new RegExp(`^${name.trim()}$`, 'i') },
    });
    if (existing) return res.status(409).json({ error: `Brand "${name}" already exists` });

    // Build coordinates if lat/lon provided — required for brand to appear in geo-filtered discover
    const coordinates = (lat != null && lon != null)
      ? { type: 'Point', coordinates: [parseFloat(lon), parseFloat(lat)] }
      : undefined;

    const brand = await Brand.create({
      name: name.trim(),
      brandType: 'admin',
      profileSource: 'manual',
      createdBy: 'platform',
      claimStatus: 'unclaimed',
      category: category || null,
      subcategory: subcategory || null,
      description: description || null,
      location: location || null,
      city: city || null,
      state: state || null,
      zip: zip || null,
      websiteUrl: websiteUrl || null,
      tags: tags || [],
      initials: generateInitials(name),
      generatedColor: generateBrandColor(name),
      categoryIcon: categoryIcon || null,
      heroImageSource: 'gradient',
      status: 'active',
      ...(coordinates && { coordinates }),
    });

    res.status(201).json({ success: true, brand });
  } catch (error) {
    console.error('Admin brand create error:', error);
    res.status(500).json({ error: 'Failed to create admin brand' });
  }
});

// POST /api/admin-panel/brands/bulk-create — Create multiple admin brands
router.post('/brands/bulk-create', async (req, res) => {
  try {
    const { brands } = req.body;
    if (!brands || !Array.isArray(brands) || brands.length === 0) {
      return res.status(400).json({ error: 'brands array is required' });
    }
    if (brands.length > 100) {
      return res.status(400).json({ error: 'Maximum 100 brands per bulk create' });
    }

    const results = { created: [], skipped: [], errors: [] };

    for (const b of brands) {
      if (!b.name) {
        results.errors.push({ name: b.name, reason: 'Missing name' });
        continue;
      }

      // Check duplicate
      const existing = await Brand.findOne({
        name: { $regex: new RegExp(`^${b.name.trim()}$`, 'i') },
      });
      if (existing) {
        results.skipped.push({ name: b.name, reason: 'Already exists' });
        continue;
      }

      try {
        const bCoordinates = (b.lat != null && b.lon != null)
          ? { type: 'Point', coordinates: [parseFloat(b.lon), parseFloat(b.lat)] }
          : undefined;

        const brand = await Brand.create({
          name: b.name.trim(),
          brandType: 'admin',
          profileSource: b.profileSource || 'manual',
          createdBy: 'platform',
          claimStatus: 'unclaimed',
          category: b.category || null,
          subcategory: b.subcategory || null,
          description: b.description || null,
          location: b.location || null,
          city: b.city || null,
          state: b.state || null,
          zip: b.zip || null,
          websiteUrl: b.websiteUrl || null,
          tags: b.tags || [],
          initials: generateInitials(b.name),
          generatedColor: generateBrandColor(b.name),
          categoryIcon: b.categoryIcon || null,
          heroImageSource: 'gradient',
          status: 'active',
          ...(bCoordinates && { coordinates: bCoordinates }),
        });
        results.created.push({ name: brand.name, id: brand._id });
      } catch (err) {
        results.errors.push({ name: b.name, reason: err.message });
      }
    }

    res.json({
      success: true,
      summary: {
        created: results.created.length,
        skipped: results.skipped.length,
        errors: results.errors.length,
      },
      results,
    });
  } catch (error) {
    console.error('Bulk create error:', error);
    res.status(500).json({ error: 'Failed to bulk create brands' });
  }
});

// PUT /api/admin-panel/brands/:id — Update an admin brand
router.put('/brands/:id', async (req, res) => {
  try {
    const brand = await Brand.findById(req.params.id);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    const allowed = [
      'name', 'category', 'subcategory', 'description', 'location',
      'city', 'state', 'zip', 'websiteUrl', 'email', 'phone', 'address',
      'tags', 'categoryIcon', 'status', 'socialLinks', 'brandColors',
      'logoUrl', 'heroImageUrl', 'legacyBrandId',
      'kioskEnabled', 'kioskOfferTitle', 'kioskRewardType', 'kioskRewardValue',
    ];

    const updates = {};
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    // Regenerate initials if name changed
    if (updates.name) {
      updates.initials = generateInitials(updates.name);
      updates.generatedColor = generateBrandColor(updates.name);
    }

    Object.assign(brand, updates);
    await brand.save();

    res.json({ success: true, brand });
  } catch (error) {
    console.error('Admin brand update error:', error);
    res.status(500).json({ error: 'Failed to update brand' });
  }
});

// DELETE /api/admin-panel/brands/:id — Delete a brand and all associated data
// Admin-only: cleans up partnerships, content, campaigns, rewards, etc.
router.delete('/brands/:id', async (req, res) => {
  try {
    const brand = await Brand.findById(req.params.id);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    // Clean up all associated data
    const [partnerships, content, campaigns, rewards] = await Promise.all([
      Partnership.deleteMany({ brandId: brand._id }),
      ContentSubmission.deleteMany({ brandId: brand._id }),
      Campaign.deleteMany({ brandId: brand._id }),
      Reward.deleteMany({ brandId: brand._id }),
    ]);

    // Remove from BrandProfile ownedBrandIds
    const BrandMember = require('../models/BrandMember');
    await BrandMember.deleteMany({ brandId: brand._id });
    await BrandProfile.updateMany(
      { ownedBrandIds: brand._id },
      { $pull: { ownedBrandIds: brand._id } }
    );

    await brand.deleteOne();

    console.log(`🗑️ Admin deleted brand "${brand.name}" + ${partnerships.deletedCount} partnerships, ${content.deletedCount} content, ${campaigns.deletedCount} campaigns, ${rewards.deletedCount} rewards`);
    res.json({
      success: true,
      message: `Brand "${brand.name}" and all associated data deleted`,
      deleted: {
        partnerships: partnerships.deletedCount,
        content: content.deletedCount,
        campaigns: campaigns.deletedCount,
        rewards: rewards.deletedCount,
      },
    });
  } catch (error) {
    console.error('Admin brand delete error:', error);
    res.status(500).json({ error: 'Failed to delete brand' });
  }
});

// ═══════════════════════════════════════════════════════════
// CLAIM REQUEST MANAGEMENT
// ═══════════════════════════════════════════════════════════

// GET /api/admin-panel/claims — List all claim requests
router.get('/claims', async (req, res) => {
  try {
    const { status = 'pending' } = req.query;
    const filter = status === 'all' ? {} : { status };

    const claims = await ClaimRequest.find(filter)
      .populate('brandId', 'name category claimStatus')
      .sort({ createdAt: -1 })
      .limit(100);

    res.json({ claims, total: claims.length });
  } catch (error) {
    console.error('Claims list error:', error);
    res.status(500).json({ error: 'Failed to fetch claims' });
  }
});

// PUT /api/admin-panel/claims/:id/approve — Approve a claim
router.put('/claims/:id/approve', async (req, res) => {
  try {
    const claim = await ClaimRequest.findById(req.params.id);
    if (!claim) return res.status(404).json({ error: 'Claim not found' });
    if (claim.status !== 'pending') {
      return res.status(400).json({ error: `Claim already ${claim.status}` });
    }

    const brand = await Brand.findById(claim.brandId);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    // Update claim
    claim.status = 'approved';
    claim.reviewedBy = req.user.email;
    claim.reviewNotes = req.body.notes || null;
    claim.reviewedAt = new Date();
    await claim.save();

    // Transition brand
    brand.brandType = 'admin_claimed';
    brand.claimStatus = 'claimed';
    brand.claimedAt = new Date();
    await brand.save();

    // Find or auto-create the claimer's user account.
    //
    // Why auto-create: the claim form is unauthenticated (any brand owner who
    // discovers KUP via the in-app "Claim This Brand" link can submit a claim
    // without first registering). Before this change, approving a claim where
    // no matching User existed would silently leave the brand ownerless and
    // dump the claimer into a manual signup flow. Auto-creating a Firebase
    // user + KUP user record + BrandProfile here turns the claim flow into a
    // one-touch onboarding: brand owner submits claim → admin approves → owner
    // receives an email with a one-time link to set their password and log in.
    let claimer = await User.findOne({ email: claim.claimerEmail.toLowerCase() });
    let userWasAutoCreated = false;
    let passwordResetLink = null;

    if (!claimer) {
      try {
        const admin = require('firebase-admin');
        const emailLower = claim.claimerEmail.toLowerCase();

        // 1. Firebase Auth user — create with random throwaway password.
        //    The claimer never uses it; they go through password-reset to set their own.
        let firebaseUser;
        try {
          firebaseUser = await admin.auth().getUserByEmail(emailLower);
          console.log(`ℹ️ Firebase user already exists for ${emailLower} — reusing`);
        } catch (notFoundErr) {
          firebaseUser = await admin.auth().createUser({
            email: emailLower,
            password: require('crypto').randomBytes(24).toString('hex'),
            displayName: claim.claimerName,
            emailVerified: false,
          });
          console.log(`✨ Firebase user auto-created for ${emailLower} (uid: ${firebaseUser.uid})`);
        }

        // 2. KUP User record
        const [legalFirstName, ...legalLastParts] = (claim.claimerName || '').trim().split(/\s+/);
        claimer = await User.create({
          email: emailLower,
          firebaseUid: firebaseUser.uid,
          legalFirstName: legalFirstName || null,
          legalLastName: legalLastParts.join(' ') || null,
          hasBrandProfile: true,
          activeProfile: 'brand',
        });

        // 3. Password-reset link for the welcome email — gives them a one-click
        //    path to set their own password without registering through the UI.
        try {
          passwordResetLink = await admin.auth().generatePasswordResetLink(emailLower);
        } catch (linkErr) {
          console.error('Password reset link generation failed:', linkErr.message);
          passwordResetLink = 'https://keepuspostd.com/pages/login.html'; // fallback
        }

        userWasAutoCreated = true;
        console.log(`✅ KUP user auto-provisioned for claim approval: ${emailLower}`);
      } catch (autoCreateErr) {
        console.error('User auto-create failed during claim approval:', autoCreateErr.message);
        // Fall through — brand stays approved but ownerless. Admin can use the
        // /brands/:id/set-owner endpoint to wire ownership manually later.
        claimer = null;
      }
    }

    // Wire brand ownership if we have a user (existing or auto-created)
    if (claimer) {
      const BrandMember = require('../models/BrandMember');
      const existing = await BrandMember.findOne({ brandId: brand._id, userId: claimer._id });
      if (!existing) {
        await BrandMember.create({
          brandId: brand._id,
          userId: claimer._id,
          role: 'owner',
          status: 'active',
          acceptedAt: new Date(),
        });
      }

      // Create BrandProfile with 14-day Pro trial if not already
      let bp = await BrandProfile.findOne({ userId: claimer._id });
      if (!bp) {
        const trialStart = new Date();
        const trialEnd = new Date(trialStart.getTime() + 14 * 24 * 60 * 60 * 1000);
        bp = await BrandProfile.create({
          userId: claimer._id,
          ownedBrandIds: [brand._id],
          planTier: 'pro',
          trialActive: true,
          trialTier: 'pro',
          trialStartedAt: trialStart,
          trialEndsAt: trialEnd,
        });
      } else if (!bp.ownedBrandIds.includes(brand._id)) {
        bp.ownedBrandIds.push(brand._id);
        await bp.save();
      }

      // Make sure the User flags reflect brand ownership
      if (!claimer.hasBrandProfile) {
        claimer.hasBrandProfile = true;
        claimer.activeProfile = claimer.activeProfile || 'brand';
        await claimer.save();
      }
    }

    // Send approval email — content depends on whether we just provisioned them
    try {
      const firstName = (claim.claimerName || '').split(' ')[0] || 'there';
      const bodyHtml = userWasAutoCreated
        ? `
          <p>Your claim for <strong>${brand.name}</strong> has been approved. Welcome to KeepUsPostd!</p>
          <p>We've set up your account using <strong>${claim.claimerEmail}</strong>. Click the button below to set your password and log in to your brand dashboard.</p>
          <p>You're starting on a <strong>14-day free Pro trial</strong> — no credit card required.</p>
          <p>Your QR code and brand profile are already live and ready for customers.</p>
        `
        : `
          <p>Your claim for <strong>${brand.name}</strong> has been approved. Welcome to KeepUsPostd!</p>
          <p>Log in with <strong>${claim.claimerEmail}</strong> to access your brand dashboard. You're starting on a <strong>14-day free Pro trial</strong>.</p>
          <p>Your QR code and brand profile are already live and ready for customers.</p>
        `;

      await sendEmail({
        to: claim.claimerEmail,
        subject: `Your ${brand.name} brand claim on KeepUsPostd has been approved`,
        headline: `You're in, ${firstName}`,
        variant: 'brand',
        bodyHtml,
        ctaText: userWasAutoCreated ? 'Set Your Password' : 'Log In to Your Dashboard',
        ctaUrl: userWasAutoCreated
          ? (passwordResetLink || 'https://keepuspostd.com/pages/login.html')
          : 'https://keepuspostd.com/pages/login.html',
      });
    } catch (emailErr) {
      console.error('Claim approval email failed:', emailErr.message);
      // Non-fatal — claim is still approved
    }

    res.json({
      success: true,
      claim,
      brand,
      userWasAutoCreated,
      passwordResetLinkSent: userWasAutoCreated && !!passwordResetLink,
    });
  } catch (error) {
    console.error('Claim approve error:', error);
    res.status(500).json({ error: 'Failed to approve claim', message: error.message });
  }
});

// PUT /api/admin-panel/claims/:id/reject — Reject a claim
router.put('/claims/:id/reject', async (req, res) => {
  try {
    const claim = await ClaimRequest.findById(req.params.id);
    if (!claim) return res.status(404).json({ error: 'Claim not found' });
    if (claim.status !== 'pending') {
      return res.status(400).json({ error: `Claim already ${claim.status}` });
    }

    claim.status = 'rejected';
    claim.reviewedBy = req.user.email;
    claim.reviewNotes = req.body.notes || 'Claim rejected';
    claim.reviewedAt = new Date();
    await claim.save();

    // Reset brand claim status
    const brand = await Brand.findById(claim.brandId);
    if (brand) {
      brand.claimStatus = 'unclaimed';
      await brand.save();
    }

    res.json({ success: true, claim });
  } catch (error) {
    console.error('Claim reject error:', error);
    res.status(500).json({ error: 'Failed to reject claim' });
  }
});

// POST /api/admin-panel/brands/:brandId/set-owner — Manually wire a user as
// the owner of a brand. Safety net for cases where the natural claim approval
// flow couldn't wire ownership (e.g. brand approved before the auto-create-
// user feature shipped, or the auto-create failed). Idempotent — safe to call
// multiple times.
//
// Body: { ownerEmail }
router.post('/brands/:brandId/set-owner', async (req, res) => {
  try {
    const { ownerEmail } = req.body;
    if (!ownerEmail || typeof ownerEmail !== 'string') {
      return res.status(400).json({ error: 'ownerEmail is required' });
    }
    const emailLower = ownerEmail.trim().toLowerCase();

    const brand = await Brand.findById(req.params.brandId);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    const user = await User.findOne({ email: emailLower });
    if (!user) {
      return res.status(404).json({
        error: 'No user account found with that email',
        message: 'Have the brand owner register at keepuspostd.com first, then re-run this. Or approve a fresh claim — that flow auto-creates the account.',
      });
    }

    const BrandMember = require('../models/BrandMember');
    const existingMember = await BrandMember.findOne({ brandId: brand._id, userId: user._id });
    let memberCreated = false;
    if (!existingMember) {
      await BrandMember.create({
        brandId: brand._id,
        userId: user._id,
        role: 'owner',
        status: 'active',
        acceptedAt: new Date(),
      });
      memberCreated = true;
    } else if (existingMember.role !== 'owner' || existingMember.status !== 'active') {
      existingMember.role = 'owner';
      existingMember.status = 'active';
      existingMember.acceptedAt = existingMember.acceptedAt || new Date();
      await existingMember.save();
    }

    // Find or create BrandProfile, attach brand
    let bp = await BrandProfile.findOne({ userId: user._id });
    let bpCreated = false;
    if (!bp) {
      const trialStart = new Date();
      const trialEnd = new Date(trialStart.getTime() + 14 * 24 * 60 * 60 * 1000);
      bp = await BrandProfile.create({
        userId: user._id,
        ownedBrandIds: [brand._id],
        planTier: 'pro',
        trialActive: true,
        trialTier: 'pro',
        trialStartedAt: trialStart,
        trialEndsAt: trialEnd,
      });
      bpCreated = true;
    } else if (!bp.ownedBrandIds.includes(brand._id)) {
      bp.ownedBrandIds.push(brand._id);
      await bp.save();
    }

    // Make sure brand reflects claimed state (in case admin is using this to
    // recover from a broken state where the brand never transitioned)
    let brandTransitioned = false;
    if (brand.claimStatus !== 'claimed' || brand.brandType !== 'admin_claimed') {
      brand.brandType = brand.brandType === 'admin' ? 'admin_claimed' : brand.brandType;
      brand.claimStatus = 'claimed';
      brand.claimedAt = brand.claimedAt || new Date();
      await brand.save();
      brandTransitioned = true;
    }

    // Make sure User flags reflect brand ownership
    if (!user.hasBrandProfile) {
      user.hasBrandProfile = true;
      user.activeProfile = user.activeProfile || 'brand';
      await user.save();
    }

    console.log(`🔧 Admin ${req.user?.email} set ${emailLower} as owner of brand ${brand.name} (${brand._id})`);

    res.json({
      message: `${emailLower} is now the owner of ${brand.name}.`,
      brand: { id: brand._id, name: brand.name, claimStatus: brand.claimStatus, brandType: brand.brandType },
      user: { id: user._id, email: user.email },
      created: {
        brandMember: memberCreated,
        brandProfile: bpCreated,
        brandTransitionedToClaimed: brandTransitioned,
      },
    });
  } catch (error) {
    console.error('Set brand owner error:', error);
    res.status(500).json({ error: 'Failed to set brand owner', message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// PLATFORM BONUS PAYMENTS
// ═══════════════════════════════════════════════════════════

// GET /api/admin-panel/influencer-lookup — Find influencer by email or handle (for bonus UI)
router.get('/influencer-lookup', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q || q.trim().length < 2) {
      return res.status(400).json({ error: 'Query must be at least 2 characters' });
    }

    const search = q.trim().toLowerCase().replace(/^@/, '');

    // Search by handle first
    let profile = await InfluencerProfile.findOne({
      $or: [
        { handle: search },
        { displayName: { $regex: search, $options: 'i' } },
      ],
    }).lean();

    if (!profile) {
      // Try by email via User model
      const user = await User.findOne({ email: { $regex: search, $options: 'i' } }, { _id: 1 }).lean();
      if (user) {
        profile = await InfluencerProfile.findOne({ userId: user._id }).lean();
      }
    }

    if (!profile) return res.status(404).json({ error: 'No influencer found' });

    // Also fetch account email from User model
    const user = await User.findById(profile.userId, { email: 1 }).lean();

    res.json({
      userId: profile.userId,
      handle: profile.handle,
      displayName: profile.displayName,
      influenceTier: profile.influenceTier,
      paypalEmail: profile.paypalEmail || null,
      accountEmail: user?.email || null,
    });
  } catch (error) {
    console.error('Influencer lookup error:', error);
    res.status(500).json({ error: 'Lookup failed' });
  }
});

// POST /api/admin-panel/bonus — Send a bonus payment to an influencer
router.post('/bonus', async (req, res) => {
  try {
    const { influencerUserId, amount, reason, brandId } = req.body;

    if (!influencerUserId || !amount || !reason) {
      return res.status(400).json({ error: 'influencerUserId, amount, and reason are required' });
    }
    if (amount <= 0 || amount > 100) {
      return res.status(400).json({ error: 'Bonus must be between $0.01 and $100' });
    }

    const influencer = await User.findById(influencerUserId);
    if (!influencer) return res.status(404).json({ error: 'Influencer not found' });

    // Create a platform bonus transaction (manual payout — admin pays via PayPal separately)
    const profile = await InfluencerProfile.findOne({ userId: influencerUserId }).lean();

    const transaction = await Transaction.create({
      userId: influencerUserId,
      brandId: brandId || null,
      type: 'platform_bonus',
      amount: amount,
      brandPaysAmount: 0,
      kupFee: 0,
      paypalFee: 0,
      description: `KUP Bonus: ${reason}`,
      status: 'pending',
      fundedBy: 'platform',
    });

    // Notify influencer (email + in-app + push)
    try {
      await notify.cashRewardEarned({
        influencer: {
          email: influencer.email,
          userId: influencerUserId,
          displayName: profile?.displayName || influencer.displayName || influencer.email,
        },
        brand: null,
        amount,
        type: 'platform_bonus',
      });
    } catch (notifyErr) {
      console.error('Bonus notification failed (non-blocking):', notifyErr.message);
    }

    res.json({
      success: true,
      message: `Bonus of $${amount} recorded for ${influencer.displayName || influencer.email}. Pay manually via PayPal.`,
      transaction,
    });
  } catch (error) {
    console.error('Bonus payment error:', error);
    res.status(500).json({ error: 'Failed to create bonus payment' });
  }
});

// ═══════════════════════════════════════════════════════════
// MODULE: SOCIAL VERIFICATION QUEUE
// ═══════════════════════════════════════════════════════════

// GET /api/admin-panel/verifications/count — Count of pending verifications
router.get('/verifications/count', async (req, res) => {
  try {
    const count = await InfluencerProfile.countDocuments({ verificationPending: true });
    res.json({ count });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch verification count' });
  }
});

// GET /api/admin-panel/verifications/pending — All pending verification requests
router.get('/verifications/pending', async (req, res) => {
  try {
    const pending = await InfluencerProfile.find({ verificationPending: true })
      .populate('userId', 'email legalFirstName legalLastName')
      .sort({ verificationPendingAt: 1 })
      .lean();

    const results = pending.map(inf => ({
      _id: inf._id,
      displayName: inf.displayName,
      handle: inf.handle,
      avatarUrl: inf.avatarUrl || null,
      pendingVerificationData: inf.pendingVerificationData || {},
      verificationPendingAt: inf.verificationPendingAt,
      userId: inf.userId,
    }));

    res.json(results);
  } catch (error) {
    console.error('Fetch pending verifications error:', error.message);
    res.status(500).json({ error: 'Failed to fetch pending verifications' });
  }
});

// POST /api/admin-panel/verifications/:id/approve — Approve a verification
router.post('/verifications/:id/approve', async (req, res) => {
  try {
    const { followerCount } = req.body;
    const count = parseInt(followerCount, 10);
    if (isNaN(count) || count < 0) {
      return res.status(400).json({ error: 'Valid followerCount is required' });
    }

    const influencer = await InfluencerProfile.findById(req.params.id);
    if (!influencer) return res.status(404).json({ error: 'Influencer profile not found' });

    const tier = tierFromFollowers(count);

    influencer.isVerified = true;
    influencer.verificationPending = false;
    influencer.influenceTier = tier.key;
    influencer.realFollowerCount = count;
    influencer.verifiedAt = influencer.verifiedAt || new Date();
    influencer.lastVerificationAt = new Date();
    influencer.pendingVerificationData = null;

    // Preserve engagement rate from pending data if present
    if (influencer.pendingVerificationData?.engagementRate != null) {
      influencer.engagementRate = parseFloat(influencer.pendingVerificationData.engagementRate);
    }

    await influencer.save();

    // Send push to influencer user
    try {
      await sendPushToUser(influencer.userId, {
        title: '✅ You\'re Verified!',
        body: `Welcome to the ${tier.displayName} tier! Brands can now see your verified status.`,
        data: { type: 'verification_approved', tier: tier.key },
      });
    } catch (pushErr) {
      console.warn('Push notify failed (approve):', pushErr.message);
    }

    // Send email notification if available
    try {
      const user = await User.findById(influencer.userId).select('email').lean();
      if (user && notify.socialInfluenceVerified) {
        await notify.socialInfluenceVerified({
          influencer: {
            email: user.email,
            userId: influencer.userId,
            displayName: influencer.displayName,
          },
          tier: tier.key,
        });
      }
    } catch (notifErr) {
      console.warn('Email notify failed (approve):', notifErr.message);
    }

    res.json({ success: true, tier: tier.displayName, tierKey: tier.key });
  } catch (error) {
    console.error('Approve verification error:', error.message);
    res.status(500).json({ error: 'Failed to approve verification' });
  }
});

// POST /api/admin-panel/verifications/:id/reject — Reject a verification
router.post('/verifications/:id/reject', async (req, res) => {
  try {
    const { reason } = req.body;

    const influencer = await InfluencerProfile.findById(req.params.id);
    if (!influencer) return res.status(404).json({ error: 'Influencer profile not found' });

    influencer.verificationPending = false;
    influencer.pendingVerificationData = null;

    await influencer.save();

    // Send push to influencer user
    try {
      await sendPushToUser(influencer.userId, {
        title: 'Verification Update',
        body: reason
          ? `Your verification needs attention: ${reason}`
          : 'Your verification request needs more information. Please resubmit.',
        data: { type: 'verification_rejected' },
      });
    } catch (pushErr) {
      console.warn('Push notify failed (reject):', pushErr.message);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Reject verification error:', error.message);
    res.status(500).json({ error: 'Failed to reject verification' });
  }
});

// GET /api/admin-panel/admin-brands/stats — Stats for admin brand system
router.get('/admin-brands/stats', async (req, res) => {
  try {
    const [
      totalAdmin, totalUnclaimed, totalPending, totalClaimed,
      totalUserBrands, pendingClaims, totalContent,
    ] = await Promise.all([
      Brand.countDocuments({ brandType: 'admin' }),
      Brand.countDocuments({ brandType: 'admin', claimStatus: 'unclaimed' }),
      Brand.countDocuments({ brandType: 'admin', claimStatus: 'pending' }),
      Brand.countDocuments({ brandType: 'admin_claimed' }),
      Brand.countDocuments({ brandType: 'user' }),
      ClaimRequest.countDocuments({ status: 'pending' }),
      ContentSubmission.countDocuments(),
    ]);

    res.json({
      adminBrands: { total: totalAdmin, unclaimed: totalUnclaimed, pending: totalPending, claimed: totalClaimed },
      userBrands: totalUserBrands,
      pendingClaims,
      totalContent,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch admin brand stats' });
  }
});

// ═══════════════════════════════════════════════════════════
// ADMIN: CLEANUP TEST DATA
// ═══════════════════════════════════════════════════════════

// DELETE /api/admin-panel/cleanup/content — Remove all content submissions + R2 files + transactions
router.delete('/cleanup/content', async (req, res) => {
  try {
    // 1. Get all media URLs for R2 cleanup
    const allContent = await ContentSubmission.find({}, 'mediaUrls posterUrl').lean();
    let r2Keys = [];
    allContent.forEach(c => {
      if (c.mediaUrls) {
        c.mediaUrls.forEach(url => {
          // Extract R2 key from URL: https://pub-xxx.r2.dev/uploads/xxx → uploads/xxx
          const match = url.match(/r2\.dev\/(.+)$/);
          if (match) r2Keys.push(match[1]);
        });
      }
      if (c.posterUrl) {
        const match = c.posterUrl.match(/r2\.dev\/(.+)$/);
        if (match) r2Keys.push(match[1]);
      }
    });

    // 2. Delete R2 files
    let r2Deleted = 0;
    if (r2Keys.length > 0) {
      try {
        const { S3Client, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
        const s3 = new S3Client({
          region: 'auto',
          endpoint: process.env.R2_ENDPOINT,
          credentials: {
            accessKeyId: process.env.R2_ACCESS_KEY_ID,
            secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
          },
        });
        // Delete in batches of 1000 (S3 limit)
        for (let i = 0; i < r2Keys.length; i += 1000) {
          const batch = r2Keys.slice(i, i + 1000);
          await s3.send(new DeleteObjectsCommand({
            Bucket: process.env.R2_BUCKET,
            Delete: { Objects: batch.map(k => ({ Key: k })) },
          }));
          r2Deleted += batch.length;
        }
      } catch (r2Err) {
        console.error('R2 cleanup error (non-blocking):', r2Err.message);
      }
    }

    // 3. Delete all content submissions
    const contentResult = await ContentSubmission.deleteMany({});

    // 4. Delete all transactions
    const txnResult = await Transaction.deleteMany({});

    // 5. Reset influencer stats
    await InfluencerProfile.updateMany({}, {
      $set: { totalCashEarned: 0, totalContentSubmitted: 0, totalContentApproved: 0 }
    });

    // 6. Delete content-related notifications
    await Notification.deleteMany({ type: { $in: ['content', 'approval', 'payment'] } });

    console.log(`🧹 Cleanup: ${contentResult.deletedCount} submissions, ${txnResult.deletedCount} transactions, ${r2Deleted} R2 files`);

    res.json({
      success: true,
      deleted: {
        submissions: contentResult.deletedCount,
        transactions: txnResult.deletedCount,
        r2Files: r2Deleted,
      },
      message: 'All test content, transactions, and media files removed.',
    });
  } catch (error) {
    console.error('Cleanup error:', error.message);
    res.status(500).json({ error: 'Cleanup failed', message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// SUPPORT TICKETS
// ═══════════════════════════════════════════════════════════

const SupportTicket = require('../models/SupportTicket');
const PromoCode = require('../models/PromoCode');

// POST /api/admin-panel/support-ticket — Submit a support ticket (authenticated)
router.post('/support-ticket', requireAuth, async (req, res) => {
  try {
    const { subject, description, priority } = req.body;
    if (!subject || !description?.trim()) {
      return res.status(400).json({ error: 'Subject and description are required' });
    }

    const ticket = await SupportTicket.create({
      userId: req.user._id,
      email: req.user.email,
      displayName: req.user.displayName || req.user.email,
      subject,
      description: description.trim(),
      priority: priority || 'medium',
    });

    // Email notification to admin
    sendEmail({
      to: process.env.ADMIN_EMAIL || 'santana@keepuspostd.com',
      subject: `Support Ticket: ${subject}`,
      headline: 'New Support Ticket',
      preheader: `From ${req.user.email}`,
      bodyHtml: `
        <p><strong>From:</strong> ${req.user.displayName || req.user.email} (${req.user.email})</p>
        <p><strong>Subject:</strong> ${subject}</p>
        <p><strong>Priority:</strong> ${priority || 'medium'}</p>
        <p><strong>Description:</strong></p>
        <p>${description.trim().replace(/\n/g, '<br>')}</p>
      `,
      ctaText: 'View in Admin Panel',
      ctaUrl: `${process.env.APP_URL || 'https://keepuspostd.com'}/app/admin-panel.html#tickets`,
      variant: 'brand',
    }).catch(e => console.error('Support ticket email error:', e.message));

    res.json({ success: true, ticketId: ticket._id, message: 'Ticket submitted' });
  } catch (error) {
    console.error('Support ticket error:', error.message);
    res.status(500).json({ error: 'Could not submit ticket' });
  }
});

// GET /api/admin-panel/support-tickets — List all tickets (admin only)
router.get('/support-tickets', async (req, res) => {
  try {
    const { status, page = 1, limit = 25 } = req.query;
    const filter = {};
    if (status) filter.status = status;
    const skip = (parseInt(page) - 1) * Math.min(parseInt(limit), 100);
    const [tickets, total] = await Promise.all([
      SupportTicket.find(filter).sort({ createdAt: -1 }).skip(skip).limit(Math.min(parseInt(limit), 100)).lean(),
      SupportTicket.countDocuments(filter),
    ]);
    res.json({ tickets, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (error) {
    res.status(500).json({ error: 'Could not fetch tickets' });
  }
});

// PUT /api/admin-panel/support-tickets/:id — Update ticket status (admin only)
router.put('/support-tickets/:id', async (req, res) => {
  try {
    const { status, notes } = req.body;
    const update = {};
    if (status) update.status = status;
    if (notes) update.notes = notes;
    if (status === 'resolved') {
      update.resolvedAt = new Date();
      update.resolvedBy = req.user?.email || 'admin';
    }
    const ticket = await SupportTicket.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    res.json({ ticket });
  } catch (error) {
    res.status(500).json({ error: 'Could not update ticket' });
  }
});

// ═══════════════════════════════════════════════════════════
// BULK BRAND CREATION — CSV upload for admin brands
// ═══════════════════════════════════════════════════════════

// POST /api/admin-panel/brands/bulk-create — Create multiple admin brands from CSV data
// Body: { brands: [{ name, category }] } OR raw CSV text in { csv: "name,category\n..." }
// Auto-generates kioskBrandCode, sets brandType=admin, claimStatus=unclaimed
// Optionally applies platform rewards if applyRewards=true
router.post('/brands/bulk-create', async (req, res) => {
  try {
    let brandList = req.body.brands;

    // Parse CSV text if provided instead of JSON array
    if (!brandList && req.body.csv) {
      const lines = req.body.csv.trim().split('\n');
      const header = lines[0].toLowerCase();
      const hasHeader = header.includes('name') && header.includes('category');
      const dataLines = hasHeader ? lines.slice(1) : lines;

      brandList = dataLines
        .map(line => {
          const parts = line.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
          return { name: parts[0], category: parts[1] || 'Other' };
        })
        .filter(b => b.name && b.name.length > 0);
    }

    if (!brandList || brandList.length === 0) {
      return res.status(400).json({ error: 'No brands provided. Send { brands: [{name, category}] } or { csv: "name,category\\n..." }' });
    }

    const applyRewards = req.body.applyRewards !== false; // default true
    const results = { created: 0, skipped: 0, errors: [], brands: [] };

    for (const item of brandList) {
      try {
        // Skip if brand with same name already exists
        const existing = await Brand.findOne({ name: { $regex: `^${item.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } });
        if (existing) {
          results.skipped++;
          results.errors.push({ name: item.name, reason: 'Already exists' });
          continue;
        }

        // Generate unique kiosk code
        const kioskBrandCode = 'KUP-' + Math.random().toString(36).substring(2, 8).toUpperCase();

        const brandData = {
          name: item.name.trim(),
          category: item.category || 'Other',
          description: item.description || null,
          brandType: 'admin',
          claimStatus: 'unclaimed',
          profileSource: 'manual',
          createdBy: 'platform',
          status: 'active',
          kioskBrandCode,
        };
        // Optional fields
        if (item.brandColors) brandData.brandColors = item.brandColors;
        if (item.city) brandData.city = item.city;
        if (item.state) brandData.state = item.state;
        if (item.websiteUrl) brandData.websiteUrl = item.websiteUrl;
        if (item.logoUrl) brandData.logoUrl = item.logoUrl;
        if (item.heroImageUrl) brandData.heroImageUrl = item.heroImageUrl;
        if (item.legacyBrandId) brandData.legacyBrandId = item.legacyBrandId;

        const brand = await Brand.create(brandData);

        // Auto-geocode city if provided (non-blocking)
        if (item.city) {
          const geocodeCity = async (brandId, city) => {
            try {
              const r = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(city)}&format=json&limit=1`, { headers: { 'User-Agent': 'KeepUsPostd-Geocoder/1.0' } });
              const d = await r.json();
              if (d?.[0]) await Brand.updateOne({ _id: brandId }, { coordinates: { type: 'Point', coordinates: [parseFloat(d[0].lon), parseFloat(d[0].lat)] } });
            } catch(_){}
          };
          geocodeCity(brand._id, item.city).catch(() => {});
        }

        // Apply platform reward if requested
        if (applyRewards) {
          await Reward.create({
            brandId: brand._id,
            type: 'points_store_credit',
            earningMethod: 'point_based',
            title: 'KUP Rewards',
            description: 'Earn points by submitting content. Unlock wallet credits automatically!',
            status: 'active',
            pointConfig: {
              contentEnabled: true,
              contentPoints: { submitted: 10, approved: 25, published: 40, bonus: 15 },
              purchaseEnabled: false,
              gratitudeEnabled: true,
              gratitudePoints: { join: 50, birthday: 25, anniversary: 100 },
              unlockThreshold: 1750,
              levels: [
                { threshold: 500, rewardType: 'wallet_credit', rewardValue: '5', description: '$5 wallet credit' },
                { threshold: 1000, rewardType: 'wallet_credit', rewardValue: '7', description: '$7 wallet credit' },
                { threshold: 1750, rewardType: 'wallet_credit', rewardValue: '8', description: '$8 wallet credit' },
              ],
            },
            createdBy: 'platform',
          });
        }

        results.created++;
        results.brands.push({ name: brand.name, id: brand._id, code: kioskBrandCode });
      } catch (itemErr) {
        results.errors.push({ name: item.name, reason: itemErr.message });
      }
    }

    console.log(`📦 Bulk create: ${results.created} created, ${results.skipped} skipped, ${results.errors.length} errors`);
    res.json(results);
  } catch (error) {
    console.error('Bulk brand create error:', error.message);
    res.status(500).json({ error: 'Bulk creation failed' });
  }
});

// ═══════════════════════════════════════════════════════════
// PLATFORM REWARDS — Auto-distributed wallet credits for admin brands
// ═══════════════════════════════════════════════════════════

// POST /api/admin-panel/platform-rewards/apply — Create platform reward on admin brands
// Applies a standard 3-level wallet credit reward to all unclaimed admin brands (or specific brandId)
router.post('/platform-rewards/apply', async (req, res) => {
  try {
    const { brandId } = req.body; // optional — if omitted, applies to ALL admin brands

    const filter = { brandType: 'admin', claimStatus: 'unclaimed' };
    if (brandId) filter._id = brandId;

    const adminBrands = await Brand.find(filter, '_id name').lean();
    if (adminBrands.length === 0) {
      return res.json({ message: 'No admin brands found', created: 0 });
    }

    let created = 0;
    let skipped = 0;

    for (const brand of adminBrands) {
      // Skip if brand already has an active point-based reward
      const existing = await Reward.findOne({ brandId: brand._id, earningMethod: 'point_based', status: 'active' });
      if (existing) { skipped++; continue; }

      await Reward.create({
        brandId: brand._id,
        type: 'points_store_credit',
        earningMethod: 'point_based',
        title: 'KUP Rewards',
        description: 'Earn points by submitting content. Unlock wallet credits automatically!',
        status: 'active',
        pointConfig: {
          contentEnabled: true,
          contentPoints: { submitted: 10, approved: 25, published: 40, bonus: 15 },
          purchaseEnabled: false,
          gratitudeEnabled: true,
          gratitudePoints: { join: 50, birthday: 25, anniversary: 100 },
          unlockThreshold: 1750,
          levels: [
            { threshold: 500, rewardType: 'wallet_credit', rewardValue: '5', description: '$5 wallet credit' },
            { threshold: 1000, rewardType: 'wallet_credit', rewardValue: '7', description: '$7 wallet credit' },
            { threshold: 1750, rewardType: 'wallet_credit', rewardValue: '8', description: '$8 wallet credit' },
          ],
        },
        createdBy: 'platform',
      });
      created++;
      console.log(`✅ Platform reward created for "${brand.name}"`);
    }

    res.json({ message: `Platform rewards applied`, created, skipped, total: adminBrands.length });
  } catch (error) {
    console.error('Platform rewards error:', error.message);
    res.status(500).json({ error: 'Could not apply platform rewards' });
  }
});

// ═══════════════════════════════════════════════════════════
// REWARD BANNERS — Update level images per brand or all admin brands
// ═══════════════════════════════════════════════════════════

// PUT /api/admin-panel/reward-banners — Update reward level images
router.put('/reward-banners', async (req, res) => {
  try {
    const { brandId, levelImages, applyToAll } = req.body;

    if (!levelImages || !Array.isArray(levelImages)) {
      return res.status(400).json({ error: 'levelImages array required' });
    }

    const filter = applyToAll
      ? { status: 'active', earningMethod: 'point_based' }
      : { brandId, status: 'active', earningMethod: 'point_based' };

    const rewards = await Reward.find(filter);
    let updated = 0;

    for (const reward of rewards) {
      let changed = false;
      if (reward.pointConfig && reward.pointConfig.levels) {
        for (let i = 0; i < levelImages.length && i < reward.pointConfig.levels.length; i++) {
          if (levelImages[i]) {
            reward.pointConfig.levels[i].imageUrl = levelImages[i];
            changed = true;
          }
        }
      }
      if (levelImages[0]) {
        reward.bannerImageUrl = levelImages[0];
        changed = true;
      }
      if (changed) {
        reward.markModified('pointConfig');
        await reward.save();
        updated++;
      }
    }

    console.log(`🖼️ Reward banners updated: ${updated} rewards${applyToAll ? ' (all admin brands)' : ''}`);
    res.json({ success: true, updated });
  } catch (error) {
    console.error('Reward banners error:', error.message);
    res.status(500).json({ error: 'Could not update reward banners' });
  }
});

// ═══════════════════════════════════════════════════════════
// PROMO CODES
// ═══════════════════════════════════════════════════════════

// POST /api/admin-panel/promo-codes — Create a promo code
router.post('/promo-codes', async (req, res) => {
  try {
    const { code, type, percentOff, appliesTo, durationMonths, maxUses, expiresAt, notes } = req.body;
    if (!code || !type) return res.status(400).json({ error: 'code and type are required' });

    const promo = await PromoCode.create({
      code: code.toUpperCase().replace(/\s/g, ''),
      type,
      percentOff: type === 'percent_off' ? (percentOff || 50) : 100,
      appliesTo: appliesTo || 'all',
      durationMonths: type === 'free' ? null : (durationMonths || null),
      maxUses: maxUses || null,
      expiresAt: expiresAt || null,
      notes,
      createdBy: req.user?.email || 'admin',
    });

    res.status(201).json({ promo });
  } catch (error) {
    if (error.code === 11000) return res.status(409).json({ error: 'Promo code already exists' });
    res.status(500).json({ error: 'Could not create promo code' });
  }
});

// GET /api/admin-panel/promo-codes — List all promo codes
router.get('/promo-codes', async (req, res) => {
  try {
    const promos = await PromoCode.find().sort({ createdAt: -1 }).lean();
    res.json({ promos });
  } catch (error) {
    res.status(500).json({ error: 'Could not fetch promo codes' });
  }
});

// PUT /api/admin-panel/promo-codes/:id — Update promo code (activate/deactivate)
router.put('/promo-codes/:id', async (req, res) => {
  try {
    const update = {};
    if (req.body.isActive !== undefined) update.isActive = req.body.isActive;
    if (req.body.maxUses !== undefined) update.maxUses = req.body.maxUses;
    if (req.body.notes !== undefined) update.notes = req.body.notes;
    const promo = await PromoCode.findByIdAndUpdate(req.params.id, update, { new: true });
    if (!promo) return res.status(404).json({ error: 'Promo code not found' });
    res.json({ promo });
  } catch (error) {
    res.status(500).json({ error: 'Could not update promo code' });
  }
});

// ══════════════════════════════════════════════════════════════════════
// PROMOTIONS — Admin sends promo offers to individual influencers
// ══════════════════════════════════════════════════════════════════════

const Promotion = require('../models/Promotion');

// POST /api/admin-panel/promotions — Create and send a promo offer
router.post('/promotions', async (req, res) => {
  try {
    const { influencerUserId, influencerHandle, brandId, brandName, amount, description, videoDuration, dos, donts, paypalReminder } = req.body;

    if (!influencerUserId || !brandId || !amount || !dos) {
      return res.status(400).json({ error: 'influencerUserId, brandId, amount, and dos are required' });
    }

    const influencer = await User.findById(influencerUserId);
    if (!influencer) return res.status(404).json({ error: 'Influencer not found' });

    const brand = await Brand.findById(brandId);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    const promo = await Promotion.create({
      influencerUserId,
      influencerHandle: influencerHandle || 'influencer',
      brandId,
      brandName: brandName || brand.name,
      amount,
      videoDuration: videoDuration || null,
      dos: dos || null,
      donts: donts || null,
      paypalReminder: paypalReminder !== false,
      description: description || null,
    });

    // Send push + in-app notification as a briefing
    // KUP is always the issuer of promos (like Uber surge pay on top of the ride fare)
    // — always show KUP branding, never the target brand's logo/color
    const KUP_LOGO_URL = 'https://keepuspostd.com/images/favicon/apple-touch-icon.png';
    const KUP_BRAND_COLOR = '#2EA5DD';

    // Short push body — just the hook (push notifications truncate at ~110 chars)
    const pushBody = `New ${brand.name} brief inside — earn $${amount} on approval. Tap to view.`;

    // Full in-app message — structured brief with all sections
    const sections = [];
    sections.push(`💰 Earn $${amount} for ${brand.name}`);
    if (videoDuration) sections.push(`⏱ Duration: ${videoDuration}`);
    if (dos) sections.push(`✅ Do: ${dos}`);
    if (donts) sections.push(`🚫 Don't: ${donts}`);
    if (description) sections.push(description);
    if (paypalReminder !== false) sections.push(`Before submitting, connect your PayPal in Profile → Payouts so we can pay you on approval.`);
    const inAppMessage = sections.join('\n\n');

    try {
      const { createInApp } = require('../services/notifications');
      await createInApp({
        userId: influencerUserId,
        title: `KeepUsPostd Bonus Opportunity`,
        message: inAppMessage,
        type: 'briefing',
        link: `/brands/${brandId}`,
        metadata: {
          brandName: 'KeepUsPostd',
          brandLogoUrl: KUP_LOGO_URL,
          brandColor: KUP_BRAND_COLOR,
          targetBrandName: brand.name,
          targetBrandId: brandId.toString(),
          promoId: promo._id.toString(),
          amount,
        },
        audience: 'influencer',
      });
      const pushResult = await sendPushToUser(influencerUserId, {
        title: `KeepUsPostd: Earn $${amount}`,
        body: pushBody,
        data: { type: 'briefing', brandId: brandId.toString(), promoId: promo._id.toString() },
      });
      if (!pushResult.success) {
        console.warn(`⚠️ Promo push not delivered to @${influencerHandle}: ${pushResult.reason} (tokens: ${pushResult.total ?? 0})`);
      }
    } catch (notifyErr) {
      console.error('Promo notification failed:', notifyErr.message);
    }

    console.log(`📣 Promo sent: $${amount} to @${influencerHandle} for ${brand.name}`);
    res.status(201).json({ success: true, promo });
  } catch (error) {
    console.error('Create promotion error:', error);
    res.status(500).json({ error: 'Failed to create promotion' });
  }
});

// GET /api/admin-panel/promotions — List all promotions with status
router.get('/promotions', async (req, res) => {
  try {
    const promos = await Promotion.find().sort({ createdAt: -1 }).lean();

    // Attach PayPal email + account email for each influencer
    for (const promo of promos) {
      const profile = await InfluencerProfile.findOne({ userId: promo.influencerUserId }, { paypalEmail: 1 }).lean();
      const user = await User.findById(promo.influencerUserId, { email: 1 }).lean();
      promo.paypalEmail = profile?.paypalEmail || null;
      promo.accountEmail = user?.email || null;
    }

    // Check if influencer submitted content for each promo
    for (const promo of promos) {
      if (promo.status === 'sent') {
        const submission = await ContentSubmission.findOne({
          brandId: promo.brandId,
          influencerProfileId: { $exists: true },
          status: { $in: ['submitted', 'approved', 'postd'] },
          createdAt: { $gte: promo.createdAt },
        }).populate('influencerProfileId', 'userId').lean();

        if (submission && String(submission.influencerProfileId?.userId) === String(promo.influencerUserId)) {
          promo.status = 'content_submitted';
          promo.contentSubmissionId = submission._id;
          await Promotion.findByIdAndUpdate(promo._id, {
            status: 'content_submitted',
            contentSubmissionId: submission._id,
          });
        }
      }
    }

    res.json({ promotions: promos });
  } catch (error) {
    console.error('List promotions error:', error);
    res.status(500).json({ error: 'Failed to list promotions' });
  }
});

// PUT /api/admin-panel/promotions/:id/mark-paid — Mark a promo as paid
router.put('/promotions/:id/mark-paid', async (req, res) => {
  try {
    const { paypalTransactionId } = req.body;
    const promo = await Promotion.findByIdAndUpdate(req.params.id, {
      status: 'paid',
      paidAt: new Date(),
      paypalTransactionId: paypalTransactionId || null,
    }, { new: true });

    if (!promo) return res.status(404).json({ error: 'Promotion not found' });

    // Notify influencer that payment has been sent
    try {
      const { createInApp } = require('../services/notifications');
      await createInApp({
        userId: promo.influencerUserId,
        title: `Payment Sent — $${promo.amount}`,
        message: `KeepUsPostd has sent $${promo.amount} to your PayPal for your ${promo.brandName} promotion.`,
        type: 'payment',
        metadata: {
          brandName: promo.brandName,
          amount: promo.amount,
        },
        audience: 'influencer',
      });
      await sendPushToUser(promo.influencerUserId, {
        title: `$${promo.amount} Sent to Your PayPal`,
        body: `Payment for your ${promo.brandName} promotion has been sent.`,
        data: { type: 'payment' },
      });

      // Also send email
      try {
        const influencer = await User.findById(promo.influencerUserId);
        if (influencer) {
          await sendEmail({
            to: influencer.email,
            subject: `Payment Sent — $${promo.amount} for ${promo.brandName}`,
            headline: `$${promo.amount} is on its way`,
            variant: 'brand',
            bodyHtml: `
              <p>KeepUsPostd has sent <strong>$${promo.amount}</strong> to your PayPal for your <strong>${promo.brandName}</strong> promotion.</p>
              <p>Check your PayPal account — the payment should arrive within minutes.</p>
            `,
          });
        }
      } catch (_) {}
    } catch (notifyErr) {
      console.error('Payment notification failed:', notifyErr.message);
    }

    res.json({ success: true, promo });
  } catch (error) {
    console.error('Mark paid error:', error);
    res.status(500).json({ error: 'Failed to mark as paid' });
  }
});

module.exports = router;
