// Campaign Routes — Full CRUD with lifecycle management
// Enforces: G1 (brand isolation), G9 (plan limits), status lifecycle
// Ref: PLATFORM_ARCHITECTURE.md → Campaign System Rules
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { Campaign, BrandProfile, User } = require('../models');
const notify = require('../services/notifications');

// Plan limits (campaigns per brand) from PLATFORM_ARCHITECTURE.md
const PLAN_LIMITS = {
  starter: 1,
  growth: 5,
  pro: 20,
  agency: 50,
  enterprise: Infinity,
};

// Valid status transitions
// draft → active, draft → ended
// active → paused, active → ended
// paused → active, paused → ended
const VALID_TRANSITIONS = {
  draft: ['active', 'ended'],
  active: ['paused', 'ended'],
  paused: ['active', 'ended'],
  ended: [], // terminal state — no transitions out
};

// POST /api/campaigns — Create a new campaign (always starts as draft)
router.post('/', requireAuth, async (req, res) => {
  try {
    const { brandId, title, description, brief, category, coverImageUrl,
            maxSubmissions, deadline, locationId } = req.body;

    if (!brandId) {
      return res.status(400).json({ error: 'brandId is required' });
    }
    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Campaign title is required' });
    }
    if (title.length > 60) {
      return res.status(400).json({ error: 'Title must be 60 characters or less' });
    }

    // Check plan limit for campaigns (rule G9)
    const brandProfile = await BrandProfile.findOne({ userId: req.user._id });
    const planTier = brandProfile ? brandProfile.planTier : 'starter';
    const limit = PLAN_LIMITS[planTier] || PLAN_LIMITS.starter;

    const currentCount = await Campaign.countDocuments({
      brandId,
      status: { $ne: 'ended' }, // only count active/draft/paused
    });

    if (currentCount >= limit) {
      return res.status(403).json({
        error: 'Campaign limit reached',
        message: `Your ${planTier} plan allows ${limit} active campaign(s) per brand. End a campaign or upgrade your plan.`,
        currentPlan: planTier,
        limit,
        current: currentCount,
      });
    }

    const campaign = await Campaign.create({
      brandId,
      locationId: locationId || null,
      title: title.trim(),
      description: description || null,
      brief: brief || null,
      category: category || null,
      coverImageUrl: coverImageUrl || null,
      maxSubmissions: maxSubmissions || null,
      deadline: deadline || null,
      status: req.body.status === 'active' ? 'active' : 'draft',
      createdBy: req.user._id,
    });

    console.log(`✅ Campaign created: "${campaign.title}" for brand ${brandId} (${campaign.status})`);

    res.status(201).json({
      message: campaign.status === 'active' ? 'Campaign published' : 'Campaign created as draft',
      campaign,
    });

    // Fire campaignLive notification if published directly (non-blocking)
    if (campaign.status === 'active') {
      try {
        const brandProfile = await BrandProfile.findOne({ ownedBrandIds: campaign.brandId });
        const brandOwner = brandProfile ? await User.findById(brandProfile.userId) : null;
        if (brandOwner) {
          notify.campaignLive({
            brand: { ownerEmail: brandOwner.email, ownerId: brandOwner._id },
            campaign: { name: campaign.title, title: campaign.title, _id: campaign._id },
          }).catch(e => console.error('[campaigns] notify.campaignLive error:', e.message));
        }
      } catch (notifyErr) {
        console.error('[campaigns] create notify error:', notifyErr.message);
      }
    }
  } catch (error) {
    console.error('Create campaign error:', error.message);
    res.status(500).json({ error: 'Could not create campaign' });
  }
});

// GET /api/campaigns?brandId=xxx — List campaigns for a brand
// Optional filters: ?status=active&category=food
router.get('/', requireAuth, async (req, res) => {
  try {
    const { brandId, status, category } = req.query;

    if (!brandId) {
      return res.status(400).json({ error: 'brandId query parameter is required' });
    }

    const filter = { brandId };
    if (status) filter.status = status;
    if (category) filter.category = category;

    const campaigns = await Campaign.find(filter)
      .sort({ createdAt: -1 })
      .limit(50);

    // Gather stats
    const stats = {
      total: campaigns.length,
      active: campaigns.filter(c => c.status === 'active').length,
      draft: campaigns.filter(c => c.status === 'draft').length,
      paused: campaigns.filter(c => c.status === 'paused').length,
      ended: campaigns.filter(c => c.status === 'ended').length,
    };

    res.json({ campaigns, stats });
  } catch (error) {
    console.error('List campaigns error:', error.message);
    res.status(500).json({ error: 'Could not fetch campaigns' });
  }
});

// GET /api/campaigns/:campaignId — Get single campaign
router.get('/:campaignId', requireAuth, async (req, res) => {
  try {
    const campaign = await Campaign.findById(req.params.campaignId);

    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    res.json({ campaign });
  } catch (error) {
    console.error('Get campaign error:', error.message);
    res.status(500).json({ error: 'Could not fetch campaign' });
  }
});

