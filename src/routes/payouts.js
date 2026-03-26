// Payout Routes — Transaction ledger + PayPal payout batches
// Rule G5: PayPal Business ONLY for all payouts
// Rule G7: Tier-based cash rates (brands can't set custom amounts)
// Ref: PLATFORM_ARCHITECTURE.md → Cash & Payments
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { Transaction, Payout, InfluencerProfile } = require('../models');

// Tier-based cash rates (per approval)
// Rule G7: Brands cannot override these — they come from influencer tier
const TIER_RATES = {
  nano: { cash_per_approval: 5, bonus_cash: 10 },
  micro: { cash_per_approval: 10, bonus_cash: 25 },
  mid: { cash_per_approval: 25, bonus_cash: 50 },
  macro: { cash_per_approval: 50, bonus_cash: 100 },
  mega: { cash_per_approval: 100, bonus_cash: 250 },
  celebrity: { cash_per_approval: 250, bonus_cash: 500 },
};

// POST /api/payouts/transaction — Create a new transaction (cash reward)
// Called when content is approved and a cash reward is configured
router.post('/transaction', requireAuth, async (req, res) => {
  try {
    const {
      payeeInfluencerId,
      brandId,
      type,
      amount,
      contentSubmissionId,
      campaignId,
      rewardId,
    } = req.body;

    if (!payeeInfluencerId) {
      return res.status(400).json({ error: 'payeeInfluencerId is required' });
    }
    if (!type) {
      return res.status(400).json({ error: 'Transaction type is required' });
    }

    const validTypes = [
      'cash_per_approval', 'bonus_cash', 'postd_pay',
      'viral_bonus', 'platform_bonus', 'referral_bonus',
    ];
    if (!validTypes.includes(type)) {
      return res.status(400).json({
        error: 'Invalid transaction type',
        message: `Type must be one of: ${validTypes.join(', ')}`,
      });
    }

    // For tier-based types, resolve amount from influencer tier
    let resolvedAmount = amount;
    if (['cash_per_approval', 'bonus_cash'].includes(type)) {
      const influencer = await InfluencerProfile.findById(payeeInfluencerId);
      if (!influencer) {
        return res.status(404).json({ error: 'Influencer not found' });
      }
      const tier = influencer.influenceTier || 'nano';
      const rates = TIER_RATES[tier] || TIER_RATES.nano;
      resolvedAmount = rates[type] || amount;
    }

    // For postd_pay, amount is required (brand sets manually)
    if (type === 'postd_pay' && (!resolvedAmount || resolvedAmount <= 0)) {
      return res.status(400).json({
        error: 'Amount required for Postd Pay',
        message: 'Postd Pay requires a specific dollar amount.',
      });
    }

    const transaction = await Transaction.create({
      payerType: brandId ? 'brand' : 'platform',
      payerBrandId: brandId || null,
      payeeInfluencerId,
      type,
      amount: resolvedAmount,
      currency: 'USD',
      contentSubmissionId: contentSubmissionId || null,
      campaignId: campaignId || null,
      rewardId: rewardId || null,
      status: 'pending',
    });

    console.log(`💰 Transaction created: $${resolvedAmount} ${type} → ${payeeInfluencerId}`);

    res.status(201).json({
      message: 'Transaction created',
      transaction,
    });
  } catch (error) {
    console.error('Create transaction error:', error.message);
    res.status(500).json({ error: 'Could not create transaction' });
  }
});

// GET /api/payouts/transactions — List transactions
// Brand view: ?brandId=xxx (transactions they're paying)
// Influencer view: ?influencerId=xxx (their earnings)
router.get('/transactions', requireAuth, async (req, res) => {
  try {
    const { brandId, influencerId, status, type } = req.query;

    if (!brandId && !influencerId) {
      return res.status(400).json({
        error: 'Provide brandId or influencerId query parameter',
      });
    }

    const filter = {};
    if (brandId) filter.payerBrandId = brandId;
    if (influencerId) filter.payeeInfluencerId = influencerId;
    if (status) filter.status = status;
    if (type) filter.type = type;

    const transactions = await Transaction.find(filter)
      .populate('payeeInfluencerId', 'displayName handle influenceTier')
      .populate('payerBrandId', 'name')
      .populate('contentSubmissionId', 'contentType status')
      .sort({ createdAt: -1 })
      .limit(100);

    // Calculate totals
    const allForQuery = await Transaction.find(filter);
    const stats = {
      total: allForQuery.length,
      totalAmount: allForQuery.reduce((sum, t) => sum + (t.amount || 0), 0),
      pending: allForQuery.filter(t => t.status === 'pending').length,
      pendingAmount: allForQuery.filter(t => t.status === 'pending').reduce((sum, t) => sum + (t.amount || 0), 0),
      paid: allForQuery.filter(t => t.status === 'paid').length,
      paidAmount: allForQuery.filter(t => t.status === 'paid').reduce((sum, t) => sum + (t.amount || 0), 0),
    };

    res.json({ transactions, stats });
  } catch (error) {
    console.error('List transactions error:', error.message);
    res.status(500).json({ error: 'Could not fetch transactions' });
  }
});

