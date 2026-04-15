// Reports Routes — Content flagging (Apple Guideline 1.2)
// POST /api/reports        — user flags content
// GET  /api/reports        — admin views open reports (moderation dashboard)
// PUT  /api/reports/:id    — admin marks reviewed/actioned/dismissed
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { ContentReport, ContentSubmission, User } = require('../models');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'santana@keepuspostd.com';

// POST /api/reports — Submit a content flag (requires auth)
router.post('/', requireAuth, async (req, res) => {
  try {
    const { contentId, reason, details } = req.body;
    if (!contentId || !reason) {
      return res.status(400).json({ error: 'contentId and reason are required' });
    }

    // Resolve the content + who made it
    const content = await ContentSubmission.findById(contentId)
      .populate('influencerProfileId', 'handle userId')
      .lean();

    const reportedUserId = content?.influencerProfileId?.userId || null;
    const reportedHandle = content?.influencerProfileId?.handle || null;

    const report = await ContentReport.create({
      reporterId: req.user._id,
      contentId,
      reportedUserId,
      reportedHandle,
      reason,
      details: details || null,
    });

    // ── Admin email notification (SendGrid) ────────────────────────
    try {
      const { sendEmail } = require('../config/email');
      const reporter = req.user.email || 'anonymous';
      const deadlineStr = new Date(report.deadlineAt).toLocaleString('en-US', {
        timeZone: 'America/New_York',
        dateStyle: 'short',
        timeStyle: 'short',
      });

      await sendEmail({
        to: ADMIN_EMAIL,
        subject: `⚠️ Content Report — Action required by ${deadlineStr} ET`,
        preheader: `${reporter} reported content for: ${reason}`,
        headline: '⚠️ New Content Report',
        bodyHtml: `
          <p>A user has flagged content that requires your review within <strong>24 hours</strong> (Apple Guideline 1.2).</p>
          <table style="width:100%;border-collapse:collapse;font-size:14px;">
            <tr><td style="padding:6px 0;color:#888;width:120px;">Report ID</td><td style="padding:6px 0;font-weight:600;">${report._id}</td></tr>
            <tr><td style="padding:6px 0;color:#888;">Content ID</td><td style="padding:6px 0;">${contentId}</td></tr>
            <tr><td style="padding:6px 0;color:#888;">Reported user</td><td style="padding:6px 0;">@${reportedHandle || 'unknown'}</td></tr>
            <tr><td style="padding:6px 0;color:#888;">Reported by</td><td style="padding:6px 0;">${reporter}</td></tr>
            <tr><td style="padding:6px 0;color:#888;">Reason</td><td style="padding:6px 0;color:#e53e3e;font-weight:700;">${reason}</td></tr>
            <tr><td style="padding:6px 0;color:#888;">Action deadline</td><td style="padding:6px 0;color:#e53e3e;">${deadlineStr} ET</td></tr>
          </table>
          <p style="margin-top:16px;">Log in to the <a href="${process.env.APP_URL || 'https://keepuspostd.com'}/app/moderation.html" style="color:#2EA5DD;">KUP Moderation Dashboard</a> to review and take action.</p>
        `,
        ctaText: 'Open Moderation Dashboard →',
        ctaUrl: `${process.env.APP_URL || 'https://keepuspostd.com'}/app/moderation.html`,
        variant: 'brand',
      });
    } catch (emailErr) {
      console.warn('Report email failed (non-blocking):', emailErr.message);
    }

    console.log(`🚨 Content report filed: ${reason} on ${contentId} by ${req.user.email}`);
    res.status(201).json({ message: 'Report submitted. Our team will review within 24 hours.', reportId: report._id });
  } catch (error) {
    console.error('Report submit error:', error.message);
    res.status(500).json({ error: 'Could not submit report' });
  }
});

// GET /api/reports — Admin: list reports (pending first, then recent)
router.get('/', requireAuth, async (req, res) => {
  try {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });

    const { status, page = 1, limit = 50 } = req.query;
    const filter = status ? { status } : {};
    const skip = (page - 1) * limit;

    const [reports, total] = await Promise.all([
      ContentReport.find(filter)
        .sort({ status: 1, createdAt: -1 }) // pending first
        .skip(skip)
        .limit(Number(limit))
        .populate('reporterId', 'email legalFirstName')
        .populate('contentId', 'mediaUrls caption brandId')
        .lean(),
      ContentReport.countDocuments(filter),
    ]);

    // Flag overdue reports (>24h since created, still pending)
    const now = new Date();
    const enriched = reports.map(r => ({
      ...r,
      isOverdue: r.status === 'pending' && new Date(r.deadlineAt) < now,
    }));

    res.json({ reports: enriched, total, page: Number(page), pages: Math.ceil(total / limit) });
  } catch (error) {
    console.error('Reports list error:', error.message);
    res.status(500).json({ error: 'Could not load reports' });
  }
});

// PUT /api/reports/:id — Admin: resolve a report
router.put('/:id', requireAuth, async (req, res) => {
  try {
    if (!req.user.isAdmin) return res.status(403).json({ error: 'Admin only' });

    const { status, actionTaken } = req.body;
    const validStatuses = ['reviewed', 'actioned', 'dismissed'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const report = await ContentReport.findByIdAndUpdate(
      req.params.id,
      { status, actionTaken: actionTaken || null, reviewedBy: req.user._id, reviewedAt: new Date() },
      { new: true }
    );

    if (!report) return res.status(404).json({ error: 'Report not found' });

    // If actioned → remove the content from the feed
    if (status === 'actioned' && report.contentId) {
      await ContentSubmission.findByIdAndUpdate(report.contentId, { status: 'rejected' });
      console.log(`🗑️ Content ${report.contentId} removed via moderation action`);
    }

    res.json({ message: 'Report updated', report });
  } catch (error) {
    console.error('Report update error:', error.message);
    res.status(500).json({ error: 'Could not update report' });
  }
});

module.exports = router;
