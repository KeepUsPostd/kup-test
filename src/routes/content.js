// Content Routes — Submission + Approval Pipeline
// Enforces: G6 (content requires approval), content ownership on submission
// Status flow: submitted → approved/rejected → postd
// Ref: PLATFORM_ARCHITECTURE.md → Content Lifecycle
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { ContentSubmission, Partnership, Campaign, InfluencerProfile, Transaction, Reward, Brand, BrandProfile, User } = require('../models');
const notify = require('../services/notifications');
const paypal = require('../config/paypal');

// ── Fee Structure & Tier Rates (mirrored from payouts.js) ─────
// Rule G7: Brands cannot override — rates come from influencer tier.
const FEES = {
  paypal: { percent: 0.0299, flat: 0.49 },
  kup:    { flat: 0.50 },
};

const BONUS_CASH_PERCENT = 0.30;

const TIER_RATES = {
  unverified:  { video: { influencerGets: 4,  brandPays: 5.14  }, image: { influencerGets: 2,  brandPays: 3.08  } },
  nano:        { video: { influencerGets: 8,  brandPays: 9.27  }, image: { influencerGets: 4,  brandPays: 5.14  } },
  micro:       { video: { influencerGets: 11, brandPays: 12.36 }, image: { influencerGets: 6,  brandPays: 7.21  } },
  rising:      { video: { influencerGets: 18, brandPays: 19.58 }, image: { influencerGets: 9,  brandPays: 10.30 } },
  established: { video: { influencerGets: 25, brandPays: 26.79 }, image: { influencerGets: 12, brandPays: 13.39 } },
  premium:     { video: { influencerGets: 33, brandPays: 35.04 }, image: { influencerGets: 15, brandPays: 16.48 } },
  celebrity:   { video: { influencerGets: 45, brandPays: 47.41 }, image: { influencerGets: 23, brandPays: 24.73 } },
};

// ── Auto-Payout Helper (Vault flow: KUP → influencer immediately) ──
// After Vault captures brand's payment to KUP, send influencer their cut right away.
// Non-blocking: if payout fails, brand charge still stands — admin can retry.
async function sendAutoPayout(transaction, influencer, amount, tier, contentType, brand, partnershipId) {
  try {
    const influencerPaypalEmail = influencer.paypalEmail;
    console.log(`💸 Auto-payout attempt: influencer=${influencer.displayName}, email=${influencerPaypalEmail || 'NONE'}, amount=$${amount}, tier=${tier}`);

    if (influencerPaypalEmail) {
      const payoutBatchId = `cpa-${transaction._id}-${Date.now()}`;
      console.log(`💸 Calling PayPal Payouts API: $${amount} → ${influencerPaypalEmail} (batch: ${payoutBatchId})`);

      const payoutResult = await paypal.createPayout(
        [{
          email: influencerPaypalEmail,
          amount: amount,
          note: `Content approved: ${influencer.displayName || 'Influencer'} — ${tier} tier ${contentType}`,
        }],
        payoutBatchId
      );

      console.log(`💸 PayPal Payouts API response:`, JSON.stringify(payoutResult?.batch_header || payoutResult));

      transaction.payoutBatchId = payoutResult.batch_header?.payout_batch_id || payoutBatchId;
      transaction.payoutSentAt = new Date();
      transaction.payoutMethod = 'auto_vault';
      console.log(`💸 Influencer payout sent: $${amount} to ${influencerPaypalEmail} (batch: ${transaction.payoutBatchId})`);

      // Send payout received notification + rating request to influencer
      notify.payoutReceived({
        influencer: { userId: influencer.userId, displayName: influencer.displayName },
        brand: { name: brand?.name || 'A brand' },
        amount,
        partnershipId,
        contentType,
      }).catch(() => {});
    } else {
      console.log(`ℹ️ No PayPal email for influencer — payout deferred to manual cashout`);
    }
  } catch (payoutErr) {
    console.error(`❌ Influencer payout FAILED: ${payoutErr.message}`);
    if (payoutErr.paypalResponse) console.error(`❌ PayPal payout response:`, JSON.stringify(payoutErr.paypalResponse));
    // Transaction stays 'paid' — brand was charged. Payout can be retried from admin.
  }
}

function resolveRate(tier, contentType) {
  const rates = TIER_RATES[tier] || TIER_RATES.nano;
  return contentType === 'video' ? rates.video : rates.image;
}

function calcBonusCash(baseAmount) {
  return Math.round(baseAmount * BONUS_CASH_PERCENT * 100) / 100;
}

// Viral bonus thresholds — when metrics cross these, trigger bonus transactions
const VIRAL_THRESHOLDS = [
  { views: 10000, bonus: 25, label: '10K views' },
  { views: 100000, bonus: 100, label: '100K views' },
  { views: 1000000, bonus: 500, label: '1M views' },
];

