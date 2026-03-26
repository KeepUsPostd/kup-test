// Campaign Routes — Stub (Full implementation in Phase 3)
// Will enforce: plan limits on campaigns per brand, status lifecycle
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');

router.get('/', requireAuth, (req, res) => {
  res.json({ message: 'Campaigns endpoint — coming in Phase 3', campaigns: [] });
});

module.exports = router;
