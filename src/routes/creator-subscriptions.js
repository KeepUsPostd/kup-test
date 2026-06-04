// Private save / notify utility for browsing creators on KUP.
//
// "Save" = private bookmark (no public count, no notification to the saved
// creator). "Notify" = opt-in push when the saved creator gets a new
// approved review. Two independent toggles on the same record. When both
// flip to false the record is deleted.
//
// IMPORTANT: this is deliberately NOT a follow system. We don't expose
// counts, we don't notify the creator they were saved, and we never let
// brands filter by it. See the Build 143 strategy call.

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { CreatorSubscription, InfluencerProfile } = require('../models');

// GET /api/creator-subscriptions/status/:profileId
// Quick state lookup for the ViewedCreatorScreen toggles. Returns
// { saved, notify } — both false if no record exists.
router.get('/status/:profileId', requireAuth, async (req, res) => {
  try {
    const sub = await CreatorSubscription.findOne({
      userId: req.user._id,
      creatorProfileId: req.params.profileId,
    }).select('saved notify').lean();
    res.json({
      saved: sub?.saved === true,
      notify: sub?.notify === true,
    });
  } catch (err) {
    console.error('[GET /creator-subscriptions/status]', err.message);
    res.status(500).json({ error: 'Could not fetch subscription status' });
  }
});

// GET /api/creator-subscriptions/mine
// All creators the user has saved or subscribed-to. Populates the creator's
// public-safe fields for rendering a list.
router.get('/mine', requireAuth, async (req, res) => {
  try {
    const subs = await CreatorSubscription.find({
      userId: req.user._id,
      $or: [{ saved: true }, { notify: true }],
    })
      .populate({
        path: 'creatorProfileId',
        select: 'handle displayName avatarUrl isVerified verificationStatus influenceTier',
      })
      .sort({ updatedAt: -1 })
      .lean();
    res.json({
      subscriptions: subs.map(s => ({
        saved: s.saved,
        notify: s.notify,
        creator: s.creatorProfileId,
        createdAt: s.createdAt,
      })),
    });
  } catch (err) {
    console.error('[GET /creator-subscriptions/mine]', err.message);
    res.status(500).json({ error: 'Could not fetch subscriptions' });
  }
});

// Toggle helper used by /toggle-save and /toggle-notify. Creates or updates
// the record. If both flags end up false, the record is deleted.
async function toggleFlag(userId, creatorProfileId, flag, res) {
  if (!['saved', 'notify'].includes(flag)) {
    return res.status(400).json({ error: 'Invalid flag' });
  }
  const creator = await InfluencerProfile.findById(creatorProfileId).select('_id').lean();
  if (!creator) return res.status(404).json({ error: 'Creator not found' });

  let sub = await CreatorSubscription.findOne({ userId, creatorProfileId });
  if (!sub) {
    sub = await CreatorSubscription.create({
      userId,
      creatorProfileId,
      [flag]: true,
    });
  } else {
    sub[flag] = !sub[flag];
    if (!sub.saved && !sub.notify) {
      await sub.deleteOne();
      return res.json({ saved: false, notify: false });
    }
    await sub.save();
  }
  res.json({ saved: sub.saved === true, notify: sub.notify === true });
}

router.post('/toggle-save/:profileId', requireAuth, async (req, res) => {
  try {
    await toggleFlag(req.user._id, req.params.profileId, 'saved', res);
  } catch (err) {
    console.error('[POST /creator-subscriptions/toggle-save]', err.message);
    res.status(500).json({ error: 'Could not toggle save' });
  }
});

router.post('/toggle-notify/:profileId', requireAuth, async (req, res) => {
  try {
    await toggleFlag(req.user._id, req.params.profileId, 'notify', res);
  } catch (err) {
    console.error('[POST /creator-subscriptions/toggle-notify]', err.message);
    res.status(500).json({ error: 'Could not toggle notify' });
  }
});

module.exports = router;
