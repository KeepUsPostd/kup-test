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
const crypto = require('crypto');
const { requireAuth } = require('../middleware/auth');
const {
  Brand, BrandProfile, InfluencerProfile,
  PurchasePointsConfig, PurchasePointsLog, Reward,
} = require('../models');
const User = require('../models/User');

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
          webhookToken: null,
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

    // Ensure a webhook token exists — generate once, never overwrite
    const existing = await PurchasePointsConfig.findOne({ brandId }).select('webhookToken');
    if (!existing?.webhookToken) {
      update.webhookToken = crypto.randomBytes(28).toString('hex');
    }

    const config = await PurchasePointsConfig.findOneAndUpdate(
      { brandId },
      { $set: update },
      { new: true, upsert: true, setDefaultsOnInsert: true }
    );

    console.log(`✅ Purchase points config saved for brand ${brandId}`);

    // ── Sync purchase tiers → Reward model so native app stays current ────────
    // The brand's points-type Reward stores purchaseTiers for display in the app.
    // Whenever the brand updates tiers here, we push the latest data into that
    // Reward record so the native app never reads stale tier info.
    try {
      const allTiers = [
        ...((config.inStore?.levels || [])
          .filter(l => l.minSpend > 0 && l.points > 0)
          .map(l => ({ spendThreshold: l.minSpend, pointsEarned: l.points }))),
        // Note: we only sync in-store tiers to the reward display since online
        // tiers are webhook-driven and separate from the in-app reward program.
      ];
      const hasAnyTiers = allTiers.length > 0 || (config.online?.levels || []).some(l => l.minSpend > 0 && l.points > 0);

      const rewardSync = await Reward.findOneAndUpdate(
        { brandId, earningMethod: 'point_based', status: 'active' },
        {
          $set: {
            'pointConfig.purchaseEnabled': hasAnyTiers,
            'pointConfig.purchaseTiers':   allTiers,
          },
        },
        { sort: { createdAt: -1 } } // most recent points reward if multiple
      );
      if (rewardSync) {
        console.log(`🔄 Synced purchase tiers → Reward ${rewardSync._id} for brand ${brandId}`);
      }
    } catch (syncErr) {
      // Non-fatal — config is already saved, sync failure shouldn't block the response
      console.warn(`⚠️ Could not sync purchase tiers to Reward model: ${syncErr.message}`);
    }

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

    // Build log entry — pointsAwarded is 0 if no KUP account found (no escrow)
    const accountFound = !!influencer;
    const logData = {
      brandId,
      channel,
      spendAmount,
      pointsAwarded: accountFound ? points : 0,  // 0 = unmatched transaction, not escrowed
      levelIndex:    accountFound ? levelIndex : 0,
      processedBy: processedBy || null,
      orderRef: orderRef || null,
      awardedAt: new Date(),
    };

    if (accountFound) {
      logData.influencerProfileId = influencer._id;
      logData.customerName  = influencer.displayName;
      logData.customerEmail = customerEmail || null;

      // Credit the influencer's balance
      await InfluencerProfile.findByIdAndUpdate(influencer._id, {
        $inc: {
          purchasePointsBalance:     points,
          totalPurchasePointsEarned: points,
        },
      });
    } else {
      // No KUP account — log for brand's visibility but award nothing.
      // Customer earns going forward once they join KUP and partner with this brand.
      logData.customerEmail = customerEmail || null;
      logData.customerName  = customerEmail ? customerEmail.split('@')[0] : 'Guest';
    }

    const log = await PurchasePointsLog.create(logData);

    // Notify influencer + brand on successful award
    if (accountFound) {
      try {
        const brand = await Brand.findById(brandId).select('name logoUrl avatarUrl createdBy').lean();
        const brandName = brand?.name || 'Brand';
        const brandLogo = brand?.logoUrl || brand?.avatarUrl || '';
        const Notification = require('../models/Notification');
        const { sendEmail } = require('../config/email');

        // Calculate full total across all point types for the notification
        const Reward = require('../models/Reward');
        const { Partnership } = require('../models');
        const ContentSubmission = require('../models/ContentSubmission');
        const activeReward = await Reward.findOne({ brandId, status: 'active', earningMethod: 'point_based' }).lean();
        const partnership = await Partnership.findOne({ brandId, influencerProfileId: influencer._id, status: 'active' }).lean();
        const bl = partnership?.pointsResetSubmissionBaseline || {};

        let fullTotal = 0;
        let nextThreshold = '?';
        let nextRewardTitle = activeReward?.title || 'Brand Rewards';
        if (activeReward) {
          const pc = activeReward.pointConfig || {};
          const pts2 = pc.contentPoints || {};
          const [sub, app, pst] = await Promise.all([
            ContentSubmission.countDocuments({ brandId, influencerProfileId: influencer._id }),
            ContentSubmission.countDocuments({ brandId, influencerProfileId: influencer._id, status: 'approved' }),
            ContentSubmission.countDocuments({ brandId, influencerProfileId: influencer._id, status: 'postd' }),
          ]);
          const contentPts = (pts2.submitted||0)*(sub-(bl.total||0)) + (pts2.approved||0)*(app-(bl.approved||0)) + (pts2.published||0)*(pst-(bl.postd||0)) + (pts2.bonus||0)*(pst-(bl.postd||0));
          const purchTotal = Math.max(0, (influencer.purchasePointsBalance || 0) + points - (bl.purchasePoints || 0));
          const giftPts = partnership?.giftedPoints || 0;
          fullTotal = contentPts + purchTotal + giftPts;
          const levels = pc.levels || [];
          const nextLevel = levels.find(l => fullTotal < l.threshold);
          if (nextLevel) { nextThreshold = nextLevel.threshold; nextRewardTitle = nextLevel.rewardValue || activeReward.title; }
          else if (levels.length) { nextThreshold = levels[levels.length-1].threshold; nextRewardTitle = levels[levels.length-1].rewardValue || activeReward.title; }
        }

        // Influencer in-app notification
        if (influencer.userId) {
          await Notification.create({
            userId: influencer.userId.toString(),
            title: 'Purchase Points Earned',
            message: `+${points} pts from ${brandName} for your $${spendAmount} purchase`,
            type: 'reward',
            metadata: {
              brandName,
              brandLogoUrl: brandLogo,
              points,
              totalPoints: fullTotal,
              unlockThreshold: nextThreshold,
              rewardTitle: nextRewardTitle,
              isPurchasePoints: true,
            },
          });
        }

        // Influencer email
        const infUser = influencer.userId ? await User.findById(influencer.userId, 'email') : null;
        if (infUser?.email) {
          await sendEmail({
            to: infUser.email,
            subject: `Purchase Points Earned — ${brandName}`,
            headline: 'Purchase Points Earned!',
            preheader: `You earned ${points} points for your $${spendAmount} purchase at ${brandName}.`,
            bodyHtml: `
              <p>You earned <strong>${points} points</strong> from your <strong>$${spendAmount}</strong> purchase at <strong>${brandName}</strong>.</p>
              <p>Keep earning points toward your next reward!</p>
            `,
            ctaText: 'View Rewards',
            ctaUrl: 'keepuspostd://rewards',
            variant: 'influencer',
          }).catch(e => console.error('[purchase-points] influencer email error:', e.message));
        }

        // Brand in-app notification
        const brandUserId = brand?.createdBy;
        if (brandUserId) {
          await Notification.create({
            userId: brandUserId.toString(),
            title: 'Purchase Points Awarded',
            message: `${influencer.displayName} earned ${points} pts from a $${spendAmount} purchase`,
            type: 'reward',
            metadata: {
              influencerName: influencer.displayName,
              influencerHandle: influencer.handle,
              points,
              spendAmount,
              isPurchasePoints: true,
            },
          });

          // Brand email
          const brandUser = await User.findById(brandUserId, 'email');
          if (brandUser?.email) {
            await sendEmail({
              to: brandUser.email,
              subject: `${influencer.displayName} Earned ${points} Purchase Points`,
              headline: 'Purchase Points Awarded',
              preheader: `${influencer.displayName} earned points from a $${spendAmount} purchase`,
              bodyHtml: `
                <p><strong>${influencer.displayName}</strong> (@${influencer.handle}) earned purchase points at your brand.</p>
                <p><strong>Points earned:</strong> ${points} pts</p>
                <p><strong>Purchase amount:</strong> $${spendAmount}</p>
              `,
              ctaText: 'View Rewards',
              ctaUrl: `${process.env.APP_URL || 'https://keepuspostd.com'}/app/cash-rewards.html?tab=rewards`,
              variant: 'brand',
            }).catch(e => console.error('[purchase-points] brand email error:', e.message));
          }
        }
      } catch (notifErr) {
        console.error('[purchase-points] notification error:', notifErr.message);
      }
    }

    if (accountFound) {
      console.log(`✅ Purchase points awarded: ${points}pts to ${influencer.displayName} (brand ${brandId}, $${spendAmount} spent, Level ${levelIndex})`);
    } else {
      console.log(`ℹ️ Purchase points: no KUP account for ${customerEmail} (brand ${brandId}, $${spendAmount} — would have earned ${points}pts)`);
    }

    res.json({
      awarded:       accountFound,
      accountFound,
      pointsAwarded: accountFound ? points : 0,
      pointsWouldEarn: accountFound ? null : points, // what they'd earn once they join
      levelIndex:    accountFound ? levelIndex : 0,
      spendAmount,
      message: accountFound
        ? `${points} points awarded for $${spendAmount} purchase (Level ${levelIndex})`
        : `No KUP account found — ${points} points available once customer joins KUP`,
      logId: log._id,
      newBalance: accountFound
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

// ── GET /api/purchase-points/webhook/test?brandId= ────────────────────────────
// Authenticated dry-run: verifies the brand's config is set up and shows what
// a $50 test purchase would earn across both channels. No log entry created.
router.get('/webhook/test', requireAuth, async (req, res) => {
  try {
    const { brandId } = req.query;
    if (!brandId) return res.status(400).json({ error: 'brandId is required' });

    const config = await PurchasePointsConfig.findOne({ brandId });
    if (!config) {
      return res.json({ connected: false, reason: 'No config found — save your tier configuration first' });
    }
    if (!config.webhookToken) {
      return res.json({ connected: false, reason: 'No webhook token yet — save your tier configuration first' });
    }

    // Dry-run: show what a $50 purchase would earn on each channel
    const TEST_AMOUNT = 50;
    const inStoreResult = calculatePoints(TEST_AMOUNT, config.inStore?.levels || []);
    const onlineResult  = calculatePoints(TEST_AMOUNT, config.online?.levels  || []);

    return res.json({
      connected:    true,
      webhookToken: config.webhookToken,
      testAmount:   TEST_AMOUNT,
      inStore: {
        enabled:    !!config.inStore?.enabled,
        levels:     config.inStore?.levels?.length || 0,
        wouldEarn:  inStoreResult.points,
        level:      inStoreResult.levelIndex,
      },
      online: {
        enabled:    !!config.online?.enabled,
        levels:     config.online?.levels?.length || 0,
        wouldEarn:  onlineResult.points,
        level:      onlineResult.levelIndex,
      },
    });
  } catch (err) {
    console.error('GET /purchase-points/webhook/test error:', err.message);
    res.status(500).json({ error: 'Could not run test' });
  }
});

// ── POST /api/purchase-points/webhook/:platform/:webhookToken ─────────────────
// Server-to-server webhook receiver — no Firebase auth required.
// Platforms call this endpoint when an order is placed/paid.
// The webhookToken in the URL acts as the shared secret.
//
// Supported platforms: shopify | woocommerce | squarespace | wix
//
// Each platform sends a different JSON payload format. We normalize them all
// into { customerEmail, spendAmount, orderRef } then run the same award logic.
router.post('/webhook/:platform/:webhookToken', async (req, res) => {
  try {
    const { platform, webhookToken } = req.params;
    const VALID_PLATFORMS = ['shopify', 'woocommerce', 'squarespace', 'wix'];

    if (!VALID_PLATFORMS.includes(platform)) {
      return res.status(400).json({ error: 'Unknown platform' });
    }

    // Validate token → look up brand config
    const config = await PurchasePointsConfig.findOne({ webhookToken });
    if (!config) {
      console.warn(`⚠️ Purchase points webhook: invalid token for platform ${platform}`);
      return res.status(401).json({ error: 'Invalid webhook token' });
    }

    // ── Parse platform-specific payload ──────────────────────────────────────
    const body = req.body;
    let customerEmail = null;
    let spendAmount = null;
    let orderRef = null;

    switch (platform) {
      case 'shopify':
        // Shopify orders/paid webhook payload
        customerEmail = body.email || body.customer?.email;
        spendAmount   = parseFloat(body.total_price || body.subtotal_price);
        orderRef      = body.order_number?.toString() || body.id?.toString();
        break;

      case 'woocommerce':
        // WooCommerce order.completed webhook payload
        customerEmail = body.billing?.email;
        spendAmount   = parseFloat(body.total);
        orderRef      = body.id?.toString();
        break;

      case 'squarespace':
        // Squarespace order.create webhook payload (nested under data.order)
        customerEmail = body.data?.order?.customerEmail;
        spendAmount   = parseFloat(body.data?.order?.grandTotal?.value ?? body.data?.order?.subtotal?.value);
        orderRef      = body.data?.order?.id;
        break;

      case 'wix':
        // Wix Automations HTTP request body (Wix Stores order placed)
        customerEmail = body.buyerInfo?.email || body.customer?.email;
        spendAmount   = parseFloat(body.totals?.total ?? body.total ?? body.price);
        orderRef      = body.orderId || body.id?.toString();
        break;
    }

    // Validate parsed values — always return 200 so platform doesn't retry on business logic misses
    if (!customerEmail || isNaN(spendAmount) || spendAmount <= 0) {
      console.warn(`⚠️ Webhook ${platform}: could not parse email/amount`, { customerEmail, spendAmount, body });
      return res.status(200).json({ received: true, awarded: false, reason: 'Could not parse customer email or spend amount from payload' });
    }

    // Check online channel enabled
    if (!config.online?.enabled) {
      return res.status(200).json({ received: true, awarded: false, reason: 'Online purchase points are disabled for this brand' });
    }

    // Calculate points
    const { points, levelIndex } = calculatePoints(spendAmount, config.online.levels);
    if (points === 0) {
      const floor = config.online.levels.length > 0
        ? Math.min(...config.online.levels.map(l => l.minSpend))
        : 0;
      return res.status(200).json({ received: true, awarded: false, reason: `Spend $${floor} or more to earn points (got $${spendAmount})` });
    }

    // Resolve influencer account by email
    let influencer = null;
    const user = await User.findOne({ email: customerEmail.toLowerCase() });
    if (user) {
      influencer = await InfluencerProfile.findOne({ userId: user._id });
    }

    // Build log entry — pointsAwarded is 0 if no KUP account found (no escrow)
    const accountFound = !!influencer;
    const logData = {
      brandId:       config.brandId,
      channel:       'online',
      spendAmount,
      pointsAwarded: accountFound ? points : 0,  // 0 = unmatched, not escrowed
      levelIndex:    accountFound ? levelIndex : 0,
      orderRef:      orderRef || null,
      processedBy:   `webhook:${platform}`,
      awardedAt:     new Date(),
    };

    if (accountFound) {
      logData.influencerProfileId = influencer._id;
      logData.customerName        = influencer.displayName;
      logData.customerEmail       = customerEmail.toLowerCase();

      // Credit the influencer's balance
      await InfluencerProfile.findByIdAndUpdate(influencer._id, {
        $inc: {
          purchasePointsBalance:     points,
          totalPurchasePointsEarned: points,
        },
      });
    } else {
      // No KUP account — log the transaction for brand visibility, award nothing.
      // Customer earns going forward once they join KUP and partner with this brand.
      logData.customerEmail = customerEmail.toLowerCase();
      logData.customerName  = customerEmail.split('@')[0];
    }

    const log = await PurchasePointsLog.create(logData);

    if (accountFound) {
      console.log(`✅ Webhook ${platform}: ${points}pts → ${customerEmail} (brand ${config.brandId}, $${spendAmount}, Level ${levelIndex})`);
    } else {
      console.log(`ℹ️ Webhook ${platform}: no KUP account for ${customerEmail} (brand ${config.brandId}, $${spendAmount} — would have earned ${points}pts)`);
    }

    return res.status(200).json({
      received:        true,
      awarded:         accountFound,
      accountFound,
      pointsAwarded:   accountFound ? points : 0,
      pointsWouldEarn: accountFound ? null : points,
      levelIndex:      accountFound ? levelIndex : 0,
      spendAmount,
      logId:           log._id,
    });

  } catch (err) {
    console.error(`POST /purchase-points/webhook error:`, err.message);
    // Always return 200 to prevent platform from retrying indefinitely
    return res.status(200).json({ received: true, awarded: false, error: 'Internal error — contact support' });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// STAFF PIN MODE — No Firebase auth required. PIN replaces identity for staff.
// Brand owner sets a 4-digit PIN from purchase-points-setup.html.
// Any staffer who knows the PIN can award purchase points from their personal phone.
// URL: keepuspostd.com/staff/:brandCode
// ══════════════════════════════════════════════════════════════════════════════

// ── GET /api/purchase-points/staff-brand?brandCode= ───────────────────────────
// Public — minimal brand info for the staff scan landing page.
// Returns brandId, name, logo, and whether a PIN has been set.
router.get('/staff-brand', async (req, res) => {
  try {
    const { brandCode } = req.query;
    if (!brandCode) return res.status(400).json({ error: 'brandCode is required' });

    const brand = await Brand.findOne({ kioskBrandCode: brandCode, status: 'active' })
      .select('name logo _id kioskBrandCode');
    if (!brand) return res.status(404).json({ error: 'Brand not found or not active' });

    // Check if purchase points configured + PIN is set (without revealing the PIN)
    const config = await PurchasePointsConfig.findOne({ brandId: brand._id })
      .select('+staffPin');
    const hasPin      = !!(config?.staffPin);
    const inStoreEnabled = !!(config?.inStore?.enabled);

    res.json({
      brandId:         brand._id,
      brandName:       brand.name,
      brandLogo:       brand.logo || null,
      brandCode,
      hasPin,
      inStoreEnabled,
    });
  } catch (err) {
    console.error('GET /purchase-points/staff-brand error:', err.message);
    res.status(500).json({ error: 'Could not load brand info' });
  }
});

// ── POST /api/purchase-points/staff-verify ────────────────────────────────────
// Validates the 4-digit staff PIN for a brand. Returns { verified: true } or 401.
// Called each time the staff scan app is opened — PIN must match to proceed.
router.post('/staff-verify', async (req, res) => {
  try {
    const { brandId, pin } = req.body;
    if (!brandId)         return res.status(400).json({ error: 'brandId is required' });
    if (!pin || !/^\d{4}$/.test(String(pin))) {
      return res.status(400).json({ error: 'PIN must be exactly 4 digits' });
    }

    const config = await PurchasePointsConfig.findOne({ brandId }).select('+staffPin');
    if (!config) return res.status(404).json({ error: 'Brand not configured for purchase points' });
    if (!config.staffPin) {
      return res.status(400).json({ error: 'No staff PIN set — ask the brand owner to configure one' });
    }

    // Constant-time comparison to prevent timing attacks on 4-digit space
    const pinBuf    = Buffer.from(String(pin));
    const storedBuf = Buffer.from(config.staffPin);
    const match = pinBuf.length === storedBuf.length &&
                  crypto.timingSafeEqual(pinBuf, storedBuf);

    if (!match) return res.status(401).json({ error: 'Incorrect PIN' });

    res.json({ verified: true, brandId });
  } catch (err) {
    console.error('POST /purchase-points/staff-verify error:', err.message);
    res.status(500).json({ error: 'Could not verify PIN' });
  }
});

// ── POST /api/purchase-points/staff-lookup ────────────────────────────────────
// Resolves a customer by QR scan (influencerProfileId), email, or @handle.
// PIN-authenticated — no Firebase token required.
router.post('/staff-lookup', async (req, res) => {
  try {
    const { brandId, pin, identifier } = req.body;
    if (!brandId || !pin || !identifier) {
      return res.status(400).json({ error: 'brandId, pin, and identifier are required' });
    }

    // Verify PIN before any lookup
    const config = await PurchasePointsConfig.findOne({ brandId }).select('+staffPin');
    if (!config?.staffPin) return res.status(400).json({ error: 'No staff PIN configured' });

    const pinBuf    = Buffer.from(String(pin));
    const storedBuf = Buffer.from(config.staffPin);
    const match = pinBuf.length === storedBuf.length &&
                  crypto.timingSafeEqual(pinBuf, storedBuf);
    if (!match) return res.status(401).json({ error: 'Incorrect PIN' });

    // Resolve customer — QR codes embed the influencerProfileId (MongoDB ObjectId)
    let influencer = null;
    const id = String(identifier).trim();

    if (/^[a-f0-9]{24}$/i.test(id)) {
      // QR scan: the market code QR encodes the influencerProfileId directly
      influencer = await InfluencerProfile.findById(id);
    } else if (id.startsWith('@')) {
      const handle = id.slice(1).toLowerCase();
      const user = await User.findOne({ handle });
      if (user) influencer = await InfluencerProfile.findOne({ userId: user._id });
    } else if (id.includes('@')) {
      const user = await User.findOne({ email: id.toLowerCase() });
      if (user) influencer = await InfluencerProfile.findOne({ userId: user._id });
    }

    if (!influencer) {
      return res.json({
        found: false,
        message: 'No KUP account found — points available once customer joins KUP',
      });
    }

    res.json({
      found:                 true,
      influencerProfileId:   influencer._id,
      displayName:           influencer.displayName,
      purchasePointsBalance: influencer.purchasePointsBalance || 0,
    });
  } catch (err) {
    console.error('POST /purchase-points/staff-lookup error:', err.message);
    res.status(500).json({ error: 'Could not look up customer' });
  }
});

// ── POST /api/purchase-points/staff-award ─────────────────────────────────────
// Awards purchase points using PIN auth (no Firebase required).
// This is the final step in the staff scan flow — PIN must be sent with every award.
router.post('/staff-award', async (req, res) => {
  try {
    const { brandId, pin, influencerProfileId, spendAmount } = req.body;
    if (!brandId || !pin) return res.status(400).json({ error: 'brandId and pin are required' });
    if (!spendAmount || parseFloat(spendAmount) <= 0) {
      return res.status(400).json({ error: 'spendAmount must be greater than 0' });
    }

    // Verify PIN
    const config = await PurchasePointsConfig.findOne({ brandId }).select('+staffPin');
    if (!config) return res.status(404).json({ error: 'Brand not configured for purchase points' });
    if (!config.staffPin) return res.status(400).json({ error: 'No staff PIN configured' });

    const pinBuf    = Buffer.from(String(pin));
    const storedBuf = Buffer.from(config.staffPin);
    const match = pinBuf.length === storedBuf.length &&
                  crypto.timingSafeEqual(pinBuf, storedBuf);
    if (!match) return res.status(401).json({ error: 'Incorrect PIN' });

    if (!config.inStore?.enabled) {
      return res.status(400).json({ error: 'In-store purchase points are not enabled for this brand' });
    }

    const spend = parseFloat(spendAmount);
    const { points, levelIndex } = calculatePoints(spend, config.inStore.levels);
    if (points === 0) {
      const floor = config.inStore.levels.length > 0
        ? Math.min(...config.inStore.levels.map(l => l.minSpend))
        : 0;
      return res.json({
        awarded: false,
        pointsAwarded: 0,
        message: `Spend $${floor} or more to earn points. Current spend: $${spend}.`,
      });
    }

    // Resolve influencer (optional — guest transactions are still logged)
    let influencer = null;
    if (influencerProfileId) {
      influencer = await InfluencerProfile.findById(influencerProfileId);
    }

    const logData = {
      brandId,
      channel:       'instore',
      spendAmount:   spend,
      pointsAwarded: influencer ? points : 0,
      levelIndex:    influencer ? levelIndex : 0,
      processedBy:   'staff-pin',
      awardedAt:     new Date(),
    };

    if (influencer) {
      logData.influencerProfileId = influencer._id;
      logData.customerName        = influencer.displayName;

      await InfluencerProfile.findByIdAndUpdate(influencer._id, {
        $inc: {
          purchasePointsBalance:     points,
          totalPurchasePointsEarned: points,
        },
      });
      // Notify influencer + brand
      try {
        const brand = await Brand.findById(brandId).select('name logoUrl avatarUrl createdBy').lean();
        const brandName = brand?.name || 'Brand';
        const Notification = require('../models/Notification');

        if (influencer.userId) {
          // Calculate full total for notification (same as /award endpoint)
          const Reward2 = require('../models/Reward');
          const { Partnership: P2 } = require('../models');
          const ContentSubmission2 = require('../models/ContentSubmission');
          const ar2 = await Reward2.findOne({ brandId, status: 'active', earningMethod: 'point_based' }).lean();
          const ps2 = await P2.findOne({ brandId, influencerProfileId: influencer._id, status: 'active' }).lean();
          const bl2 = ps2?.pointsResetSubmissionBaseline || {};
          let ft2 = 0; let nt2 = '?'; let nrt2 = ar2?.title || 'Brand Rewards';
          if (ar2) {
            const pc2 = ar2.pointConfig || {}; const cp2 = pc2.contentPoints || {};
            const [s2,a2,p2] = await Promise.all([ContentSubmission2.countDocuments({brandId,influencerProfileId:influencer._id}),ContentSubmission2.countDocuments({brandId,influencerProfileId:influencer._id,status:'approved'}),ContentSubmission2.countDocuments({brandId,influencerProfileId:influencer._id,status:'postd'})]);
            const ct2 = (cp2.submitted||0)*(s2-(bl2.total||0))+(cp2.approved||0)*(a2-(bl2.approved||0))+(cp2.published||0)*(p2-(bl2.postd||0))+(cp2.bonus||0)*(p2-(bl2.postd||0));
            const pt2 = Math.max(0,(influencer.purchasePointsBalance||0)+points-(bl2.purchasePoints||0));
            ft2 = ct2+pt2+(ps2?.giftedPoints||0);
            const lv2 = pc2.levels||[]; const nl2 = lv2.find(l=>ft2<l.threshold);
            if(nl2){nt2=nl2.threshold;nrt2=nl2.rewardValue||ar2.title}else if(lv2.length){nt2=lv2[lv2.length-1].threshold;nrt2=lv2[lv2.length-1].rewardValue||ar2.title}
          }
          await Notification.create({
            userId: influencer.userId.toString(),
            title: 'Purchase Points Earned',
            message: `+${points} pts from ${brandName} for your $${spend} purchase`,
            type: 'reward',
            metadata: {
              brandName,
              brandLogoUrl: brand?.logoUrl || brand?.avatarUrl || '',
              points,
              totalPoints: ft2,
              unlockThreshold: nt2,
              rewardTitle: nrt2,
              isPurchasePoints: true,
            },
          });
        }
        if (brand?.createdBy) {
          await Notification.create({
            userId: brand.createdBy.toString(),
            title: 'Purchase Points Awarded',
            message: `${influencer.displayName} earned ${points} pts from a $${spend} purchase`,
            type: 'reward',
            metadata: {
              influencerName: influencer.displayName,
              influencerHandle: influencer.handle,
              points,
              spendAmount: spend,
              isPurchasePoints: true,
            },
          });
          // Brand email
          try {
            const User2 = require('../models/User');
            const brandUser2 = await User2.findById(brand.createdBy, 'email');
            if (brandUser2?.email) {
              const { sendEmail: se2 } = require('../config/email');
              await se2({
                to: brandUser2.email,
                subject: `${influencer.displayName} Earned ${points} Purchase Points`,
                headline: 'Purchase Points Awarded',
                preheader: `${influencer.displayName} earned points from a $${spend} purchase`,
                bodyHtml: `<p><strong>${influencer.displayName}</strong> earned purchase points at your brand.</p><p><strong>Points earned:</strong> ${points} pts</p><p><strong>Purchase amount:</strong> $${spend}</p>`,
                ctaText: 'View Rewards',
                ctaUrl: `${process.env.APP_URL || 'https://keepuspostd.com'}/app/cash-rewards.html?tab=rewards`,
                variant: 'brand',
              }).catch(e => console.error('[staff-award] brand email error:', e.message));
            }
          } catch(e) {}
        }
      } catch (notifErr) {
        console.error('[staff-award] notification error:', notifErr.message);
      }

      console.log(`✅ Staff PIN: ${points}pts → ${influencer.displayName} (brand ${brandId}, $${spend}, Level ${levelIndex})`);
    } else {
      logData.customerName = 'Guest';
      console.log(`ℹ️ Staff PIN: guest $${spend} (brand ${brandId}) — no KUP account, would earn ${points}pts`);
    }

    const log = await PurchasePointsLog.create(logData);

    res.json({
      awarded:         !!influencer,
      pointsAwarded:   influencer ? points : 0,
      pointsWouldEarn: influencer ? null : points,
      levelIndex:      influencer ? levelIndex : 0,
      spendAmount:     spend,
      message: influencer
        ? `${points} points awarded to ${influencer.displayName} (Level ${levelIndex})`
        : `No KUP account — ${points} points waiting once they join KUP`,
      newBalance: influencer
        ? (influencer.purchasePointsBalance || 0) + points
        : null,
      logId: log._id,
    });
  } catch (err) {
    console.error('POST /purchase-points/staff-award error:', err.message);
    res.status(500).json({ error: 'Could not award points' });
  }
});

// ── PUT /api/purchase-points/staff-pin ────────────────────────────────────────
// Brand owner sets or rotates the 4-digit staff PIN. requireAuth — owner only.
router.put('/staff-pin', requireAuth, async (req, res) => {
  try {
    const { brandId, pin } = req.body;
    if (!brandId) return res.status(400).json({ error: 'brandId is required' });
    if (!pin || !/^\d{4}$/.test(String(pin))) {
      return res.status(400).json({ error: 'PIN must be exactly 4 digits (0–9)' });
    }

    // Verify requester owns the brand
    const brandProfile = await BrandProfile.findOne({ userId: req.user._id });
    if (!brandProfile || !brandProfile.ownedBrandIds.some(id => id.toString() === brandId)) {
      return res.status(403).json({ error: 'You do not own this brand' });
    }

    await PurchasePointsConfig.findOneAndUpdate(
      { brandId },
      { $set: { staffPin: String(pin) } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    console.log(`✅ Staff PIN set/rotated for brand ${brandId}`);
    res.json({ message: 'Staff PIN saved. Share it only with trusted staff.' });
  } catch (err) {
    console.error('PUT /purchase-points/staff-pin error:', err.message);
    res.status(500).json({ error: 'Could not save staff PIN' });
  }
});

module.exports = router;
