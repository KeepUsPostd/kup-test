// Kiosk Reward Model — One-time-use instant reward codes
// Auto-generated 6-char codes with 24-hour expiration
// Ref: KIOSK_MODE_SPEC.md → Instant Rewards
const mongoose = require('mongoose');

const kioskRewardSchema = new mongoose.Schema({
  brandId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Brand',
    required: true,
  },
  guestReviewerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'GuestReviewer',
    required: true,
  },
  contentSubmissionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ContentSubmission',
    default: null,
  },

  // Reward details
  code: { type: String, required: true, unique: true }, // e.g., KUP-ABCDE1
  rewardType: {
    type: String,
    enum: ['free_item', 'discount_percent', 'discount_fixed', 'points'],
    required: true,
  },
  rewardValue: { type: String, required: true }, // "Free Taco", "10%", "$5 off", "500 points"

  // Status lifecycle: issued → redeemed → expired
  status: {
    type: String,
    enum: ['issued', 'redeemed', 'expired'],
    default: 'issued',
  },
  issuedAt: { type: Date, default: Date.now },
  redeemedAt: { type: Date, default: null },
  expiresAt: {
    type: Date,
    required: true,
    default: () => new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
  },
}, {
  timestamps: true,
});

// TTL index — auto-expire after 24 hours (MongoDB auto-deletes)
kioskRewardSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
kioskRewardSchema.index({ brandId: 1, status: 1 });
kioskRewardSchema.index({ code: 1 }, { unique: true });

module.exports = mongoose.model('KioskReward', kioskRewardSchema);
