// Subscription Model — Brand plan subscriptions (PayPal Business)
// Rule G5: All payments via PayPal Business — no Stripe, no bank transfer
// Ref: DATABASE_SCHEMA.md → subscriptions
const mongoose = require('mongoose');

const subscriptionSchema = new mongoose.Schema({
  brandProfileId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'BrandProfile',
    required: true,
  },

  // PayPal identifiers
  paypalSubscriptionId: { type: String, unique: true, sparse: true },
  paypalCustomerId: { type: String, default: null },
  paypalPayerEmail: { type: String, default: null }, // encrypted in production

  // Plan details
  planTier: {
    type: String,
    enum: ['starter', 'growth', 'pro', 'agency', 'enterprise'],
    required: true,
  },
  billingCycle: {
    type: String,
    enum: ['monthly', 'annual'],
    default: 'monthly',
  },

  // Status lifecycle
  status: {
    type: String,
    enum: ['active', 'past_due', 'canceled', 'trialing'],
    default: 'trialing',
  },

  // Billing period
  currentPeriodStart: { type: Date, default: null },
  currentPeriodEnd: { type: Date, default: null },
  cancelAtPeriodEnd: { type: Boolean, default: false },

  // 7-day grace period tracking
  trialEnd: { type: Date, default: null },
  gracePeriodEligible: { type: Boolean, default: true },
}, {
  timestamps: true,
});

// Indexes
subscriptionSchema.index({ brandProfileId: 1 });
subscriptionSchema.index({ status: 1 });

module.exports = mongoose.model('Subscription', subscriptionSchema);
