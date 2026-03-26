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
}, {
  timestamps: true,
});

// Indexes — one partnership per brand+influencer (compound unique)
partnershipSchema.index({ brandId: 1, influencerProfileId: 1 }, { unique: true });
partnershipSchema.index({ influencerProfileId: 1, status: 1 });
partnershipSchema.index({ brandId: 1, status: 1 });

module.exports = mongoose.model('Partnership', partnershipSchema);
