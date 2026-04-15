// Influencer Profile Model — Public-facing influencer identity
// Max 1 per user. Ref: DATABASE_SCHEMA.md → influencer_profiles
const mongoose = require('mongoose');

const influencerProfileSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,
  },

  // Public identity — every creator needs these to be visible on the platform.
  // Set from existing user data (name from registration, handle from email).
  // Creators can enhance these later through the native app.
  displayName: { type: String, required: true, maxlength: 30 },
  handle: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    maxlength: 20,
  },
  avatarUrl: { type: String, default: null },
  bio: { type: String, maxlength: 150, default: null },
  coverImageUrl: { type: String, default: null },

  // Influence verification
  influenceTier: {
    type: String,
    enum: ['unverified', 'startup', 'nano', 'micro', 'rising', 'established', 'premium', 'celebrity'],
    default: 'unverified',
  },
  realFollowerCount: { type: Number, default: null },
  influenceScore: { type: Number, default: null, min: 0, max: 100 },
  isVerified: { type: Boolean, default: false },
  verificationPending: { type: Boolean, default: false },
  verificationPendingAt: { type: Date, default: null },
  pendingVerificationData: { type: mongoose.Schema.Types.Mixed, default: null },
  // stores: { handles: {instagram, tiktok, etc}, followerCount: number, engagementRate: number }
  verifiedAt: { type: Date, default: null },
  lastVerificationAt: { type: Date, default: null },

  // Creator progression
  creatorTier: {
    type: String,
    enum: ['newcomer', 'reviewer', 'verified_reviewer', 'featured_creator', 'top_creator'],
    default: 'newcomer',
  },
  totalReviews: { type: Number, default: 0 },
  adminBrandReviews: { type: Number, default: 0 },
  campaignAccessUnlocked: { type: Boolean, default: false },

  // Aggregated stats (denormalized)
  totalBrandsPartnered: { type: Number, default: 0 },
  totalPointsEarned: { type: Number, default: 0 },
  totalCashEarned: { type: Number, default: 0 },

  // Purchase points balance — awarded by brands when influencer makes qualifying purchases
  purchasePointsBalance: { type: Number, default: 0, min: 0 },
  totalPurchasePointsEarned: { type: Number, default: 0, min: 0 }, // lifetime total (never decremented)
  averageRating: { type: Number, default: null },
  ratingCount: { type: Number, default: 0 },

  // Preferences
  interests: [{ type: String }],
  notificationPrefs: {
    pushEnabled: { type: Boolean, default: true },
    emailEnabled: { type: Boolean, default: true },
    bonusAlerts: { type: Boolean, default: true },
    campaignAlerts: { type: Boolean, default: true },
  },

  // Social links — handles per platform (instagram, tiktok, youtube, twitter, etc.)
  socialLinks: {
    type: Map,
    of: String,
    default: {},
  },

  // Engagement rate (0–100, stored as a percentage e.g. 4.2 = 4.2%)
  engagementRate: { type: Number, default: null },

  // Payment — PayPal
  // paypalEmail: used for Payouts API cashouts (KUP → influencer bonuses/withdrawals)
  // paypalMerchantId: PPCP merchant ID — enables direct brand → influencer routing
  paypalEmail: { type: String, default: null },
  paypalConnectedAt: { type: Date, default: null },

  // PPCP Merchant Onboarding (brand → influencer direct payments)
  paypalMerchantId: { type: String, default: null },          // Assigned by PayPal after PPCP onboarding
  paypalOnboardingStatus: {
    type: String,
    enum: ['not_started', 'pending', 'completed', 'failed'],
    default: 'not_started',
  },
  paypalTrackingId: { type: String, default: null },          // Our internal ID used during onboarding flow

  // Platform visibility — hidden influencers are auto-created or test accounts
  // that should not appear in brand portal views on the website.
  // Does NOT affect native app — influencer can still use the app normally.
  isHidden: { type: Boolean, default: false },

  // Referral
  referralCode: { type: String, unique: true, sparse: true },
}, {
  timestamps: true,
});

// Indexes
influencerProfileSchema.index({ influenceTier: 1 });
influencerProfileSchema.index({ creatorTier: 1 });
influencerProfileSchema.index({ isVerified: 1 });
influencerProfileSchema.index({ interests: 1 });
// referralCode already indexed via unique/sparse in field def

module.exports = mongoose.model('InfluencerProfile', influencerProfileSchema);
