// Partnership Model — Brand ↔ Influencer relationships
// Ref: DATABASE_SCHEMA.md → partnerships
const mongoose = require('mongoose');

const partnershipSchema = new mongoose.Schema({
  brandId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Brand',
    required: true,
  },
  influencerProfileId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'InfluencerProfile',
    required: true,
  },

  status: {
    type: String,
    enum: ['active', 'paused', 'ended', 'brand_inactive'],
    default: 'active',
  },
  source: {
    type: String,
    enum: ['invitation', 'request', 'discovery', 'admin_brand'],
    default: 'invitation',
  },

  // Stats (denormalized)
  totalSubmissions: { type: Number, default: 0 },
  totalApproved: { type: Number, default: 0 },
  totalCashEarned: { type: Number, default: 0 },
  totalPointsEarned: { type: Number, default: 0 },

  startedAt: { type: Date, default: Date.now },
  endedAt: { type: Date, default: null },
  endedBy: {
    type: String,
    enum: ['brand', 'influencer', 'system'],
    default: null,
  },

  // Brand's rating of influencer (submitted after content approval)
  brandRating: {
    contentQuality: { type: Number, min: 1, max: 5, default: null },
    timeliness: { type: Number, min: 1, max: 5, default: null },
    communication: { type: Number, min: 1, max: 5, default: null },
    briefCompliance: { type: Number, min: 1, max: 5, default: null },
    overall: { type: Number, min: 1, max: 5, default: null },
    feedback: { type: String, maxlength: 500, default: null },
    ratedAt: { type: Date, default: null },
    contentSubmissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'ContentSubmission', default: null },
  },

  // Influencer's rating of the brand (submitted after payout received)
  influencerRating: {
    communication: { type: Number, min: 1, max: 5, default: null },
    paymentTimeliness: { type: Number, min: 1, max: 5, default: null },
    creativeFreedom: { type: Number, min: 1, max: 5, default: null },
    overallExperience: { type: Number, min: 1, max: 5, default: null },
    overall: { type: Number, min: 1, max: 5, default: null },
    feedback: { type: String, maxlength: 500, default: null },
    ratedAt: { type: Date, default: null },
  },
}, {
  timestamps: true,
});

// Indexes — one partnership per brand+influencer (compound unique)
partnershipSchema.index({ brandId: 1, influencerProfileId: 1 }, { unique: true });
partnershipSchema.index({ influencerProfileId: 1, status: 1 });
partnershipSchema.index({ brandId: 1, status: 1 });

module.exports = mongoose.model('Partnership', partnershipSchema);
