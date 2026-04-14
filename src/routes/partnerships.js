// Partnership Routes — Brand ↔ Influencer relationship management
// Enforces: G1 (brand isolation), unique partnerships, lifecycle management
// Sources: invitation, request, discovery, admin_brand
// Ref: PLATFORM_ARCHITECTURE.md → Partnership System
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { Partnership, InfluencerProfile, ContentSubmission, BrandProfile, Brand } = require('../models');
const { checkTrialStatus } = require('../services/trial');
const notify = require('../services/notifications');

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

    // Exclude the requesting user's own influencer profile + hidden accounts from brand-side discovery
    const filter = { campaignAccessUnlocked: true, isHidden: { $ne: true }, userId: { $ne: req.user._id } };

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
      const autoName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || (user.email || '').split('@')[0];
      const baseHandle = autoName.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9_]/g, '').substring(0, 20) || `user${Date.now()}`;
      influencer = await InfluencerProfile.create({
        userId: user._id,
        displayName: autoName,
        handle: baseHandle,
      });
    }
    const influencerProfileId = influencer._id;

    // Enforce influencer slot limit based on brand owner's plan tier
    const brandDoc = await Brand.findById(brandId).lean();
    let brandProfile = null;
    if (brandDoc) {
      brandProfile = await BrandProfile.findOne({ ownedBrandIds: brandDoc._id });
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

        // Increment influencer's brand partner count back
        await InfluencerProfile.findByIdAndUpdate(influencerProfileId, {
          $inc: { totalBrandsPartnered: 1 },
        });

        console.log(`🔄 Partnership reactivated: brand ${brandId} + influencer ${influencerProfileId}`);

        // Notify brand owner about the re-partnered influencer
        try {
          const { User } = require('../models');
          const ownerUser = brandProfile
            ? await User.findById(brandProfile.userId, 'email').lean()
            : null;
          await notify.newInfluencerPartner({
            brand: {
              name: brandDoc?.name,
              email: brandDoc?.email,
              ownerEmail: ownerUser?.email || brandDoc?.email,
              ownerId: brandProfile?.userId || null,
              logoUrl: brandDoc?.logoUrl || null,
            },
            influencer: {
              displayName: influencer.displayName,
              handle: influencer.handle,
            },
          });
        } catch (notifyErr) {
          console.warn('Reactivation notification error:', notifyErr.message);
        }

        // Notify influencer they're re-partnered
        try {
          const inflUser = await require('../models').User.findById(req.user._id, 'email').lean();
          await notify.newBrandPartnership({
            influencer: {
              email: inflUser?.email,
              userId: req.user._id,
              displayName: influencer.displayName,
            },
            brand: { name: brandDoc?.name || 'A brand', logoUrl: brandDoc?.logoUrl || null },
          });
        } catch (notifyErr) {
          console.warn('Influencer reactivation notification error:', notifyErr.message);
        }

        // 🏆 Award "join" gratitude points on re-partnership
        try {
          const { Reward } = require('../models');
          const rewards = await Reward.find({ brandId, status: 'active', earningMethod: 'point_based' });
          for (const reward of rewards) {
            const pc = reward.pointConfig || {};
            if (!pc.gratitudeEnabled) continue;
            const gp = pc.gratitudePoints || {};
            const joinPts = gp.join || 0;
            if (joinPts <= 0) continue;
            notify.pointsEarned({
              influencer, brand: brandDoc,
              rewardTitle: reward.title, points: joinPts, stage: 'join',
              totalPoints: joinPts, unlockThreshold: pc.unlockThreshold || 300,
              partnershipId: existing._id?.toString(),
            }).catch(() => {});
          }
        } catch (gratErr) {
          console.warn('Re-partnership gratitude points error:', gratErr.message);
        }

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

    // Increment influencer's brand partner count
    await InfluencerProfile.findByIdAndUpdate(influencerProfileId, {
      $inc: { totalBrandsPartnered: 1 },
    });

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

    // Notify brand owner about the new partner (email + in-app + push)
    try {
      const { User } = require('../models');
      const ownerUser = brandProfile
        ? await User.findById(brandProfile.userId, 'email firstName lastName').lean()
        : null;
      await notify.newInfluencerPartner({
        brand: {
          name: brandDoc?.name,
          email: brandDoc?.email,
          ownerEmail: ownerUser?.email || brandDoc?.email,
          ownerId: brandProfile?.userId || null,
          logoUrl: brandDoc?.logoUrl || null,
        },
        influencer: {
          displayName: influencer.displayName,
          handle: influencer.handle,
        },
      });
    } catch (notifyErr) {
      // Non-critical — log but don't fail the partnership creation
      console.warn('Partnership notification error:', notifyErr.message);
    }

    // Notify influencer that they're now partnered (email + in-app + push)
    try {
      const inflUser = await require('../models').User.findById(req.user._id, 'email').lean();
      await notify.newBrandPartnership({
        influencer: {
          email: inflUser?.email,
          userId: req.user._id,
          displayName: influencer.displayName,
        },
        brand: { name: brandDoc?.name || 'A brand', logoUrl: brandDoc?.logoUrl || null },
      });
    } catch (notifyErr) {
      console.warn('Influencer partnership notification error:', notifyErr.message);
    }

    // 🏆 Award "join" gratitude points for all active point-based rewards
    try {
      const { Reward } = require('../models');
      const rewards = await Reward.find({ brandId, status: 'active', earningMethod: 'point_based' });
      for (const reward of rewards) {
        const pc = reward.pointConfig || {};
        if (!pc.gratitudeEnabled) continue;
        const gp = pc.gratitudePoints || {};
        const joinPts = gp.join || 0;
        if (joinPts <= 0) continue;

        notify.pointsEarned({
          influencer,
          brand: brandDoc,
          rewardTitle: reward.title,
          points: joinPts,
          stage: 'join',
          totalPoints: joinPts,
          unlockThreshold: pc.unlockThreshold || 300,
          partnershipId: partnership._id?.toString(),
        }).catch(() => {});
      }
    } catch (gratErr) {
      console.warn('Gratitude points error:', gratErr.message);
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
    // Default to active partnerships only — ended ones shouldn't show in the app
    filter.status = status || 'active';

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
      .populate('influencerProfileId', 'displayName handle avatarUrl influenceTier creatorTier stats isHidden isVerified realFollowerCount followerCount totalReviews averageRating ratingCount totalCashEarned')
      .populate('brandId', 'name initials generatedColor logoUrl avatarUrl category kioskBrandCode brandColors')
      .sort({ createdAt: -1 })
      .limit(200);

    // Filter out hidden influencers (auto-created/test accounts) from brand portal views
    const filtered = partnerships.filter(p => !p.influencerProfileId?.isHidden);

    // Gather stats excluding brand owner's own profile and ended partnerships
    const statsFilter = brandId ? { brandId } : {};
    if (brandId) {
      const ownProfile = await InfluencerProfile.findOne({ userId: req.user._id }, '_id').lean();
      if (ownProfile) {
        statsFilter.influencerProfileId = { $ne: ownProfile._id };
      }
    }
    const [activeCount, pausedCount] = await Promise.all([
      Partnership.countDocuments({ ...statsFilter, status: 'active' }),
      Partnership.countDocuments({ ...statsFilter, status: 'paused' }),
    ]);
    const stats = {
      total: activeCount + pausedCount,
      active: activeCount,
      paused: pausedCount,
      ended: 0,
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

// POST /api/partnerships/leave — Influencer ends their partnership with a brand
// Body: { brandId }  — looks up partnership by brandId + logged-in user's influencer profile
router.post('/leave', requireAuth, async (req, res) => {
  try {
    const { brandId } = req.body;
    if (!brandId) return res.status(400).json({ error: 'brandId is required' });

    const influencer = await InfluencerProfile.findOne({ userId: req.user._id });
    if (!influencer) return res.status(404).json({ error: 'Influencer profile not found' });

    const partnership = await Partnership.findOne({
      brandId,
      influencerProfileId: influencer._id,
      status: { $in: ['active', 'paused'] },
    });

    if (!partnership) {
      return res.status(404).json({ error: 'No active partnership found with this brand' });
    }

    partnership.status = 'ended';
    partnership.endedAt = new Date();
    partnership.endedBy = 'influencer';
    await partnership.save();

    // Decrement influencer's brand partner count (floor at 0)
    await InfluencerProfile.findByIdAndUpdate(influencer._id, {
      $inc: { totalBrandsPartnered: -1 },
    });
    await InfluencerProfile.updateOne(
      { _id: influencer._id, totalBrandsPartnered: { $lt: 0 } },
      { $set: { totalBrandsPartnered: 0 } }
    );

    console.log(`👋 Influencer @${influencer.handle} left brand ${brandId}`);

    // Notify brand owner that the influencer left
    try {
      const { User } = require('../models');
      const brandDoc = await Brand.findById(brandId).lean();
      const brandProfile = await BrandProfile.findOne({ ownedBrandIds: brandId });
      const ownerUser = brandProfile
        ? await User.findById(brandProfile.userId, 'email').lean()
        : null;

      if (ownerUser || brandDoc?.email) {
        const { sendEmail } = require('../config/email');
        const APP_URL = process.env.APP_URL || 'https://keepuspostd.com';
        await sendEmail({
          to: ownerUser?.email || brandDoc?.email,
          subject: `Partner Update — ${influencer.displayName || influencer.handle} left ${brandDoc?.name || 'your brand'}`,
          headline: 'Influencer Left Partnership',
          preheader: `${influencer.displayName || influencer.handle} ended their partnership.`,
          bodyHtml: `
            <p><strong>${influencer.displayName || influencer.handle}</strong> has ended their partnership with <strong>${brandDoc?.name || 'your brand'}</strong>.</p>
            <p>Any pending content submissions will remain in your queue.</p>
          `,
          ctaText: 'View Influencers',
          ctaUrl: `${APP_URL}/pages/inner/influencers.html`,
          variant: 'brand',
        });

        if (brandProfile?.userId) {
          const { Notification } = require('../models');
          await Notification.create({
            userId: brandProfile.userId,
            title: 'Partner Left',
            message: `${influencer.displayName || influencer.handle} ended their partnership with ${brandDoc?.name || 'your brand'}.`,
            type: 'partnership',
            link: '/pages/inner/influencers.html',
          });
        }
      }
    } catch (notifyErr) {
      console.warn('Leave notification error:', notifyErr.message);
    }

    res.json({ message: 'Partnership ended', partnership });
  } catch (error) {
    console.error('Leave partnership error:', error.message);
    res.status(500).json({ error: 'Could not leave partnership' });
  }
});

// GET /api/partnerships/:partnershipId — Get single partnership with details
router.get('/:partnershipId', requireAuth, async (req, res) => {
  try {
    const partnership = await Partnership.findById(req.params.partnershipId)
      .populate('influencerProfileId', 'displayName handle avatarUrl influenceTier creatorTier stats bio isVerified realFollowerCount')
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

    // Update influencer's brand partner count when ending (floor at 0)
    if (newStatus === 'ended') {
      await InfluencerProfile.findByIdAndUpdate(partnership.influencerProfileId, {
        $inc: { totalBrandsPartnered: -1 },
      });
      await InfluencerProfile.updateOne(
        { _id: partnership.influencerProfileId, totalBrandsPartnered: { $lt: 0 } },
        { $set: { totalBrandsPartnered: 0 } }
      );
    }

    console.log(`🤝 Partnership ${partnership._id} → ${newStatus}`);

    // Notify influencer when brand ends the partnership
    if (newStatus === 'ended') {
      try {
        const inflProfile = await InfluencerProfile.findById(partnership.influencerProfileId).lean();
        const brandDoc = await Brand.findById(partnership.brandId).lean();
        const { User } = require('../models');
        const inflUser = inflProfile?.userId
          ? await User.findById(inflProfile.userId, 'email').lean()
          : null;
        await notify.partnershipRemoved({
          influencer: {
            email: inflUser?.email,
            userId: inflProfile?.userId,
            displayName: inflProfile?.displayName || inflProfile?.handle,
          },
          brand: { name: brandDoc?.name || 'A brand', logoUrl: brandDoc?.logoUrl || null },
        });
      } catch (notifyErr) {
        console.warn('End partnership notification error:', notifyErr.message);
      }
    }

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
// Called from Flutter Rate Partnership screen after influencer receives payout
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

    // Roll up to Brand model — brand's average rating from all influencer feedback
    try {
      const allBrandRated = await Partnership.find({
        brandId: partnership.brandId,
        'influencerRating.overall': { $ne: null },
      }, 'influencerRating.overall').lean();

      const brandRatingCount = allBrandRated.length;
      const brandAvgRating = brandRatingCount > 0
        ? Math.round((allBrandRated.reduce((sum, p) => sum + p.influencerRating.overall, 0) / brandRatingCount) * 10) / 10
        : null;

      await Brand.findByIdAndUpdate(partnership.brandId, {
        averageRating: brandAvgRating,
        ratingCount: brandRatingCount,
      });
    } catch (rollupErr) {
      console.error('Brand rating rollup error (non-blocking):', rollupErr.message);
    }

    console.log(`⭐ Influencer rated brand: partnership ${partnership._id} → ${overall}/5`);

    res.json({ message: 'Rating saved', overall, partnership });
  } catch (error) {
    console.error('Rate partnership error:', error.message);
    res.status(500).json({ error: 'Could not save rating' });
  }
});

// POST /api/partnerships/:partnershipId/brand-rate — Brand rates influencer after content approval
// Called from Content Manager after "Confirm Approval"
router.post('/:partnershipId/brand-rate', requireAuth, async (req, res) => {
  try {
    const { contentQuality, timeliness, communication, briefCompliance, feedback, contentSubmissionId } = req.body;

    // Validate all 4 required scores
    const scores = { contentQuality, timeliness, communication, briefCompliance };
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
      (contentQuality + timeliness + communication + briefCompliance) / 4
    );

    partnership.brandRating = {
      contentQuality,
      timeliness,
      communication,
      briefCompliance,
      overall,
      feedback: feedback || null,
      ratedAt: new Date(),
      contentSubmissionId: contentSubmissionId || null,
    };

    await partnership.save();

    // Roll up to InfluencerProfile — influencer's average rating from all brand feedback
    try {
      const allInfluencerRated = await Partnership.find({
        influencerProfileId: partnership.influencerProfileId,
        'brandRating.overall': { $ne: null },
      }, 'brandRating.overall').lean();

      const ratingCount = allInfluencerRated.length;
      const averageRating = ratingCount > 0
        ? Math.round((allInfluencerRated.reduce((sum, p) => sum + p.brandRating.overall, 0) / ratingCount) * 10) / 10
        : null;

      await InfluencerProfile.findByIdAndUpdate(partnership.influencerProfileId, {
        averageRating,
        ratingCount,
      });
    } catch (rollupErr) {
      console.error('Influencer rating rollup error (non-blocking):', rollupErr.message);
    }

    console.log(`⭐ Brand rated influencer: partnership ${partnership._id} → ${overall}/5`);

    res.json({ message: 'Brand rating saved', overall, partnership });
  } catch (error) {
    console.error('Brand rate error:', error.message);
    res.status(500).json({ error: 'Could not save brand rating' });
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

// POST /api/partnerships/:partnershipId/award-gratitude — Award gratitude points manually
// Used for birthday, anniversary, or admin-triggered gratitude events
// Body: { stage: 'birthday' | 'anniversary' }
router.post('/:partnershipId/award-gratitude', requireAuth, async (req, res) => {
  try {
    const { stage, giftPoints } = req.body;
    if (!stage || !['birthday', 'anniversary', 'join', 'gift'].includes(stage)) {
      return res.status(400).json({ error: 'stage must be birthday, anniversary, join, or gift' });
    }

    const partnership = await Partnership.findById(req.params.partnershipId)
      .populate('influencerProfileId', 'displayName handle avatarUrl userId')
      .lean();
    if (!partnership) return res.status(404).json({ error: 'Partnership not found' });

    const { Reward, Brand, ContentSubmission } = require('../models');
    const brand = await Brand.findById(partnership.brandId);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    const rewards = await Reward.find({ brandId: partnership.brandId, status: 'active', earningMethod: 'point_based' });
    let awarded = 0;

    for (const reward of rewards) {
      const pc = reward.pointConfig || {};

      // For gift stage: use custom giftPoints amount, no gratitude check needed
      let points;
      if (stage === 'gift') {
        points = parseInt(giftPoints) || 0;
      } else {
        if (!pc.gratitudeEnabled) continue;
        const gp = pc.gratitudePoints || {};
        points = gp[stage] || 0;
      }
      if (points <= 0) continue;

      // Calculate current total for the notification
      const infId = partnership.influencerProfileId._id || partnership.influencerProfileId;
      const [submitted, approved, postd] = await Promise.all([
        ContentSubmission.countDocuments({ brandId: partnership.brandId, influencerProfileId: infId }),
        ContentSubmission.countDocuments({ brandId: partnership.brandId, influencerProfileId: infId, status: 'approved' }),
        ContentSubmission.countDocuments({ brandId: partnership.brandId, influencerProfileId: infId, status: 'postd' }),
      ]);
      const pts = pc.contentPoints || {};
      const contentPts = (pts.submitted || 0) * submitted + (pts.approved || 0) * approved + (pts.published || 0) * postd + (pts.bonus || 0) * postd;

      // Include purchase + existing gift points in total (same as my-progress API)
      let purchasePts = 0;
      if (pc.purchaseEnabled) {
        try {
          const PurchasePointsLog = require('../models/PurchasePointsLog');
          const agg = await PurchasePointsLog.aggregate([
            { $match: { brandId: require('mongoose').Types.ObjectId.createFromHexString(partnership.brandId.toString()), influencerProfileId: infId } },
            { $group: { _id: null, total: { $sum: '$pointsAwarded' } } },
          ]);
          purchasePts = agg[0]?.total ?? 0;
        } catch (_) {}
      }
      const existingGiftPts = partnership.giftedPoints || 0;
      const totalWithGift = contentPts + purchasePts + existingGiftPts + points;

      // Find next level
      const levels = pc.levels || [];
      const nextLevel = levels.find(l => totalWithGift < l.threshold);
      const displayThreshold = nextLevel ? nextLevel.threshold : (pc.unlockThreshold || 300);
      const displayTitle = nextLevel ? (nextLevel.rewardValue || reward.title) : reward.title;

      await notify.pointsEarned({
        influencer: partnership.influencerProfileId,
        brand,
        rewardTitle: displayTitle,
        points,
        stage: stage === 'gift' ? 'gift from brand' : stage,
        totalPoints: totalWithGift,
        unlockThreshold: displayThreshold,
        partnershipId: partnership._id.toString(),
      });

      // Check if any level was just unlocked by this gift
      // previousTotal = total BEFORE this gift was added
      const previousTotal = totalWithGift - points;
      for (const lvl of levels) {
        if (totalWithGift >= lvl.threshold && previousTotal < lvl.threshold) {
          console.log(`🎉 Gift unlocked level: ${lvl.rewardValue} for ${partnership.influencerProfileId.displayName}`);
          notify.levelUnlocked({
            influencer: partnership.influencerProfileId,
            brand,
            rewardValue: lvl.rewardValue,
            rewardType: lvl.rewardType,
            threshold: lvl.threshold,
            totalPoints: totalWithGift,
            partnershipId: partnership._id.toString(),
          }).catch(() => {});
        }
      }

      awarded += points;
    }

    // Persist gifted points on partnership
    if (stage === 'gift' && awarded > 0) {
      await Partnership.findByIdAndUpdate(partnership._id, {
        $inc: { giftedPoints: awarded, totalPointsEarned: awarded },
      });
    }

    console.log(`🎁 ${stage} points awarded: ${awarded} pts for partnership ${partnership._id}`);
    res.json({ message: `${awarded} points awarded`, awarded });
  } catch (error) {
    console.error('Award gratitude error:', error.message);
    res.status(500).json({ error: 'Could not award gratitude points' });
  }
});

module.exports = router;
