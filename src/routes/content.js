// Content Routes — Submission + Approval Pipeline
// Enforces: G6 (content requires approval), content ownership on submission
// Status flow: submitted → approved/rejected → postd
// Ref: PLATFORM_ARCHITECTURE.md → Content Lifecycle
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { ContentSubmission, Partnership, Campaign, InfluencerProfile } = require('../models');

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

    // RULE: No "Unknown" influencers. Profile must have displayName and handle.
    if (!influencerProfile.displayName || !influencerProfile.handle) {
      return res.status(400).json({
        error: 'Incomplete creator profile',
        message: 'Please complete your creator profile (display name and handle) before submitting content.',
      });
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

    res.json({ message: 'Content approved', submission });
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
// Triggers Bonus Cash check (future implementation)
router.put('/:submissionId/postd', requireAuth, async (req, res) => {
  try {
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
    await submission.save();

    console.log(`📢 Content marked as Postd: ${submission._id}`);

    res.json({ message: 'Content marked as Postd (published)', submission });
  } catch (error) {
    console.error('Postd content error:', error.message);
    res.status(500).json({ error: 'Could not update content status' });
  }
});

// PUT /api/content/:submissionId/metrics — Update engagement metrics
router.put('/:submissionId/metrics', requireAuth, async (req, res) => {
  try {
    const { likes, comments, shares, views } = req.body;

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

    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    res.json({ message: 'Metrics updated', submission });
  } catch (error) {
    console.error('Update metrics error:', error.message);
    res.status(500).json({ error: 'Could not update metrics' });
  }
});

module.exports = router;
