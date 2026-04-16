const mongoose = require('mongoose');

const promoCodeSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, uppercase: true },
  type: {
    type: String,
    enum: ['percent_off', 'free'],  // percent_off = discount, free = 100% off forever
    required: true,
  },
  percentOff: { type: Number, default: null },  // e.g. 50 for 50% off (only for percent_off type)
  appliesTo: {
    type: String,
    enum: ['all', 'growth', 'pro', 'agency'],  // which plans this code works on
    default: 'all',
  },
  durationMonths: { type: Number, default: null },  // null = forever, 3 = first 3 months
  maxUses: { type: Number, default: null },  // null = unlimited
  usedCount: { type: Number, default: 0 },
  usedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  isActive: { type: Boolean, default: true },
  expiresAt: { type: Date, default: null },  // null = never expires
  createdBy: { type: String, default: 'admin' },
  notes: { type: String, default: null },
}, { timestamps: true });

promoCodeSchema.index({ code: 1 });

module.exports = mongoose.model('PromoCode', promoCodeSchema);
