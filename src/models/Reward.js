// Reward Model — Reward configurations created by brands
// Rule R1: One earning method per reward
// Rule R2: No point pooling across rewards
// Ref: DATABASE_SCHEMA.md → rewards
const mongoose = require('mongoose');

const rewardSchema = new mongoose.Schema({
  brandId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Brand',
    required: true,
  },

  // Type & earning method
  type: {
    type: String,
    enum: [
      'points_store_credit',
      'free_product',
      'discount',
      'cash_per_approval',
      'bonus_cash',
      'postd_pay',
    ],
    required: true,
  },
  earningMethod: {
    type: String,
    enum: ['point_based', 'per_approval'],
    default: null, // null for cash types
  },

  // Details
  title: { type: String, required: true, maxlength: 21 },
  description: { type: String, maxlength: 85, default: null },

  // Point-based config (when earningMethod = "point_based")
  pointConfig: {
    pointsPerAction: { type: Number, default: null },
    pointsToRedeem: { type: Number, default: null },
    rewardValue: { type: String, default: null },
  },

  // Cash config (when type includes "cash")
  cashConfig: {
    amountPerApproval: { type: Number, default: null },
    currency: { type: String, default: 'USD' },
  },

  // Discount config
  discountConfig: {
    discountType: {
      type: String,
      enum: ['percentage', 'fixed'],
      default: null,
    },
    discountValue: { type: Number, default: null },
    discountCode: { type: String, default: null },
  },

  // Product config
  productConfig: {
    productName: { type: String, default: null },
    productDescription: { type: String, default: null },
    productImageUrl: { type: String, default: null },
  },

  // Status
  status: {
    type: String,
    enum: ['active', 'draft', 'paused', 'ended'],
    default: 'draft',
  },

  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
}, {
  timestamps: true,
});

// Indexes
rewardSchema.index({ brandId: 1, status: 1 });
rewardSchema.index({ type: 1 });

module.exports = mongoose.model('Reward', rewardSchema);
