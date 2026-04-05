// BrandInvite Model — Tracks pending email invitations sent by brands to influencers
// Created when brand uses "+ Add Influencer" → email invite flow
// Status transitions: pending → accepted (when invitee signs up) | expired (after 30 days)
const mongoose = require('mongoose');

const brandInviteSchema = new mongoose.Schema({
  brandId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Brand',
    required: true,
  },
  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
  },
  status: {
    type: String,
    enum: ['pending', 'accepted', 'expired'],
    default: 'pending',
  },
  message: {
    type: String,
    default: null,
  },
  sentBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  // Team member invite fields (inviteType: 'team_member')
  inviteType: {
    type: String,
    enum: ['influencer', 'team_member'],
    default: 'influencer',
  },
  role: {
    type: String,
    enum: ['admin', 'manager', 'viewer', 'location_manager', null],
    default: null,
  },
  // Secure token for accept link (team_member invites only)
  token: {
    type: String,
    default: null,
    index: true,
  },
  // Set when invitee clicks invite link and creates a partnership or accepts team role
  acceptedAt: {
    type: Date,
    default: null,
  },
  acceptedByUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  // Auto-expire after 30 days (pending only — accepted invites kept as record)
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  },
}, {
  timestamps: true,
});

// One pending invite per brand+email (prevent duplicates)
brandInviteSchema.index({ brandId: 1, email: 1 }, { unique: true, partialFilterExpression: { status: 'pending' } });
brandInviteSchema.index({ brandId: 1, status: 1 });
brandInviteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL — MongoDB auto-deletes after expiry

module.exports = mongoose.model('BrandInvite', brandInviteSchema);
