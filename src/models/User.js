// User Model — Single source of truth for authentication
// One document per human. Ref: DATABASE_SCHEMA.md → users
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  passwordHash: { type: String, default: null },
  phone: { type: String, default: null, sparse: true },

  // Authentication
  authProvider: {
    type: String,
    enum: ['email', 'google', 'linkedin'],
    default: 'email',
  },
  firebaseUid: { type: String, unique: true, sparse: true },
  twoFactorEnabled: { type: Boolean, default: false },

  // Profile flags (dual-profile system)
  hasInfluencerProfile: { type: Boolean, default: false },
  hasBrandProfile: { type: Boolean, default: false },
  onboardingComplete: { type: Boolean, default: false },
  onboardingSteps: { type: [Number], default: [] }, // Completed step indices [0,1,2,3,4]
  referredByCode: { type: String, default: null },  // Referral code used at signup
  activeProfile: {
    type: String,
    enum: ['influencer', 'brand'],
    default: null,
  },

  // Legal / compliance
  legalFirstName: { type: String, default: null },
  legalLastName: { type: String, default: null },
  avatarUrl: { type: String, default: null },
  dateOfBirth: { type: Date, default: null },
  address: {
    street: { type: String, default: null },
    city: { type: String, default: null },
    state: { type: String, default: null },
    zip: { type: String, default: null },
    country: { type: String, default: 'US' },
  },

  // Push notification tokens (one per device)
  fcmTokens: [{
    token: { type: String, required: true },
    device: { type: String, default: null },    // e.g., 'iPhone 15', 'Pixel 8'
    platform: { type: String, enum: ['ios', 'android', 'web'], default: null },
    registeredAt: { type: Date, default: Date.now },
  }],

  // Notification preferences (category-level toggles)
  notificationPrefs: {
    email: {
      content: { type: Boolean, default: true },
      campaigns: { type: Boolean, default: true },
      rewards: { type: Boolean, default: true },
      payments: { type: Boolean, default: true },    // Always on — can't disable
      security: { type: Boolean, default: true },    // Always on — can't disable
      referrals: { type: Boolean, default: true },
      platformUpdates: { type: Boolean, default: true },
    },
    push: {
      content: { type: Boolean, default: true },
      campaigns: { type: Boolean, default: true },
      rewards: { type: Boolean, default: true },
      payments: { type: Boolean, default: true },
      security: { type: Boolean, default: true },    // Always on — can't disable
      referrals: { type: Boolean, default: true },
      platformUpdates: { type: Boolean, default: false },
    },
  },

  // System
  status: {
    type: String,
    enum: ['active', 'suspended', 'deactivating', 'deleted'],
    default: 'active',
  },
  deactivationStartedAt: { type: Date, default: null },
  deactivationReason: { type: String, default: null },
  lastLoginAt: { type: Date, default: null },
  loginCount: { type: Number, default: 0 },
}, {
  timestamps: true, // adds createdAt + updatedAt
});

// Indexes (email, firebaseUid, phone already indexed via unique/sparse in field def)
userSchema.index({ status: 1 });

module.exports = mongoose.model('User', userSchema);
