// Public read-only endpoints for browsing creator/influencer profiles.
// Used by the in-app "view another creator's profile" feature when a viewer
// taps an @handle on a review.

const express = require('express');
const router = express.Router();
const { InfluencerProfile, ContentSubmission } = require('../models');
const { optionalAuth } = require('../middleware/auth');

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

// GET /api/influencers/:profileId/content
// Returns the creator's PUBLIC content (approved + postd only — never drafts,
// rejected, hidden, or pending review). Shaped to match the watch-feed item
// schema so the Flutter side can drop it straight into WatchFeedScreen's
// preloadedContent. optionalAuth so anonymous viewers can browse; likedByMe
// flags fill correctly for signed-in viewers.
router.get('/:profileId/content', optionalAuth, async (req, res) => {
  try {
    const { profileId } = req.params;
    if (!profileId) return res.status(400).json({ error: 'profileId is required' });

    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 20);
    const skip = (page - 1) * limit;

    const submissions = await ContentSubmission.find({
      influencerProfileId: profileId,
      status: { $in: ['approved', 'postd'] },
    })
      .populate('influencerProfileId', 'displayName handle avatarUrl influenceTier verificationStatus isVerified')
      .populate('brandId', 'name logoUrl generatedColor category city')
      .sort({ approvedAt: -1, submittedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean();

    const viewerId = req.user?._id?.toString() || null;
    const items = submissions.map(s => ({
      _id:           s._id,
      displayName:   s.influencerProfileId?.displayName || 'Creator',
      handle:        s.influencerProfileId?.handle || 'creator',
      avatarUrl:     s.influencerProfileId?.avatarUrl || null,
      verified:      s.influencerProfileId?.verificationStatus === 'verified',
      caption:       s.caption || '',
      brandId:       s.brandId?._id?.toString() || null,
      brandName:     s.brandId?.name || 'Brand',
      brandLogo:     s.brandId?.logoUrl || null,
      brandColor:    s.brandId?.generatedColor || '#1A1A1A',
      brandCategory: s.brandId?.category || null,
      brandCity:     s.brandId?.city || null,
      mediaUrls:     s.mediaUrls || [],
      posterUrl:     s.posterUrl || null,
      contentType:   s.contentType,
      likes:         s.metrics?.likes || 0,
      comments:      s.metrics?.comments || 0,
      shares:        s.metrics?.shares || 0,
      likedByMe:     viewerId ? (s.likedBy || []).map(String).includes(viewerId) : false,
    }));

    res.json({ submissions: items, page, hasMore: items.length === limit });
  } catch (err) {
    console.error('[GET /influencers/:profileId/content]', err.message);
    res.status(500).json({ error: 'Could not fetch creator content' });
  }
});

module.exports = router;
