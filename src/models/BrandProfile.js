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

  // Brand-Direct PPCP: brand pays influencer directly (KUP gets platform fee)
  brandPaypalMerchantId: { type: String, default: null },
  brandPaypalOnboardingStatus: {
    type: String,
    enum: ['not_started', 'pending', 'completed'],
    default: 'not_started',
  },
  brandPaypalTrackingId: { type: String, default: null },
  brandPaypalConnectedAt: { type: Date, default: null },
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

  // Account credit — balance in USD cents accumulated from referral rewards and other credits.
  // 100 = $1.00. Applied as a discount on future billing (manual process for now).
  accountCredit: { type: Number, default: 0, min: 0 },

  // Tracks whether the referral reward has already been paid out to the referrer
  // so we never double-credit on plan changes or re-activations.
  referralRewardDisbursed: { type: Boolean, default: false },

  // Date the brand first activated a qualifying paid plan (used for 30-day hold).
  paidPlanActivatedAt: { type: Date, default: null },

  // Whether this brand received the referred-brand 10% discount on first subscription.
  referralDiscountApplied: { type: Boolean, default: false },
}, {
  timestamps: true,
});

// Indexes
brandProfileSchema.index({ primaryBrandId: 1 });
brandProfileSchema.index({ planTier: 1 });
brandProfileSchema.index({ trialActive: 1, trialEndsAt: 1 }); // Trial expiry queries
// referralCode already indexed via unique/sparse in field def

module.exports = mongoose.model('BrandProfile', brandProfileSchema);
