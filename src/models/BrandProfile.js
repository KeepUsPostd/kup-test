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
  paypalVaultPaymentTokenId: { type: String, default: null }, // Vault v3: saved payment method for content approval auto-capture
  paypalVaultSetupAt: { type: Date, default: null },
  planStartedAt: { type: Date, default: null },
  planExpiresAt: { type: Date, default: null },

  // 14-day free trial — full Pro access, no CC required
  trialActive: { type: Boolean, default: false },
  trialTier: { type: String, default: 'pro' },  // What tier they get during trial
  trialStartedAt: { type: Date, default: null },
  trialEndsAt: { type: Date, default: null },
  trialExpired: { type: Boolean, default: false },  // True after downgrade to starter

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
brandProfileSchema.index({ trialActive: 1, trialEndsAt: 1 }); // Trial expiry queries
// referralCode already indexed via unique/sparse in field def

module.exports = mongoose.model('BrandProfile', brandProfileSchema);
