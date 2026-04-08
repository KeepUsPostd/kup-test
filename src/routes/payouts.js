// Payout Routes — Transaction ledger + PayPal payout batches
// Rule G5: PayPal Business ONLY for all payouts
// Rule G7: Tier-based cash rates (brands can't set custom amounts)
// Ref: PLATFORM_ARCHITECTURE.md → Cash & Payments
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { Transaction, Payout, InfluencerProfile } = require('../models');
const paypal = require('../config/paypal');

// ── Fee Structure ──────────────────────────────────────────────
// Deducted at the moment the brand pays the influencer.
// Influencer receives clean whole-dollar amount after both fees.
const FEES = {
  paypal: { percent: 0.0299, flat: 0.49 },  // PayPal card transaction fee
  kup:    { flat: 0.50 },                    // KUP platform fee per transaction
};

// ── Tier-Based Cash Rates ─────────────────────────────────────
// Rule G7: Brands cannot override — rates come from influencer tier.
// brandPays = (influencerGets + kupFee + paypalFlat) / (1 - paypalPercent)
// Bonus Cash = 30% of the influencer's base pay (paid separately).
//
// Keys match InfluencerProfile.influenceTier enum values.
// contentType 'video' → video rates, 'photo'/'mixed' → image rates.
const BONUS_CASH_PERCENT = 0.30;

const TIER_RATES = {
  unverified:  { video: { influencerGets: 4,  brandPays: 5.14  }, image: { influencerGets: 2,  brandPays: 3.08  } },
  nano:        { video: { influencerGets: 8,  brandPays: 9.27  }, image: { influencerGets: 4,  brandPays: 5.14  } },
  micro:       { video: { influencerGets: 11, brandPays: 12.36 }, image: { influencerGets: 6,  brandPays: 7.21  } },
  rising:      { video: { influencerGets: 18, brandPays: 19.58 }, image: { influencerGets: 9,  brandPays: 10.30 } },
  established: { video: { influencerGets: 25, brandPays: 26.79 }, image: { influencerGets: 12, brandPays: 13.39 } },
  premium:     { video: { influencerGets: 33, brandPays: 35.04 }, image: { influencerGets: 15, brandPays: 16.48 } },
  celebrity:   { video: { influencerGets: 45, brandPays: 47.41 }, image: { influencerGets: 23, brandPays: 24.73 } },
};

/**
 * Resolve the rate for a given tier + content type.
 * @param {string} tier - InfluencerProfile.influenceTier value
 * @param {string} contentType - 'video', 'photo', or 'mixed'
 * @returns {{ influencerGets: number, brandPays: number }}
 */
function resolveRate(tier, contentType) {
  const rates = TIER_RATES[tier] || TIER_RATES.nano;
  return contentType === 'video' ? rates.video : rates.image;
}

/**
 * Calculate bonus cash for a base influencer payout.
 * @param {number} baseAmount - The influencerGets amount
 * @returns {number} Bonus amount (30% of base, rounded to 2 decimals)
 */
