// GoogleBusinessConfig — OAuth tokens + settings per brand
const mongoose = require('mongoose');

const googleBusinessConfigSchema = new mongoose.Schema({
  brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', required: true, unique: true },

  // Google account + location
  googleAccountId: { type: String, default: null },
  locationId:      { type: String, default: null },  // full resource name e.g. "accounts/123/locations/456"
  locationName:    { type: String, default: null },
  locationAddress: { type: String, default: null },
  placeId:         { type: String, default: null },  // Google Maps Place ID for direct review links
  reviewUrl:       { type: String, default: null },  // Direct URL to leave a Google review

  // OAuth tokens (never returned in standard queries)
  accessToken:  { type: String, select: false, default: null },
  refreshToken: { type: String, select: false, default: null },
  tokenExpiry:  { type: Date, default: null },

  connectedAt:       { type: Date, default: null },
  connectedByUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },

  settings: {
    enabledPostTypes: {
      whatsNew:  { type: Boolean, default: true },
      offers:    { type: Boolean, default: false },
      events:    { type: Boolean, default: false },
      updates:   { type: Boolean, default: true },
      products:  { type: Boolean, default: false },
    },
    autoPost:       { type: Boolean, default: false },
    requireApproval:{ type: Boolean, default: true },
    bonusType:  { type: String, enum: ['points','cash','both','none'], default: 'points' },
    bonusPoints:{ type: Number, default: 50 },
    bonusCash:  { type: Number, default: 5 },
  },
}, { timestamps: true });

googleBusinessConfigSchema.index({ brandId: 1 });

module.exports = mongoose.model('GoogleBusinessConfig', googleBusinessConfigSchema);
