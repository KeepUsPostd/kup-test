// Reward Model — Reward configurations created by brands
// Rule R1: One earning method per reward
// Rule R2: No point pooling across rewards
// Rule R4: Cash rates are tier-based (not custom)
// Rule R5: Cash types allow multi-select
// Rule R6: Non-cash types exclusive per reward
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
  imageUrl: { type: String, default: null },
  bannerImageUrl: { type: String, default: null }, // Reward card banner (fallback: brand gradient)

  // Point-based config (when earningMethod = "point_based")
  // Ref: DATABASE_SCHEMA.md → rewards.point_config
  pointConfig: {
    contentEnabled: { type: Boolean, default: false },
    contentPoints: {
      submitted: { type: Number, default: 10 },
      approved: { type: Number, default: 25 },
      published: { type: Number, default: 40 },
      bonus: { type: Number, default: 15 },
    },
    purchaseEnabled: { type: Boolean, default: false },
    purchaseTiers: [{
      spendThreshold: { type: Number },
      pointsEarned: { type: Number },
    }], // max 3 tiers
    gratitudeEnabled: { type: Boolean, default: false },
    gratitudePoints: {
      join: { type: Number, default: 50 },
      birthday: { type: Number, default: 25 },
      anniversary: { type: Number, default: 100 },
    },
    unlockThreshold: { type: Number, default: null }, // legacy single threshold (use levels[] instead)

    // 3-Level Progressive Unlock System
    // Each reward has up to 3 milestone levels based on brand's subscription plan:
    //   Startup: 1 level, Growth: 2 levels, Pro/Agency: 3 levels
    // Points reset to 0 when influencer claims a level reward
    levels: [{
      threshold: { type: Number, required: true },    // points needed to unlock
      rewardType: { type: String, enum: ['discount', 'free'], required: true },
      rewardValue: { type: String, default: null },    // e.g. '10%', '25%', 'Free Sneakers'
      description: { type: String, maxlength: 100, default: null },
    }], // max 3 levels
  },

  // Cash config (for cash_per_approval, bonus_cash, postd_pay)
  // CPA & Bonus rates resolved from influencer tier — not stored here
  cashConfig: {
    budgetCap: { type: Number, default: null }, // optional spending limit
    budgetSpent: { type: Number, default: 0 },
  },

  // Discount config
  discountConfig: {
    discountType: {
      type: String,
      enum: ['percentage', 'fixed', 'freeship'],
      default: null,
    },
    discountValue: { type: Number, default: null },
    discountCode: { type: String, default: null },
    expirationDays: { type: Number, default: null }, // 30, 60, or null (no expiry)
  },

  // Product config
  productConfig: {
    productName: { type: String, default: null },
    productValue: { type: Number, default: null },
    shippingMethod: {
      type: String,
      enum: ['address', 'email', 'pickup'],
      default: null,
    },
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
rewardSchema.index({ earningMethod: 1 });

module.exports = mongoose.model('Reward', rewardSchema);
