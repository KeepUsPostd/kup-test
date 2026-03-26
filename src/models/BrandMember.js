// Brand Member Model — Team membership (user → brand with role)
// Ref: DATABASE_SCHEMA.md → brand_members
const mongoose = require('mongoose');

const brandMemberSchema = new mongoose.Schema({
  brandId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Brand',
    required: true,
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },

  role: {
    type: String,
    enum: ['owner', 'admin', 'manager', 'viewer', 'location_manager'],
    required: true,
  },
  locationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Location',
    default: null, // only for location_manager role
  },

  invitedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  invitedAt: { type: Date, default: null },
  acceptedAt: { type: Date, default: null },

  status: {
    type: String,
    enum: ['active', 'invited', 'removed'],
    default: 'active',
  },
}, {
  timestamps: true,
});

// Indexes — one user per brand (compound unique)
brandMemberSchema.index({ brandId: 1, userId: 1 }, { unique: true });
brandMemberSchema.index({ brandId: 1, role: 1 });
brandMemberSchema.index({ userId: 1 });

module.exports = mongoose.model('BrandMember', brandMemberSchema);
