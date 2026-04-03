// PurchasePointsLog Model
// Records every purchase points award — one doc per transaction.
// Used for brand stats, influencer balance, and audit trail.
const mongoose = require('mongoose');

const purchasePointsLogSchema = new mongoose.Schema({
  brandId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Brand',
    required: true,
  },

  // Who received the points — at least one of these will be set
  influencerProfileId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'InfluencerProfile',
    default: null,
  },
  guestReviewerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'GuestReviewer',
    default: null,
  },

  // Customer name/email for display (denormalized so it survives profile changes)
  customerName:  { type: String, default: null },
  customerEmail: { type: String, default: null },

  channel: {
    type: String,
    enum: ['instore', 'online'],
    required: true,
  },

  spendAmount:   { type: Number, required: true, min: 0 },  // $ spent
  pointsAwarded: { type: Number, required: true, min: 0 },  // pts earned
  levelMatched:  { type: Number, default: 0 },              // 1, 2, or 3 (0 = below floor)

  // In-store: who processed the transaction
  processedBy: { type: String, default: null },

  // Online: e-commerce order reference
  orderRef: { type: String, default: null },

  awardedAt: { type: Date, default: Date.now },
}, { timestamps: true });

// Indexes for stats queries
purchasePointsLogSchema.index({ brandId: 1, awardedAt: -1 });
purchasePointsLogSchema.index({ influencerProfileId: 1, awardedAt: -1 });
purchasePointsLogSchema.index({ brandId: 1, channel: 1 });

module.exports = mongoose.model('PurchasePointsLog', purchasePointsLogSchema);
