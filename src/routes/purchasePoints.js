// Purchase Points Routes
// Brands set 3 spend tiers → customers earn flat points by reaching each tier.
// Tier logic: highest tier the customer's spend meets or exceeds wins.
// No daily cap — every qualifying transaction awards points independently.
//
// Example config: [{minSpend:25,points:75},{minSpend:50,points:150},{minSpend:75,points:200}]
//   $30 spent → Level 1 → 75 pts
//   $55 spent → Level 2 → 150 pts
//   $80 spent → Level 3 → 200 pts (max, no stacking)
//   $15 spent → 0 pts (below floor)

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const {
  Brand, BrandProfile, InfluencerProfile,
  PurchasePointsConfig, PurchasePointsLog,
} = require('../models');

// ── Shared helper ─────────────────────────────────────────────────────────────
function calculatePoints(spendAmount, levels) {
  if (!levels || !levels.length) return { points: 0, levelIndex: 0 };
  const eligible = levels
    .map((l, i) => ({ minSpend: l.minSpend, points: l.points, levelIndex: i + 1 }))
    .filter(l => l.minSpend > 0 && l.points > 0)
    .sort((a, b) => b.minSpend - a.minSpend); // highest threshold first
  const match = eligible.find(l => spendAmount >= l.minSpend);
  return match
    ? { points: match.points, levelIndex: match.levelIndex }
    : { points: 0, levelIndex: 0 };
}

// ── GET /api/purchase-points/config?brandId= ──────────────────────────────────
// Returns the brand's current purchase points config (or default empty config)
router.get('/config', requireAuth, async (req, res) => {
  try {
    const { brandId } = req.query;
    if (!brandId) return res.status(400).json({ error: 'brandId is required' });

    let config = await PurchasePointsConfig.findOne({ brandId });
    if (!config) {
      // Return sensible defaults — brand hasn't configured yet
      return res.json({
        config: {
          brandId,
          inStore: {
            enabled: true,
            levels: [
              { minSpend: 25,  points: 75  },
              { minSpend: 50,  points: 150 },
              { minSpend: 100, points: 250 },
            ],
          },
          online: {
            enabled: false,
            levels: [
              { minSpend: 25,  points: 75  },
              { minSpend: 50,  points: 150 },
              { minSpend: 100, points: 250 },
            ],
          },
        },
        isNew: true,
      });
    }

    res.json({ config, isNew: false });
  } catch (err) {
    console.error('GET /purchase-points/config error:', err.message);
    res.status(500).json({ error: 'Could not load config' });
  }
});

