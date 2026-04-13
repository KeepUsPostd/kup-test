// Brand Music Routes — Upload, manage, and serve music tracks for capture flow
// Brands/artists upload tracks here → influencers see them in the app's "Add Sound" sheet.

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { BrandMusic, Brand } = require('../models');

// ── GET /api/music?brandId= — List active tracks for a brand ──────────────
// Used by: app capture flow "Add Sound" sheet, web portal music management
router.get('/', requireAuth, async (req, res) => {
  try {
    const { brandId } = req.query;
    if (!brandId) return res.status(400).json({ error: 'brandId is required' });

    const tracks = await BrandMusic.find({ brandId, status: 'active' })
      .sort({ usageCount: -1, createdAt: -1 })
      .lean();

    res.json({ tracks });
  } catch (error) {
    console.error('GET /music error:', error.message);
    res.status(500).json({ error: 'Could not fetch music' });
  }
});

// ── GET /api/music/all?brandId= — All tracks (including paused) for management ──
router.get('/all', requireAuth, async (req, res) => {
  try {
    const { brandId } = req.query;
    if (!brandId) return res.status(400).json({ error: 'brandId is required' });

    const tracks = await BrandMusic.find({ brandId, status: { $ne: 'removed' } })
      .sort({ createdAt: -1 })
      .lean();

    res.json({ tracks });
  } catch (error) {
    console.error('GET /music/all error:', error.message);
    res.status(500).json({ error: 'Could not fetch music' });
  }
});

// ── GET /api/music/discover — All active tracks across all brands ──────────
// Used by: app capture flow when browsing all available sounds
router.get('/discover', async (req, res) => {
  try {
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const tracks = await BrandMusic.find({ status: 'active' })
      .populate('brandId', 'name logoUrl initials generatedColor')
      .sort({ usageCount: -1, createdAt: -1 })
      .limit(limit)
      .lean();

    res.json({ tracks });
  } catch (error) {
    console.error('GET /music/discover error:', error.message);
    res.status(500).json({ error: 'Could not fetch music' });
  }
});

// ── POST /api/music — Upload a new track ──────────────────────────────────
// audioUrl comes from /api/upload (R2) — this just saves the metadata + licensing
router.post('/', requireAuth, async (req, res) => {
  try {
    const {
      brandId, title, artist, genre, duration,
      audioUrl, coverImageUrl,
      licenseType, rightsHolderName, attestation,
      expiryDate, territory, notes,
    } = req.body;

    if (!brandId) return res.status(400).json({ error: 'brandId is required' });
    if (!title?.trim()) return res.status(400).json({ error: 'Track title is required' });
    if (!audioUrl) return res.status(400).json({ error: 'audioUrl is required (upload the file first via /api/upload)' });
    if (!licenseType) return res.status(400).json({ error: 'licenseType is required (original, licensed, or royalty_free)' });
    if (!rightsHolderName?.trim()) return res.status(400).json({ error: 'Rights holder name is required' });
    if (!attestation) return res.status(400).json({ error: 'You must attest that you have the rights to distribute this music' });

    // Verify brand ownership
    const brand = await Brand.findById(brandId);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    const track = await BrandMusic.create({
      brandId,
      uploadedBy: req.user._id,
      title: title.trim(),
      artist: artist?.trim() || null,
      genre: genre?.trim() || null,
      duration: duration || 0,
      audioUrl,
      coverImageUrl: coverImageUrl || null,
      licensing: {
        licenseType,
        rightsHolderName: rightsHolderName.trim(),
        attestation: true,
        attestedAt: new Date(),
        attestedFromIp: req.ip || req.headers['x-forwarded-for'] || null,
        expiryDate: expiryDate || null,
        territory: territory || 'worldwide',
        notes: notes || null,
      },
    });

    console.log(`🎵 Music uploaded: "${title}" by ${artist || brand.name} (brand ${brandId})`);
    res.status(201).json({ message: 'Track uploaded', track });
  } catch (error) {
    console.error('POST /music error:', error.message);
    res.status(500).json({ error: 'Could not save track' });
  }
});

// ── PUT /api/music/:trackId — Update track metadata or status ─────────────
router.put('/:trackId', requireAuth, async (req, res) => {
  try {
    const { trackId } = req.params;
    const updates = {};

    // Allow updating specific fields
    const allowed = ['title', 'artist', 'genre', 'coverImageUrl', 'status'];
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    const track = await BrandMusic.findByIdAndUpdate(trackId, updates, { new: true });
    if (!track) return res.status(404).json({ error: 'Track not found' });

    res.json({ message: 'Track updated', track });
  } catch (error) {
    console.error('PUT /music error:', error.message);
    res.status(500).json({ error: 'Could not update track' });
  }
});

// ── POST /api/music/:trackId/use — Increment usage count ──────────────────
// Called by app when an influencer uses a track in a review
router.post('/:trackId/use', requireAuth, async (req, res) => {
  try {
    await BrandMusic.findByIdAndUpdate(req.params.trackId, { $inc: { usageCount: 1 } });
    res.json({ message: 'Usage recorded' });
  } catch (error) {
    res.status(500).json({ error: 'Could not record usage' });
  }
});

// ── DELETE /api/music/:trackId — Soft-remove a track ──────────────────────
router.delete('/:trackId', requireAuth, async (req, res) => {
  try {
    const track = await BrandMusic.findByIdAndUpdate(
      req.params.trackId,
      { status: 'removed' },
      { new: true },
    );
    if (!track) return res.status(404).json({ error: 'Track not found' });

    res.json({ message: 'Track removed' });
  } catch (error) {
    console.error('DELETE /music error:', error.message);
    res.status(500).json({ error: 'Could not remove track' });
  }
});

module.exports = router;
