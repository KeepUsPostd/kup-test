// Brand Profile Model — Brand-owner identity
// Max 1 per user. Ref: DATABASE_SCHEMA.md → brand_profiles
const mongoose = require('mongoose');

const brandProfileSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
  },

  // Links to brands this user owns
  primaryBrandId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Brand',
    default: null,
  },
  ownedBrandIds: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Brand',
  }],

  // Subscription & billing (PayPal Business — NOT Stripe)
  planTier: {
    type: String,
    enum: ['starter', 'growth', 'pro', 'agency', 'enterprise'],
    default: 'starter',
  },
  billingCycle: {
    type: String,
    enum: ['monthly', 'annual'],
    default: null,
  },
  paypalCustomerId: { type: String, default: null },
  paypalSubscriptionId: { type: String, default: null },
  planStartedAt: { type: Date, default: null },
  planExpiresAt: { type: Date, default: null },

  // Referral
  referralCode: { type: String, unique: true, sparse: true },
  referredBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BrandProfile',
    default: null,
  },
}, {
  timestamps: true,
});

// Indexes
brandProfileSchema.index({ primaryBrandId: 1 });
brandProfileSchema.index({ planTier: 1 });
// referralCode already indexed via unique/sparse in field def

module.exports = mongoose.model('BrandProfile', brandProfileSchema);
