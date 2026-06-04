// BrandLocation — One physical location for a Brand.
//
// A Brand can have N BrandLocation rows. Single-location brands have exactly
// one with isPrimary=true (seeded by migration from the legacy
// Brand.address/coordinates fields). Multi-location brands ("franchises") have
// many, with one designated primary for default display.
//
// Why a separate collection instead of an embedded array on Brand:
//  - Lets us query nearby locations across ALL brands with a single 2dsphere
//    index (used by the discover/watch feeds and the in-app franchise locator).
//  - Updates to a single location don't rewrite the entire Brand doc.
//  - Future per-location stats (kiosk scans, location-tagged reviews) can
//    aggregate cleanly on BrandLocation._id.
//
// Soft deletes via isActive=false so analytics and prior submissions keep
// referring to a stable _id even after a location is closed.

const mongoose = require('mongoose');

const brandLocationSchema = new mongoose.Schema(
  {
    brandId:    { type: mongoose.Schema.Types.ObjectId, ref: 'Brand', required: true, index: true },

    // Display label for this location — e.g. "Lincoln Park" or "Mall of America".
    // Falls back to the city if the brand doesn't name it explicitly.
    name:       { type: String, trim: true, default: '' },

    // Address components — kept as separate fields for clean editing in the
    // brand portal. Geocoding fills `coordinates` from these.
    address:    { type: String, trim: true, default: '' },
    city:       { type: String, trim: true, default: '' },
    state:      { type: String, trim: true, default: '' },
    zip:        { type: String, trim: true, default: '' },
    country:    { type: String, trim: true, default: 'US' },

    // GeoJSON Point — [longitude, latitude]. The 2dsphere index below powers
    // $nearSphere queries for the in-app franchise locator and discover feed.
    coordinates: {
      type:        { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], default: undefined }, // [lon, lat]
    },

    // Optional Google Place ID — useful for review deep-links and reconciling
    // with Google Business listings. Populated when the brand uses Places
    // autocomplete in the portal.
    placeId:    { type: String, default: null },

    // Designated primary location. Used as the default display when the brand
    // is referenced without a specific location. Exactly one per brand should
    // be true; the BrandLocation routes enforce this on create/update.
    isPrimary:  { type: Boolean, default: false },

    // Soft-delete flag. Closed locations are kept (so historical submissions
    // can still reference them) but excluded from the locator + nearby search.
    isActive:   { type: Boolean, default: true },
  },
  { timestamps: true }
);

// 2dsphere index for $nearSphere distance queries. Sparse because new docs
// may not have coordinates until geocoding completes.
brandLocationSchema.index({ coordinates: '2dsphere' }, { sparse: true });

// Hot-path indexes for the in-app franchise locator and brand-portal list.
brandLocationSchema.index({ brandId: 1, isActive: 1 });
brandLocationSchema.index({ brandId: 1, isPrimary: 1 });

module.exports = mongoose.model('BrandLocation', brandLocationSchema);
