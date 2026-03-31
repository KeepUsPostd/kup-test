// Partnership Routes — Brand ↔ Influencer relationship management
// Enforces: G1 (brand isolation), unique partnerships, lifecycle management
// Sources: invitation, request, discovery, admin_brand
// Ref: PLATFORM_ARCHITECTURE.md → Partnership System
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { Partnership, InfluencerProfile, ContentSubmission } = require('../models');

// POST /api/partnerships — Create a new partnership
// Brand invites an influencer OR influencer requests to join
router.post('/', requireAuth, async (req, res) => {
  try {
    const { brandId, influencerProfileId, source } = req.body;

    if (!brandId) {
      return res.status(400).json({ error: 'brandId is required' });
    }
    if (!influencerProfileId) {
      return res.status(400).json({ error: 'influencerProfileId is required' });
    }

    // Check if partnership already exists
    const existing = await Partnership.findOne({ brandId, influencerProfileId });
    if (existing) {
      if (existing.status === 'ended') {
        // Reactivate ended partnership
        existing.status = 'active';
        existing.startedAt = new Date();
        existing.endedAt = null;
        existing.endedBy = null;
        await existing.save();

        console.log(`🔄 Partnership reactivated: brand ${brandId} + influencer ${influencerProfileId}`);
        return res.json({ message: 'Partnership reactivated', partnership: existing });
      }
      return res.status(409).json({
        error: 'Partnership already exists',
        message: 'This influencer already has a partnership with this brand.',
        partnership: existing,
      });
    }

    // Validate influencer exists
    const influencer = await InfluencerProfile.findById(influencerProfileId);
    if (!influencer) {
      return res.status(404).json({ error: 'Influencer profile not found' });
    }

    const partnership = await Partnership.create({
      brandId,
      influencerProfileId,
      status: 'active',
      source: source || 'invitation',
      startedAt: new Date(),
    });

    console.log(`🤝 Partnership created: brand ${brandId} + @${influencer.handle}`);

    res.status(201).json({
      message: 'Partnership created',
      partnership,
    });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({
        error: 'Partnership already exists',
        message: 'This influencer already has a partnership with this brand.',
      });
    }
    console.error('Create partnership error:', error.message);
    res.status(500).json({ error: 'Could not create partnership' });
  }
});

// GET /api/partnerships?brandId=xxx — List partnerships for a brand
// Optional filters: ?status=active&source=invitation
router.get('/', requireAuth, async (req, res) => {
  try {
    const { brandId, influencerProfileId, status, source } = req.query;

    if (!brandId && !influencerProfileId) {
      return res.status(400).json({ error: 'brandId or influencerProfileId query parameter is required' });
    }

    const filter = {};
    if (brandId) filter.brandId = brandId;
    if (influencerProfileId) filter.influencerProfileId = influencerProfileId;
    if (status) filter.status = status;
    if (source) filter.source = source;

    const partnerships = await Partnership.find(filter)
      .populate('influencerProfileId', 'displayName handle avatarUrl influenceTier creatorTier stats')
      .populate('brandId', 'name initials generatedColor kioskBrandCode brandColors')
      .sort({ createdAt: -1 })
      .limit(200);

    // Gather stats
    const stats = {
      total: partnerships.length,
      active: partnerships.filter(p => p.status === 'active').length,
      paused: partnerships.filter(p => p.status === 'paused').length,
      ended: partnerships.filter(p => p.status === 'ended').length,
    };

    res.json({ partnerships, stats });
  } catch (error) {
    console.error('List partnerships error:', error.message);
    res.status(500).json({ error: 'Could not fetch partnerships' });
  }
});

// GET /api/partnerships/:partnershipId — Get single partnership with details
router.get('/:partnershipId', requireAuth, async (req, res) => {
  try {
    const partnership = await Partnership.findById(req.params.partnershipId)
      .populate('influencerProfileId', 'displayName handle avatarUrl influenceTier creatorTier stats bio')
      .populate('brandId', 'name initials generatedColor category');

    if (!partnership) {
      return res.status(404).json({ error: 'Partnership not found' });
    }

    // Get content submission stats for this partnership
    const contentStats = await ContentSubmission.aggregate([
      { $match: { partnershipId: partnership._id } },
      { $group: {
        _id: '$status',
        count: { $sum: 1 },
      }},
    ]);

    res.json({ partnership, contentStats });
  } catch (error) {
    console.error('Get partnership error:', error.message);
    res.status(500).json({ error: 'Could not fetch partnership' });
  }
});

