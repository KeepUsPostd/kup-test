// BrandCatalog Model — Products, menu items, experiences, services
// Universal catalog: works for restaurants (dishes), beauty (products),
// travel (experiences), fitness (classes), retail (items), auto (vehicles).
// Influencers tag catalog items during the review capture flow.

const mongoose = require('mongoose');

const brandCatalogSchema = new mongoose.Schema({
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

  // Item info
  name: { type: String, required: true, trim: true, maxlength: 120 },
  description: { type: String, trim: true, maxlength: 300, default: null },
  imageUrl: { type: String, default: null },  // R2 CDN URL
  price: { type: String, trim: true, maxlength: 20, default: null }, // "$12.99" or "From $149/night"
  category: { type: String, trim: true, maxlength: 50, default: null }, // "Appetizers", "Skincare", "SUVs"
  sku: { type: String, trim: true, maxlength: 50, default: null }, // optional product SKU/ID
  externalUrl: { type: String, trim: true, default: null }, // link to product page / booking

  // Status
  status: {
    type: String,
    enum: ['active', 'paused', 'removed'],
    default: 'active',
  },

  // Display order — brands can reorder items
  sortOrder: { type: Number, default: 0 },

  // Usage stats
  tagCount: { type: Number, default: 0 }, // times tagged in reviews
}, {
  timestamps: true,
});

brandCatalogSchema.index({ brandId: 1, status: 1, sortOrder: 1 });
brandCatalogSchema.index({ brandId: 1, category: 1 });

module.exports = mongoose.model('BrandCatalog', brandCatalogSchema);
