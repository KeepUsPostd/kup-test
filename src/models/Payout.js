// Payout Model — PayPal payout batches
// Groups multiple transactions into a single PayPal batch payout
// Ref: DATABASE_SCHEMA.md → payouts
const mongoose = require('mongoose');

const payoutSchema = new mongoose.Schema({
  paypalBatchId: { type: String, unique: true, sparse: true },
  totalAmount: { type: Number, required: true, min: 0 },
  transactionCount: { type: Number, required: true, min: 1 },
  transactionIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Transaction',
  }],

  status: {
    type: String,
    enum: ['created', 'processing', 'completed', 'failed', 'partial'],
    default: 'created',
  },
  initiatedBy: {
    type: String,
    enum: ['system', 'admin'],
    default: 'system',
  },

  initiatedAt: { type: Date, default: Date.now },
  completedAt: { type: Date, default: null },
  paypalResponse: { type: mongoose.Schema.Types.Mixed, default: null },
}, {
  timestamps: true,
});

// Indexes
payoutSchema.index({ status: 1 });
payoutSchema.index({ initiatedAt: 1 });

module.exports = mongoose.model('Payout', payoutSchema);
