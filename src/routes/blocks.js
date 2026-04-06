// Blocks Routes — User blocking (Apple Guideline 1.2)
// POST   /api/blocks              — block a user (by contentId or userId)
// DELETE /api/blocks/:userId      — unblock
// GET    /api/blocks              — get caller's block list (for feed filtering)
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { UserBlock, ContentSubmission, User } = require('../models');

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'santana@keepuspostd.com';

// POST /api/blocks — Block a user
router.post('/', requireAuth, async (req, res) => {
  try {
    const { contentId, userId } = req.body;
    if (!contentId && !userId) {
      return res.status(400).json({ error: 'contentId or userId required' });
    }

    // Resolve userId from contentId if needed
    let blockedUserId = userId;
    let blockedHandle = null;

    if (contentId && !userId) {
      const content = await ContentSubmission.findById(contentId)
        .populate('influencerProfileId', 'userId handle')
        .lean();
      blockedUserId = content?.influencerProfileId?.userId;
      blockedHandle = content?.influencerProfileId?.handle;
    }

    if (!blockedUserId) return res.status(404).json({ error: 'Could not identify user to block' });
    if (String(blockedUserId) === String(req.user._id)) {
      return res.status(400).json({ error: 'You cannot block yourself' });
    }

    await UserBlock.findOneAndUpdate(
      { blockerId: req.user._id, blockedUserId },
      { blockerId: req.user._id, blockedUserId, blockedHandle },
      { upsert: true, new: true }
    );

    // ── Notify admin of block (Apple Guideline 1.2) ──────────────
    try {
      const { sendEmail } = require('../config/email');
      await sendEmail({
        to: ADMIN_EMAIL,
        subject: `🚫 User Block Report — @${blockedHandle || blockedUserId}`,
        preheader: `${req.user.email} blocked @${blockedHandle || 'a user'}`,
        headline: 'User Block Notification',
        bodyHtml: `
          <p>A user has blocked another user on KeepUsPostd. This is logged per Apple Guideline 1.2.</p>
          <table style="width:100%;border-collapse:collapse;font-size:14px;">
            <tr><td style="padding:6px 0;color:#888;width:140px;">Blocked by</td><td style="padding:6px 0;">${req.user.email}</td></tr>
            <tr><td style="padding:6px 0;color:#888;">Blocked user</td><td style="padding:6px 0;">@${blockedHandle || 'unknown'} (${blockedUserId})</td></tr>
            <tr><td style="padding:6px 0;color:#888;">Content flagged</td><td style="padding:6px 0;">${contentId || 'N/A'}</td></tr>
          </table>
          <p style="margin-top:12px;color:#888;font-size:13px;">No action required unless this account has multiple block reports.</p>
        `,
        variant: 'brand',
      });
    } catch (emailErr) {
      console.warn('Block email failed (non-blocking):', emailErr.message);
    }

    console.log(`🚫 Block: ${req.user.email} blocked @${blockedHandle || blockedUserId}`);
    res.status(201).json({ message: `@${blockedHandle || 'user'} blocked — their content will no longer appear in your feed.` });
  } catch (error) {
    console.error('Block error:', error.message);
    res.status(500).json({ error: 'Could not block user' });
  }
});

// DELETE /api/blocks/:userId — Unblock
router.delete('/:userId', requireAuth, async (req, res) => {
  try {
    await UserBlock.findOneAndDelete({ blockerId: req.user._id, blockedUserId: req.params.userId });
    res.json({ message: 'User unblocked' });
  } catch (error) {
    res.status(500).json({ error: 'Could not unblock user' });
  }
});

// GET /api/blocks — Get caller's block list (for filtering feed client-side)
router.get('/', requireAuth, async (req, res) => {
  try {
    const blocks = await UserBlock.find({ blockerId: req.user._id }).lean();
    const blockedUserIds = blocks.map(b => b.blockedUserId.toString());
    res.json({ blockedUserIds, total: blocks.length });
  } catch (error) {
    res.status(500).json({ error: 'Could not load block list' });
  }
});

module.exports = router;
