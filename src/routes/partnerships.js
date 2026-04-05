// Partnership Routes — Brand ↔ Influencer relationship management
// Enforces: G1 (brand isolation), unique partnerships, lifecycle management
// Sources: invitation, request, discovery, admin_brand
// Ref: PLATFORM_ARCHITECTURE.md → Partnership System
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { Partnership, InfluencerProfile, ContentSubmission, BrandProfile, Brand } = require('../models');
const { checkTrialStatus } = require('../services/trial');

// Influencer slot limits per plan tier
const INFLUENCER_SLOT_LIMITS = {
  starter: 10,
  growth: 100,
  pro: 500,
  agency: 2000,
  enterprise: Infinity,
};

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
    const { brandId, source } = req.body;

    if (!brandId) {
      return res.status(400).json({ error: 'brandId is required' });
    }

    // Look up or auto-create influencer profile — brand-only users get one on first partner tap
    let influencer = await InfluencerProfile.findOne({ userId: req.user._id });
    if (!influencer) {
      const user = req.user;
      const baseHandle = (user.email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '') || `user${Date.now()}`;
      influencer = await InfluencerProfile.create({
        userId: user._id,
        displayName: `${user.firstName || ''} ${user.lastName || ''}`.trim() || baseHandle,
        handle: baseHandle,
      });
    }
    const influencerProfileId = influencer._id;

    // Enforce influencer slot limit based on brand owner's plan tier
    const brandDoc = await Brand.findById(brandId).lean();
    if (brandDoc) {
      const brandProfile = await BrandProfile.findOne({ ownedBrandIds: brandDoc._id });
      if (brandProfile) {
        const { effectiveTier } = checkTrialStatus(brandProfile);
        const slotLimit = INFLUENCER_SLOT_LIMITS[effectiveTier] ?? 10;
        if (slotLimit !== Infinity) {
          const activeCount = await Partnership.countDocuments({
            brandId,
            status: { $in: ['active', 'paused'] },
          });
          if (activeCount >= slotLimit) {
            return res.status(403).json({
              error: 'Partnership limit reached',
              message: `This brand has reached its ${slotLimit}-influencer limit on the ${effectiveTier} plan. Upgrade to add more partners.`,
              currentPlan: effectiveTier,
              limit: slotLimit,
              current: activeCount,
            });
          }
        }
      }
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

    const resolvedSource = source || 'invitation';
    // All partnerships activate instantly — no approval gate.
    // Brand control is handled via plan slot limits, remove, pause, and future Invite Only mode.
    const partnership = await Partnership.create({
      brandId,
      influencerProfileId,
      status: 'active',
      source: resolvedSource,
      startedAt: new Date(),
    });

    console.log(`🤝 Partnership created: brand ${brandId} + @${influencer.handle}`);

    // Update BrandInvite record to 'accepted' so the Invited tab reflects the response.
    // This links the partnership back to the email invite that brought the influencer in.
    try {
      const { BrandInvite } = require('../models');
      const user = req.user;
      if (user.email) {
        await BrandInvite.findOneAndUpdate(
          { brandId, email: user.email.toLowerCase(), status: 'pending' },
          { status: 'accepted', acceptedAt: new Date() },
        );
      }
    } catch (inviteErr) {
      // Non-critical — log but don't fail the partnership creation
      console.warn('Could not update BrandInvite status:', inviteErr.message);
    }

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
      return res.json({ brands: [] });
    }

    const { status } = req.query;
    const filter = { influencerProfileId: influencerProfile._id };
    if (status) filter.status = status;

    const partnerships = await Partnership.find(filter)
      .populate('brandId', 'name initials generatedColor category logoUrl heroImageUrl kioskBrandCode brandColors')
      .sort({ createdAt: -1 })
      .limit(200);

    // Flatten to Brand objects directly — app's Brand.fromJson expects brand fields at root level
    const brands = partnerships
      .filter(p => p.brandId) // skip any orphaned partnerships
      .map(p => {
        const b = p.brandId.toObject ? p.brandId.toObject() : p.brandId;
        return {
          ...b,
          partnershipId: p._id,
          partnershipStatus: p.status,
        };
      });

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
      partnered: !!partnership && partnership.status === 'active', // Flutter compat alias
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

    // Gather stats from full DB count (not filtered list) so numbers are accurate
    // even when the brand owner's own profile is excluded from the visible list
    const statsFilter = brandId ? { brandId } : {};
    const [totalCount, activeCount, pausedCount] = await Promise.all([
      Partnership.countDocuments(statsFilter),
      Partnership.countDocuments({ ...statsFilter, status: 'active' }),
      Partnership.countDocuments({ ...statsFilter, status: 'paused' }),
    ]);
    const stats = {
      total: totalCount,
      active: activeCount,
      paused: pausedCount,
      ended: totalCount - activeCount - pausedCount,
    };

    res.json({ partnerships: filtered, stats });
  } catch (error) {
    console.error('List partnerships error:', error.message);
    res.status(500).json({ error: 'Could not fetch partnerships' });
  }
});

