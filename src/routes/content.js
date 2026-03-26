// Content Routes — Stub (Full implementation in Phase 4)
// Will enforce: content ownership on submission, approval pipeline
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');

router.get('/', requireAuth, (req, res) => {
  res.json({ message: 'Content endpoint — coming in Phase 4', content: [] });
});

module.exports = router;
