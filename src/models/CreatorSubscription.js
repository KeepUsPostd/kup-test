// Creator Subscription Model
//
// Tracks a viewer's PRIVATE relationship to another creator on the platform.
// Strictly two utility flags — never used as a public "follower" count, never
// shown to the creator they relate to. Aligned with the "no follower minimum,
// everyone has influence" thesis (see Build 143 strategy call).
//
//   - saved:  viewer has bookmarked this creator (private favorites list)
//   - notify: viewer wants a push when this creator gets a new approved review
//
// One record per (viewer userId, creator influencerProfileId). When both
// flags flip to false the record is deleted.

const mongoose = require('mongoose');

const creatorSubscriptionSchema = new mongoose.Schema({
  // The VIEWER (the user doing the saving/subscribing)
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  // The CREATOR being saved/subscribed to (InfluencerProfile._id)
  creatorProfileId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'InfluencerProfile',
    required: true,
    index: true,
  },
  saved: { type: Boolean, default: false },
  notify: { type: Boolean, default: false },
}, { timestamps: true });

// One record per (viewer, creator).
creatorSubscriptionSchema.index({ userId: 1, creatorProfileId: 1 }, { unique: true });

// Useful for the notifier query: "everyone who wants pushes about creator X".
creatorSubscriptionSchema.index({ creatorProfileId: 1, notify: 1 });

module.exports = mongoose.model('CreatorSubscription', creatorSubscriptionSchema);
