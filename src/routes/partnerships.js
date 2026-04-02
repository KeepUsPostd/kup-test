// Partnership Routes — Brand ↔ Influencer relationship management
// Enforces: G1 (brand isolation), unique partnerships, lifecycle management
// Sources: invitation, request, discovery, admin_brand
// Ref: PLATFORM_ARCHITECTURE.md → Partnership System
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { Partnership, InfluencerProfile, ContentSubmission } = require('../models');

// GET /api/partnerships/discover — Browse influencers for brand discovery tab
// Query params: q (search), niche, tier, sort, page, limit
router.get('/discover', requireAuth, async (req, res) => {
  try {
    const { q = '', niche, tier, sort = 'newest', page = 1, limit = 20 } = req.query;
    const skip = (parseInt(page) - 1) * Math.min(parseInt(limit), 50);
    const take = Math.min(parseInt(limit), 50);

    // Exclude the requesting user's own influencer profile from brand-side discovery
    const filter = { campaignAccessUnlocked: true, userId: { $ne: req.user._id } };

    if (q && q.trim().length >= 2) {
      const search = q.trim();
      filter.$or = [
        { handle: { $regex: search, $options: 'i' } },
        { displayName: { $regex: search, $options: 'i' } },
      ];
    }

    if (niche && niche !== 'all') {
      filter.interests = niche;
    }

    if (tier && tier !== 'all') {
      filter.influenceTier = tier;
    }

    const sortMap = {
      newest: { createdAt: -1 },
      followers: { realFollowerCount: -1 },
      engagement: { engagementRate: -1 },
      relevance: { influenceScore: -1 },
    };
    const sortObj = sortMap[sort] || sortMap.newest;

    const [profiles, total] = await Promise.all([
      InfluencerProfile.find(filter, {
        handle: 1, displayName: 1, avatarUrl: 1, bio: 1,
        influenceTier: 1, realFollowerCount: 1, engagementRate: 1,
        interests: 1, totalBrandsPartnered: 1, isVerified: 1,
        totalCashEarned: 1, averageRating: 1, ratingCount: 1,
      }).sort(sortObj).skip(skip).limit(take).lean(),
      InfluencerProfile.countDocuments(filter),
    ]);

    res.json({ profiles, total, page: parseInt(page), pages: Math.ceil(total / take) });
  } catch (err) {
    console.error('Discovery error:', err);
    res.status(500).json({ error: 'Failed to load discovery results' });
  }
});

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

// GET /api/partnerships/my-brands — All brands the logged-in influencer is partnered with
// Called by Flutter brand dashboard tab to list partner brands
router.get('/my-brands', requireAuth, async (req, res) => {
  try {
    const user = req.user;
    const influencerProfile = await InfluencerProfile.findOne({ userId: user._id });
    if (!influencerProfile) {
      return res.status(404).json({ error: 'Influencer profile not found' });
    }

    const { status } = req.query;
    const filter = { influencerProfileId: influencerProfile._id };
    if (status) filter.status = status;

    const partnerships = await Partnership.find(filter)
      .populate('brandId', 'name initials generatedColor category logoUrl kioskBrandCode brandColors')
      .sort({ createdAt: -1 })
      .limit(200);

    const brands = partnerships.map(p => ({
      partnership: p,
      brand: p.brandId,
    }));

    res.json({ brands, total: brands.length });
  } catch (error) {
    console.error('My brands error:', error.message);
    res.status(500).json({ error: 'Could not fetch partner brands' });
  }
});

