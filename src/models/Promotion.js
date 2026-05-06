// Promotion Model — Admin-created promotional offers to individual influencers
const mongoose = require('mongoose');

const promotionSchema = new mongoose.Schema({
  influencerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  influencerHandle: { type: String, required: true },
  brandId: { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', required: true },
  brandName: { type: String, required: true },
  amount: { type: Number, required: true }, // payment amount in USD
  description: { type: String, default: null }, // optional additional notes
  videoDuration: { type: String, default: null }, // e.g. "15–30 seconds"
  dos: { type: String, default: null }, // what to include in the content
  donts: { type: String, default: null }, // what to avoid
  paypalReminder: { type: Boolean, default: true }, // remind creator to connect PayPal
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
