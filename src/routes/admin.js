// KUP Admin Routes — Platform administration endpoints
// Protected by auth + owner/admin role check.
// These are internal tools, not exposed to regular users.

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const reengagement = require('../services/reengagement');
const { processExpiredTrials } = require('../services/trial');

// ── Middleware: Require admin/owner role ───────────────────
// For now, we check if the user has a brand profile (brand owners = admins)
// In production, add proper role-based access control
async function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });

  // Simple check: user must have admin flag or be the platform owner
  // TODO: Replace with proper RBAC when admin panel is built
  const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase());
  if (adminEmails.includes(req.user.email?.toLowerCase())) {
    return next();
  }

  return res.status(403).json({ error: 'Admin access required' });
}

// POST /api/admin/reengagement/run — Run all automated campaigns
router.post('/reengagement/run', requireAuth, requireAdmin, async (req, res) => {
  try {
    const results = await reengagement.runAll();
    res.json({ message: 'Re-engagement campaigns completed', results });
  } catch (error) {
    console.error('Re-engagement run error:', error.message);
    res.status(500).json({ error: 'Failed to run campaigns', message: error.message });
  }
});

// POST /api/admin/reengagement/run-weekly — Run weekly campaigns
router.post('/reengagement/run-weekly', requireAuth, requireAdmin, async (req, res) => {
  try {
    const results = await reengagement.runWeekly();
    res.json({ message: 'Weekly campaigns completed', results });
  } catch (error) {
    res.status(500).json({ error: 'Failed to run weekly campaigns', message: error.message });
  }
});

// POST /api/admin/reengagement/run-monthly — Run monthly campaigns
router.post('/reengagement/run-monthly', requireAuth, requireAdmin, async (req, res) => {
  try {
    const results = await reengagement.runMonthly();
    res.json({ message: 'Monthly campaigns completed', results });
  } catch (error) {
    res.status(500).json({ error: 'Failed to run monthly campaigns', message: error.message });
  }
});

// POST /api/admin/reengagement/run/:campaignId — Run a specific campaign
router.post('/reengagement/run/:campaignId', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await reengagement.run(req.params.campaignId);
    res.json({ message: `Campaign ${req.params.campaignId} completed`, result });
  } catch (error) {
    res.status(500).json({ error: 'Failed to run campaign', message: error.message });
  }
});

// POST /api/admin/reengagement/feature-launch — Announce a new feature
router.post('/reengagement/feature-launch', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { featureName, description, ctaUrl } = req.body;
    if (!featureName || !description) {
      return res.status(400).json({ error: 'featureName and description are required' });
    }
    const result = await reengagement.newFeatureLaunch({ featureName, description, ctaUrl });
    res.json({ message: 'Feature launch announced', result });
  } catch (error) {
    res.status(500).json({ error: 'Failed to send announcement', message: error.message });
  }
});

// POST /api/admin/reengagement/milestone — Announce a platform milestone
router.post('/reengagement/milestone', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { milestone, description } = req.body;
    if (!milestone || !description) {
      return res.status(400).json({ error: 'milestone and description are required' });
    }
    const result = await reengagement.platformMilestone({ milestone, description });
    res.json({ message: 'Milestone announced', result });
  } catch (error) {
    res.status(500).json({ error: 'Failed to send milestone', message: error.message });
  }
});

// POST /api/admin/trials/process-expired — Downgrade expired trials to Starter
// Run daily via cron or manually from admin panel.
router.post('/trials/process-expired', requireAuth, requireAdmin, async (req, res) => {
  try {
    const result = await processExpiredTrials();
    res.json({ message: 'Trial expiry processing complete', result });
  } catch (error) {
    console.error('Trial expiry error:', error.message);
    res.status(500).json({ error: 'Failed to process expired trials', message: error.message });
  }
});

// DELETE /api/admin/partnerships/cleanup — Remove test/orphaned partnerships by influencer email
// Usage: POST body { influencerEmail: "test@gmail.com", brandName: "Santana Thrasybule" }
router.delete('/partnerships/cleanup', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { influencerEmail, brandName } = req.body;
    const User = require('../models/User');
    const InfluencerProfile = require('../models/InfluencerProfile');
    const Brand = require('../models/Brand');
    const Partnership = require('../models/Partnership');

    const user = await User.findOne({ email: influencerEmail });
    if (!user) return res.status(404).json({ error: `User not found: ${influencerEmail}` });

    const influencer = await InfluencerProfile.findOne({ userId: user._id });
    if (!influencer) return res.status(404).json({ error: 'Influencer profile not found' });

    const brand = await Brand.findOne({ name: new RegExp(brandName, 'i') });
    if (!brand) return res.status(404).json({ error: `Brand not found: ${brandName}` });

    const result = await Partnership.deleteMany({
      influencerProfileId: influencer._id,
      brandId: brand._id,
    });

    res.json({
      message: `Removed ${result.deletedCount} partnership(s) between ${influencerEmail} and ${brand.name}`,
      deleted: result.deletedCount,
    });
  } catch (error) {
    console.error('Partnership cleanup error:', error.message);
    res.status(500).json({ error: 'Could not clean up partnerships', message: error.message });
  }
});

