// UserBlock Model — One user blocking another
// Apple Guideline 1.2: blocked user's content removed from feed instantly
const mongoose = require('mongoose');

const userBlockSchema = new mongoose.Schema({
  blockerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  blockedUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  blockedHandle: { type: String, default: null }, // denormalized for quick display
}, { timestamps: true });

// One block per pair
userBlockSchema.index({ blockerId: 1, blockedUserId: 1 }, { unique: true });
userBlockSchema.index({ blockerId: 1 }); // fast lookup for feed filtering

module.exports = mongoose.model('UserBlock', userBlockSchema);
