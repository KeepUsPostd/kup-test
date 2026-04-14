// Reward Routes — Full CRUD with platform rule enforcement
// Enforces: R1 (one earning method), R4 (tier-based cash), R5 (cash multi-select),
//           R6 (non-cash exclusive per reward)
// Ref: PLATFORM_ARCHITECTURE.md → Reward System Rules
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { Reward, InfluencerProfile, BrandProfile, Transaction, ContentSubmission, PurchasePointsLog } = require('../models');
const notify = require('../services/notifications');

// Cash reward types (rule R5: these allow multi-select per brand)
const CASH_TYPES = ['cash_per_approval', 'bonus_cash', 'postd_pay'];

// Non-cash types (rule R6: exclusive per reward — different fulfillment)
const NON_CASH_TYPES = ['points_store_credit', 'free_product', 'discount'];

// POST /api/rewards — Create a new reward
router.post('/', requireAuth, async (req, res) => {
  try {
    const { brandId, type, earningMethod, title, description,
            pointConfig, cashConfig, discountConfig, productConfig,
            imageUrl, bannerImageUrl } = req.body;

    if (!brandId) {
      return res.status(400).json({ error: 'brandId is required' });
    }
    if (!type) {
      return res.status(400).json({ error: 'Reward type is required' });
    }
    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Reward title is required' });
    }
    if (title.length > 21) {
      return res.status(400).json({ error: 'Title must be 21 characters or less' });
    }

    // Rule R1: Non-cash rewards MUST have an earning method
    if (NON_CASH_TYPES.includes(type) && !earningMethod) {
      return res.status(400).json({
        error: 'Earning method required',
        message: 'Non-cash rewards must specify an earning method: "point_based" or "per_approval".',
      });
    }

    // Cash rewards should NOT have an earning method
    if (CASH_TYPES.includes(type) && earningMethod) {
      return res.status(400).json({
        error: 'Cash rewards don\'t use earning methods',
        message: 'Cash reward rates are tier-based. Remove the earningMethod field.',
      });
    }

    // Rule R1 validation: If point_based, validate point config
    if (earningMethod === 'point_based') {
      if (!pointConfig) {
        return res.status(400).json({
          error: 'Point configuration required',
          message: 'Point-based rewards need a pointConfig with at least one enabled category.',
        });
      }

      // At least one point category must be enabled
      const hasCategory = pointConfig.contentEnabled ||
                          pointConfig.purchaseEnabled ||
                          pointConfig.gratitudeEnabled;
      if (!hasCategory) {
        return res.status(400).json({
          error: 'Enable at least one point category',
          message: 'Enable Content Points, Purchase Points, or Gratitude Points.',
        });
      }

      // Unlock threshold must be > 0
      if (!pointConfig.unlockThreshold || pointConfig.unlockThreshold <= 0) {
        return res.status(400).json({
          error: 'Unlock threshold required',
          message: 'Set a point unlock threshold greater than 0.',
        });
      }

      // Max 3 purchase tiers
      if (pointConfig.purchaseEnabled && pointConfig.purchaseTiers &&
          pointConfig.purchaseTiers.length > 3) {
        return res.status(400).json({
          error: 'Maximum 3 purchase tiers',
          message: 'You can have up to 3 purchase point tiers.',
        });
      }
    }

    const reward = await Reward.create({
      brandId,
      type,
      earningMethod: CASH_TYPES.includes(type) ? null : earningMethod,
      title: title.trim(),
      description: description || null,
      imageUrl: imageUrl || null,
      bannerImageUrl: bannerImageUrl || null,
      pointConfig: earningMethod === 'point_based' ? pointConfig : undefined,
      cashConfig: CASH_TYPES.includes(type) ? (cashConfig || {}) : undefined,
      discountConfig: type === 'discount' ? (discountConfig || {}) : undefined,
      productConfig: type === 'free_product' ? (productConfig || {}) : undefined,
      status: req.body.status === 'active' ? 'active' : 'draft',
      createdBy: req.user._id,
    });

    console.log(`✅ Reward created: "${reward.title}" (${reward.type}) status=${reward.status} for brand ${brandId}`);

    res.status(201).json({
      message: reward.status === 'active' ? 'Reward created and active' : 'Reward created as draft',
      reward,
    });
  } catch (error) {
    console.error('Create reward error:', error.message);
    res.status(500).json({ error: 'Could not create reward' });
  }
});

