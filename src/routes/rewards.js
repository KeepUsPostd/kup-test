// Reward Routes — Stub (Full implementation in Phase 3)
// Will enforce: R1 (one earning method), R2 (no point pooling), tier-based cash rates
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');

router.get('/', requireAuth, (req, res) => {
  res.json({ message: 'Rewards endpoint — coming in Phase 3', rewards: [] });
});

module.exports = router;
