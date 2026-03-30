// Claim Request Model — Brand ownership claims
// When a real brand rep wants to claim an admin-created brand
const mongoose = require('mongoose');

const claimRequestSchema = new mongoose.Schema({
  brandId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Brand',
    required: true,
  },

  // Claimer info
  claimerName: { type: String, required: true },
  claimerTitle: { type: String, default: null },
  claimerEmail: { type: String, required: true },
  claimerPhone: { type: String, default: null },
  authorizationStatement: { type: String, default: null },
  documentUrl: { type: String, default: null },

  // Auto-validation
  emailDomainMatch: { type: Boolean, default: false },
  duplicateClaim: { type: Boolean, default: false },

  // Review status
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending',
  },
  reviewedBy: { type: String, default: null },
  reviewNotes: { type: String, default: null },
  reviewedAt: { type: Date, default: null },
}, {
  timestamps: true,
});

claimRequestSchema.index({ brandId: 1 });
claimRequestSchema.index({ status: 1 });
claimRequestSchema.index({ claimerEmail: 1 });

module.exports = mongoose.model('ClaimRequest', claimRequestSchema);