// PUT /api/partnerships/:partnershipId/status — Change partnership status
// active → paused, paused → active, active/paused → ended
router.put('/:partnershipId/status', requireAuth, async (req, res) => {
  try {
    const { status: newStatus, endedBy } = req.body;
    const partnership = await Partnership.findById(req.params.partnershipId);

    if (!partnership) {
      return res.status(404).json({ error: 'Partnership not found' });
    }

    const validTransitions = {
      active: ['paused', 'ended'],
      paused: ['active', 'ended'],
      ended: [], // terminal
      brand_inactive: ['active'], // can reactivate
    };

    const allowed = validTransitions[partnership.status] || [];
    if (!allowed.includes(newStatus)) {
      return res.status(400).json({
        error: 'Invalid status transition',
        message: `Cannot change from "${partnership.status}" to "${newStatus}". Allowed: ${allowed.join(', ') || 'none'}`,
      });
    }

    partnership.status = newStatus;

    if (newStatus === 'ended') {
      partnership.endedAt = new Date();
      partnership.endedBy = endedBy || 'brand';
    }

    if (newStatus === 'active' && partnership.endedAt) {
      // Reactivating — clear ended fields
      partnership.endedAt = null;
      partnership.endedBy = null;
      partnership.startedAt = new Date();
    }

    await partnership.save();

    console.log(`🤝 Partnership ${partnership._id} → ${newStatus}`);

    res.json({ message: `Partnership ${newStatus}`, partnership });
  } catch (error) {
    console.error('Partnership status error:', error.message);
    res.status(500).json({ error: 'Could not update partnership status' });
  }
});

// DELETE /api/partnerships/:partnershipId — Remove partnership
// Only ended partnerships can be fully deleted
router.delete('/:partnershipId', requireAuth, async (req, res) => {
  try {
    const partnership = await Partnership.findById(req.params.partnershipId);

    if (!partnership) {
      return res.status(404).json({ error: 'Partnership not found' });
    }

    if (partnership.status !== 'ended') {
      return res.status(400).json({
        error: 'Cannot delete active partnership',
        message: 'End the partnership first before deleting.',
      });
    }

    await Partnership.findByIdAndDelete(req.params.partnershipId);

    console.log(`🗑️ Partnership deleted: ${req.params.partnershipId}`);

    res.json({ message: 'Partnership deleted' });
  } catch (error) {
    console.error('Delete partnership error:', error.message);
    res.status(500).json({ error: 'Could not delete partnership' });
  }
});

// POST /api/partnerships/:partnershipId/rate — Influencer rates a brand partnership
router.post('/:partnershipId/rate', requireAuth, async (req, res) => {
  try {
    const { communication, paymentTimeliness, creativeFreedom, overallExperience, feedback } = req.body;

    // Validate all 4 required scores
    const scores = { communication, paymentTimeliness, creativeFreedom, overallExperience };
    for (const [key, val] of Object.entries(scores)) {
      if (!val || val < 1 || val > 5) {
        return res.status(400).json({ error: `${key} must be between 1 and 5` });
      }
    }

    const partnership = await Partnership.findById(req.params.partnershipId);
    if (!partnership) {
      return res.status(404).json({ error: 'Partnership not found' });
    }

    const overall = Math.round(
      (communication + paymentTimeliness + creativeFreedom + overallExperience) / 4
    );

    partnership.influencerRating = {
      communication,
      paymentTimeliness,
      creativeFreedom,
      overallExperience,
      overall,
      feedback: feedback || null,
      ratedAt: new Date(),
    };

    await partnership.save();

    console.log(`⭐ Partnership ${partnership._id} rated: ${overall}/5`);

    res.json({ message: 'Rating saved', overall, partnership });
  } catch (error) {
    console.error('Rate partnership error:', error.message);
    res.status(500).json({ error: 'Could not save rating' });
  }
});

module.exports = router;