// PUT /api/campaigns/:campaignId — Update campaign details
// Only allows editing certain fields. Status changes use dedicated endpoint.
router.put('/:campaignId', requireAuth, async (req, res) => {
  try {
    const campaign = await Campaign.findById(req.params.campaignId);

    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    // Can't edit ended campaigns
    if (campaign.status === 'ended') {
      return res.status(400).json({
        error: 'Cannot edit ended campaign',
        message: 'Ended campaigns cannot be modified. Create a new campaign instead.',
      });
    }

    const allowedFields = ['title', 'description', 'brief', 'category',
      'coverImageUrl', 'maxSubmissions', 'deadline', 'locationId'];

    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    if (updates.title && updates.title.length > 60) {
      return res.status(400).json({ error: 'Title must be 60 characters or less' });
    }

    const updated = await Campaign.findByIdAndUpdate(
      req.params.campaignId,
      { $set: updates },
      { new: true, runValidators: true }
    );

    res.json({ message: 'Campaign updated', campaign: updated });
  } catch (error) {
    console.error('Update campaign error:', error.message);
    res.status(500).json({ error: 'Could not update campaign' });
  }
});

// PUT /api/campaigns/:campaignId/status — Change campaign status
// Enforces lifecycle: draft → active → paused ↔ active → ended
router.put('/:campaignId/status', requireAuth, async (req, res) => {
  try {
    const { status: newStatus } = req.body;
    const campaign = await Campaign.findById(req.params.campaignId);

    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    // Validate the transition
    const allowed = VALID_TRANSITIONS[campaign.status] || [];
    if (!allowed.includes(newStatus)) {
      return res.status(400).json({
        error: 'Invalid status transition',
        message: `Cannot change from "${campaign.status}" to "${newStatus}". Allowed: ${allowed.join(', ') || 'none (terminal state)'}`,
        currentStatus: campaign.status,
        allowedTransitions: allowed,
      });
    }

    // Apply the transition with timestamps
    campaign.status = newStatus;

    if (newStatus === 'active' && !campaign.activatedAt) {
      campaign.activatedAt = new Date();
    }
    if (newStatus === 'paused') {
      campaign.pausedAt = new Date();
    }
    if (newStatus === 'ended') {
      campaign.endedAt = new Date();
    }

    await campaign.save();

    console.log(`📋 Campaign "${campaign.title}" → ${newStatus}`);

    // Fire campaign lifecycle notifications (non-blocking)
    try {
      const brandProfile = await BrandProfile.findOne({ ownedBrandIds: campaign.brandId });
      const brandOwner = brandProfile ? await User.findById(brandProfile.userId) : null;
      const notifyBrand = brandOwner ? { ownerEmail: brandOwner.email, ownerId: brandOwner._id } : null;
      const notifyCampaign = { name: campaign.title, title: campaign.title, _id: campaign._id };
      if (notifyBrand) {
        if (newStatus === 'active') {
          notify.campaignLive({ brand: notifyBrand, campaign: notifyCampaign }).catch(e => console.error('[campaigns] notify.campaignLive error:', e.message));
        } else if (newStatus === 'paused') {
          notify.campaignPaused({ brand: notifyBrand, campaign: notifyCampaign }).catch(e => console.error('[campaigns] notify.campaignPaused error:', e.message));
        } else if (newStatus === 'ended') {
          notify.campaignEnded({ brand: notifyBrand, campaign: notifyCampaign }).catch(e => console.error('[campaigns] notify.campaignEnded error:', e.message));
        }
      }
    } catch (notifyErr) {
      console.error('[campaigns] status notify lookup error:', notifyErr.message);
    }

    res.json({
      message: `Campaign ${newStatus}`,
      campaign,
    });
  } catch (error) {
    console.error('Status change error:', error.message);
    res.status(500).json({ error: 'Could not update campaign status' });
  }
});

// DELETE /api/campaigns/:campaignId — Delete campaign (draft only)
// Rule: Only draft campaigns can be deleted.
router.delete('/:campaignId', requireAuth, async (req, res) => {
  try {
    const campaign = await Campaign.findById(req.params.campaignId);

    if (!campaign) {
      return res.status(404).json({ error: 'Campaign not found' });
    }

    if (campaign.status !== 'draft') {
      return res.status(400).json({
        error: 'Cannot delete non-draft campaign',
        message: `This campaign is "${campaign.status}". Only draft campaigns can be deleted. End the campaign first.`,
      });
    }

    await Campaign.findByIdAndDelete(req.params.campaignId);

    console.log(`🗑️ Campaign deleted: "${campaign.title}"`);

    res.json({ message: 'Draft campaign deleted' });
  } catch (error) {
    console.error('Delete campaign error:', error.message);
    res.status(500).json({ error: 'Could not delete campaign' });
  }
});

module.exports = router;
