// Campaign Model — Brand campaigns for influencer content
// Lifecycle: draft → active → paused ↔ active → ended
// Ref: DATABASE_SCHEMA.md → campaigns
const mongoose = require('mongoose');

const campaignSchema = new mongoose.Schema({
  brandId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Brand',
    required: true,
  },
  locationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Location',
    default: null, // for location-scoped campaigns
  },

  // Linked reward — determines what influencers earn for approved content in this campaign
  rewardId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Reward',
    default: null, // null = falls back to brand-level active reward
  },

  title: { type: String, required: true, maxlength: 60 },
  description: { type: String, maxlength: 500, default: null },
  brief: { type: String, maxlength: 2000, default: null },
  coverImageUrl: { type: String, default: null },
  category: { type: String, default: null },

  // Status lifecycle
  status: {
    type: String,
    enum: ['draft', 'active', 'paused', 'ended'],
    default: 'draft',
  },
  activatedAt: { type: Date, default: null },
  pausedAt: { type: Date, default: null },
  endedAt: { type: Date, default: null },

  // Limits
  maxSubmissions: { type: Number, default: null }, // null = unlimited
  submissionCount: { type: Number, default: 0 },
  deadline: { type: Date, default: null },

  // Platform bonus indicator
  hasPlatformBonus: { type: Boolean, default: false },

  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
}, {
  timestamps: true,
});

// Indexes
campaignSchema.index({ brandId: 1, status: 1 });
campaignSchema.index({ status: 1 });
campaignSchema.index({ category: 1 });
campaignSchema.index({ deadline: 1 });
campaignSchema.index({ hasPlatformBonus: 1 });

module.exports = mongoose.model('Campaign', campaignSchema);
