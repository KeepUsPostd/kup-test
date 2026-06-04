// Public read-only endpoints for browsing creator/influencer profiles.
// Used by the in-app "view another creator's profile" feature when a viewer
// taps an @handle on a review.

const express = require('express');
const router = express.Router();
const { InfluencerProfile, ContentSubmission } = require('../models');

// GET /api/influencers/handle/:handle
// Returns the creator's PUBLIC-SAFE profile. NEVER returns email/phone/
// PayPal/financial fields. Used by the view-other-creator-profile screen.
router.get('/handle/:handle', async (req, res) => {
  try {
    const raw = (req.params.handle || '').trim().replace(/^@+/, '').toLowerCase();
    if (!raw) return res.status(400).json({ error: 'handle is required' });

    const profile = await InfluencerProfile.findOne(
      { handle: raw },
      // Whitelist what we expose — anything not listed is never returned.
      'handle displayName avatarUrl bio isVerified verificationStatus influenceTier createdAt averageRating ratingCount'
    ).lean();

    if (!profile) return res.status(404).json({ error: 'Creator not found' });

    // Aggregate public stats — counts of their approved + postd reviews. Brands
    // they've worked with is left for a future iteration (cross-brand exposure
    // wants its own privacy review).
    const [approvedCount, postdCount] = await Promise.all([
      ContentSubmission.countDocuments({ influencerProfileId: profile._id, status: 'approved' }),
      ContentSubmission.countDocuments({ influencerProfileId: profile._id, status: 'postd' }),
    ]);

    res.json({
      profile: {
        ...profile,
        reviewCount: approvedCount + postdCount,
        approvedCount,
        postdCount,
      },
    });
  } catch (err) {
    console.error('[GET /influencers/handle]', err.message);
    res.status(500).json({ error: 'Could not fetch creator profile' });
  }
});

module.exports = router;