function calcBonusCash(baseAmount) {
  return Math.round(baseAmount * BONUS_CASH_PERCENT * 100) / 100;
}

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

    // For tier-based types, resolve amount from influencer tier + content type
    let resolvedAmount = amount;
    let brandPaysAmount = amount;
    let kupFee = 0;
    let paypalFee = 0;

    if (['cash_per_approval', 'bonus_cash'].includes(type)) {
      const influencer = await InfluencerProfile.findById(payeeInfluencerId);
      if (!influencer) {
        return res.status(404).json({ error: 'Influencer not found' });
      }
      const tier = influencer.influenceTier || 'nano';

      // Determine content type for video vs image rate lookup
      let contentType = req.body.contentType || 'photo';
      if (contentSubmissionId) {
        const { ContentSubmission } = require('../models');
        const sub = await ContentSubmission.findById(contentSubmissionId).select('contentType');
        if (sub) contentType = sub.contentType;
      }

      if (type === 'cash_per_approval') {
        const rate = resolveRate(tier, contentType);
        resolvedAmount = rate.influencerGets;
        brandPaysAmount = rate.brandPays;
      } else if (type === 'bonus_cash') {
        // Bonus = 30% of the base CPA influencerGets for this tier
        const baseRate = resolveRate(tier, contentType);
        resolvedAmount = calcBonusCash(baseRate.influencerGets);
        // Bonus also has fees applied on the brand side
        brandPaysAmount = Math.round(((resolvedAmount + FEES.kup.flat + FEES.paypal.flat) / (1 - FEES.paypal.percent)) * 100) / 100;
      }

      kupFee = FEES.kup.flat;
      paypalFee = Math.round((brandPaysAmount * FEES.paypal.percent + FEES.paypal.flat) * 100) / 100;
    }

    // For postd_pay, amount is required (brand sets manually)
    if (type === 'postd_pay' && (!resolvedAmount || resolvedAmount <= 0)) {
      return res.status(400).json({
        error: 'Amount required for Postd Pay',
        message: 'Postd Pay requires a specific dollar amount.',
      });
    }

    // For postd_pay, calculate fees on the manual amount
    if (type === 'postd_pay') {
      kupFee = FEES.kup.flat;
      brandPaysAmount = Math.round(((resolvedAmount + FEES.kup.flat + FEES.paypal.flat) / (1 - FEES.paypal.percent)) * 100) / 100;
      paypalFee = Math.round((brandPaysAmount * FEES.paypal.percent + FEES.paypal.flat) * 100) / 100;
    }

    const transaction = await Transaction.create({
      payerType: brandId ? 'brand' : 'platform',
      payerBrandId: brandId || null,
      payeeInfluencerId,
      type,
      amount: resolvedAmount,          // What the influencer receives
      brandPaysAmount: brandPaysAmount, // What the brand is charged (gross)
      kupFee: kupFee,                   // KUP platform fee
      paypalFee: paypalFee,             // PayPal processing fee
      currency: 'USD',
      contentSubmissionId: contentSubmissionId || null,
      campaignId: campaignId || null,
      rewardId: rewardId || null,
      status: 'pending',
    });

    console.log(`💰 Transaction created: $${resolvedAmount} to influencer (brand charged $${brandPaysAmount}) ${type} → ${payeeInfluencerId}`);

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

    const rawTransactions = await Transaction.find(filter)
      .populate('payeeInfluencerId', 'displayName handle influenceTier isHidden')
      .populate('payerBrandId', 'name')
      .populate('contentSubmissionId', 'contentType status')
      .sort({ createdAt: -1 })
      .limit(100);

    // Filter out transactions from hidden influencers (auto-created/test accounts)
    const transactions = rawTransactions.filter(t => !t.payeeInfluencerId?.isHidden);

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

    // Fetch all transactions in this batch and their influencer PayPal emails
    const transactions = await Transaction.find({ _id: { $in: payout.transactionIds } });
    const influencerIds = [...new Set(transactions.map(t => t.payeeInfluencerId.toString()))];
    const influencers = await InfluencerProfile.find({ _id: { $in: influencerIds } });
    const influencerMap = {};
    for (const inf of influencers) {
      influencerMap[inf._id.toString()] = inf;
    }

    // Build payout items for PayPal
    const payoutItems = [];
    const missingEmails = [];
    for (const txn of transactions) {
      const inf = influencerMap[txn.payeeInfluencerId.toString()];
      if (!inf || !inf.paypalEmail) {
        missingEmails.push(txn._id);
        continue;
      }
      payoutItems.push({
        email: inf.paypalEmail,
        amount: txn.amount,
        note: `KUP payout: ${txn.type} — ${inf.displayName}`,
      });
    }

    if (missingEmails.length > 0) {
      return res.status(400).json({
        error: 'Some influencers have not connected PayPal',
        missingPayPalTransactions: missingEmails,
        message: `${missingEmails.length} transaction(s) are missing influencer PayPal emails.`,
      });
    }

    // Call PayPal Payouts API
    const batchId = `KUP_BATCH_${payout._id}_${Date.now()}`;
    const paypalResult = await paypal.createPayout(payoutItems, batchId);

    // Update payout with PayPal response
    payout.paypalBatchId = paypalResult.batch_header.payout_batch_id;
    payout.paypalResponse = paypalResult;
    payout.status = 'processing';
    await payout.save();

    // Mark transactions as processing (PayPal webhook will finalize to 'paid')
    await Transaction.updateMany(
      { _id: { $in: payout.transactionIds } },
      { $set: { status: 'processing' } }
    );

    console.log(`📤 Payout batch sent to PayPal: ${payout.paypalBatchId} — $${payout.totalAmount}`);

    res.json({
      message: 'Payout batch sent to PayPal for processing',
      payout,
      paypalBatchId: payout.paypalBatchId,
    });
  } catch (error) {
    console.error('Complete payout error:', error.message);
    res.status(500).json({ error: 'Could not complete payout batch' });
  }
});

