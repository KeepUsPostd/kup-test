// SavedContent Model — User's saved/bookmarked content
const mongoose = require('mongoose');
const { Schema } = mongoose;

const savedContentSchema = new Schema({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  contentId: {
    type: Schema.Types.ObjectId,
    ref: 'ContentSubmission',
    required: true,
  },
  savedAt: {
    type: Date,
    default: Date.now,
  },
}, { timestamps: false });

// Prevent duplicate saves
savedContentSchema.index({ userId: 1, contentId: 1 }, { unique: true });

module.exports = mongoose.model('SavedContent', savedContentSchema);