// GET /api/rewards?brandId=xxx — List rewards for a brand
// Optional filters: ?status=active&type=points_store_credit
router.get('/', requireAuth, async (req, res) => {
  try {
    const { brandId, status, type } = req.query;

    if (!brandId) {
      return res.status(400).json({ error: 'brandId query parameter is required' });
    }

    const filter = { brandId };
    if (status) filter.status = status;
    if (type) filter.type = type;

    const rewards = await Reward.find(filter)
      .sort({ createdAt: -1 })
      .limit(50);

    // Gather stats
    const stats = {
      total: rewards.length,
      active: rewards.filter(r => r.status === 'active').length,
      draft: rewards.filter(r => r.status === 'draft').length,
      cashRewards: rewards.filter(r => CASH_TYPES.includes(r.type)).length,
      nonCashRewards: rewards.filter(r => NON_CASH_TYPES.includes(r.type)).length,
    };

    res.json({ rewards, stats });
  } catch (error) {
    console.error('List rewards error:', error.message);
    res.status(500).json({ error: 'Could not fetch rewards' });
  }
});

// GET /api/rewards/my-progress — MUST be before /:rewardId or Express matches "my-progress" as an ObjectId
// Influencer-facing — returns point balance per reward for the current user's brand partnership
router.get('/my-progress', requireAuth, async (req, res) => {
  try {
    const { brandId } = req.query;
    if (!brandId) return res.status(400).json({ error: 'brandId required' });

    const profile = await InfluencerProfile.findOne({ userId: req.user._id }).lean();
    if (!profile) return res.json({ rewards: [], points: {} });

    const rewards = await Reward.find({ brandId, status: 'active' }).lean();

    const [submitted, approved, postd] = await Promise.all([
      ContentSubmission.countDocuments({ brandId, influencerProfileId: profile._id }),
      ContentSubmission.countDocuments({ brandId, influencerProfileId: profile._id, status: 'approved' }),
      ContentSubmission.countDocuments({ brandId, influencerProfileId: profile._id, status: 'postd' }),
    ]);

    let purchasePoints = 0;
    let purchaseCount = 0;
    try {
      const purchaseAgg = await PurchasePointsLog.aggregate([
        { $match: { brandId: require('mongoose').Types.ObjectId.createFromHexString(brandId), influencerProfileId: profile._id } },
        { $group: { _id: null, totalPoints: { $sum: '$pointsAwarded' }, count: { $sum: 1 } } },
      ]);
      purchasePoints = purchaseAgg[0]?.totalPoints ?? 0;
      purchaseCount = purchaseAgg[0]?.count ?? 0;
    } catch (aggErr) {
      console.warn('[my-progress] Purchase aggregate error:', aggErr.message);
    }

    // Get partnership for claimed level tracking + reset baseline
    const { Partnership } = require('../models');
    const partnership = await Partnership.findOne({ brandId, influencerProfileId: profile._id, status: 'active' }).lean();
    const claimedLevels = partnership?.claimedLevels || [];

    // Subtract reset baseline if points were reset after a full cycle
    const baseline = partnership?.pointsResetSubmissionBaseline || {};
    const adjSubmitted = submitted - (baseline.total || 0);
    const adjApproved = approved - (baseline.approved || 0);
    const adjPostd = postd - (baseline.postd || 0);

    const progress = rewards.map(reward => {
      const pc = reward.pointConfig || {};
      let contentPts = 0;
      if (pc.contentEnabled) {
        const pts = pc.contentPoints || {};
        contentPts = (pts.submitted || 10) * adjSubmitted + (pts.approved || 25) * adjApproved + (pts.published || 40) * adjPostd + (pts.bonus || 0) * adjPostd;
      }
      const purchasePts = pc.purchaseEnabled ? Math.max(0, purchasePoints - (baseline.purchasePoints || 0)) : 0;
      const giftPts = (partnership?.giftedPoints || 0) + (partnership?.gratitudePoints || 0);
      const totalPts = contentPts + purchasePts + giftPts;

      // Build levels progress (new 3-level system)
      const levels = (pc.levels && pc.levels.length > 0)
        ? pc.levels.map((lvl, idx) => ({
            level: idx + 1,
            threshold: lvl.threshold,
            rewardType: lvl.rewardType,
            rewardValue: lvl.rewardValue,
            description: lvl.description,
            unlocked: totalPts >= lvl.threshold,
            claimed: claimedLevels.includes(idx),
          }))
        : null;

      // Fallback to legacy single threshold if no levels defined
      const threshold = levels
        ? (levels.find(l => !l.unlocked)?.threshold || levels[levels.length - 1]?.threshold || 300)
        : (pc.unlockThreshold || 300);
      const percent = Math.min(Math.round((totalPts / threshold) * 100), 100);

      return {
        rewardId: reward._id, title: reward.title, type: reward.type,
        earningMethod: reward.earningMethod, totalPoints: totalPts,
        unlockThreshold: threshold, percentComplete: percent,
        unlocked: totalPts >= threshold,
        levels: levels,
        breakdown: {
          content: { points: contentPts, submitted, approved, postd },
          purchase: { points: purchasePts, transactions: purchaseCount },
        },
      };
    });

    res.json({ rewards: progress });
  } catch (error) {
    console.error('My progress error:', error.message);
    res.status(500).json({ error: 'Could not load progress' });
  }
});

