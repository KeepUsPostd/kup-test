// Brand Catalog Routes — CRUD for products, menu items, experiences, etc.
// Universal system: restaurants upload dishes, beauty brands upload products,
// travel brands upload experiences. Influencers tag these in reviews.

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { BrandCatalog, Brand } = require('../models');

// ── GET /api/catalog?brandId= — Active items for a brand ─────────────────
// Used by: app capture flow "Tag Items" step + web portal management
router.get('/', requireAuth, async (req, res) => {
  try {
    const { brandId, category } = req.query;
    if (!brandId) return res.status(400).json({ error: 'brandId is required' });

    const filter = { brandId, status: 'active' };
    if (category) filter.category = category;

    const items = await BrandCatalog.find(filter)
      .sort({ sortOrder: 1, createdAt: -1 })
      .lean();

    // Get unique categories for filter tabs
    const categories = await BrandCatalog.distinct('category', { brandId, status: 'active', category: { $ne: null } });

    res.json({ items, categories });
  } catch (error) {
    console.error('GET /catalog error:', error.message);
    res.status(500).json({ error: 'Could not fetch catalog' });
  }
});

// ── GET /api/catalog/all?brandId= — All items including paused ───────────
router.get('/all', requireAuth, async (req, res) => {
  try {
    const { brandId } = req.query;
    if (!brandId) return res.status(400).json({ error: 'brandId is required' });

    const items = await BrandCatalog.find({ brandId, status: { $ne: 'removed' } })
      .sort({ category: 1, sortOrder: 1, createdAt: -1 })
      .lean();

    const categories = await BrandCatalog.distinct('category', { brandId, status: { $ne: 'removed' }, category: { $ne: null } });

    res.json({ items, categories });
  } catch (error) {
    console.error('GET /catalog/all error:', error.message);
    res.status(500).json({ error: 'Could not fetch catalog' });
  }
});

// ── POST /api/catalog — Add a catalog item ────────────────────────────────
router.post('/', requireAuth, async (req, res) => {
  try {
    const { brandId, name, description, imageUrl, price, category, sku, externalUrl, sortOrder } = req.body;

    if (!brandId) return res.status(400).json({ error: 'brandId is required' });
    if (!name?.trim()) return res.status(400).json({ error: 'Item name is required' });

    const brand = await Brand.findById(brandId);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    const item = await BrandCatalog.create({
      brandId,
      uploadedBy: req.user._id,
      name: name.trim(),
      description: description?.trim() || null,
      imageUrl: imageUrl || null,
      price: price?.trim() || null,
      category: category?.trim() || null,
      sku: sku?.trim() || null,
      externalUrl: externalUrl?.trim() || null,
      sortOrder: sortOrder || 0,
    });

    console.log(`📦 Catalog item added: "${name}" to ${brand.name}`);
    res.status(201).json({ message: 'Item added', item });
  } catch (error) {
    console.error('POST /catalog error:', error.message);
    res.status(500).json({ error: 'Could not add item' });
  }
});

// ── PUT /api/catalog/:itemId — Update an item ────────────────────────────
router.put('/:itemId', requireAuth, async (req, res) => {
  try {
    const updates = {};
    const allowed = ['name', 'description', 'imageUrl', 'price', 'category', 'sku', 'externalUrl', 'status', 'sortOrder'];
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    const item = await BrandCatalog.findByIdAndUpdate(req.params.itemId, updates, { new: true });
    if (!item) return res.status(404).json({ error: 'Item not found' });

    res.json({ message: 'Item updated', item });
  } catch (error) {
    console.error('PUT /catalog error:', error.message);
    res.status(500).json({ error: 'Could not update item' });
  }
});

// ── POST /api/catalog/:itemId/tag — Increment tag count ──────────────────
// Called when an influencer tags this item in a review
router.post('/:itemId/tag', requireAuth, async (req, res) => {
  try {
    await BrandCatalog.findByIdAndUpdate(req.params.itemId, { $inc: { tagCount: 1 } });
    res.json({ message: 'Tag recorded' });
  } catch (error) {
    res.status(500).json({ error: 'Could not record tag' });
  }
});

// ── DELETE /api/catalog/:itemId — Soft-remove an item ────────────────────
router.delete('/:itemId', requireAuth, async (req, res) => {
  try {
    const item = await BrandCatalog.findByIdAndUpdate(
      req.params.itemId,
      { status: 'removed' },
      { new: true },
    );
    if (!item) return res.status(404).json({ error: 'Item not found' });

    res.json({ message: 'Item removed' });
  } catch (error) {
    console.error('DELETE /catalog error:', error.message);
    res.status(500).json({ error: 'Could not remove item' });
  }
});

module.exports = router;
