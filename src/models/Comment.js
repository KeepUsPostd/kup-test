// Comment Model — User comments on content submissions
const mongoose = require('mongoose');
const { Schema } = mongoose;

const commentSchema = new Schema({
  contentId: {
    type: Schema.Types.ObjectId,
    ref: 'ContentSubmission',
    required: true,
    index: true,
  },
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  displayName: {
    type: String,
    required: true,
    trim: true,
  },
  avatarUrl: {
    type: String,
    default: null,
  },
  text: {
    type: String,
    required: true,
    trim: true,
    maxlength: 500,
  },
}, { timestamps: true });

module.exports = mongoose.model('Comment', commentSchema);
