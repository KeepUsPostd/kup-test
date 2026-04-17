// Notification Model — In-App Notification Center
// Stores notifications shown in the bell icon / notification drawer.
// Emails are sent separately via SendGrid — this is for in-app only.
const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  userId: {
    type: String, // Firebase UID
    required: true,
    index: true,
  },

  title: {
    type: String,
    required: true,
    maxlength: 200,
  },

  message: {
    type: String,
    required: true,
    maxlength: 500,
  },

  // Category for filtering & preferences
  type: {
    type: String,
    enum: [
      'content',     // Content submissions, approvals, rejections
      'approval',    // Content approved by brand
      'payment',     // Earnings, cashouts, billing
      'campaign',    // Campaign invites, milestones
      'briefing',    // Campaign briefs sent to partnered influencers
      'bonus',       // Bonus alerts, time-limited offers
      'partnership', // New partners, removals
      'reward',      // Points, rewards unlocked
      'account',     // Profile, security, settings
      'system',      // Platform updates, maintenance
    ],
    default: 'system',
  },

  // Deep link within the app (relative path)
  link: {
    type: String,
    default: null,
  },

  // Who should see this: 'influencer' (points, rewards), 'brand' (submissions, partnerships), 'all' (system)
  audience: {
    type: String,
    enum: ['influencer', 'brand', 'all'],
    default: 'all',
  },

  // Extra data for the frontend (submission ID, amount, etc.)
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },

  // Read status
  read: {
    type: Boolean,
    default: false,
  },
  readAt: {
    type: Date,
    default: null,
  },
}, {
  timestamps: true,
});

// Indexes
notificationSchema.index({ userId: 1, read: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, type: 1 });
notificationSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 }); // Auto-delete after 90 days

module.exports = mongoose.model('Notification', notificationSchema);
