// Withdrawal Model — Tracks influencer cash-out requests
// When an influencer cashes out their available balance, a Withdrawal record
// is created and the funds are sent via PayPal Payouts API.
// Ref: wallet.js routes
const mongoose = require('mongoose');

const withdrawalSchema = new mongoose.Schema({
  influencerProfileId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'InfluencerProfile',
    required: true,
  },
  amount: { type: Number, required: true, min: 0 },        // Amount sent to influencer
  paypalPayoutFee: { type: Number, default: 0.25 },         // PayPal Payouts API fee (KUP absorbs)
  paypalEmail: { type: String, required: true },             // Snapshot of email at time of cashout
  paypalBatchId: { type: String, default: null },
  paypalPayoutItemId: { type: String, default: null },

  status: {
    type: String,
    enum: ['processing', 'completed', 'failed', 'returned'],
    default: 'processing',
  },

  // Which transactions this cashout covers
  transactionIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Transaction',
  }],

  completedAt: { type: Date, default: null },
  failedReason: { type: String, default: null },
}, {
  timestamps: true,
});

// Indexes
withdrawalSchema.index({ influencerProfileId: 1, status: 1 });
withdrawalSchema.index({ paypalBatchId: 1 }, { sparse: true });

module.exports = mongoose.model('Withdrawal', withdrawalSchema);
