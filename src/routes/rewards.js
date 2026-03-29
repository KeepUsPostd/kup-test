// Reward Routes — Full CRUD with platform rule enforcement
// Enforces: R1 (one earning method), R4 (tier-based cash), R5 (cash multi-select),
//           R6 (non-cash exclusive per reward)
// Ref: PLATFORM_ARCHITECTURE.md → Reward System Rules
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { Reward } = require('../models');

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

module.exports = router;
