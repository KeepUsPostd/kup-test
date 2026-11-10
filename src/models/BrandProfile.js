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

  // Admin feature-override lock.
  // Set to true when an admin upgrades a brand's planTier via the
  // /override-features endpoint without changing their PayPal subscription
  // (e.g. partner deals: subscription stays at Growth $29/mo, planTier upgraded
  // to Agency for feature access). Prevents the billing/confirm flow from
  // resetting planTier back to subscription.planTier on any re-confirm.
  // Cancellation webhooks DO clear this (back to starter is the correct exit).
  planTierLockedByAdmin: { type: Boolean, default: false },
  planTierLockedAt: { type: Date, default: null },
  planTierLockedBy: { type: String, default: null }, // admin email for audit

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

  // Instant Review Widget — the brand's website-embed review capture feature.
  // When true, /brand/:brandCode/review is publicly accessible for anyone to
  // record a review directly from the brand's website (no app required).
  // When false, the widget page returns a "not available" state and the brand
  // portal hides the widget config panel. Defaults ON at launch — this feature
  // ships to all brands day 1, but the flag preserves the ability to disable
  // per-brand if a brand ever asks for privacy (e.g. content-sensitive vertical).
  embedWidgetEnabled: { type: Boolean, default: true, index: true },

  // Tracks lifetime approved reviews collected via the Instant Review Widget.
  // Denormalized rollup — recomputed on approval. Read by portal analytics
  // and by the free-plan monthly-approval cap enforcement.
  embedApprovalsLifetime: { type: Number, default: 0 },

  // Brand-authored review guidance shown on the Instant Review Widget page
  // just below the reward card. Renders as a dashed-border "note pinned by
  // the brand" — signals what makes a great review for THIS brand
  // specifically. When empty/null the widget shows a KUP-authored default
  // that gives universal guidance ("Share your honest experience — a quick
  // intro, what stood out, and why it mattered"). Editable from the brand
  // portal's Instant Review panel (Phase 4).
  reviewBriefing: { type: String, default: null, maxlength: 1000 },

  // Optional per-brand Instant Review consent wording. When set, it replaces
  // the default lead-in on the required checkbox. KeepUsPostd's Terms and
  // Privacy sentence always follows it and cannot be removed.
  widgetConsentText: { type: String, default: null, maxlength: 600 },

  // Optional per-brand marketing opt-in. When set, the widget shows a second,
  // UNCHECKED, optional checkbox with this label. Brands can only export the
  // contact details of reviewers who ticked it.
  widgetOptInText: { type: String, default: null, maxlength: 300 },

  // The word the Instant Review page uses for what people record. Causes and
  // campaigns use 'video' so reviewers are not asked to "review" a person.
  widgetNoun: { type: String, enum: ['review', 'video'], default: 'review' },
}, {
  timestamps: true,
});

// Indexes
brandProfileSchema.index({ primaryBrandId: 1 });
brandProfileSchema.index({ planTier: 1 });
brandProfileSchema.index({ trialActive: 1, trialEndsAt: 1 }); // Trial expiry queries
// referralCode already indexed via unique/sparse in field def

module.exports = mongoose.model('BrandProfile', brandProfileSchema);