// GET /api/rewards/brand-progress?brandId=xxx — Brand-side: all influencer progress across rewards
// Used by web dashboard Cash & Rewards → Rewards tab
router.get('/brand-progress', requireAuth, async (req, res) => {
  try {
    const { brandId } = req.query;
    if (!brandId) return res.status(400).json({ error: 'brandId required' });

    // Get active point-based rewards
    const rewards = await Reward.find({ brandId, status: 'active', earningMethod: 'point_based' }).lean();

    // Get all active partnerships for this brand
    const { Partnership } = require('../models');
    const partnerships = await Partnership.find({ brandId, status: 'active' })
      .populate('influencerProfileId', 'displayName handle avatarUrl influenceTier')
      .sort({ createdAt: -1 })
      .lean();

    // For each partnership, calculate point progress
    const influencerProgress = [];
    for (const p of partnerships) {
      const inf = p.influencerProfileId;
      if (!inf) continue;

      const [submitted, approved, postd, purchaseAgg] = await Promise.all([
        ContentSubmission.countDocuments({ brandId, influencerProfileId: inf._id }),
        ContentSubmission.countDocuments({ brandId, influencerProfileId: inf._id, status: 'approved' }),
        ContentSubmission.countDocuments({ brandId, influencerProfileId: inf._id, status: 'postd' }),
        PurchasePointsLog.aggregate([
          { $match: { brandId: require('mongoose').Types.ObjectId.createFromHexString(brandId), influencerProfileId: inf._id } },
          { $group: { _id: null, totalPoints: { $sum: '$pointsAwarded' }, count: { $sum: 1 } } },
        ]).catch(() => []),
      ]);

      const purchasePoints = purchaseAgg[0]?.totalPoints ?? 0;
      const claimedLevels = p.claimedLevels || [];
      // Subtract reset baseline
      const bl = p.pointsResetSubmissionBaseline || {};
      const adjSub = submitted - (bl.total || 0);
      const adjApp = approved - (bl.approved || 0);
      const adjPost = postd - (bl.postd || 0);
      const rewardProgress = rewards.map(reward => {
        const pc = reward.pointConfig || {};
        const pts = pc.contentPoints || {};
        const contentPts = pc.contentEnabled
          ? (pts.submitted || 0) * adjSub + (pts.approved || 0) * adjApp + (pts.published || 0) * adjPost + (pts.bonus || 0) * adjPost
          : 0;
        const purchasePts = pc.purchaseEnabled ? Math.max(0, purchasePoints - (bl.purchasePoints || 0)) : 0;
        const giftPts = (p.giftedPoints || 0) + (p.gratitudePoints || 0);
        const totalPts = contentPts + purchasePts + giftPts;

        // Build levels progress
        const levels = (pc.levels && pc.levels.length > 0)
          ? pc.levels.map((lvl, idx) => ({
              level: idx + 1,
              threshold: lvl.threshold,
              rewardType: lvl.rewardType,
              rewardValue: lvl.rewardValue,
              unlocked: totalPts >= lvl.threshold,
              claimed: claimedLevels.includes(idx),
            }))
          : null;

        const threshold = levels
          ? (levels.find(l => !l.unlocked)?.threshold || levels[levels.length - 1]?.threshold || 300)
          : (pc.unlockThreshold || 300);
        const percent = Math.min(Math.round((totalPts / threshold) * 100), 100);

        return {
          rewardId: reward._id,
          rewardTitle: reward.title,
          rewardType: reward.type,
          totalPoints: totalPts,
          unlockThreshold: threshold,
          percentComplete: percent,
          unlocked: totalPts >= threshold,
          levels: levels,
        };
      });

      influencerProgress.push({
        influencer: {
          _id: inf._id,
          displayName: inf.displayName,
          handle: inf.handle,
          avatarUrl: inf.avatarUrl,
          influenceTier: inf.influenceTier,
        },
        partnershipId: p._id,
        submitted,
        approved,
        postd,
        rewards: rewardProgress,
      });
    }

    // Sort by highest total points first (most active influencers at top)
    influencerProgress.sort((a, b) => {
      const aMax = Math.max(...(a.rewards || []).map(r => r.totalPoints || 0), 0);
      const bMax = Math.max(...(b.rewards || []).map(r => r.totalPoints || 0), 0);
      return bMax - aMax;
    });

    res.json({ influencers: influencerProgress, rewards });
  } catch (error) {
    console.error('Brand progress error:', error.message);
    res.status(500).json({ error: 'Could not load brand progress' });
  }
});