// POST /api/content — Submit new content
// Called by influencers when they submit content for a brand
router.post('/', requireAuth, async (req, res) => {
  try {
    const { brandId, campaignId, contentType, caption, mediaUrls, posterUrl,
            platform, platformPostUrl, partnershipId } = req.body;

    if (!brandId) {
      return res.status(400).json({ error: 'brandId is required' });
    }
    if (!contentType) {
      return res.status(400).json({ error: 'contentType is required (photo, video, or mixed)' });
    }

    // Validate campaign exists and is active (if provided)
    if (campaignId) {
      const campaign = await Campaign.findById(campaignId);
      if (!campaign) {
        return res.status(404).json({ error: 'Campaign not found' });
      }
      if (campaign.status !== 'active') {
        return res.status(400).json({
          error: 'Campaign not active',
          message: `This campaign is "${campaign.status}". Content can only be submitted to active campaigns.`,
        });
      }
      // Check max submissions
      if (campaign.maxSubmissions && campaign.submissionCount >= campaign.maxSubmissions) {
        return res.status(400).json({
          error: 'Campaign full',
          message: 'This campaign has reached its maximum number of submissions.',
        });
      }
    }

    // Look up the influencer profile for this user — auto-create if brand account submitting as creator
    let influencerProfile = await InfluencerProfile.findOne({ userId: req.user._id });
    if (!influencerProfile) {
      const user = req.user;
      const autoName = `${user.legalFirstName || ''} ${user.legalLastName || ''}`.trim() || (user.email || '').split('@')[0];
      const baseHandle = autoName.toLowerCase().replace(/\s+/g, '').replace(/[^a-z0-9_]/g, '').substring(0, 20) || `user${Date.now()}`;
      const referralCode = 'INF-' + Math.random().toString(36).substring(2, 8).toUpperCase();
      const displayName = autoName;
      let finalHandle = baseHandle;
      const existingHandle = await InfluencerProfile.findOne({ handle: baseHandle }).select('_id').lean();
      if (existingHandle) {
        finalHandle = baseHandle.substring(0, 15) + '_' + Math.random().toString(36).substring(2, 5);
      }
      try {
        influencerProfile = await InfluencerProfile.create({
          userId: user._id,
          displayName,
          handle: finalHandle,
          referralCode,
        });
        await User.findByIdAndUpdate(user._id, { hasInfluencerProfile: true });
        console.log(`✅ Auto-created influencer profile for ${user.email} during content submit`);
      } catch (createErr) {
        console.error('Could not auto-create influencer profile:', createErr.message);
        return res.status(403).json({
          error: 'No influencer profile',
          message: 'You need a creator account to submit content.',
        });
      }
    }

    // Self-submission gate: brand members cannot submit content to their own brand
    const BrandMember = require('../models/BrandMember');
    const isBrandMember = await BrandMember.findOne({
      brandId: brandId,
      userId: req.user._id,
      status: 'active',
    });
    if (isBrandMember) {
      return res.status(403).json({
        error: 'self_submission',
        message: "You can't submit reviews to your own brand. Choose a different brand to review as an influencer.",
      });
    }

    // RULE: No "Unknown" influencers. If profile is missing displayName or handle,
    // auto-populate from the User record we already have — don't block the flow.
    // The native app will prompt for profile enhancement later.
    if (!influencerProfile.displayName || !influencerProfile.handle) {
      const user = req.user;
      const fallbackName = [user.legalFirstName, user.legalLastName].filter(Boolean).join(' ')
        || user.email.split('@')[0];
      const fallbackHandle = user.email.split('@')[0].toLowerCase().replace(/[^a-z0-9_]/g, '_').substring(0, 20);

      if (!influencerProfile.displayName) influencerProfile.displayName = fallbackName;
      if (!influencerProfile.handle) influencerProfile.handle = fallbackHandle;
      await influencerProfile.save();
      console.log(`🔧 Auto-completed creator profile for ${user.email}: "${influencerProfile.displayName}" @${influencerProfile.handle}`);
    }

    // Derive posterUrl from video filename if client didn't send it
    // Upload route names posters as: <videoBasename>-poster.jpg
    // Works for both web and Flutter app submissions
    let resolvedPosterUrl = posterUrl || null;
    if (!resolvedPosterUrl && contentType === 'video' && mediaUrls && mediaUrls.length > 0) {
      const videoUrl = mediaUrls[0];
      if (videoUrl && videoUrl.startsWith('http')) {
        resolvedPosterUrl = videoUrl.replace(/\.[^.]+$/, '-poster.jpg');
      }
    }

    const submission = await ContentSubmission.create({
      influencerProfileId: influencerProfile._id,
      brandId,
      campaignId: campaignId || null,
      partnershipId: partnershipId || null,
      contentType,
      caption: caption || null,
      mediaUrls: mediaUrls || [],
      posterUrl: resolvedPosterUrl,
      platform: platform || null,
      platformPostUrl: platformPostUrl || null,
      status: 'submitted',
      submittedAt: new Date(),
    });

    // Increment campaign submission count
    if (campaignId) {
      await Campaign.findByIdAndUpdate(campaignId, {
        $inc: { submissionCount: 1 },
      });
    }

    // Increment partnership submission count
    if (partnershipId) {
      await Partnership.findByIdAndUpdate(partnershipId, {
        $inc: { totalSubmissions: 1 },
      });
    }

    // Increment influencer profile post count
    await InfluencerProfile.findByIdAndUpdate(influencerProfile._id, {
      $inc: { totalReviews: 1 },
    });

    console.log(`📸 Content submitted for brand ${brandId} (${contentType})`);

    // 📧 Notify brand (new submission) + influencer (confirmation)
    try {
      const brand = await Brand.findById(brandId);
      const influencer = await InfluencerProfile.findById(submission.influencerProfileId);
      if (brand && influencer) {
        notify.contentSubmitted({ brand, influencer, submission }).catch(() => {});
        notify.contentSubmissionConfirmed({ influencer: { ...influencer.toObject(), email: req.user.email, userId: req.user._id }, brand, submission }).catch(() => {});
      }
    } catch (notifyErr) {
      console.error('Notification error (non-blocking):', notifyErr.message);
    }

    res.status(201).json({
      message: 'Content submitted for review',
      submission,
    });
  } catch (error) {
    console.error('Submit content error:', error.message);
    res.status(500).json({ error: 'Could not submit content' });
  }
});

// ── Public Feed Endpoints ────────────────────────────────────────────────────