// ── PUT /api/purchase-points/config ───────────────────────────────────────────
// Save / update brand's purchase points level config
router.put('/config', requireAuth, async (req, res) => {
  try {
    const { brandId, inStore, online } = req.body;
    if (!brandId) return res.status(400).json({ error: 'brandId is required' });

    // Verify requester owns the brand
    const brandProfile = await BrandProfile.findOne({ userId: req.user._id });
    if (!brandProfile || !brandProfile.ownedBrandIds.some(id => id.toString() === brandId)) {
      return res.status(403).json({ error: 'You do not own this brand' });
    }

    // Validate levels: max 3, minSpend and points must be positive numbers
    const validateLevels = (levels) => {
      if (!Array.isArray(levels) || levels.length > 3) return false;
      return levels.every(l =>
        typeof l.minSpend === 'number' && l.minSpend >= 0 &&
        typeof l.points === 'number' && l.points >= 1
      );
    };

    if (inStore && inStore.levels && !validateLevels(inStore.levels)) {
      return res.status(400).json({ error: 'In-store levels invalid. Max 3 levels, minSpend ≥ 0, points ≥ 1.' });
    }
    if (online && online.levels && !validateLevels(online.levels)) {
      return res.status(400).json({ error: 'Online levels invalid. Max 3 levels, minSpend ≥ 0, points ≥ 1.' });
    }

    // Sort levels ascending by minSpend before saving (clean data)
    const sortLevels = (levels) =>
      [...levels].sort((a, b) => a.minSpend - b.minSpend);

    const update = {};
    if (inStore !== undefined) {
      update.inStore = {
        enabled: inStore.enabled !== false,
        levels: sortLevels(inStore.levels || []),
      };
    }
    if (online !== undefined) {
      update.online = {
        enabled: online.enabled === true,
        levels: sortLevels(online.levels || []),
      };
    }

    const config = await PurchasePointsConfig.findOneAndUpdate(
      { brandId },
      { $set: update },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    console.log(`✅ Purchase points config saved for brand ${brandId}`);
    res.json({ message: 'Purchase points config saved', config });
  } catch (err) {
    console.error('PUT /purchase-points/config error:', err.message);
    res.status(500).json({ error: 'Could not save config' });
  }
});

// ── GET /api/purchase-points/stats?brandId= ───────────────────────────────────
// Real aggregated stats for the brand's purchase points dashboard
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const { brandId } = req.query;
    if (!brandId) return res.status(400).json({ error: 'brandId is required' });

    const [totalAgg, inStoreAgg, onlineAgg, recentAwards] = await Promise.all([
      // Total points ever awarded by this brand
      PurchasePointsLog.aggregate([
        { $match: { brandId: require('mongoose').Types.ObjectId.createFromHexString(brandId) } },
        { $group: { _id: null, totalPoints: { $sum: '$pointsAwarded' }, totalTransactions: { $sum: 1 } } },
      ]),
      // In-store breakdown
      PurchasePointsLog.aggregate([
        { $match: {
          brandId: require('mongoose').Types.ObjectId.createFromHexString(brandId),
          channel: 'instore',
        }},
        { $group: { _id: null, points: { $sum: '$pointsAwarded' }, transactions: { $sum: 1 } } },
      ]),
      // Online breakdown
      PurchasePointsLog.aggregate([
        { $match: {
          brandId: require('mongoose').Types.ObjectId.createFromHexString(brandId),
          channel: 'online',
        }},
        { $group: { _id: null, points: { $sum: '$pointsAwarded' }, transactions: { $sum: 1 } } },
      ]),
      // 5 most recent awards for activity feed
      PurchasePointsLog.find({ brandId })
        .sort({ awardedAt: -1 })
        .limit(5)
        .lean(),
    ]);

    res.json({
      stats: {
        totalPoints:        totalAgg[0]?.totalPoints        ?? 0,
        totalTransactions:  totalAgg[0]?.totalTransactions  ?? 0,
        inStorePoints:      inStoreAgg[0]?.points           ?? 0,
        inStoreTransactions:inStoreAgg[0]?.transactions     ?? 0,
        onlinePoints:       onlineAgg[0]?.points            ?? 0,
        onlineTransactions: onlineAgg[0]?.transactions      ?? 0,
      },
      recentAwards,
    });
  } catch (err) {
    console.error('GET /purchase-points/stats error:', err.message);
    res.status(500).json({ error: 'Could not load stats' });
  }
});

