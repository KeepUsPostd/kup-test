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
  mediaUrls: [{ type: String }],
  platform: {
    type: String,
    enum: ['instagram', 'tiktok', 'youtube', 'twitter', 'facebook', 'kiosk'],
    default: null,
  },
  platformPostUrl: { type: String, default: null },

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

  // Engagement metrics (post-publication)
  metrics: {
    likes: { type: Number, default: 0 },
    comments: { type: Number, default: 0 },
    shares: { type: Number, default: 0 },
    views: { type: Number, default: 0 },
  },
}, {
  timestamps: true,
});

// Indexes
contentSubmissionSchema.index({ brandId: 1, status: 1 });
contentSubmissionSchema.index({ influencerProfileId: 1, status: 1 });
contentSubmissionSchema.index({ campaignId: 1 });

module.exports = mongoose.model('ContentSubmission', contentSubmissionSchema);
