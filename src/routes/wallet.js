// Wallet Routes — Influencer earnings, transaction history, and PayPal payouts
// Vault flow: brand pays KUP → KUP immediately pays influencer via Payouts API
// App mirrors transactions as an "Earn Dashboard" for the wallet feel
// Rule G5: PayPal Business ONLY
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { InfluencerProfile, Transaction, Withdrawal } = require('../models');
const paypal = require('../config/paypal');

// ── Constants ────────────────────────────────────────────────
const MINIMUM_CASHOUT = 5.00;              // Minimum cashout amount in USD
const PAYPAL_PAYOUT_FEE = 0.25;           // PayPal Payouts API fee per item (KUP absorbs)

// ── GET /api/wallet/balance — Earn Dashboard stats ──
router.get('/balance', requireAuth, async (req, res) => {
  try {
    const influencer = await InfluencerProfile.findOne({ userId: req.user._id });
    if (!influencer) {
      return res.status(404).json({
        error: 'Influencer profile not found',
        message: 'You need an influencer profile to view your earnings.',
      });
    }

    // Paid to You: all paid transactions (auto-payout already sent to their PayPal)
    const paidResult = await Transaction.aggregate([
      {
        $match: {
          payeeInfluencerId: influencer._id,
          status: 'paid',
        },
      },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    const paidToYou = paidResult.length > 0 ? paidResult[0].total : 0;

    // This Month: paid transactions from current calendar month
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const thisMonthResult = await Transaction.aggregate([
      {
        $match: {
          payeeInfluencerId: influencer._id,
          status: 'paid',
          paidAt: { $gte: startOfMonth },
        },
      },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    const thisMonth = thisMonthResult.length > 0 ? thisMonthResult[0].total : 0;

    // Approved Submissions: count of paid transactions
    const approvedCount = await Transaction.countDocuments({
      payeeInfluencerId: influencer._id,
      status: 'paid',
    });

    // Next Payout: pending transactions (awaiting brand approval/payment)
    const pendingResult = await Transaction.aggregate([
      {
        $match: {
          payeeInfluencerId: influencer._id,
          status: { $in: ['pending', 'processing'] },
        },
      },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    const nextPayout = pendingResult.length > 0 ? pendingResult[0].total : 0;

    // Lifetime: everything earned
    const lifetime = Math.round((paidToYou + nextPayout) * 100) / 100;

    // Legacy: withdrawn total (for backward compat)
    const withdrawnResult = await Withdrawal.aggregate([
      {
        $match: {
          influencerProfileId: influencer._id,
          status: 'completed',
        },
      },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    const withdrawn = withdrawnResult.length > 0 ? withdrawnResult[0].total : 0;

    console.log(`💰 Earn dashboard for ${influencer.displayName}: $${paidToYou} paid, $${thisMonth} this month, $${nextPayout} pending, ${approvedCount} approvals`);

    res.json({
      // Earn Dashboard fields
      paidToYou: Math.round(paidToYou * 100) / 100,
      thisMonth: Math.round(thisMonth * 100) / 100,
      approvedCount,
      nextPayout: Math.round(nextPayout * 100) / 100,
      lifetime,

      // Legacy fields (backward compat with old wallet page)
      available: Math.round(paidToYou * 100) / 100,
      pending: Math.round(nextPayout * 100) / 100,
      withdrawn: Math.round(withdrawn * 100) / 100,

      currency: 'USD',
      paypalConnected: !!influencer.paypalEmail,
    });
  } catch (error) {
    console.error('Wallet balance error:', error.message);
    res.status(500).json({ error: 'Could not fetch wallet balance' });
  }
});

// ── GET /api/wallet/transactions — Get influencer's transaction history ──
router.get('/transactions', requireAuth, async (req, res) => {
  try {
    const influencer = await InfluencerProfile.findOne({ userId: req.user._id });
    if (!influencer) {
      return res.status(404).json({
        error: 'Influencer profile not found',
        message: 'You need an influencer profile to view transactions.',
      });
    }

    const { status, type, page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const skip = (pageNum - 1) * limitNum;

    // Build filter
    const filter = { payeeInfluencerId: influencer._id };
    if (status) filter.status = status;
    if (type) filter.type = type;

    // Get total count for pagination
    const total = await Transaction.countDocuments(filter);

    // Fetch paginated transactions
    const transactions = await Transaction.find(filter)
      .populate('payerBrandId', 'name')
      .populate('contentSubmissionId', 'contentType status')
      .populate('withdrawalId', 'status completedAt')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum);

    // Calculate totals for the filtered set
    const totalsResult = await Transaction.aggregate([
      { $match: filter },
      {
        $group: {
          _id: null,
          totalAmount: { $sum: '$amount' },
          count: { $sum: 1 },
        },
      },
    ]);
    const totals = totalsResult.length > 0
      ? { totalAmount: totalsResult[0].totalAmount, count: totalsResult[0].count }
      : { totalAmount: 0, count: 0 };

    res.json({
      transactions,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        pages: Math.ceil(total / limitNum),
      },
      totals,
    });
  } catch (error) {
    console.error('Wallet transactions error:', error.message);
    res.status(500).json({ error: 'Could not fetch transactions' });
  }
});

// ── POST /api/wallet/cashout — Request a cash-out to PayPal ──
// Note: With Vault auto-payout, most transactions are already paid out.
// This cashout is a fallback for transactions that weren't auto-paid
// (e.g. influencer had no PayPal email at time of approval, payout failed, etc.)
router.post('/cashout', requireAuth, async (req, res) => {
  try {
    const influencer = await InfluencerProfile.findOne({ userId: req.user._id });
    if (!influencer) {
      return res.status(404).json({
        error: 'Influencer profile not found',
        message: 'You need an influencer profile to cash out.',
      });
    }

    // Validate PayPal connection
    if (!influencer.paypalEmail) {
      return res.status(400).json({
        error: 'PayPal not connected',
        message: 'Please connect your PayPal account before cashing out. Go to Settings → Payment to add your PayPal email.',
      });
    }

    // Check for existing pending cashout
    const pendingCashout = await Withdrawal.findOne({
      influencerProfileId: influencer._id,
      status: 'processing',
    });
    if (pendingCashout) {
      return res.status(400).json({
        error: 'Cashout already in progress',
        message: 'You have a pending cashout. Please wait for it to complete before requesting another.',
        existingWithdrawal: pendingCashout._id,
      });
    }

    // Available for cashout: paid, NOT already auto-paid, NOT already withdrawn
    const availableResult = await Transaction.aggregate([
      {
        $match: {
          payeeInfluencerId: influencer._id,
          status: 'paid',
          withdrawalId: null,
          payoutSentAt: null,  // Skip transactions already auto-paid via Vault
        },
      },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    const availableBalance = availableResult.length > 0 ? availableResult[0].total : 0;

    // Determine cashout amount (full balance if not specified)
    let cashoutAmount = req.body.amount
      ? parseFloat(req.body.amount)
      : availableBalance;

    cashoutAmount = Math.round(cashoutAmount * 100) / 100;

    // Validate amount
    if (isNaN(cashoutAmount) || cashoutAmount <= 0) {
      return res.status(400).json({
        error: 'Invalid amount',
        message: 'Cashout amount must be a positive number.',
      });
    }

    if (cashoutAmount < MINIMUM_CASHOUT) {
      return res.status(400).json({
        error: 'Below minimum cashout',
        message: `Minimum cashout amount is $${MINIMUM_CASHOUT.toFixed(2)}. Your requested amount: $${cashoutAmount.toFixed(2)}.`,
        minimumCashout: MINIMUM_CASHOUT,
      });
    }

    if (cashoutAmount > Math.round(availableBalance * 100) / 100) {
      return res.status(400).json({
        error: 'Insufficient balance',
        message: `You requested $${cashoutAmount.toFixed(2)} but your available balance is $${availableBalance.toFixed(2)}.`,
        available: Math.round(availableBalance * 100) / 100,
      });
    }

    // Find the transactions to cover this cashout (oldest first — FIFO)
    // Only grab transactions NOT already auto-paid
    const eligibleTransactions = await Transaction.find({
      payeeInfluencerId: influencer._id,
      status: 'paid',
      withdrawalId: null,
      payoutSentAt: null,
    }).sort({ createdAt: 1 });

    const coveredTransactionIds = [];
    let runningTotal = 0;
    for (const txn of eligibleTransactions) {
      if (runningTotal >= cashoutAmount) break;
      coveredTransactionIds.push(txn._id);
      runningTotal += txn.amount;
    }

    // Create the Withdrawal record
    const withdrawal = await Withdrawal.create({
      influencerProfileId: influencer._id,
      amount: cashoutAmount,
      paypalPayoutFee: PAYPAL_PAYOUT_FEE,
      paypalEmail: influencer.paypalEmail,
      status: 'processing',
      transactionIds: coveredTransactionIds,
    });

    // Mark covered transactions with this withdrawalId
    await Transaction.updateMany(
      { _id: { $in: coveredTransactionIds } },
      { $set: { withdrawalId: withdrawal._id, payoutMethod: 'manual_cashout' } }
    );

    // Send via PayPal Payouts API
    const batchId = `KUP_CASHOUT_${withdrawal._id}_${Date.now()}`;
    let paypalBatchId = null;

    try {
      const paypalResult = await paypal.createPayout(
        [{
          email: influencer.paypalEmail,
          amount: cashoutAmount,
          note: `KeepUsPostd cashout — $${cashoutAmount.toFixed(2)} to ${influencer.displayName}`,
        }],
        batchId
      );

      paypalBatchId = paypalResult.batch_header?.payout_batch_id || null;
      withdrawal.paypalBatchId = paypalBatchId;

      // Extract payout item ID if available
      if (paypalResult.items && paypalResult.items.length > 0) {
        withdrawal.paypalPayoutItemId = paypalResult.items[0].payout_item_id || null;
      }

      await withdrawal.save();

      console.log(`💸 Cashout initiated: $${cashoutAmount.toFixed(2)} → ${influencer.paypalEmail} (batch: ${paypalBatchId})`);
    } catch (paypalError) {
      // PayPal call failed — roll back the withdrawal
      console.error('PayPal payout failed:', paypalError.message);

      withdrawal.status = 'failed';
      withdrawal.failedReason = paypalError.message;
      await withdrawal.save();

      // Un-link transactions so they're available again
      await Transaction.updateMany(
        { _id: { $in: coveredTransactionIds } },
        { $set: { withdrawalId: null, payoutMethod: null } }
      );

      return res.status(502).json({
        error: 'PayPal payout failed',
        message: 'Could not send payment to PayPal. Your balance has not been affected. Please try again later.',
        details: paypalError.message,
      });
    }

    res.status(201).json({
      message: `Cashout of $${cashoutAmount.toFixed(2)} initiated! Funds will arrive in your PayPal account shortly.`,
      withdrawal,
      paypalBatchId,
    });
  } catch (error) {
    console.error('Cashout error:', error.message);
    res.status(500).json({ error: 'Could not process cashout' });
  }
});

// ── GET /api/wallet/cashouts — Get cashout/withdrawal history ──
router.get('/cashouts', requireAuth, async (req, res) => {
  try {
    const influencer = await InfluencerProfile.findOne({ userId: req.user._id });
    if (!influencer) {
      return res.status(404).json({
        error: 'Influencer profile not found',
        message: 'You need an influencer profile to view cashout history.',
      });
    }

    const withdrawals = await Withdrawal.find({ influencerProfileId: influencer._id })
      .sort({ createdAt: -1 })
      .limit(100);

    // Summary stats
    const completed = withdrawals.filter(w => w.status === 'completed');
    const stats = {
      totalWithdrawals: withdrawals.length,
      completedCount: completed.length,
      totalWithdrawn: completed.reduce((sum, w) => sum + w.amount, 0),
      processingCount: withdrawals.filter(w => w.status === 'processing').length,
      failedCount: withdrawals.filter(w => w.status === 'failed').length,
    };

    res.json({ withdrawals, stats });
  } catch (error) {
    console.error('Cashout history error:', error.message);
    res.status(500).json({ error: 'Could not fetch cashout history' });
  }
});

// ── GET /api/wallet/cashout/:id/status — Check status of a specific cashout ──
router.get('/cashout/:id/status', requireAuth, async (req, res) => {
  try {
    const influencer = await InfluencerProfile.findOne({ userId: req.user._id });
    if (!influencer) {
      return res.status(404).json({
        error: 'Influencer profile not found',
      });
    }

    const withdrawal = await Withdrawal.findOne({
      _id: req.params.id,
      influencerProfileId: influencer._id,
    });

    if (!withdrawal) {
      return res.status(404).json({
        error: 'Withdrawal not found',
        message: 'This cashout does not exist or does not belong to your account.',
      });
    }

    // If still processing and we have a PayPal batch ID, sync status from PayPal
    if (withdrawal.status === 'processing' && withdrawal.paypalBatchId) {
      try {
        const batchDetails = await paypal.getPayoutBatch(withdrawal.paypalBatchId);
        const batchStatus = batchDetails.batch_header?.batch_status;

        if (batchStatus === 'SUCCESS') {
          withdrawal.status = 'completed';
          withdrawal.completedAt = new Date();

          // Try to grab the payout item ID
          if (batchDetails.items && batchDetails.items.length > 0) {
            withdrawal.paypalPayoutItemId = batchDetails.items[0].payout_item_id || withdrawal.paypalPayoutItemId;
          }

          await withdrawal.save();
          console.log(`✅ Cashout completed (synced): $${withdrawal.amount} → ${withdrawal.paypalEmail}`);
        } else if (batchStatus === 'DENIED' || batchStatus === 'CANCELED') {
          withdrawal.status = 'failed';
          withdrawal.failedReason = `PayPal batch ${batchStatus.toLowerCase()}`;
          await withdrawal.save();

          // Un-link transactions so they're available again
          await Transaction.updateMany(
            { _id: { $in: withdrawal.transactionIds } },
            { $set: { withdrawalId: null, payoutMethod: null } }
          );
          console.log(`❌ Cashout failed (synced): ${withdrawal.paypalBatchId} — ${batchStatus}`);
        }
        // If still PENDING or PROCESSING on PayPal side, leave as-is
      } catch (syncError) {
        console.warn('Could not sync cashout status from PayPal:', syncError.message);
        // Non-fatal — just return what we have
      }
    }

    res.json({
      withdrawal,
      paypalSynced: withdrawal.status !== 'processing', // true if we got a final status
    });
  } catch (error) {
    console.error('Cashout status error:', error.message);
    res.status(500).json({ error: 'Could not fetch cashout status' });
  }
});

module.exports = router;