// GET /api/rewards/distribution-history — MUST be before /:rewardId or Express matches it as an ObjectId
router.get('/distribution-history', requireAuth, async (req, res) => {
  try {
    const { brandId } = req.query;
    if (!brandId) return res.status(400).json({ error: 'brandId is required' });

    const { Partnership } = require('../models');
    const partnerships = await Partnership.find({
      brandId,
      'distributions.0': { $exists: true },
    }, 'distributions influencerProfileId')
      .populate('influencerProfileId', 'displayName handle avatarUrl')
      .sort({ 'distributions.distributedAt': -1 })
      .lean();

    const history = [];
    for (const p of partnerships) {
      const inf = p.influencerProfileId || {};
      for (const d of (p.distributions || [])) {
        history.push({
          ...d,
          influencerName: d.influencerName || inf.displayName || '',
          influencerHandle: d.influencerHandle || inf.handle || '',
          influencerAvatar: inf.avatarUrl || '',
          partnershipId: p._id,
        });
      }
    }
    history.sort((a, b) => new Date(b.distributedAt) - new Date(a.distributedAt));
    res.json({ distributions: history, total: history.length });
  } catch (error) {
    console.error('Distribution history error:', error.message);
    res.status(500).json({ error: 'Could not fetch distribution history' });
  }
});

// GET /api/rewards/:rewardId — Get single reward
router.get('/:rewardId', requireAuth, async (req, res) => {
  try {
    const reward = await Reward.findById(req.params.rewardId);

    if (!reward) {
      return res.status(404).json({ error: 'Reward not found' });
    }

    res.json({ reward });
  } catch (error) {
    console.error('Get reward error:', error.message);
    res.status(500).json({ error: 'Could not fetch reward' });
  }
});

