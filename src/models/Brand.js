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
  tags: [{ type: String }],

  // Visual system
  logoUrl: { type: String, default: null },
  initials: { type: String, maxlength: 2 },
  generatedColor: { type: String, default: null },
  categoryIcon: { type: String, default: null },
  heroImageUrl: { type: String, default: null },
  heroImageSource: {
    type: String,
    enum: ['gradient', 'influencer', 'brand'],
    default: 'gradient',
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

module.exports = mongoose.model('Brand', brandSchema);