// GET /api/partnerships/pending-invites — All email invites for a brand's Invited tab
// Returns both pending (awaiting response) and accepted (partnered via invite link)
// MUST be before /:partnershipId or Express will match 'pending-invites' as a partnershipId
router.get('/pending-invites', requireAuth, async (req, res) => {
  try {
    const { brandId } = req.query;
    console.log(`📬 pending-invites called — brandId: ${brandId}`);
    if (!brandId) return res.status(400).json({ error: 'brandId is required' });

    const { BrandInvite } = require('../models');
    const invites = await BrandInvite.find({
      brandId,
      status: { $in: ['pending', 'accepted'] },
    })
      .sort({ createdAt: -1 })
      .lean();

    console.log(`📬 pending-invites result — ${invites.length} invite(s) found for brand ${brandId}`);
    res.json({ invites });
  } catch (error) {
    console.error('Pending invites error:', error.message);
    res.status(500).json({ error: 'Could not load pending invites' });
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

    // Roll up averageRating + ratingCount onto the InfluencerProfile
    // Recalculate from all rated partnerships for this influencer (accurate aggregate)
    try {
      const allRated = await Partnership.find({
        influencerProfileId: partnership.influencerProfileId,
        'influencerRating.overall': { $ne: null },
      }, 'influencerRating.overall').lean();

      const ratingCount = allRated.length;
      const averageRating = ratingCount > 0
        ? Math.round((allRated.reduce((sum, p) => sum + p.influencerRating.overall, 0) / ratingCount) * 10) / 10
        : null;

      await InfluencerProfile.findByIdAndUpdate(partnership.influencerProfileId, {
        averageRating,
        ratingCount,
      });
    } catch (rollupErr) {
      console.error('Rating rollup error (non-blocking):', rollupErr.message);
    }

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
    const { brandId, emails, message, partnerLink } = req.body;

    if (!brandId || !Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ error: 'brandId and emails array are required' });
    }

    const { Brand, BrandInvite } = require('../models');
    const brand = await Brand.findById(brandId);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    const { sendEmail } = require('../config/email');

    const brandName = brand.name || 'A brand on KeepUsPostd';
    // Use passed partnerLink only if it looks like a real URL (not a placeholder or empty)
    const isValidLink = partnerLink && partnerLink.startsWith('https://') && !partnerLink.includes('...');
    // Use /brands/{mongoId} — this matches the AASA Universal Link pattern so iOS opens the app directly.
    // Fallback chain: passed link → mongo ID path → handle → kiosk code
    const link = isValidLink
      ? partnerLink
      : `https://keepuspostd.com/brands/${brand._id}`;
    const customMessage = (message || '').trim()
      .replace('{brand name}', brandName); // resolve placeholder if present

    const results = { sent: [], failed: [] };

    for (const email of emails.slice(0, 50)) { // Cap at 50 per call
      try {
        await sendEmail({
          to: email,
          subject: `${brandName} wants to partner with you on KeepUsPostd`,
          preheader: `You've been invited to partner with ${brandName} and start earning.`,
          headline: `${brandName} wants to partner with you!`,
          bodyHtml: `
            <p style="margin:0 0 16px;">You've been personally invited to join KeepUsPostd and partner with <strong>${brandName}</strong>. Share reviews, earn cash rewards, and grow your influence.</p>
            ${customMessage ? `<blockquote style="border-left:3px solid #2EA5DD;margin:0 0 20px;padding:12px 16px;color:#444;background:#f8f9fa;border-radius:4px;text-align:left;">"${customMessage}"<br><small style="color:#888;">— ${brandName}</small></blockquote>` : ''}
            <div style="background:#f5f7fa;border-radius:10px;padding:16px;margin:0 0 8px;word-break:break-all;">
              <p style="margin:0 0 6px;font-size:12px;color:#888;font-weight:600;text-transform:uppercase;letter-spacing:.05em;">Your partner link</p>
              <a href="${link}" style="color:#2EA5DD;font-weight:700;font-size:0.9rem;text-decoration:none;">${link}</a>
            </div>
          `,
          ctaText: 'Join as a Partner',
          ctaUrl: link,
          variant: 'influencer',
        });
        results.sent.push(email);
        console.log(`📧 Influencer invite sent to ${email} from brand ${brandId}`);

        // Save invite record so it appears in the Invited tab dashboard
        // upsert: re-sending to same email refreshes the expiry instead of erroring
        await BrandInvite.findOneAndUpdate(
          { brandId, email: email.toLowerCase() },
          {
            brandId,
            email: email.toLowerCase(),
            status: 'pending',
            message: customMessage || null,
            sentBy: req.user?._id || null,
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        );
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