// PUT /api/rewards/:rewardId — Update reward
router.put('/:rewardId', requireAuth, async (req, res) => {
  try {
    const reward = await Reward.findById(req.params.rewardId);

    if (!reward) {
      return res.status(404).json({ error: 'Reward not found' });
    }

    if (reward.status === 'ended') {
      return res.status(400).json({
        error: 'Cannot edit ended reward',
        message: 'Ended rewards cannot be modified. Create a new reward instead.',
      });
    }

    const allowedFields = ['title', 'description', 'imageUrl', 'bannerImageUrl',
      'pointConfig', 'cashConfig', 'discountConfig', 'productConfig',
      'status'];

    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    if (updates.title && updates.title.length > 21) {
      return res.status(400).json({ error: 'Title must be 21 characters or less' });
    }

    const updated = await Reward.findByIdAndUpdate(
      req.params.rewardId,
      { $set: updates },
      { new: true, runValidators: true }
    );

    res.json({ message: 'Reward updated', reward: updated });
  } catch (error) {
    console.error('Update reward error:', error.message);
    res.status(500).json({ error: 'Could not update reward' });
  }
});

// PUT /api/rewards/:rewardId/status — Change reward status
router.put('/:rewardId/status', requireAuth, async (req, res) => {
  try {
    const { status: newStatus } = req.body;
    const reward = await Reward.findById(req.params.rewardId);

    if (!reward) {
      return res.status(404).json({ error: 'Reward not found' });
    }

    const validStatuses = ['active', 'draft', 'paused', 'ended'];
    if (!validStatuses.includes(newStatus)) {
      return res.status(400).json({
        error: 'Invalid status',
        message: `Status must be one of: ${validStatuses.join(', ')}`,
      });
    }

    // Can't reactivate an ended reward
    if (reward.status === 'ended' && newStatus !== 'ended') {
      return res.status(400).json({
        error: 'Cannot reactivate ended reward',
        message: 'Ended rewards are permanent. Create a new reward instead.',
      });
    }

    reward.status = newStatus;
    await reward.save();

    console.log(`🎁 Reward "${reward.title}" → ${newStatus}`);

    res.json({ message: `Reward ${newStatus}`, reward });
  } catch (error) {
    console.error('Reward status error:', error.message);
    res.status(500).json({ error: 'Could not update reward status' });
  }
});

// DELETE /api/rewards/:rewardId — Delete reward (draft only)
router.delete('/:rewardId', requireAuth, async (req, res) => {
  try {
    const reward = await Reward.findById(req.params.rewardId);

    if (!reward) {
      return res.status(404).json({ error: 'Reward not found' });
    }

    if (reward.status !== 'draft') {
      return res.status(400).json({
        error: 'Cannot delete non-draft reward',
        message: `This reward is "${reward.status}". Only draft rewards can be deleted.`,
      });
    }

    await Reward.findByIdAndDelete(req.params.rewardId);

    console.log(`🗑️ Reward deleted: "${reward.title}"`);

    res.json({ message: 'Draft reward deleted' });
  } catch (error) {
    console.error('Delete reward error:', error.message);
    res.status(500).json({ error: 'Could not delete reward' });
  }
});

