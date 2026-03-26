// Model Barrel File — Re-exports all Mongoose models
// Import from here: const { User, Brand } = require('./models');

module.exports = {
  User: require('./User'),
  InfluencerProfile: require('./InfluencerProfile'),
  BrandProfile: require('./BrandProfile'),
  Brand: require('./Brand'),
  BrandMember: require('./BrandMember'),
  Campaign: require('./Campaign'),
  Reward: require('./Reward'),
  ContentSubmission: require('./ContentSubmission'),
  Partnership: require('./Partnership'),
  GuestReviewer: require('./GuestReviewer'),
  KioskReward: require('./KioskReward'),
};
