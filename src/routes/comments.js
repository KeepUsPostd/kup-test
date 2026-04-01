// Comments Routes — User comments on content submissions
// GET  /api/comments/:contentId  — list comments (public)
// POST /api/comments/:contentId  — post a comment (auth required)
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Comment = require('../models/Comment');
const ContentSubmission = require('../models/ContentSubmission');
const { requireAuth } = require('../middleware/auth');

// GET /api/comments/:contentId — list comments (no auth required, paginated)
router.get('/:contentId', async (req, res) => {
  try {
    const { contentId } = req.params;
    if (!mongoose.isValidObjectId(contentId)) {
      return res.status(400).json({ error: 'Invalid content ID' });
    }

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const comments = await Comment.find({ contentId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    res.json({ comments });
  } catch (error) {
    console.error('[comments GET]', error.message);
    res.status(500).json({ error: 'Failed to load comments' });
  }
});

// POST /api/comments/:contentId — post a comment (auth required)
router.post('/:contentId', requireAuth, async (req, res) => {
  try {
    const { contentId } = req.params;
    const { text } = req.body;

    if (!mongoose.isValidObjectId(contentId)) {
      return res.status(400).json({ error: 'Invalid content ID' });
    }
    if (!text || typeof text !== 'string' || text.trim().length === 0) {
      return res.status(400).json({ error: 'Comment text required' });
    }
    if (text.trim().length > 500) {
      return res.status(400).json({ error: 'Comment too long (max 500 characters)' });
    }

    const firstName = req.user.legalFirstName || '';
    const lastName = req.user.legalLastName || '';
    const displayName = [firstName, lastName].filter(Boolean).join(' ') || 'User';

    const comment = await Comment.create({
      contentId,
      userId: req.user._id,
      displayName,
      avatarUrl: req.user.avatarUrl || null,
      text: text.trim(),
    });

    // Increment comment count on the content submission
    await ContentSubmission.findByIdAndUpdate(contentId, {
      $inc: { 'metrics.comments': 1 },
    });

    res.status(201).json({ comment });
  } catch (error) {
    console.error('[comments POST]', error.message);
    res.status(500).json({ error: 'Failed to post comment' });
  }
});

module.exports = router;
