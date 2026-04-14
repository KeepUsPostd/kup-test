// Saved Content Routes — User bookmarks for content submissions
// GET    /api/saved          — list saved content (auth required)
// POST   /api/saved/:id      — save a piece of content (auth required)
// DELETE /api/saved/:id      — unsave a piece of content (auth required)
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const SavedContent = require('../models/SavedContent');
const { requireAuth } = require('../middleware/auth');

// All routes require auth
router.use(requireAuth);

// GET /api/saved — list saved content for the current user
router.get('/', async (req, res) => {
  try {
    const saved = await SavedContent.find({ userId: req.user._id })
      .sort({ savedAt: -1 })
      .populate({
        path: 'contentId',
        select: 'caption contentType mediaUrls posterUrl brandName displayName handle status metrics',
      })
      .lean();

    // Filter out any nulls (content deleted after saving)
    const items = saved
      .map(s => s.contentId)
      .filter(Boolean);

    res.json({ saved: items });
  } catch (error) {
    console.error('[saved GET]', error.message);
    res.status(500).json({ error: 'Failed to load saved content' });
  }
});

// POST /api/saved/:contentId — save content (upsert — safe to call twice)
router.post('/:contentId', async (req, res) => {
  try {
    const { contentId } = req.params;
    if (!mongoose.isValidObjectId(contentId)) {
      return res.status(400).json({ error: 'Invalid content ID' });
    }

    await SavedContent.findOneAndUpdate(
      { userId: req.user._id, contentId },
      { savedAt: new Date() },
      { upsert: true, new: true },
    );

    res.json({ saved: true });
  } catch (error) {
    // Ignore duplicate key errors (already saved — still a success)
    if (error.code === 11000) return res.json({ saved: true });
    console.error('[saved POST]', error.message);
    res.status(500).json({ error: 'Failed to save content' });
  }
});

// DELETE /api/saved/:contentId — unsave content
router.delete('/:contentId', async (req, res) => {
  try {
    const { contentId } = req.params;
    if (!mongoose.isValidObjectId(contentId)) {
      return res.status(400).json({ error: 'Invalid content ID' });
    }

    await SavedContent.deleteOne({ userId: req.user._id, contentId });
    res.json({ saved: false });
  } catch (error) {
    console.error('[saved DELETE]', error.message);
    res.status(500).json({ error: 'Failed to unsave content' });
  }
});

module.exports = router;
