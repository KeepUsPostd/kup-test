// BrandMusic Model — Music tracks uploaded by brand/artist accounts
// Used in the app's capture flow so influencers can add brand music to reviews.
// Includes licensing attestation for legal protection.

const mongoose = require('mongoose');

const brandMusicSchema = new mongoose.Schema({
  brandId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Brand',
    required: true,
  },
  uploadedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },

  // Track info
  title: { type: String, required: true, trim: true, maxlength: 100 },
  artist: { type: String, trim: true, maxlength: 100 },
  genre: { type: String, trim: true, maxlength: 50 },
  duration: { type: Number, default: 0 }, // seconds
  audioUrl: { type: String, required: true },  // R2 CDN URL
  coverImageUrl: { type: String, default: null }, // optional album art

  // Status
  status: {
    type: String,
    enum: ['active', 'paused', 'removed'],
    default: 'active',
  },

  // Licensing — legal protection for KUP
  licensing: {
    licenseType: {
      type: String,
      enum: ['original', 'licensed', 'royalty_free'],
      required: true,
    },
    rightsHolderName: { type: String, required: true, trim: true },
    attestation: { type: Boolean, required: true, default: false },
    // "I certify I own or have obtained all necessary rights to distribute
    //  this music on KeepUsPostd and agree to indemnify KeepUsPostd against
    //  any claims arising from this upload."
    attestedAt: { type: Date, default: null },
    attestedFromIp: { type: String, default: null },
    expiryDate: { type: Date, default: null }, // null = perpetual
    territory: { type: String, default: 'worldwide' },
    notes: { type: String, maxlength: 500, default: null },
  },

  // Usage stats
  usageCount: { type: Number, default: 0 }, // times used in reviews
}, {
  timestamps: true,
});

brandMusicSchema.index({ brandId: 1, status: 1 });
brandMusicSchema.index({ status: 1, usageCount: -1 }); // popular tracks

module.exports = mongoose.model('BrandMusic', brandMusicSchema);