// PATCH /api/admin/influencers/hide — Mark an influencer as hidden on brand portal (website)
// Hidden influencers still work normally in the native app.
// Usage: { influencerEmail: "user@example.com", hidden: true }
router.patch('/influencers/hide', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { influencerEmail, hidden = true } = req.body;
    const User = require('../models/User');
    const InfluencerProfile = require('../models/InfluencerProfile');

    const user = await User.findOne({ email: influencerEmail });
    if (!user) return res.status(404).json({ error: `User not found: ${influencerEmail}` });

    const influencer = await InfluencerProfile.findOneAndUpdate(
      { userId: user._id },
      { isHidden: hidden },
      { new: true }
    );
    if (!influencer) return res.status(404).json({ error: 'Influencer profile not found' });

    res.json({
      message: `Influencer @${influencer.handle} is now ${hidden ? 'hidden' : 'visible'} on the brand portal`,
      handle: influencer.handle,
      isHidden: influencer.isHidden,
    });
  } catch (error) {
    console.error('Influencer hide error:', error.message);
    res.status(500).json({ error: 'Could not update influencer visibility', message: error.message });
  }
});

// DELETE /api/admin/influencers/content — Delete all content submissions from an influencer
// Usage: { influencerEmail: "user@example.com" }
router.delete('/influencers/content', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { influencerEmail } = req.body;
    const User = require('../models/User');
    const InfluencerProfile = require('../models/InfluencerProfile');
    const ContentSubmission = require('../models/ContentSubmission');

    const user = await User.findOne({ email: influencerEmail });
    if (!user) return res.status(404).json({ error: `User not found: ${influencerEmail}` });

    const influencer = await InfluencerProfile.findOne({ userId: user._id });
    if (!influencer) return res.status(404).json({ error: 'Influencer profile not found' });

    const result = await ContentSubmission.deleteMany({ influencerProfileId: influencer._id });

    res.json({
      message: `Deleted ${result.deletedCount} content submission(s) from @${influencer.handle}`,
      handle: influencer.handle,
      deleted: result.deletedCount,
    });
  } catch (error) {
    console.error('Content deletion error:', error.message);
    res.status(500).json({ error: 'Could not delete content', message: error.message });
  }
});

// POST /api/admin/recalculate-partner-counts — Fix all totalBrandsPartnered from actual data
router.post('/recalculate-partner-counts', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { InfluencerProfile, Partnership } = require('../models');
    const profiles = await InfluencerProfile.find({}, '_id handle totalBrandsPartnered').lean();
    const fixed = [];

    for (const p of profiles) {
      const actual = await Partnership.countDocuments({ influencerProfileId: p._id, status: 'active' });
      if (p.totalBrandsPartnered !== actual) {
        await InfluencerProfile.updateOne({ _id: p._id }, { $set: { totalBrandsPartnered: actual } });
        fixed.push({ handle: p.handle, was: p.totalBrandsPartnered, now: actual });
      }
    }

    console.log(`🔧 Recalculated partner counts: ${fixed.length} fixed out of ${profiles.length}`);
    res.json({ checked: profiles.length, fixed });
  } catch (error) {
    console.error('Recalculate error:', error.message);
    res.status(500).json({ error: 'Failed to recalculate', message: error.message });
  }
});

// POST /api/admin/test-email — Send a test email to diagnose delivery issues
router.post('/test-email', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { sendEmail } = require('../config/email');
    const { to } = req.body;
    if (!to) return res.status(400).json({ error: 'to is required' });

    const result = await sendEmail({
      to,
      subject: 'Partnership Update — Santana Thrasybule',
      headline: 'New Partnership',
      preheader: 'Your partnership with Santana Thrasybule is now active.',
      bodyHtml: `
        <p>Your partnership with <strong>Santana Thrasybule</strong> is now active on KeepUsPostd.</p>
        <p>You can submit content and earn rewards from this brand.</p>
        <p style="font-size:0.8rem;color:#888;">This is a test email sent from the admin panel to verify delivery.</p>
      `,
      ctaText: 'View Partnership',
      ctaUrl: 'https://keepuspostd.com/app/brands.html',
      variant: 'influencer',
    });

    console.log(`📧 Admin test email to ${to}:`, JSON.stringify(result));
    res.json({ to, result });
  } catch (error) {
    console.error('Test email error:', error.message);
    res.status(500).json({ error: 'Failed to send test email', message: error.message });
  }
});

module.exports = router;
