// Reward Claim — records when a per-approval reward is handed over IN PERSON
// (staff scans the creator's existing profile QR → confirms → marks claimed).
// Prevents double-claims for pickup/physical rewards. Digital rewards (link/code)
// auto-deliver via notification and don't need a claim record. Ref: REWARD_DELIVERY.md
const mongoose = require('mongoose');

const rewardClaimSchema = new mongoose.Schema({
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
  rewardId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Reward',
    default: null,
  },
  contentSubmissionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ContentSubmission',
    default: null,
  },
  rewardTitle: { type: String, default: null },
  method: { type: String, default: null },        // pickup / address / etc.
  claimedVia: { type: String, default: 'staff' },  // staff scan (PIN)
}, {
  timestamps: true,
});

// One reward claim per brand+creator (per reward when set) — prevents double handouts.
rewardClaimSchema.index({ brandId: 1, influencerProfileId: 1, rewardId: 1 });

module.exports = mongoose.model('RewardClaim', rewardClaimSchema);
