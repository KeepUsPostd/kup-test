// KUP Admin Panel API — Phase 1 (Launch-Critical)
// Modules: Dashboard KPIs, User Management, Content Moderation, Reviews, Financials, Messages
// Protected by requireAuth + requireAdmin (email-based for now)

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const {
  User, Brand, Campaign, ContentSubmission, Transaction,
  InfluencerProfile, BrandProfile, Subscription, Partnership,
  GuestReviewer, Notification, Reward, Withdrawal,
} = require('../models');

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

    res.json({ message: `Content ${action}ed`, submission: { id: submission._id, status: submission.status } });
  } catch (error) {
    res.status(500).json({ error: 'Failed to moderate content' });
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

module.exports = router;
