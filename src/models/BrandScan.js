const mongoose = require('mongoose');
const brandScanSchema = new mongoose.Schema({
  brandId:   { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', required: true },
  timestamp: { type: Date, default: Date.now },
  device:    { type: String, enum: ['mobile', 'tablet', 'desktop'], default: 'mobile' },
  city:      { type: String, default: null },
  state:     { type: String, default: null },
  country:   { type: String, default: 'US' },
  converted: { type: Boolean, default: false },
  convertedUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  scanCode:  { type: String, default: null }, // the code or handle that was scanned
}, { timestamps: false });

brandScanSchema.index({ brandId: 1, timestamp: -1 });
brandScanSchema.index({ brandId: 1, converted: 1 });

module.exports = mongoose.model('BrandScan', brandScanSchema);
