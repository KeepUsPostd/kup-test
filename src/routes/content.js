// Content Routes — Submission + Approval Pipeline
// Enforces: G6 (content requires approval), content ownership on submission
// Status flow: submitted → approved/rejected → postd
// Ref: PLATFORM_ARCHITECTURE.md → Content Lifecycle
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { ContentSubmission, Partnership, Campaign, InfluencerProfile, Transaction, Reward } = require('../models');

// Tier-based cash rates (mirrored from payouts.js for server-side reward triggering)
// Rule G7: Brands cannot override — comes from influencer tier
const TIER_RATES = {
  unverified: { cash_per_approval: 2, bonus_cash: 5 },
  nano: { cash_per_approval: 5, bonus_cash: 10 },
  micro: { cash_per_approval: 10, bonus_cash: 25 },
  rising: { cash_per_approval: 25, bonus_cash: 50 },
  established: { cash_per_approval: 50, bonus_cash: 100 },
  premium: { cash_per_approval: 100, bonus_cash: 250 },
};

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
    const { brandId, campaignId, contentType, caption, mediaUrls,
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

    // Look up the influencer profile for this user
    const influencerProfile = await InfluencerProfile.findOne({ userId: req.user._id });
    if (!influencerProfile) {
      return res.status(403).json({
        error: 'No influencer profile',
        message: 'You need a creator account to submit content.',
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

    const submission = await ContentSubmission.create({
      influencerProfileId: influencerProfile._id,
      brandId,
      campaignId: campaignId || null,
      partnershipId: partnershipId || null,
      contentType,
      caption: caption || null,
      mediaUrls: mediaUrls || [],
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

    console.log(`📸 Content submitted for brand ${brandId} (${contentType})`);

    res.status(201).json({
      message: 'Content submitted for review',
      submission,
    });
  } catch (error) {
    console.error('Submit content error:', error.message);
    res.status(500).json({ error: 'Could not submit content' });
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

    const submissions = await ContentSubmission.find(filter)
      .populate('influencerProfileId', 'displayName handle avatarUrl influenceTier')
      .populate('campaignId', 'title status')
      .sort({ submittedAt: -1 })
      .limit(100);

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

// GET /api/content/:submissionId — Get single submission
router.get('/:submissionId', requireAuth, async (req, res) => {
  try {
    const submission = await ContentSubmission.findById(req.params.submissionId)
      .populate('influencerProfileId', 'displayName handle avatarUrl influenceTier')
      .populate('campaignId', 'title status')
      .populate('reviewedBy', 'email legalFirstName legalLastName');

    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
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

    submission.status = 'approved';
    submission.reviewedAt = new Date();
    submission.reviewedBy = req.user._id;
    await submission.save();

    // Update partnership stats
    if (submission.partnershipId) {
      await Partnership.findByIdAndUpdate(submission.partnershipId, {
        $inc: { totalApproved: 1 },
      });
    }

    console.log(`✅ Content approved: ${submission._id}`);

    // === AUTO-TRIGGER CASH PER APPROVAL REWARD ===
    // Check if this brand has an active cash_per_approval reward configured
    let rewardTriggered = null;
    try {
      const cpaReward = await Reward.findOne({
        brandId: submission.brandId,
        type: 'cash_per_approval',
        status: 'active',
      });

      if (cpaReward) {
        // Resolve rate from influencer tier
        const influencer = await InfluencerProfile.findById(submission.influencerProfileId);
        const tier = influencer ? (influencer.influenceTier || 'nano') : 'nano';
        const rates = TIER_RATES[tier] || TIER_RATES.nano;
        const amount = rates.cash_per_approval;

        // Check budget cap
        const withinBudget = !cpaReward.cashConfig.budgetCap ||
          (cpaReward.cashConfig.budgetSpent + amount) <= cpaReward.cashConfig.budgetCap;

        if (withinBudget) {
          const transaction = await Transaction.create({
            payerType: 'brand',
            payerBrandId: submission.brandId,
            payeeInfluencerId: submission.influencerProfileId,
            type: 'cash_per_approval',
            amount,
            currency: 'USD',
            contentSubmissionId: submission._id,
            campaignId: submission.campaignId || null,
            rewardId: cpaReward._id,
            status: 'pending',
          });

          // Update budget spent + influencer stats
          cpaReward.cashConfig.budgetSpent += amount;
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

          rewardTriggered = { type: 'cash_per_approval', amount, tier, transactionId: transaction._id };
          console.log(`💰 CPA reward: $${amount} (${tier} tier) → influencer ${submission.influencerProfileId}`);
        } else {
          console.log(`⚠️ CPA reward skipped: budget cap reached ($${cpaReward.cashConfig.budgetSpent}/$${cpaReward.cashConfig.budgetCap})`);
        }
      }
    } catch (rewardErr) {
      console.error('CPA reward trigger error (non-blocking):', rewardErr.message);
      // Don't fail the approval — rewards are a bonus, not a requirement
    }

    res.json({ message: 'Content approved', submission, rewardTriggered });
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

    res.json({ message: 'Content rejected with feedback', submission });
  } catch (error) {
    console.error('Reject content error:', error.message);
    res.status(500).json({ error: 'Could not reject content' });
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
        const rates = TIER_RATES[tier] || TIER_RATES.nano;
        const amount = rates.bonus_cash;

        const withinBudget = !bonusReward.cashConfig.budgetCap ||
          (bonusReward.cashConfig.budgetSpent + amount) <= bonusReward.cashConfig.budgetCap;

        if (withinBudget) {
          const transaction = await Transaction.create({
            payerType: 'brand',
            payerBrandId: submission.brandId,
            payeeInfluencerId: submission.influencerProfileId,
            type: 'bonus_cash',
            amount,
            currency: 'USD',
            contentSubmissionId: submission._id,
            campaignId: submission.campaignId || null,
            rewardId: bonusReward._id,
            status: 'pending',
          });

          bonusReward.cashConfig.budgetSpent += amount;
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

          rewardTriggered = { type: 'bonus_cash', amount, tier, transactionId: transaction._id };
          console.log(`💰 Bonus Cash: $${amount} (${tier} tier) → influencer ${submission.influencerProfileId}`);
        }
      }
    } catch (rewardErr) {
      console.error('Bonus Cash trigger error (non-blocking):', rewardErr.message);
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