// GET /api/payouts/rates — Get tier-based cash rates (public info)
router.get('/rates', (req, res) => {
  res.json({
    rates: TIER_RATES,
    fees: FEES,
    bonusCashPercent: BONUS_CASH_PERCENT,
  });
});

// ── Brand → Influencer Payment Routes ──────────────────────

// POST /api/payouts/pay — Create PayPal order for brand-to-influencer payment
// Brand clicks "Pay" → we create a PayPal order → return approval URL
router.post('/pay', requireAuth, async (req, res) => {
  try {
    const { transactionId } = req.body;

    if (!transactionId) {
      return res.status(400).json({ error: 'transactionId is required' });
    }

    const transaction = await Transaction.findById(transactionId);
    if (!transaction) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    if (transaction.status !== 'pending') {
      return res.status(400).json({
        error: 'Transaction is not pending',
        message: `Transaction status is "${transaction.status}". Only pending transactions can be paid.`,
      });
    }

    // Look up the influencer's PayPal email
    const influencer = await InfluencerProfile.findById(transaction.payeeInfluencerId);
    if (!influencer) {
      return res.status(404).json({ error: 'Influencer not found' });
    }

    if (!influencer.paypalEmail) {
      return res.status(400).json({
        error: 'Influencer has not connected their PayPal account',
      });
    }

    // Build return/cancel URLs
    const baseUrl = process.env.APP_URL || process.env.BASE_URL || 'http://localhost:3001';
    const cancelUrl = `${baseUrl}/pages/inner/cash-account.html?payment=canceled`;
    const returnUrl = `${baseUrl}/api/payouts/pay/capture?transactionId=${transactionId}`;
    const description = `KUP payment: ${transaction.type} to ${influencer.displayName}`;

    // Create PayPal order
    const order = await paypal.createOrder(
      transaction.brandPaysAmount,
      description,
      returnUrl,
      cancelUrl
    );

    // Extract approval URL from PayPal response
    const approvalLink = order.links && order.links.find(l => l.rel === 'payer-action' || l.rel === 'approve');
    const approvalUrl = approvalLink ? approvalLink.href : null;

    // Store order ID on transaction and mark as processing
    transaction.paypalOrderId = order.id;
    transaction.status = 'processing';
    await transaction.save();

    console.log(`💳 PayPal order created: ${order.id} for transaction ${transactionId}`);

    res.json({
      approvalUrl,
      orderId: order.id,
      transaction,
    });
  } catch (error) {
    console.error('Create PayPal order error:', error.message);
    res.status(500).json({ error: 'Could not create PayPal payment' });
  }
});

// GET /api/payouts/pay/capture — PayPal redirects here after brand approves
// No auth required — this is a browser redirect from PayPal
router.get('/pay/capture', async (req, res) => {
  try {
    const { transactionId, token } = req.query;

    if (!transactionId || !token) {
      return res.redirect('/pages/inner/cash-rewards.html?payment=error&reason=missing_params');
    }

    const transaction = await Transaction.findById(transactionId);
    if (!transaction) {
      return res.redirect('/pages/inner/cash-rewards.html?payment=error&reason=transaction_not_found');
    }

    if (transaction.status !== 'processing') {
      return res.redirect('/pages/inner/cash-rewards.html?payment=error&reason=invalid_status');
    }

    // Capture the PayPal order (token is the order ID PayPal sends back)
    const capture = await paypal.captureOrder(token);

    // Extract capture ID from response
    const captureId = capture.purchase_units
      && capture.purchase_units[0]
      && capture.purchase_units[0].payments
      && capture.purchase_units[0].payments.captures
      && capture.purchase_units[0].payments.captures[0]
      && capture.purchase_units[0].payments.captures[0].id;

    // Update transaction as paid
    transaction.status = 'paid';
    transaction.paypalTransactionId = captureId || token;
    transaction.paidAt = new Date();
    await transaction.save();

    // Update influencer's totalCashEarned (also handled by PAYMENT.CAPTURE.COMPLETED webhook — idempotent)
    await InfluencerProfile.findByIdAndUpdate(
      transaction.payeeInfluencerId,
      { $inc: { totalCashEarned: transaction.amount } }
    );

    console.log(`✅ Payment captured: $${transaction.amount} to influencer ${transaction.payeeInfluencerId}`);

    // Redirect to Cash Transactions page so brand sees the confirmed transaction
    res.redirect('/pages/inner/cash-account.html?payment=success');
  } catch (error) {
    console.error('Capture PayPal order error:', error.message);
    res.redirect('/pages/inner/cash-account.html?payment=error&reason=capture_failed');
  }
});

