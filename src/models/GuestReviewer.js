// Guest Reviewer Model — One-time kiosk identity capture
// Guests can later convert to full influencer accounts
// Ref: KIOSK_MODE_SPEC.md → Guest/Lite Reviewer System
const mongoose = require('mongoose');

const guestReviewerSchema = new mongoose.Schema({
  brandId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Brand',
    required: true,
  },
  firstName: { type: String, required: true, maxlength: 50 },
  phone: { type: String, required: true },
  email: { type: String, default: null },

  // Conversion tracking — bridges kiosk guest to full app account
  convertedToInfluencerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'InfluencerProfile',
    default: null,
  },

  // Stats
  totalReviews: { type: Number, default: 0 },
  totalRewardsEarned: { type: Number, default: 0 },
  lastVisitAt: { type: Date, default: Date.now },
}, {
  timestamps: true,
});

// Unique constraint: one guest per phone per brand
guestReviewerSchema.index({ phone: 1, brandId: 1 }, { unique: true });
guestReviewerSchema.index({ brandId: 1 });

module.exports = mongoose.model('GuestReviewer', guestReviewerSchema);
