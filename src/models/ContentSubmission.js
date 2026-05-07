// Content Submission Model — Influencer-submitted content
// Lifecycle: submitted → approved/rejected → postd
// Content ownership: brand owns on submission (PLATFORM_ARCHITECTURE.md)
// Ref: DATABASE_SCHEMA.md → content_submissions
const mongoose = require('mongoose');

const contentSubmissionSchema = new mongoose.Schema({
  influencerProfileId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'InfluencerProfile',
    required: true,
  },
  brandId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Brand',
    required: true,
  },
  campaignId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Campaign',
    default: null, // null for non-campaign content (admin brand reviews)
  },
  partnershipId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Partnership',
    default: null,
  },

  // Content
  contentType: {
    type: String,
    enum: ['photo', 'video', 'mixed'],
    required: true,
  },
  caption: { type: String, maxlength: 500, default: null },
  mediaUrls: [{ type: String }],              // Current/active version (starts as original, updated on edit)
  originalMediaUrls: [{ type: String }],       // Influencer's original submission (never changes after first edit)
  posterUrl: { type: String, default: null },  // Server-generated thumbnail (first frame of video)
  editedMediaUrls: [{ type: String }],         // Brand-edited versions (trimmed, cropped, etc.)

  // Tagged catalog items (influencer selects during capture flow)
  taggedItems: [{
    catalogItemId: { type: mongoose.Schema.Types.ObjectId, ref: 'BrandCatalog' },
    name: { type: String },
    imageUrl: { type: String, default: null },
    price: { type: String, default: null },
  }],

  // Music track used in the review
  musicTrackId: { type: mongoose.Schema.Types.ObjectId, ref: 'BrandMusic', default: null },

  // Brand-applied overlays (saved from content manager editing tools)
  textOverlays: [{
    text: { type: String },
    position: { type: String, enum: ['top', 'center', 'bottom'], default: 'center' },
  }],
  logoOverlay: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },

  platform: {
    type: String,
    enum: ['instagram', 'tiktok', 'youtube', 'twitter', 'facebook', 'kiosk', 'google_business'],
    default: null,
  },
  platformPostUrl: { type: String, default: null },

  // Content Signature — invisible tracking metadata embedded in downloaded files
  // Generated on first download, persists for life of the content
  contentSignature: {
    kupId: { type: String, default: null },         // e.g. "KP-2026-A3F7X"
    generatedAt: { type: Date, default: null },
    downloadCount: { type: Number, default: 0 },
  },

  // Status lifecycle
  status: {
    type: String,
    enum: ['submitted', 'approved', 'rejected', 'postd'],
    default: 'submitted',
  },
  submittedAt: { type: Date, default: Date.now },
  reviewedAt: { type: Date, default: null },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  rejectionReason: { type: String, default: null },
  postdAt: { type: Date, default: null },

  // Admin rating — used when submission has no partnershipId (admin brand submissions)
  // Mirrors brandRating on Partnership for rollup purposes
  adminRating: {
    contentQuality:  { type: Number, default: null },
    timeliness:      { type: Number, default: null },
    communication:   { type: Number, default: null },
    briefCompliance: { type: Number, default: null },
    overall:         { type: Number, default: null },
    feedback:        { type: String, default: null },
    ratedAt:         { type: Date,   default: null },
  },

  // Engagement metrics (post-publication)
  metrics: {
    likes: { type: Number, default: 0 },
    comments: { type: Number, default: 0 },
    shares: { type: Number, default: 0 },
    views: { type: Number, default: 0 },
  },
  likedBy: [{ type: String }], // userIds who liked this content
}, {
  timestamps: true,
});

// Indexes
contentSubmissionSchema.index({ brandId: 1, status: 1 });
contentSubmissionSchema.index({ influencerProfileId: 1, status: 1 });
contentSubmissionSchema.index({ campaignId: 1 });

module.exports = mongoose.model('ContentSubmission', contentSubmissionSchema);