// POST /api/payouts/pay/batch — Process multiple pending transactions at once
// Creates a single PayPal order with the combined total, then marks all as paid after capture
router.post('/pay/batch', requireAuth, async (req, res) => {
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

    // Verify all influencers have PayPal connected
    const influencerIds = [...new Set(transactions.map(t => t.payeeInfluencerId.toString()))];
    const influencers = await InfluencerProfile.find({ _id: { $in: influencerIds } });
    const influencerMap = {};
    for (const inf of influencers) {
      influencerMap[inf._id.toString()] = inf;
    }

    const missingPayPal = [];
    for (const txn of transactions) {
      const inf = influencerMap[txn.payeeInfluencerId.toString()];
      if (!inf || !inf.paypalEmail) {
        missingPayPal.push(txn._id);
      }
    }

    if (missingPayPal.length > 0) {
      return res.status(400).json({
        error: 'Some influencers have not connected PayPal',
        missingPayPalTransactions: missingPayPal,
      });
    }

    // Calculate combined total
    const totalAmount = transactions.reduce((sum, t) => sum + (t.brandPaysAmount || t.amount), 0);
    const roundedTotal = Math.round(totalAmount * 100) / 100;

    // Build return/cancel URLs
    const baseUrl = process.env.APP_URL || process.env.BASE_URL || 'http://localhost:3001';
    const txnIdsParam = transactionIds.join(',');
    const returnUrl = `${baseUrl}/api/payouts/pay/batch/capture?transactionIds=${txnIdsParam}`;
    const cancelUrl = `${baseUrl}/pages/inner/cash-rewards.html?payment=canceled`;
    const description = `KUP batch payment: ${transactions.length} transactions`;

    // Create a single PayPal order for the total
    const order = await paypal.createOrder(roundedTotal, description, returnUrl, cancelUrl);

    const approvalLink = order.links && order.links.find(l => l.rel === 'payer-action' || l.rel === 'approve');
    const approvalUrl = approvalLink ? approvalLink.href : null;

    // Mark all transactions as processing and store order ID
    await Transaction.updateMany(
      { _id: { $in: transactionIds } },
      { $set: { status: 'processing', paypalOrderId: order.id } }
    );

    console.log(`💳 Batch PayPal order created: ${order.id} for ${transactions.length} transactions ($${roundedTotal})`);

    res.json({
      approvalUrl,
      orderId: order.id,
      transactions: transactions.map(t => t._id),
      totalAmount: roundedTotal,
    });
  } catch (error) {
    console.error('Create batch PayPal order error:', error.message);
    res.status(500).json({ error: 'Could not create batch PayPal payment' });
  }
});

// GET /api/payouts/pay/batch/capture — PayPal redirects here after batch approval
// No auth required — browser redirect from PayPal
router.get('/pay/batch/capture', async (req, res) => {
  try {
    const { transactionIds, token } = req.query;

    if (!transactionIds || !token) {
      return res.redirect('/pages/inner/cash-rewards.html?payment=error&reason=missing_params');
    }

    const txnIdArray = transactionIds.split(',');

    // Capture the PayPal order
    const capture = await paypal.captureOrder(token);

    const captureId = capture.purchase_units
      && capture.purchase_units[0]
      && capture.purchase_units[0].payments
      && capture.purchase_units[0].payments.captures
      && capture.purchase_units[0].payments.captures[0]
      && capture.purchase_units[0].payments.captures[0].id;

    // Mark all transactions as paid
    const now = new Date();
    await Transaction.updateMany(
      { _id: { $in: txnIdArray } },
      {
        $set: {
          status: 'paid',
          paypalTransactionId: captureId || token,
          paidAt: now,
        },
      }
    );

    // Update each influencer's totalCashEarned
    const transactions = await Transaction.find({ _id: { $in: txnIdArray } });
    const earningsByInfluencer = {};
    for (const txn of transactions) {
      const infId = txn.payeeInfluencerId.toString();
      earningsByInfluencer[infId] = (earningsByInfluencer[infId] || 0) + txn.amount;
    }

    for (const [infId, earned] of Object.entries(earningsByInfluencer)) {
      await InfluencerProfile.findByIdAndUpdate(infId, { $inc: { totalCashEarned: earned } });
    }

    console.log(`✅ Batch payment captured: ${txnIdArray.length} transactions paid`);

    res.redirect('/pages/inner/cash-rewards.html?payment=success');
  } catch (error) {
    console.error('Capture batch PayPal order error:', error.message);
    res.redirect('/pages/inner/cash-rewards.html?payment=error&reason=capture_failed');
  }
});

module.exports = router;