// GET /api/content/feed/categories — Categories that have approved content (for filter pills)
router.get('/feed/categories', async (req, res) => {
  try {
    const brandIdsWithContent = await ContentSubmission.distinct('brandId', { status: 'approved' });
    const categories = await Brand.distinct('category', {
      _id: { $in: brandIdsWithContent },
      category: { $ne: null, $nin: ['', 'null', 'undefined'] },
    });
    res.json({ categories: categories.sort() });
  } catch (error) {
    console.error('[GET /content/feed/categories]', error.message);
    res.status(500).json({ error: 'Could not load categories' });
  }
});

// GET /api/content/feed — Platform-wide approved content for the video discovery feed
// No auth required — Apple reviewers with any account (or none) see real content
// Optional filters: ?category=Food+%26+Beverage  ?brandIds=id1,id2,id3
router.get('/feed', async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const skip = (page - 1) * limit;
    const { category, brandIds, lat, lon, radiusMi } = req.query;

    // Build filter
    const contentFilter = { status: 'approved' };

    // Geo filter — find brands near the user's coordinates
    if (lat && lon) {
      const latitude = parseFloat(lat);
      const longitude = parseFloat(lon);
      const radius = Math.min(parseFloat(radiusMi) || 25, 100); // default 25mi, max 100mi
      const radiusMeters = radius * 1609.34;

      if (!isNaN(latitude) && !isNaN(longitude)) {
        const nearbyBrands = await Brand.find({
          coordinates: {
            $nearSphere: {
              $geometry: { type: 'Point', coordinates: [longitude, latitude] },
              $maxDistance: radiusMeters,
            },
          },
          status: 'active',
        }).select('_id').lean();

        contentFilter.brandId = { $in: nearbyBrands.map(b => b._id) };
      }
    }

    // Category filter — find brands in this category, then filter content by those brands
    if (category && category.toLowerCase() !== 'all') {
      const matchingBrands = await Brand.find({
        category: { $regex: `^${category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
      }).select('_id').lean();
      const categoryIds = matchingBrands.map(b => b._id);
      if (contentFilter.brandId) {
        // Intersect with geo filter
        const geoSet = new Set(contentFilter.brandId.$in.map(String));
        contentFilter.brandId = { $in: categoryIds.filter(id => geoSet.has(String(id))) };
      } else {
        contentFilter.brandId = { $in: categoryIds };
      }
    }

    // Brand IDs filter — for "My Brands" pill (comma-separated)
    if (brandIds) {
      const ids = brandIds.split(',').filter(Boolean);
      if (contentFilter.brandId) {
        // Intersect with category filter
        const categorySet = new Set(contentFilter.brandId.$in.map(String));
        contentFilter.brandId = { $in: ids.filter(id => categorySet.has(id)) };
      } else {
        contentFilter.brandId = { $in: ids };
      }
    }

    const submissions = await ContentSubmission.find(contentFilter)
      .populate('influencerProfileId', 'displayName handle avatarUrl influenceTier verificationStatus isVerified')
      .populate('brandId', 'name logoUrl generatedColor category city')
      .sort({ approvedAt: -1, submittedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const feed = submissions.map(s => ({
      _id:           s._id,
      displayName:   s.influencerProfileId?.displayName || 'Creator',
      handle:        s.influencerProfileId?.handle || 'creator',
      avatarUrl:     s.influencerProfileId?.avatarUrl || null,
      verified:      s.influencerProfileId?.verificationStatus === 'verified',
      caption:       s.caption || '',
      brandName:     s.brandId?.name || 'Brand',
      brandLogo:     s.brandId?.logoUrl || null,
      brandColor:    s.brandId?.generatedColor || '#1A1A1A',
      brandCategory: s.brandId?.category || null,
      brandCity:     s.brandId?.city || null,
      mediaUrls:     s.mediaUrls || [],
      posterUrl:     s.posterUrl || null,
      contentType:   s.contentType,
      likes:         s.metrics?.likes || 0,
      comments:      s.metrics?.comments || 0,
      shares:        s.metrics?.shares || 0,
    }));

    res.json({ feed, page, hasMore: submissions.length === limit });
  } catch (error) {
    console.error('[GET /content/feed]', error.message);
    res.status(500).json({ error: 'Could not load feed' });
  }
});

// GET /api/content/mine — Current influencer's own approved submissions
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const influencer = await InfluencerProfile.findOne({ userId: req.user._id });
    if (!influencer) return res.json({ submissions: [] });

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const skip = (page - 1) * limit;
    const statusFilter = req.query.status ? { status: req.query.status } : {};

    const submissions = await ContentSubmission.find({
      influencerProfileId: influencer._id,
      ...statusFilter,
    })
      .populate('brandId', 'name logoUrl generatedColor')
      .sort({ submittedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    // Fetch reward/payment info for these submissions
    const subIds = submissions.map(s => s._id);
    const { Transaction } = require('../models');
    const transactions = await Transaction.find({
      contentSubmissionId: { $in: subIds },
      status: { $in: ['paid', 'pending', 'processing'] },
    }).select('contentSubmissionId amount type status').lean();

    // Map transactions by submission ID
    const txMap = {};
    transactions.forEach(tx => {
      const sid = tx.contentSubmissionId?.toString();
      if (sid) txMap[sid] = { amount: tx.amount, type: tx.type, payStatus: tx.status };
    });

    const result = submissions.map(s => ({
      _id:         s._id,
      status:      s.status,           // needed for Stats tab approval rate
      displayName: influencer.displayName || req.user.firstName || 'You',
      handle:      influencer.handle || 'me',
      avatarUrl:   influencer.avatarUrl || null,
      verified:    influencer.verificationStatus === 'verified',
      caption:     s.caption || '',
      brandName:   s.brandId?.name || 'Brand',
      brandId:     s.brandId?._id || null,
      brandLogo:   s.brandId?.logoUrl || null,
      brandColor:  s.brandId?.generatedColor || '#1A1A1A',
      mediaUrls:   s.mediaUrls || [],
      posterUrl:   s.posterUrl || null,
      contentType: s.contentType,
      platform:    s.platform || null,
      postdAt:     s.postdAt || null,
      submittedAt: s.submittedAt,
      likes:       s.metrics?.likes || 0,
      comments:    s.metrics?.comments || 0,
      shares:      s.metrics?.shares || 0,
      // Reward earned for this submission (if any)
      reward:      txMap[s._id.toString()] || null,
    }));

    res.json({ submissions: result });
  } catch (error) {
    console.error('[GET /content/mine]', error.message);
    res.status(500).json({ error: 'Could not load your content' });
  }
});

// GET /api/content?brandId=xxx — List content for a brand
// Optional filters: ?status=submitted&campaignId=xxx
router.get('/', requireAuth, async (req, res) => {
  try {
    const { brandId, status, campaignId, influencerProfileId } = req.query;

    if (!brandId) {
      return res.status(400).json({ error: 'brandId query parameter is required' });
    }

    const filter = { brandId };
    if (status) filter.status = status;
    if (campaignId) filter.campaignId = campaignId;
    if (influencerProfileId) filter.influencerProfileId = influencerProfileId;

    const rawSubmissions = await ContentSubmission.find(filter)
      .populate('influencerProfileId', 'displayName handle avatarUrl influenceTier bio realFollowerCount engagementRate totalReviews totalBrandsPartnered isHidden isVerified userId')
      .populate('campaignId', 'title status')
      .sort({ submittedAt: -1 })
      .limit(100);

    // Filter out content from hidden influencers (auto-created/test accounts)
    // Hidden influencers still work in the native app — this only affects the brand portal
    const submissions = rawSubmissions.filter(s => !s.influencerProfileId?.isHidden);

    // Backfill avatar from User model for influencers whose InfluencerProfile.avatarUrl is null
    // (happens when photo was saved via PUT /api/auth/profile before the sync fix)
    for (const sub of submissions) {
      if (sub.influencerProfileId && !sub.influencerProfileId.avatarUrl && sub.influencerProfileId.userId) {
        const user = await User.findById(sub.influencerProfileId.userId, 'avatarUrl').lean();
        if (user?.avatarUrl) sub.influencerProfileId.avatarUrl = user.avatarUrl;
      }
    }

    // Gather stats
    const allForBrand = await ContentSubmission.countDocuments({ brandId });
    const stats = {
      total: allForBrand,
      submitted: await ContentSubmission.countDocuments({ brandId, status: 'submitted' }),
      approved: await ContentSubmission.countDocuments({ brandId, status: 'approved' }),
      rejected: await ContentSubmission.countDocuments({ brandId, status: 'rejected' }),
      postd: await ContentSubmission.countDocuments({ brandId, status: 'postd' }),
    };

    res.json({ submissions, stats });
  } catch (error) {
    console.error('List content error:', error.message);
    res.status(500).json({ error: 'Could not fetch content' });
  }
});

// GET /api/content/brand/:brandId — Get approved content for a brand (used by Flutter brand profile)
router.get('/brand/:brandId', requireAuth, async (req, res) => {
  try {
    const submissions = await ContentSubmission.find({
      brandId: req.params.brandId,
      status: { $in: ['approved', 'postd'] },
    })
      .populate('influencerProfileId', 'displayName handle avatarUrl influenceTier')
      .sort({ submittedAt: -1 })
      .limit(50);

    res.json({ submissions });
  } catch (error) {
    console.error('Brand content error:', error.message);
    res.status(500).json({ error: 'Could not fetch brand content' });
  }
});

// GET /api/content/:submissionId — Get single submission
router.get('/:submissionId', requireAuth, async (req, res) => {
  try {
    const submission = await ContentSubmission.findById(req.params.submissionId)
      .populate('influencerProfileId', 'displayName handle avatarUrl influenceTier bio realFollowerCount engagementRate totalReviews totalBrandsPartnered isVerified userId')
      .populate('campaignId', 'title status')
      .populate('reviewedBy', 'email legalFirstName legalLastName');

    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    // Fallback: if influencer profile has no avatarUrl, check User model
    if (submission.influencerProfileId && !submission.influencerProfileId.avatarUrl && submission.influencerProfileId.userId) {
      const user = await User.findById(submission.influencerProfileId.userId, 'avatarUrl').lean();
      if (user?.avatarUrl) {
        submission.influencerProfileId.avatarUrl = user.avatarUrl;
      }
    }

    res.json({ submission });
  } catch (error) {
    console.error('Get submission error:', error.message);
    res.status(500).json({ error: 'Could not fetch submission' });
  }
});

// PUT /api/content/:submissionId/approve — Approve content (brand action)
// Rule G6: Content requires approval before going live
router.put('/:submissionId/approve', requireAuth, async (req, res) => {
  try {
    const submission = await ContentSubmission.findById(req.params.submissionId);

    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    if (submission.status !== 'submitted') {
      return res.status(400).json({
        error: 'Cannot approve',
        message: `This content is "${submission.status}". Only submitted content can be approved.`,
      });
    }

    // RULE: Brand must have an active reward configured before approving content.
    // This protects influencers from doing unpaid work.
    // Cash AND points-based rewards both count — either one unlocks approvals.
    const activeReward = await Reward.findOne({
      brandId: submission.brandId,
      status: 'active',
    });

    if (!activeReward) {
      return res.status(402).json({
        error: 'reward_required',
        message: 'Set up a reward before approving content.',
        detail: 'KUP requires brands to have an active reward configured — cash per approval or points — before influencer content can be approved. This protects your influencers and your brand reputation. Brands without active rewards also receive lower trust ratings on the platform.',
        action: 'Go to Rewards → Create a cash or points reward to unlock approvals.',
      });
    }

    // Warn if active reward is NOT cash_per_approval — no auto-transaction will fire.
    // Non-cash rewards (free_product, points) require manual distribution by the brand.
    const hasCashReward = await Reward.findOne({
      brandId: submission.brandId,
      type: 'cash_per_approval',
      status: 'active',
    });
    const rewardGateNote = !hasCashReward
      ? 'No cash_per_approval reward active — no automatic transaction created. Distribute reward manually if needed.'
      : null;

    submission.status = 'approved';
    submission.reviewedAt = new Date();
    submission.reviewedBy = req.user._id;

    // Generate KUP content signature (tracking ID embedded in all approved content)
    const year = new Date().getFullYear();
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const rand = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    submission.contentSignature = {
      kupId: `KP-${year}-${rand}`,
      generatedAt: new Date(),
    };

    await submission.save();

    // Update partnership stats
    if (submission.partnershipId) {
      await Partnership.findByIdAndUpdate(submission.partnershipId, {
        $inc: { totalApproved: 1 },
      });
    }

    console.log(`✅ Content approved: ${submission._id}`);

    // === AUTO-TRIGGER REWARD ON APPROVAL ===
    // Priority: campaign-linked reward → brand-level active CPA reward
    let rewardTriggered = null;
    try {
      console.log(`🎰 Reward trigger START — brandId=${submission.brandId}, campaignId=${submission.campaignId || 'none'}, influencer=${submission.influencerProfileId}`);
      let cpaReward = null;

      // 1. Check if the campaign has a linked reward
      if (submission.campaignId) {
        const campaign = await Campaign.findById(submission.campaignId).populate('rewardId').lean();
        if (campaign?.rewardId && campaign.rewardId.status === 'active') {
          cpaReward = await Reward.findById(campaign.rewardId._id);
          console.log(`🎯 Using campaign-linked reward: ${cpaReward?.title} (${cpaReward?.type})`);
        }
      }

      // 2. Fallback: find brand-level active CPA reward
      if (!cpaReward) {
        console.log(`🔍 Looking for CPA reward: brandId=${submission.brandId}, type=cash_per_approval, status=active`);
        cpaReward = await Reward.findOne({
          brandId: submission.brandId,
          type: 'cash_per_approval',
          status: 'active',
        });
        if (cpaReward) console.log(`🔄 Using brand-level fallback reward: ${cpaReward.title}`);
        else console.log(`⚠️ No active CPA reward found for brand ${submission.brandId}`);
      }

      if (cpaReward) {
        // Resolve rate from influencer tier + content type (video vs photo)
        const influencer = await InfluencerProfile.findById(submission.influencerProfileId);
        const tier = influencer ? (influencer.influenceTier || 'nano') : 'nano';
        const rate = resolveRate(tier, submission.contentType);
        const amount = rate.influencerGets;
        const brandPaysAmount = rate.brandPays;
        const kupFee = FEES.kup.flat;
        const paypalFee = Math.round((brandPaysAmount * FEES.paypal.percent + FEES.paypal.flat) * 100) / 100;

        // Check budget cap (against brandPays — what the brand is actually charged)
        const withinBudget = !cpaReward.cashConfig.budgetCap ||
          (cpaReward.cashConfig.budgetSpent + brandPaysAmount) <= cpaReward.cashConfig.budgetCap;

        if (withinBudget) {
          const transaction = await Transaction.create({
            payerType: 'brand',
            payerBrandId: submission.brandId,
            payeeInfluencerId: submission.influencerProfileId,
            type: 'cash_per_approval',
            amount,
            brandPaysAmount,
            kupFee,
            paypalFee,
            currency: 'USD',
            contentSubmissionId: submission._id,
            campaignId: submission.campaignId || null,
            rewardId: cpaReward._id,
            status: 'pending',
            // status becomes 'paid' after brand completes PayPal payment via POST /api/payouts/pay
          });

          // Update budget spent (track gross brand cost) + influencer stats (track net received)
          cpaReward.cashConfig.budgetSpent += brandPaysAmount;
          await cpaReward.save();

          if (influencer) {
            influencer.totalCashEarned = (influencer.totalCashEarned || 0) + amount;
            await influencer.save();
          }

          // Update partnership cash earned
          if (submission.partnershipId) {
            await Partnership.findByIdAndUpdate(submission.partnershipId, {
              $inc: { totalCashEarned: amount },
            });
          }

          // === PAYPAL PAYMENT (PPCP) ===
          // Strategy: Vault auto-capture (seamless) → redirect fallback → pending
          let approvalUrl = null;
          let paymentStatus = 'pending'; // 'paid', 'pending', 'failed'
          let paymentError = null;
          const brandForNotify = await Brand.findById(submission.brandId, 'name').lean();
          try {
            const freshInfluencer = influencer || await InfluencerProfile.findById(submission.influencerProfileId);
            if (freshInfluencer?.paypalMerchantId) {
              const desc = `KUP CPA: ${freshInfluencer.displayName || 'Influencer'} — ${tier} tier ${submission.contentType}`;

              // Check if brand has a saved Vault payment token for auto-capture
              const brandProfile = await BrandProfile.findOne({ ownedBrandIds: submission.brandId });
              const vaultToken = brandProfile?.paypalVaultPaymentTokenId;

              if (vaultToken) {
                // === SEAMLESS AUTO-CAPTURE (no redirect) ===
                try {
                  const order = await paypal.createOrderWithVault(
                    brandPaysAmount,
                    desc,
                    vaultToken,
                    freshInfluencer.paypalMerchantId,
                    FEES.kup.flat,
                    String(transaction._id)
                  );

                  transaction.paypalOrderId = order.id;
                  const captureStatus = order.status; // 'COMPLETED' if auto-captured

                  if (captureStatus === 'COMPLETED') {
                    transaction.status = 'paid';
                    transaction.paidAt = new Date();
                    paymentStatus = 'paid';
                    console.log(`💳 Vault auto-capture SUCCESS: ${order.id} — $${brandPaysAmount}`);

                    // Auto-payout to influencer via Payouts API
                    await sendAutoPayout(transaction, freshInfluencer, amount, tier, submission.contentType, brandForNotify, submission.partnershipId);
                  } else {
                    // Order created but not captured — may need manual capture
                    console.log(`⚠️ Vault order ${order.id} status: ${captureStatus} — attempting capture...`);
                    try {
                      await paypal.captureOrder(order.id);
                      transaction.status = 'paid';
                      transaction.paidAt = new Date();
                      paymentStatus = 'paid';
                      console.log(`💳 Vault capture SUCCESS after retry: ${order.id}`);

                      // Auto-payout after manual capture too
                      await sendAutoPayout(transaction, freshInfluencer, amount, tier, submission.contentType, brandForNotify, submission.partnershipId);
                    } catch (captureErr) {
                      paymentError = captureErr.message;
                      console.error(`❌ Vault capture FAILED: ${order.id} — ${captureErr.message}`);
                    }
                  }
                  await transaction.save();
                } catch (vaultErr) {
                  // Vault payment failed (insufficient funds, expired token, etc.)
                  paymentError = vaultErr.message;
                  console.error(`❌ Vault auto-capture FAILED: ${vaultErr.message}`);
                  if (vaultErr.paypalResponse) console.error(`❌ PayPal details:`, JSON.stringify(vaultErr.paypalResponse));
                  // Fall through to redirect flow below
                }
              }

              // === REDIRECT FALLBACK (no vault token or vault failed) ===
              if (paymentStatus !== 'paid') {
                const APP_URL = process.env.APP_URL || 'https://keepuspostd.com';
                const returnUrl = `${APP_URL}/api/payouts/pay/capture?transactionId=${transaction._id}`;
                const cancelUrl = `${APP_URL}/pages/inner/cash-rewards.html?payment=canceled`;

                const order = await paypal.createOrder(
                  brandPaysAmount, desc, returnUrl, cancelUrl,
                  freshInfluencer.paypalMerchantId, FEES.kup.flat, String(transaction._id)
                );

                const approvalLink = order.links && order.links.find(l => l.rel === 'payer-action' || l.rel === 'approve');
                approvalUrl = approvalLink ? approvalLink.href : null;
                transaction.paypalOrderId = order.id;
                await transaction.save();
                console.log(`💳 PayPal Order created (redirect): ${order.id} (PPCP → ${freshInfluencer.paypalMerchantId})`);
              }
            } else {
              console.log(`ℹ️ No PPCP merchant ID for influencer ${submission.influencerProfileId} — transaction logged as pending`);
              try {
                const pendingInfluencer = freshInfluencer || await InfluencerProfile.findById(submission.influencerProfileId);
                const pendingBrand = await Brand.findById(submission.brandId);
                if (pendingInfluencer && pendingBrand) {
                  notify.paypalMoneyWaiting({
                    influencer: { ...pendingInfluencer.toObject(), email: pendingInfluencer.paypalEmail || '', userId: pendingInfluencer.userId },
                    brand: pendingBrand,
                    amount,
                  }).catch(e => console.error('[content/approve] paypalMoneyWaiting notify failed:', e.message));
                }
              } catch (notifyErr) {
                console.error('[content/approve] paypalMoneyWaiting lookup failed:', notifyErr.message);
              }
            }
          } catch (orderErr) {
            console.error('[content/approve] PayPal payment failed (non-blocking):', orderErr.message);
            paymentError = orderErr.message;
          }

          rewardTriggered = { type: 'cash_per_approval', amount, brandPaysAmount, tier, contentType: submission.contentType, transactionId: transaction._id, approvalUrl, paymentStatus, paymentError };
          console.log(`💰 CPA reward: $${amount} to influencer (brand charged $${brandPaysAmount}) — ${tier} tier, ${submission.contentType} → ${submission.influencerProfileId}`);
        } else {
          console.log(`⚠️ CPA reward skipped: budget cap reached ($${cpaReward.cashConfig.budgetSpent}/$${cpaReward.cashConfig.budgetCap})`);
          // Surface budget exhaustion — brand needs to know no transaction was created
          rewardTriggered = {
            type: 'cash_per_approval',
            skipped: true,
            reason: 'budget_cap_reached',
            budgetSpent: cpaReward.cashConfig.budgetSpent,
            budgetCap: cpaReward.cashConfig.budgetCap,
          };
        }
      }
    } catch (rewardErr) {
      console.error('CPA reward trigger error (non-blocking):', rewardErr.message);
      // Don't fail the approval — rewards are a bonus, not a requirement
    }

    // 📧 Notify influencer: content approved + reward earned
    try {
      const influencer = await InfluencerProfile.findById(submission.influencerProfileId);
      const brand = await Brand.findById(submission.brandId);
      if (influencer && brand) {
        // Use the User's login email for notifications (not paypalEmail which is for payouts)
        const infUser = await User.findById(influencer.userId, 'email').lean();
        const inf = { ...influencer.toObject(), email: infUser?.email || influencer.paypalEmail || '', userId: influencer.userId };
        notify.contentApproved({ influencer: inf, brand, submission, reward: rewardTriggered }).catch(() => {});
        if (rewardTriggered) {
          notify.cashRewardEarned({ influencer: inf, brand, amount: rewardTriggered.amount, type: 'cash_per_approval', partnershipId: submission.partnershipId?.toString() }).catch(() => {});
        }
      }
    } catch (notifyErr) {
      console.error('Notification error (non-blocking):', notifyErr.message);
    }

    res.json({ message: 'Content approved', submission, rewardTriggered, rewardGateNote });
  } catch (error) {
    console.error('Approve content error:', error.message);
    res.status(500).json({ error: 'Could not approve content' });
  }
});

// PUT /api/content/:submissionId/reject — Reject content (must include reason)
router.put('/:submissionId/reject', requireAuth, async (req, res) => {
  try {
    const { reason } = req.body;

    if (!reason || !reason.trim()) {
      return res.status(400).json({
        error: 'Rejection reason required',
        message: 'You must provide feedback when rejecting content.',
      });
    }

    const submission = await ContentSubmission.findById(req.params.submissionId);

    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    if (submission.status !== 'submitted') {
      return res.status(400).json({
        error: 'Cannot reject',
        message: `This content is "${submission.status}". Only submitted content can be rejected.`,
      });
    }

    submission.status = 'rejected';
    submission.reviewedAt = new Date();
    submission.reviewedBy = req.user._id;
    submission.rejectionReason = reason.trim();
    await submission.save();

    console.log(`❌ Content rejected: ${submission._id} — "${reason}"`);

    // 📧 Notify influencer: content rejected
    try {
      const influencer = await InfluencerProfile.findById(submission.influencerProfileId);
      const brand = await Brand.findById(submission.brandId);
      if (influencer && brand) {
        const inf = { ...influencer.toObject(), email: influencer.paypalEmail || '', userId: influencer.userId };
        notify.contentRejected({ influencer: inf, brand, submission, reason: reason.trim() }).catch(() => {});
      }
    } catch (notifyErr) {
      console.error('Notification error (non-blocking):', notifyErr.message);
    }

    res.json({ message: 'Content rejected with feedback', submission });
  } catch (error) {
    console.error('Reject content error:', error.message);
    res.status(500).json({ error: 'Could not reject content' });
  }
});

// POST /api/content/:submissionId/download — Brand downloads approved content
// Increments downloadCount, ensures kupId exists, returns media URLs
router.post('/:submissionId/download', requireAuth, async (req, res) => {
  try {
    const submission = await ContentSubmission.findById(req.params.submissionId);

    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    if (!['approved', 'postd'].includes(submission.status)) {
      return res.status(400).json({ error: 'Only approved content can be downloaded' });
    }

    // Ensure kupId exists (fallback: generate now if approve somehow ran before this code)
    if (!submission.contentSignature?.kupId) {
      const year = new Date().getFullYear();
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      const rand = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
      submission.contentSignature = {
        kupId: `KP-${year}-${rand}`,
        generatedAt: new Date(),
        downloadCount: 1,
      };
    } else {
      submission.contentSignature.downloadCount = (submission.contentSignature.downloadCount || 0) + 1;
    }

    await submission.save();

    res.json({
      kupId: submission.contentSignature.kupId,
      downloadCount: submission.contentSignature.downloadCount,
      mediaUrls: submission.mediaUrls,
    });
  } catch (error) {
    console.error('Download content error:', error.message);
    res.status(500).json({ error: 'Could not process download' });
  }
});

// PUT /api/content/:submissionId/postd — Mark content as "Postd" (published)
// Captures platform + post URL, triggers Bonus Cash reward
router.put('/:submissionId/postd', requireAuth, async (req, res) => {
  try {
    const { platform, platformPostUrl } = req.body;

    const submission = await ContentSubmission.findById(req.params.submissionId);

    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    if (submission.status !== 'approved') {
      return res.status(400).json({
        error: 'Cannot mark as Postd',
        message: `Content must be approved first. Current status: "${submission.status}".`,
      });
    }

    submission.status = 'postd';
    submission.postdAt = new Date();
    if (platform) submission.platform = platform;
    if (platformPostUrl) submission.platformPostUrl = platformPostUrl;
    await submission.save();

    console.log(`📢 Content marked as Postd: ${submission._id} on ${platform || 'unknown'}`);

    // === AUTO-TRIGGER BONUS CASH REWARD ===
    let rewardTriggered = null;
    try {
      const bonusReward = await Reward.findOne({
        brandId: submission.brandId,
        type: 'bonus_cash',
        status: 'active',
      });

      if (bonusReward) {
        const influencer = await InfluencerProfile.findById(submission.influencerProfileId);
        const tier = influencer ? (influencer.influenceTier || 'nano') : 'nano';
        const baseRate = resolveRate(tier, submission.contentType);
        const amount = calcBonusCash(baseRate.influencerGets);  // 30% of base CPA
        const brandPaysAmount = Math.round(((amount + FEES.kup.flat + FEES.paypal.flat) / (1 - FEES.paypal.percent)) * 100) / 100;
        const kupFee = FEES.kup.flat;
        const paypalFee = Math.round((brandPaysAmount * FEES.paypal.percent + FEES.paypal.flat) * 100) / 100;

        const withinBudget = !bonusReward.cashConfig.budgetCap ||
          (bonusReward.cashConfig.budgetSpent + brandPaysAmount) <= bonusReward.cashConfig.budgetCap;

        if (withinBudget) {
          const transaction = await Transaction.create({
            payerType: 'brand',
            payerBrandId: submission.brandId,
            payeeInfluencerId: submission.influencerProfileId,
            type: 'bonus_cash',
            amount,
            brandPaysAmount,
            kupFee,
            paypalFee,
            currency: 'USD',
            contentSubmissionId: submission._id,
            campaignId: submission.campaignId || null,
            rewardId: bonusReward._id,
            status: 'pending',
          });

          bonusReward.cashConfig.budgetSpent += brandPaysAmount;
          await bonusReward.save();

          if (influencer) {
            influencer.totalCashEarned = (influencer.totalCashEarned || 0) + amount;
            await influencer.save();
          }

          if (submission.partnershipId) {
            await Partnership.findByIdAndUpdate(submission.partnershipId, {
              $inc: { totalCashEarned: amount },
            });
          }

          rewardTriggered = { type: 'bonus_cash', amount, brandPaysAmount, tier, contentType: submission.contentType, transactionId: transaction._id };
          console.log(`💰 Bonus Cash: $${amount} to influencer (brand charged $${brandPaysAmount}) — ${tier} tier, ${submission.contentType} → ${submission.influencerProfileId}`);
        }
      }
    } catch (rewardErr) {
      console.error('Bonus Cash trigger error (non-blocking):', rewardErr.message);
    }

    // 📧 Notify influencer: content posted + bonus earned
    try {
      const influencer = await InfluencerProfile.findById(submission.influencerProfileId);
      const brand = await Brand.findById(submission.brandId);
      if (influencer && brand) {
        const inf = { ...influencer.toObject(), email: influencer.paypalEmail || '', userId: influencer.userId };
        notify.contentPostd({ influencer: inf, brand, submission, bonusAmount: rewardTriggered?.amount }).catch(() => {});
        if (rewardTriggered) {
          notify.cashRewardEarned({ influencer: inf, brand, amount: rewardTriggered.amount, type: 'bonus_cash' }).catch(() => {});
        }
      }
    } catch (notifyErr) {
      console.error('Notification error (non-blocking):', notifyErr.message);
    }

    res.json({ message: 'Content marked as Postd (published)', submission, rewardTriggered });
  } catch (error) {
    console.error('Postd content error:', error.message);
    res.status(500).json({ error: 'Could not update content status' });
  }
});

// PUT /api/content/:submissionId/overlays — Save brand-applied text/logo overlays
// Called when brand uses Save Edit on video content in the content manager
router.put('/:submissionId/overlays', requireAuth, async (req, res) => {
  try {
    const { textOverlays, logoOverlay } = req.body;
    const submission = await ContentSubmission.findById(req.params.submissionId);

    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    submission.textOverlays = textOverlays || [];
    submission.logoOverlay = logoOverlay || null;
    await submission.save();

    console.log(`🎨 Overlays saved for: ${submission._id} (${(textOverlays || []).length} text, logo: ${!!logoOverlay})`);

    res.json({ message: 'Overlays saved', submission });
  } catch (error) {
    console.error('Save overlays error:', error.message);
    res.status(500).json({ error: 'Could not save overlays' });
  }
});

// PUT /api/content/:submissionId/metrics — Update engagement metrics
// After updating, checks viral bonus thresholds and triggers rewards
router.put('/:submissionId/metrics', requireAuth, async (req, res) => {
  try {
    const { likes, comments, shares, views } = req.body;

    // Get the submission BEFORE updating to check which thresholds are newly crossed
    const prevSubmission = await ContentSubmission.findById(req.params.submissionId);
    if (!prevSubmission) {
      return res.status(404).json({ error: 'Submission not found' });
    }
    const prevViews = (prevSubmission.metrics && prevSubmission.metrics.views) || 0;

    const submission = await ContentSubmission.findByIdAndUpdate(
      req.params.submissionId,
      {
        $set: {
          'metrics.likes': likes || 0,
          'metrics.comments': comments || 0,
          'metrics.shares': shares || 0,
          'metrics.views': views || 0,
        },
      },
      { new: true }
    );

    // === CHECK VIRAL BONUS THRESHOLDS ===
    const newViews = views || 0;
    const viralBonuses = [];

    for (const threshold of VIRAL_THRESHOLDS) {
      // Only trigger if we just crossed this threshold (wasn't already past it)
      if (newViews >= threshold.views && prevViews < threshold.views) {
        try {
          // Check if this threshold was already rewarded (prevent duplicates)
          const existing = await Transaction.findOne({
            contentSubmissionId: submission._id,
            type: 'viral_bonus',
            amount: threshold.bonus,
          });

          if (!existing) {
            const transaction = await Transaction.create({
              payerType: 'platform', // viral bonuses paid by platform, not brand
              payeeInfluencerId: submission.influencerProfileId,
              type: 'viral_bonus',
              amount: threshold.bonus,
              currency: 'USD',
              contentSubmissionId: submission._id,
              campaignId: submission.campaignId || null,
              status: 'pending',
            });

            // Update influencer earnings
            await InfluencerProfile.findByIdAndUpdate(submission.influencerProfileId, {
              $inc: { totalCashEarned: threshold.bonus },
            });

            viralBonuses.push({
              threshold: threshold.label,
              bonus: threshold.bonus,
              transactionId: transaction._id,
            });

            console.log(`🔥 Viral bonus triggered: $${threshold.bonus} for ${threshold.label} on submission ${submission._id}`);
          }
        } catch (bonusErr) {
          console.error('Viral bonus trigger error:', bonusErr.message);
        }
      }
    }

    res.json({
      message: 'Metrics updated',
      submission,
      viralBonuses: viralBonuses.length > 0 ? viralBonuses : null,
    });
  } catch (error) {
    console.error('Update metrics error:', error.message);
    res.status(500).json({ error: 'Could not update metrics' });
  }
});

module.exports = router;
