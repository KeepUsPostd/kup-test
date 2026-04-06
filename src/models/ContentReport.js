// ContentReport Model — User-submitted flags for objectionable content
// Apple Guideline 1.2 requirement: developer must act within 24 hours
const mongoose = require('mongoose');

const contentReportSchema = new mongoose.Schema({
  // Who reported it
  reporterId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null, // null = anonymous/unauthenticated report
  },

  // What was reported
  contentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'ContentSubmission',
    required: true,
  },
  reportedUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null, // resolved from content at report time
  },
  reportedHandle: { type: String, default: null },

  // Why
  reason: {
    type: String,
    enum: [
      'Inappropriate content',
      'Spam or misleading',
      'Harassment or bullying',
      'Hate speech',
      'Dangerous content',
      'Other',
    ],
    required: true,
  },
  details: { type: String, default: null }, // optional extra notes

  // Resolution
  status: {
    type: String,
    enum: ['pending', 'reviewed', 'actioned', 'dismissed'],
    default: 'pending',
  },
  reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  reviewedAt: { type: Date, default: null },
  actionTaken: { type: String, default: null }, // e.g. 'content_removed', 'user_banned'

  // Deadline tracking (Apple requires 24hr action)
  deadlineAt: {
    type: Date,
    default: () => new Date(Date.now() + 24 * 60 * 60 * 1000),
  },
}, { timestamps: true });

contentReportSchema.index({ status: 1, createdAt: -1 });
contentReportSchema.index({ contentId: 1 });
contentReportSchema.index({ reportedUserId: 1 });
contentReportSchema.index({ deadlineAt: 1 }); // for overdue alerts

module.exports = mongoose.model('ContentReport', contentReportSchema);
