// KUP Admin Routes — Platform administration endpoints
// Protected by auth + owner/admin role check.
// These are internal tools, not exposed to regular users.

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const reengagement = require('../services/reengagement');

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

module.exports = router;
