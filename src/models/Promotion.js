// Promotion Model — Admin-created promotional offers to individual influencers
const mongoose = require('mongoose');

const promotionSchema = new mongoose.Schema({
  influencerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  influencerHandle: { type: String, required: true },
  brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', required: true },
  brandName: { type: String, required: true },
  amount: { type: Number, required: true }, // payment amount in USD
  description: { type: String, required: true }, // what content to create
  status: {
    type: String,
    enum: ['sent', 'content_submitted', 'paid', 'expired', 'declined'],
    default: 'sent',
  },
  contentSubmissionId: { type: mongoose.Schema.Types.ObjectId, ref: 'ContentSubmission', default: null },
  paidAt: { type: Date, default: null },
  paypalTransactionId: { type: String, default: null },
  createdBy: { type: String, default: 'admin' },
}, { timestamps: true });

promotionSchema.index({ influencerUserId: 1, status: 1 });
promotionSchema.index({ brandId: 1 });

module.exports = mongoose.model('Promotion', promotionSchema);