// POST /api/rewards/distribute — Distribute a reward to one or more influencers
// Called by distribute-reward.html when a brand sends a reward to a partner
router.post('/distribute', requireAuth, async (req, res) => {
  try {
    const { brandId, influencerId, influencerProfileIds, rewardId } = req.body;

    if (!brandId) {
      return res.status(400).json({ error: 'brandId is required' });
    }
    if (!rewardId) {
      return res.status(400).json({ error: 'rewardId is required' });
    }

    // Support single influencerId (from distribute-reward.html) or bulk array
    const recipientIds = influencerProfileIds
      ? (Array.isArray(influencerProfileIds) ? influencerProfileIds : [influencerProfileIds])
      : (influencerId ? [influencerId] : []);

    if (recipientIds.length === 0) {
      return res.status(400).json({ error: 'influencerId or influencerProfileIds is required' });
    }

    // Verify the reward belongs to this brand
    const reward = await Reward.findById(rewardId);
    if (!reward) {
      return res.status(404).json({ error: 'Reward not found' });
    }
    if (String(reward.brandId) !== String(brandId)) {
      return res.status(403).json({ error: 'This reward does not belong to your brand' });
    }
    if (reward.status !== 'active') {
      return res.status(400).json({
        error: 'Reward is not active',
        message: `Reward status is "${reward.status}". Only active rewards can be distributed.`,
      });
    }

    // Verify brand profile belongs to the requesting user
    const brandProfile = await BrandProfile.findOne({ _id: brandId, userId: req.user._id });
    if (!brandProfile) {
      return res.status(403).json({ error: 'You do not own this brand' });
    }

    const results = [];
    const errors = [];

    for (const infId of recipientIds) {
      try {
        const influencer = await InfluencerProfile.findById(infId).populate('userId', 'email');
        if (!influencer) {
          errors.push({ influencerId: infId, error: 'Influencer not found' });
          continue;
        }

        // Build transaction record — only for cash rewards (free_product/points have $0 value)
        const isCash = CASH_TYPES.includes(reward.type);
        const cashAmount = isCash && reward.cashConfig
          ? (reward.cashConfig.amount || reward.cashConfig.rate || 0)
          : 0;

        // Only create a transaction record for cash-type rewards
        let transaction = null;
        if (isCash && cashAmount > 0) {
          transaction = await Transaction.create({
            payerType: 'brand',
            payerBrandId: brandId,
            payeeInfluencerId: infId,
            type: 'bonus_cash',
            rewardId: reward._id,
            amount: cashAmount,
            currency: 'USD',
            status: 'paid',
            paidAt: new Date(),
          });
        }

        // Fire notification (non-blocking)
        if (isCash && cashAmount > 0 && influencer.userId?.email) {
          notify.cashRewardEarned({
            influencer: { email: influencer.userId.email, name: influencer.influencerName },
            brand: { name: brandProfile.businessName || brandProfile.name },
            amount: cashAmount,
            type: reward.type,
          }).catch(err => console.error('[rewards/distribute] notify error:', err.message));
        }

        results.push({ influencerId: infId, transactionId: transaction?._id || null, status: 'success' });
        console.log(`✅ Reward "${reward.title}" distributed to influencer ${infId} by brand ${brandId}`);
      } catch (infErr) {
        console.error(`[rewards/distribute] Error for influencer ${infId}:`, infErr.message);
        errors.push({ influencerId: infId, error: infErr.message });
      }
    }

    const allFailed = results.length === 0 && errors.length > 0;
    if (allFailed) {
      return res.status(500).json({
        error: 'Distribution failed for all recipients',
        errors,
      });
    }

    res.json({
      message: `Reward distributed to ${results.length} influencer(s)`,
      distributed: results.length,
      failed: errors.length,
      results,
      errors: errors.length > 0 ? errors : undefined,
    });
  } catch (error) {
    console.error('Distribute reward error:', error.message);
    res.status(500).json({ error: 'Could not distribute reward' });
  }
});