// POST /api/payouts/batch — Create a payout batch (groups pending transactions)
// In production, this sends a PayPal Payouts API batch request
router.post('/batch', requireAuth, async (req, res) => {
  try {
    const { transactionIds } = req.body;

    if (!transactionIds || !transactionIds.length) {
      return res.status(400).json({ error: 'transactionIds array is required' });
    }

    // Validate all transactions are pending
    const transactions = await Transaction.find({
      _id: { $in: transactionIds },
      status: 'pending',
    });

    if (transactions.length === 0) {
      return res.status(400).json({
        error: 'No pending transactions found',
        message: 'All specified transactions are already processed or invalid.',
      });
    }

    if (transactions.length !== transactionIds.length) {
      return res.status(400).json({
        error: 'Some transactions are not pending',
        message: `Found ${transactions.length} pending out of ${transactionIds.length} requested.`,
      });
    }

    const totalAmount = transactions.reduce((sum, t) => sum + t.amount, 0);

    // Create payout batch
    const payout = await Payout.create({
      totalAmount,
      transactionCount: transactions.length,
      transactionIds: transactions.map(t => t._id),
      status: 'created',
      initiatedBy: 'admin',
      initiatedAt: new Date(),
    });

    // Mark transactions as processing
    await Transaction.updateMany(
      { _id: { $in: transactionIds } },
      {
        $set: {
          status: 'processing',
          payoutId: payout._id,
        },
      }
    );

    console.log(`📤 Payout batch created: $${totalAmount} (${transactions.length} transactions)`);

    // In production: Call PayPal Payouts API here
    // const paypalResult = await paypal.payouts.create({ ... });
    // payout.paypalBatchId = paypalResult.batch_header.payout_batch_id;

    res.status(201).json({
      message: 'Payout batch created',
      payout,
      // In production: paypalBatchId would be included
    });
  } catch (error) {
    console.error('Create payout batch error:', error.message);
    res.status(500).json({ error: 'Could not create payout batch' });
  }
});

// GET /api/payouts/batches — List payout batches
router.get('/batches', requireAuth, async (req, res) => {
  try {
    const { status } = req.query;
    const filter = {};
    if (status) filter.status = status;

    const payouts = await Payout.find(filter)
      .sort({ initiatedAt: -1 })
      .limit(50);

    res.json({ payouts });
  } catch (error) {
    console.error('List payouts error:', error.message);
    res.status(500).json({ error: 'Could not fetch payouts' });
  }
});

// PUT /api/payouts/batch/:payoutId/complete — Mark batch as completed (test mode)
// In production, this would be called by PayPal webhook
router.put('/batch/:payoutId/complete', requireAuth, async (req, res) => {
  try {
    const payout = await Payout.findById(req.params.payoutId);
    if (!payout) {
      return res.status(404).json({ error: 'Payout batch not found' });
    }

    if (payout.status !== 'created' && payout.status !== 'processing') {
      return res.status(400).json({
        error: 'Cannot complete this batch',
        message: `Batch status is "${payout.status}". Only created/processing batches can be completed.`,
      });
    }

    payout.status = 'completed';
    payout.completedAt = new Date();
    await payout.save();

    // Mark all transactions as paid
    await Transaction.updateMany(
      { _id: { $in: payout.transactionIds } },
      {
        $set: {
          status: 'paid',
          paidAt: new Date(),
        },
      }
    );

    console.log(`✅ Payout batch completed: $${payout.totalAmount}`);

    res.json({
      message: 'Payout batch completed — all transactions marked as paid',
      payout,
    });
  } catch (error) {
    console.error('Complete payout error:', error.message);
    res.status(500).json({ error: 'Could not complete payout batch' });
  }
});

// GET /api/payouts/rates — Get tier-based cash rates (public info)
router.get('/rates', (req, res) => {
  res.json({ rates: TIER_RATES });
});

module.exports = router;
