// Transaction Model — All money movement on the platform
// Single ledger for cash rewards, bonuses, postd pay, payouts
// Ref: DATABASE_SCHEMA.md → transactions
const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  // Parties
  payerType: {
    type: String,
    enum: ['brand', 'platform'],
    required: true,
  },
  payerBrandId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Brand',
    default: null,
  },
  payeeInfluencerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'InfluencerProfile',
    required: true,
  },

  // Type of payment
  type: {
    type: String,
    enum: [
      'cash_per_approval',
      'bonus_cash',
      'postd_pay',
      'viral_bonus',
      'platform_bonus',
      'referral_bonus',
    ],
    required: true,
  },

  // Amount breakdown
  amount: { type: Number, required: true, min: 0 },          // What the influencer receives (net)
  brandPaysAmount: { type: Number, default: null, min: 0 },  // What the brand is charged (gross)
  kupFee: { type: Number, default: 0, min: 0 },              // KUP platform fee ($0.50)
  paypalFee: { type: Number, default: 0, min: 0 },           // PayPal processing fee
  currency: { type: String, default: 'USD' },

  // Context (what triggered this payment)
  contentSubmissionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ContentSubmission',
    default: null,
  },
  campaignId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Campaign',
    default: null,
  },
  rewardId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Reward',
    default: null,
  },

  // Payout tracking
  status: {
    type: String,
    enum: ['pending', 'processing', 'paid', 'failed', 'refunded'],
    default: 'pending',
  },
  payoutId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Payout',
    default: null,
  },
  paypalOrderId: { type: String, default: null },
  paypalTransactionId: { type: String, default: null },

  // Wallet: links this transaction to a cashout (prevents double-counting)
  withdrawalId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Withdrawal',
    default: null,
  },

  paidAt: { type: Date, default: null },
  failedReason: { type: String, default: null },
}, {
  timestamps: true,
});

// Indexes
transactionSchema.index({ payeeInfluencerId: 1, status: 1 });
transactionSchema.index({ payerBrandId: 1, type: 1 });
transactionSchema.index({ status: 1 });
transactionSchema.index({ type: 1 });
transactionSchema.index({ contentSubmissionId: 1 }, { sparse: true });
transactionSchema.index({ createdAt: 1 });

module.exports = mongoose.model('Transaction', transactionSchema);
