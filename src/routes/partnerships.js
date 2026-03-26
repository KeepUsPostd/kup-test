// Partnership Routes — Stub (Full implementation in Phase 4)
// Will enforce: brand isolation, partnership lifecycle
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');

router.get('/', requireAuth, (req, res) => {
  res.json({ message: 'Partnerships endpoint — coming in Phase 4', partnerships: [] });
});

module.exports = router;