// ── POST /api/purchase-points/award ───────────────────────────────────────────
// Award purchase points to a customer (influencer) for a qualifying purchase.
// Called by: in-store clerk via kiosk, or online store tracking webhook.
//
// Body: { brandId, influencerProfileId OR customerEmail, spendAmount, channel }
router.post('/award', requireAuth, async (req, res) => {
  try {
    const { brandId, influencerProfileId, customerEmail, spendAmount, channel, orderRef, processedBy } = req.body;

    if (!brandId)     return res.status(400).json({ error: 'brandId is required' });
    if (!spendAmount || spendAmount <= 0) return res.status(400).json({ error: 'spendAmount must be greater than 0' });
    if (!channel || !['instore', 'online'].includes(channel)) {
      return res.status(400).json({ error: 'channel must be "instore" or "online"' });
    }
    if (!influencerProfileId && !customerEmail) {
      return res.status(400).json({ error: 'influencerProfileId or customerEmail is required' });
    }

    // Load brand's purchase points config
    const config = await PurchasePointsConfig.findOne({ brandId });
    if (!config) return res.status(404).json({ error: 'This brand has not configured purchase points yet' });

    const channelConfig = channel === 'instore' ? config.inStore : config.online;
    if (!channelConfig.enabled) {
      return res.status(400).json({ error: `Purchase points are not enabled for ${channel} on this brand` });
    }

    // Calculate points
    const { points, levelIndex } = calculatePoints(spendAmount, channelConfig.levels);
    if (points === 0) {
      const floor = channelConfig.levels.length > 0
        ? Math.min(...channelConfig.levels.map(l => l.minSpend))
        : 0;
      return res.json({
        awarded: false,
        pointsAwarded: 0,
        message: `Spend $${floor} or more to earn points. Current spend: $${spendAmount}.`,
        levelIndex: 0,
      });
    }

    // Resolve influencer profile
    let influencer = null;
    if (influencerProfileId) {
      influencer = await InfluencerProfile.findById(influencerProfileId);
    } else if (customerEmail) {
      influencer = await InfluencerProfile.findOne({
        userId: (await require('../models/User').findOne({ email: customerEmail.toLowerCase() })?._id),
      });
    }

    // Build log entry
    const logData = {
      brandId,
      channel,
      spendAmount,
      pointsAwarded: points,
      levelIndex,
      processedBy: processedBy || null,
      orderRef: orderRef || null,
      awardedAt: new Date(),
    };

    if (influencer) {
      logData.influencerProfileId = influencer._id;
      logData.customerName  = influencer.displayName;
      logData.customerEmail = customerEmail || null;

      // Update influencer's balance
      await InfluencerProfile.findByIdAndUpdate(influencer._id, {
        $inc: {
          purchasePointsBalance:     points,
          totalPurchasePointsEarned: points,
        },
      });
    } else {
      // No account found — log the transaction anyway (points held in escrow for when they sign up)
      logData.customerEmail = customerEmail || null;
      logData.customerName  = customerEmail ? customerEmail.split('@')[0] : 'Guest';
    }

    const log = await PurchasePointsLog.create(logData);

    console.log(`✅ Purchase points awarded: ${points}pts to ${influencer ? influencer.displayName : customerEmail} (brand ${brandId}, $${spendAmount} spent, Level ${levelIndex})`);

    res.json({
      awarded: true,
      pointsAwarded: points,
      levelIndex,
      spendAmount,
      message: `${points} points awarded for $${spendAmount} purchase (Level ${levelIndex})`,
      logId: log._id,
      newBalance: influencer
        ? (influencer.purchasePointsBalance || 0) + points
        : null,
    });
  } catch (err) {
    console.error('POST /purchase-points/award error:', err.message);
    res.status(500).json({ error: 'Could not award points' });
  }
});

// ── GET /api/purchase-points/history?brandId=&limit= ─────────────────────────
// Full award history for brand's transaction log tab
router.get('/history', requireAuth, async (req, res) => {
  try {
    const { brandId, limit = 50, page = 1 } = req.query;
    if (!brandId) return res.status(400).json({ error: 'brandId is required' });

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [logs, total] = await Promise.all([
      PurchasePointsLog.find({ brandId })
        .sort({ awardedAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      PurchasePointsLog.countDocuments({ brandId }),
    ]);

    res.json({ logs, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (err) {
    console.error('GET /purchase-points/history error:', err.message);
    res.status(500).json({ error: 'Could not load history' });
  }
});

// ── GET /api/purchase-points/preview ─────────────────────────────────────────
// Public-ish: preview what points a given spend would earn for a brand.
// Used by the native app to show "Spend $X more to reach Level 2"
router.get('/preview', async (req, res) => {
  try {
    const { brandId, spendAmount, channel = 'instore' } = req.query;
    if (!brandId || !spendAmount) {
      return res.status(400).json({ error: 'brandId and spendAmount are required' });
    }

    const config = await PurchasePointsConfig.findOne({ brandId });
    if (!config) return res.json({ points: 0, levelIndex: 0, levels: [] });

    const channelConfig = channel === 'instore' ? config.inStore : config.online;
    const { points, levelIndex } = calculatePoints(parseFloat(spendAmount), channelConfig.levels);

    // Calculate "next level" to show upgrade prompt
    const sorted = [...(channelConfig.levels || [])]
      .map((l, i) => ({ ...l.toObject(), levelIndex: i + 1 }))
      .sort((a, b) => a.minSpend - b.minSpend);
    const nextLevel = sorted.find(l => l.minSpend > parseFloat(spendAmount));

    res.json({
      points,
      levelIndex,
      levels: sorted,
      nextLevel: nextLevel || null,
      toNextLevel: nextLevel ? (nextLevel.minSpend - parseFloat(spendAmount)).toFixed(2) : null,
    });
  } catch (err) {
    console.error('GET /purchase-points/preview error:', err.message);
    res.status(500).json({ error: 'Could not preview points' });
  }
});

module.exports = router;
