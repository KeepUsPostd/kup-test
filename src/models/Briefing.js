// Briefing Model — Brand-sent creative briefs to their influencers
// Brands can brief all their influencers (brand-level) or a campaign's influencers (campaign-level).
// NO payment fields — those are admin-only (Promotion model).
const mongoose = require('mongoose');

const briefingSchema = new mongoose.Schema({
  // Who sent it
  brandId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Brand',    required: true },
  brandName:  { type: String, required: true },
  sentBy:     { type: mongoose.Schema.Types.ObjectId, ref: 'User',     required: true },

  // Scope — null campaignId = brand-wide brief
  campaignId: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', default: null },

  // Audience
  audienceType: {
    type: String,
    enum: ['all', 'selected'],
    default: 'all',
  },
  // Populated when audienceType = 'selected' — array of InfluencerProfile _ids
  selectedInfluencerProfileIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'InfluencerProfile' }],

  // Brief content — matches the 4 brand-facing fields
  mediaDuration: { type: String, default: null },  // e.g. "15–30 seconds"
  include:       { type: String, required: true },  // what to include / dos
  avoid:         { type: String, default: null },   // what to avoid / donts
  extra:         { type: String, default: null },   // optional extra notes

  // Delivery tracking
  sentCount: { type: Number, default: 0 },  // how many influencers received it

}, { timestamps: true });

briefingSchema.index({ brandId: 1, createdAt: -1 });
briefingSchema.index({ campaignId: 1 });

module.exports = mongoose.model('Briefing', briefingSchema);