// GET /api/partnerships/check?brandId=xxx — Check if logged-in influencer is partnered with a brand
// Called by Flutter to show/hide follow button
router.get('/check', requireAuth, async (req, res) => {
  try {
    const { brandId } = req.query;
    if (!brandId) {
      return res.status(400).json({ error: 'brandId is required' });
    }

    const user = req.user;
    const influencerProfile = await InfluencerProfile.findOne({ userId: user._id });
    if (!influencerProfile) {
      return res.json({ isPartner: false, partnership: null });
    }

    const partnership = await Partnership.findOne({
      brandId,
      influencerProfileId: influencerProfile._id,
    });

    res.json({
      isPartner: !!partnership && partnership.status === 'active',
      partnership: partnership || null,
    });
  } catch (error) {
    console.error('Partnership check error:', error.message);
    res.status(500).json({ error: 'Could not check partnership' });
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

    // When listing a brand's partners, exclude the brand owner's own influencer profile
    // so they don't see themselves in their own influencer list
    if (brandId) {
      const ownProfile = await InfluencerProfile.findOne({ userId: req.user._id }, '_id').lean();
      if (ownProfile) {
        filter.influencerProfileId = { $ne: ownProfile._id };
      }
    }
    // Restore explicit influencerProfileId filter if passed (overrides exclusion)
    if (influencerProfileId) filter.influencerProfileId = influencerProfileId;

    const partnerships = await Partnership.find(filter)
      .populate('influencerProfileId', 'displayName handle avatarUrl influenceTier creatorTier stats')
      .populate('brandId', 'name initials generatedColor kioskBrandCode brandColors')
      .sort({ createdAt: -1 })
      .limit(200);

    const filtered = partnerships;

    // Gather stats
    const stats = {
      total: filtered.length,
      active: filtered.filter(p => p.status === 'active').length,
      paused: filtered.filter(p => p.status === 'paused').length,
      ended: filtered.filter(p => p.status === 'ended').length,
    };

    res.json({ partnerships: filtered, stats });
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

// POST /api/partnerships/invite — Send email invitations to influencers by email address
// Body: { brandId, emails: ['a@b.com', ...], message (optional) }
router.post('/invite', requireAuth, async (req, res) => {
  try {
    const { brandId, emails, message } = req.body;

    if (!brandId || !Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ error: 'brandId and emails array are required' });
    }

    const { Brand } = require('../models');
    const brand = await Brand.findById(brandId);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    const notify = require('../services/notifications');
    const sgMail = require('../config/email');

    const brandName = brand.name || 'A brand on KeepUsPostd';
    const signupUrl = `https://keepuspostd.com/pages/register-brand.html?type=creator&brandId=${brandId}`;
    const customMessage = (message || '').trim();

    const results = { sent: [], failed: [] };

    for (const email of emails.slice(0, 50)) { // Cap at 50 per call
      try {
        await sgMail.send({
          to: email,
          from: { name: 'KeepUsPostd', email: 'santana@keepuspostd.com' },
          subject: `${brandName} wants to partner with you on KeepUsPostd`,
          html: `
            <div style="font-family:Montserrat,Arial,sans-serif;max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;border:1px solid #eee;">
              <div style="background:linear-gradient(135deg,#2EA5DD 0%,#707BBB 100%);padding:32px;text-align:center;">
                <img src="https://keepuspostd.com/assets/images/kup_white_new_logo.png" alt="KeepUsPostd" style="height:32px;">
              </div>
              <div style="padding:32px;">
                <h2 style="font-size:1.3rem;font-weight:700;color:#1a1a1a;margin:0 0 12px;">${brandName} wants to partner with you!</h2>
                <p style="color:#555;line-height:1.7;margin:0 0 16px;">You've been invited to join KeepUsPostd and partner with <strong>${brandName}</strong>. Create content, earn cash rewards, and grow your influence.</p>
                ${customMessage ? `<blockquote style="border-left:3px solid #2EA5DD;margin:0 0 20px;padding:12px 16px;color:#444;background:#f8f9fa;border-radius:4px;">"${customMessage}"<br><small style="color:#888;">— ${brandName}</small></blockquote>` : ''}
                <a href="${signupUrl}" style="display:inline-block;padding:14px 28px;background:#2EA5DD;color:#fff;text-decoration:none;border-radius:8px;font-weight:700;font-size:0.9rem;">Accept Invitation</a>
                <p style="color:#999;font-size:0.78rem;margin-top:24px;">You received this because ${brandName} invited you. If you don't want invitations, simply ignore this email.</p>
              </div>
            </div>
          `,
        });
        results.sent.push(email);
        console.log(`📧 Influencer invite sent to ${email} from brand ${brandId}`);
      } catch (emailErr) {
        console.error(`❌ Failed to send invite to ${email}:`, emailErr.message);
        results.failed.push(email);
      }
    }

    res.json({
      message: `${results.sent.length} invitation${results.sent.length !== 1 ? 's' : ''} sent`,
      sent: results.sent.length,
      failed: results.failed.length,
    });
  } catch (error) {
    console.error('Influencer invite error:', error.message);
    res.status(500).json({ error: 'Could not send invitations' });
  }
});

module.exports = router;