// GET /api/rewards/my-progress?brandId=xxx
// Influencer-facing — returns point balance per reward for the current user's brand partnership
// POST /api/rewards/distribute-level — Distribute an unlocked reward level to an influencer
// Body: { partnershipId, rewardId, levelIndex, method, code, trackingNumber, notes }
// method: 'email' | 'instore' | 'mail'
router.post('/distribute-level', requireAuth, async (req, res) => {
  try {
    const { partnershipId, rewardId, levelIndex, method, code, trackingNumber, notes } = req.body;

    if (!partnershipId || rewardId === undefined || levelIndex === undefined) {
      return res.status(400).json({ error: 'partnershipId, rewardId, and levelIndex are required' });
    }
    if (!method || !['email', 'instore', 'mail'].includes(method)) {
      return res.status(400).json({ error: 'method must be email, instore, or mail' });
    }

    const { Partnership, Brand } = require('../models');
    const partnership = await Partnership.findById(partnershipId)
      .populate('influencerProfileId', 'displayName handle avatarUrl userId paypalEmail');
    if (!partnership) return res.status(404).json({ error: 'Partnership not found' });

    const reward = await Reward.findById(rewardId);
    if (!reward) return res.status(404).json({ error: 'Reward not found' });

    const levels = reward.pointConfig?.levels || [];
    if (levelIndex < 0 || levelIndex >= levels.length) {
      return res.status(400).json({ error: 'Invalid level index' });
    }

    const level = levels[levelIndex];
    const inf = partnership.influencerProfileId;
    const brand = await Brand.findById(partnership.brandId);

    // Mark level as claimed + log distribution
    if (!partnership.claimedLevels) partnership.claimedLevels = [];
    if (!partnership.claimedLevels.includes(levelIndex)) {
      partnership.claimedLevels.push(levelIndex);
    }
    if (!partnership.distributions) partnership.distributions = [];
    partnership.distributions.push({
      levelIndex,
      rewardValue: level.rewardValue,
      rewardType: level.rewardType,
      method,
      code: method === 'email' ? (code || null) : null,
      trackingNumber: method === 'mail' ? (trackingNumber || null) : null,
      notes: notes || null,
      influencerName: inf?.displayName || '',
      influencerHandle: inf?.handle || '',
      distributedAt: new Date(),
    });

    // Check if ALL levels are now claimed → reset points for a new cycle
    const allLevelsClaimed = levels.every((_, idx) => partnership.claimedLevels.includes(idx));
    if (allLevelsClaimed) {
      console.log(`🔄 All ${levels.length} levels claimed for ${inf?.displayName} — resetting points for new cycle`);
      partnership.claimedLevels = [];
      partnership.rewardPoints = 0;
      partnership.giftedPoints = 0;
      partnership.gratitudePoints = 0;
      // Reset submission counts by storing the current counts as a baseline
      // so the dynamic calculation starts fresh
      partnership.pointsResetAt = new Date();
      // Capture purchase points baseline too
      let purchaseBaseline = 0;
      try {
        const PurchasePointsLog = require('../models/PurchasePointsLog');
        const agg = await PurchasePointsLog.aggregate([
          { $match: { brandId: partnership.brandId, influencerProfileId: inf._id } },
          { $group: { _id: null, total: { $sum: '$pointsAwarded' } } },
        ]);
        purchaseBaseline = agg[0]?.total ?? 0;
      } catch (_) {}
      partnership.pointsResetSubmissionBaseline = {
        total: await ContentSubmission.countDocuments({ brandId: partnership.brandId, influencerProfileId: inf._id }),
        approved: await ContentSubmission.countDocuments({ brandId: partnership.brandId, influencerProfileId: inf._id, status: 'approved' }),
        postd: await ContentSubmission.countDocuments({ brandId: partnership.brandId, influencerProfileId: inf._id, status: 'postd' }),
        purchasePoints: purchaseBaseline,
      };
    }

    await partnership.save();

    // Notify influencer based on method
    const notify = require('../services/notifications');
    if (inf?.userId) {
      let msg = '';
      if (method === 'email') {
        msg = `Your reward "${level.rewardValue}" from ${brand?.name} is ready! Code: ${code || 'Check your email'}`;
      } else if (method === 'instore') {
        msg = `Your reward "${level.rewardValue}" from ${brand?.name} is ready for pickup! Show your Market Code QR at the store.`;
      } else if (method === 'mail') {
        msg = `Your reward "${level.rewardValue}" from ${brand?.name} has been shipped!${trackingNumber ? ' Tracking: ' + trackingNumber : ''}`;
      }

      // Create in-app notification directly (createInApp is internal to notifications.js)
      const Notification = require('../models/Notification');
      await Notification.create({
        userId: inf.userId,
        title: 'Reward Distributed!',
        message: msg,
        type: 'reward',
        metadata: {
          brandName: brand?.name || '',
          brandLogoUrl: brand?.logoUrl || brand?.avatarUrl || '',
          rewardValue: level.rewardValue,
          rewardType: level.rewardType,
          method,
          code: method === 'email' ? code : null,
          trackingNumber: method === 'mail' ? trackingNumber : null,
          isDistribution: true,
        },
      });
    }

    // Send email to influencer with reward details
    try {
      const User = require('../models/User');
      console.log('[distribute-level] Email step: inf.userId =', inf?.userId, '| method =', method, '| code =', code);
      const infUser = inf?.userId ? await User.findById(inf.userId, 'email') : null;
      console.log('[distribute-level] User email lookup:', infUser?.email || 'NOT FOUND');
      if (infUser?.email) {
        const { sendEmail } = require('../config/email');
        let bodyHtml = '';
        let subject = '';
        if (method === 'email' && code) {
          subject = `Your Reward from ${brand?.name} — ${level.rewardValue}`;
          bodyHtml = `
            <p><strong>${brand?.name}</strong> has sent you a reward for your partnership.</p>
            <p><strong>Reward:</strong> ${level.rewardValue}</p>
            <p><strong>Code:</strong> ${code}</p>
            <p>Use this code to redeem your reward.</p>
            ${notes ? `<p><strong>Note from ${brand?.name}:</strong> ${notes}</p>` : ''}
          `;
        } else if (method === 'instore') {
          subject = `Your Reward is Ready for Pickup — ${brand?.name}`;
          bodyHtml = `
            <p><strong>${brand?.name}</strong> has a reward ready for you.</p>
            <p><strong>Reward:</strong> ${level.rewardValue}</p>
            <p>Show your Market Code QR at the store to redeem.</p>
            ${notes ? `<p><strong>Note from ${brand?.name}:</strong> ${notes}</p>` : ''}
          `;
        } else if (method === 'mail') {
          subject = `Your Reward Has Been Shipped — ${brand?.name}`;
          bodyHtml = `
            <p><strong>${brand?.name}</strong> has shipped your reward.</p>
            <p><strong>Reward:</strong> ${level.rewardValue}</p>
            ${trackingNumber ? `<p><strong>Tracking:</strong> ${trackingNumber}</p>` : ''}
            ${notes ? `<p><strong>Note from ${brand?.name}:</strong> ${notes}</p>` : ''}
          `;
        }
        if (subject) {
          console.log('[distribute-level] Sending email to:', infUser.email, '| subject:', subject);
          const emailResult = await sendEmail({
            to: infUser.email,
            subject,
            headline: 'Reward Distributed',
            preheader: `${brand?.name} sent you a reward`,
            bodyHtml,
            ctaText: 'View Rewards',
            ctaUrl: `keepuspostd://rewards`,
            variant: 'brand',
          });
          console.log('[distribute-level] Email result:', JSON.stringify(emailResult));
        } else {
          console.log('[distribute-level] No subject generated — method:', method, '| code:', code, '| skipping email');
        }
      } else {
        console.log('[distribute-level] No user email found — skipping email');
      }
    } catch (emailErr) {
      console.error('[rewards/distribute-level] EMAIL ERROR:', emailErr.message, emailErr.stack?.substring(0, 200));
    }

    console.log(`🎁 Reward distributed: "${level.rewardValue}" to ${inf?.displayName} via ${method}`);
    res.json({ message: 'Reward distributed', level: level.rewardValue, method, claimedLevels: partnership.claimedLevels });
  } catch (error) {
    console.error('Distribute level error:', error.message);
    res.status(500).json({ error: 'Could not distribute reward' });
  }
});

module.exports = router;
