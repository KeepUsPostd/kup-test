// Brand Model — Every brand on the platform
// Types: admin (unclaimed), admin_claimed, user-created
// Ref: DATABASE_SCHEMA.md → brands
const mongoose = require('mongoose');

const brandSchema = new mongoose.Schema({
  // Classification
  name: { type: String, required: true },
  brandType: {
    type: String,
    enum: ['admin', 'admin_claimed', 'user'],
    default: 'user',
  },
  profileSource: {
    type: String,
    enum: ['ai_generated', 'manual', 'user'],
    default: 'user',
  },
  createdBy: {
    type: mongoose.Schema.Types.Mixed, // "platform" or ObjectId
    required: true,
  },

  // Claim tracking
  claimStatus: {
    type: String,
    enum: ['unclaimed', 'pending', 'claimed', 'n/a'],
    default: 'n/a',
  },
  claimedAt: { type: Date, default: null },
  claimedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },

  // Brand identity
  category: { type: String, default: null },
  subcategory: { type: String, default: null },
  description: { type: String, maxlength: 500, default: null },
  location: { type: String, default: null },
  websiteUrl: { type: String, default: null },
  email: { type: String, default: null },
  phone: { type: String, default: null },
  address: { type: String, default: null },
  city: { type: String, default: null },
  state: { type: String, default: null },
  zip: { type: String, default: null },
  // GeoJSON Point — for proximity-based feed filtering
  coordinates: {
    type: { type: String, enum: ['Point'] },
    coordinates: { type: [Number] },
  },
  socialLinks: {
    facebook: { type: String, default: null },
    instagram: { type: String, default: null },
    twitter: { type: String, default: null },
    tiktok: { type: String, default: null },
    linkedin: { type: String, default: null },
  },
  tags: [{ type: String }],

  // Visual system
  logoUrl: { type: String, default: null },
  initials: { type: String, maxlength: 4 },
  generatedColor: { type: String, default: null },
  categoryIcon: { type: String, default: null },
  heroImageUrl: { type: String, default: null },
  heroImageSource: {
    type: String,
    enum: ['gradient', 'influencer', 'brand'],
    default: 'gradient',
  },

  // Brand colors (used for gradient backgrounds on rewards, campaigns, profile cards)
  // Fallback chain: custom banner image → brand colors gradient → KUP default gradient
  brandColors: {
    primary: { type: String, default: null },    // e.g., '#ED8444' (hex)
    secondary: { type: String, default: null },  // e.g., '#E84393' (hex)
  },

  // Franchise
  isFranchise: { type: Boolean, default: false },
  parentBrandId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Brand',
    default: null,
  },

  // Stats (denormalized, updated on events)
  totalReviews: { type: Number, default: 0 },
  totalContentPieces: { type: Number, default: 0 },
  totalInfluencersEngaged: { type: Number, default: 0 },
  averageRating: { type: Number, default: null },
  ratingCount: { type: Number, default: 0 },

  // Kiosk Mode Configuration
  kioskEnabled: { type: Boolean, default: false },
  kioskOfferTitle: { type: String, default: 'Leave a review, get a reward!', maxlength: 60 },
  kioskRewardType: {
    type: String,
    enum: ['free_item', 'discount_percent', 'discount_fixed', 'points'],
    default: 'discount_percent',
  },
  kioskRewardValue: { type: String, default: '10% Off' },
  kioskRecordingLimit: { type: Number, default: 60, min: 15, max: 120 }, // seconds
  kioskAutoApprove: { type: Boolean, default: false },
  kioskRequireSmsVerify: { type: Boolean, default: false },
  kioskDailyRewardCap: { type: Number, default: 50, min: 1, max: 500 },
  kioskBrandingColor: { type: String, default: '#FF6B35' }, // hex color
  kioskBrandingLogo: { type: String, default: null }, // URL to logo for kiosk display
  kioskActiveLocations: { type: Number, default: 0 }, // how many kiosks currently active
  kioskBrandCode: { type: String, default: null, unique: true, sparse: true }, // short code for kiosk URL
  brandHandle: { type: String, unique: true, sparse: true, lowercase: true }, // @handle for public profile URL — NO default (sparse requires missing, not null)

  // System
  status: {
    type: String,
    enum: ['active', 'suspended', 'deactivating', 'deleted'],
    default: 'active',
  },
}, {
  timestamps: true,
});

// Indexes
brandSchema.index({ name: 'text' }); // text search
brandSchema.index({ brandType: 1 });
brandSchema.index({ claimStatus: 1 });
brandSchema.index({ category: 1 });
brandSchema.index({ isFranchise: 1 });
brandSchema.index({ parentBrandId: 1 }, { sparse: true });
brandSchema.index({ status: 1 });
brandSchema.index({ tags: 1 });
brandSchema.index({ createdBy: 1 });
brandSchema.index({ coordinates: '2dsphere' }, { sparse: true });

module.exports = mongoose.model('Brand', brandSchema);
