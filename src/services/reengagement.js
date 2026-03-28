// KUP Re-Engagement Campaign Service
// Automated campaigns that bring inactive users back to the platform.
// These run on a schedule (cron job or manual trigger) and send targeted
// notifications to users based on their activity patterns.
//
// 21 campaigns across 3 audiences: Influencer, Brand, Platform-wide
//
// Usage:
//   const reengagement = require('../services/reengagement');
//   await reengagement.runAll();            // Run all campaigns
//   await reengagement.runInfluencer();     // Run influencer campaigns only
//   await reengagement.runBrand();          // Run brand campaigns only
//   await reengagement.run('RE-I-001');     // Run a specific campaign
//
// Ref: NOTIFICATION_MAP.md → Re-Engagement Campaign Library

const { sendEmail } = require('../config/email');
const { sendPushToUser } = require('../config/push');
const Notification = require('../models/Notification');

const APP_URL = process.env.APP_URL || 'http://localhost:3001';

// ── Helper: Dollar format ─────────────────────────────────
function $(amount) {
  return `$${Number(amount).toFixed(2)}`;
}

// ── Helper: Days ago date ─────────────────────────────────
function daysAgo(days) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

// ── Helper: In-app notification ───────────────────────────
async function createInApp({ userId, title, message, type, link }) {
  try {
    await Notification.create({ userId, title, message, type, link });
  } catch (err) {
    console.error('Re-engagement in-app failed:', err.message);
  }
}

// ── Helper: Push notification (non-blocking) ──────────────
async function push(userId, { title, body, link }) {
  try {
    await sendPushToUser(userId, { title, body, link });
  } catch (err) { /* silent */ }
}

// ═══════════════════════════════════════════════════════════
// INFLUENCER CAMPAIGNS
// ═══════════════════════════════════════════════════════════

// RE-I-001: Inactive 3+ days — "Brands are waiting for you"
async function influencerInactive3Days() {
  const InfluencerProfile = require('../models/InfluencerProfile');
  const User = require('../models/User');

  const cutoff = daysAgo(3);
  const users = await User.find({
    hasInfluencerProfile: true,
    lastLoginAt: { $lt: cutoff, $gt: daysAgo(7) }, // 3-7 days inactive (not overlapping with 7-day campaign)
    status: 'active',
  }, { email: 1, firebaseUid: 1 }).limit(100);

  let sent = 0;
  for (const user of users) {
    await sendEmail({
      to: user.email,
      subject: 'Brands Are Waiting for You — KeepUsPostd',
      headline: 'Brands Are Waiting!',
      preheader: 'New content opportunities are available.',
      bodyHtml: `
        <p>Hey! It's been a few days since you checked in on KeepUsPostd.</p>
        <p>There are brands looking for creators like you. Don't miss out on new partnership opportunities and earning potential.</p>
      `,
      ctaText: 'Browse Brands',
      ctaUrl: `${APP_URL}/app/marketplace.html`,
      variant: 'influencer',
    });
    push(user.firebaseUid, { title: '👋 Brands are waiting!', body: 'New content opportunities available.', link: '/app/marketplace.html' });
    sent++;
  }
  return { campaign: 'RE-I-001', sent };
}

// RE-I-002: Inactive 7+ days — "We miss you!"
async function influencerInactive7Days() {
  const User = require('../models/User');

  const cutoff = daysAgo(7);
  const users = await User.find({
    hasInfluencerProfile: true,
    lastLoginAt: { $lt: cutoff, $gt: daysAgo(30) },
    status: 'active',
  }, { email: 1, firebaseUid: 1 }).limit(100);

  let sent = 0;
  for (const user of users) {
    await sendEmail({
      to: user.email,
      subject: 'We Miss You! — KeepUsPostd',
      headline: 'We Miss You!',
      preheader: 'Come back and see what\'s new.',
      bodyHtml: `
        <p>It's been a while since your last visit. We've got new brands, campaigns, and earning opportunities waiting for you.</p>
        <p>Your profile is still active and ready to go. Jump back in!</p>
      `,
      ctaText: 'Open the App',
      ctaUrl: `${APP_URL}/app/home.html`,
      variant: 'influencer',
    });
    sent++;
  }
  return { campaign: 'RE-I-002', sent };
}

// RE-I-004: Has unviewed approved content — "You have earnings waiting"
async function influencerEarningsWaiting() {
  const Transaction = require('../models/Transaction');
  const InfluencerProfile = require('../models/InfluencerProfile');

  // Find influencers with paid transactions but no cashout
  const profiles = await InfluencerProfile.aggregate([
    { $lookup: { from: 'transactions', localField: '_id', foreignField: 'influencerProfileId', as: 'txns' } },
    { $addFields: {
      uncashedBalance: {
        $sum: {
          $map: {
            input: { $filter: { input: '$txns', as: 't', cond: { $and: [{ $eq: ['$$t.status', 'paid'] }, { $eq: ['$$t.withdrawalId', null] }] } } },
            as: 't',
            in: '$$t.amount',
          }
        }
      }
    }},
    { $match: { uncashedBalance: { $gte: 5 } } }, // Min cashout amount
    { $limit: 50 },
  ]);

  let sent = 0;
  for (const profile of profiles) {
    if (!profile.userId) continue;
    const User = require('../models/User');
    const user = await User.findOne({ firebaseUid: profile.userId }, { email: 1, firebaseUid: 1 });
    if (!user) continue;

    await sendEmail({
      to: user.email,
      subject: `💰 You Have ${$(profile.uncashedBalance)} Waiting — KeepUsPostd`,
      headline: 'You Have Earnings Waiting!',
      preheader: `${$(profile.uncashedBalance)} is ready to cash out.`,
      bodyHtml: `
        <p>You have <strong>${$(profile.uncashedBalance)}</strong> in your KeepUsPostd wallet that you haven't cashed out yet.</p>
        <p>Cash out to your PayPal anytime — it only takes a few seconds.</p>
      `,
      ctaText: 'Cash Out Now',
      ctaUrl: `${APP_URL}/app/wallet.html`,
      variant: 'influencer',
    });
    push(user.firebaseUid, { title: `💰 ${$(profile.uncashedBalance)} waiting!`, body: 'Cash out your earnings to PayPal.', link: '/app/wallet.html' });
    sent++;
  }
  return { campaign: 'RE-I-004', sent };
}

// RE-I-007: Weekly earnings summary — "Your week in review"
async function influencerWeeklySummary() {
  const Transaction = require('../models/Transaction');
  const InfluencerProfile = require('../models/InfluencerProfile');
  const User = require('../models/User');

  const weekAgo = daysAgo(7);

  // Find influencers who earned something this week
  const earners = await Transaction.aggregate([
    { $match: { status: 'paid', paidAt: { $gte: weekAgo }, type: { $in: ['cash_per_approval', 'bonus_cash', 'postd_pay'] } } },
    { $group: { _id: '$influencerProfileId', weeklyTotal: { $sum: '$amount' }, count: { $sum: 1 } } },
    { $limit: 100 },
  ]);

  let sent = 0;
  for (const earner of earners) {
    const profile = await InfluencerProfile.findById(earner._id, { userId: 1 });
    if (!profile?.userId) continue;
    const user = await User.findOne({ firebaseUid: profile.userId }, { email: 1 });
    if (!user) continue;

    await sendEmail({
      to: user.email,
      subject: `Your Week in Review — You Earned ${$(earner.weeklyTotal)}`,
      headline: 'Your Week in Review',
      preheader: `${$(earner.weeklyTotal)} earned from ${earner.count} transaction${earner.count > 1 ? 's' : ''} this week.`,
      bodyHtml: `
        <p>Here's your weekly KeepUsPostd recap:</p>
        <p>
          <strong>Earned this week:</strong> ${$(earner.weeklyTotal)}<br>
          <strong>Transactions:</strong> ${earner.count}
        </p>
        <p>Keep creating great content to grow your earnings!</p>
      `,
      ctaText: 'View Wallet',
      ctaUrl: `${APP_URL}/app/wallet.html`,
      variant: 'influencer',
    });
    sent++;
  }
  return { campaign: 'RE-I-007', sent };
}

// RE-I-008: Incomplete profile — "Finish your profile" (48hr after signup)
async function influencerIncompleteProfile() {
  const InfluencerProfile = require('../models/InfluencerProfile');
  const User = require('../models/User');

  const cutoff48h = daysAgo(2);
  const cutoff7d = daysAgo(7);

  // Users who signed up 2-7 days ago but haven't completed profile
  const profiles = await InfluencerProfile.find({
    verificationTier: 'unverified',
    createdAt: { $lt: cutoff48h, $gt: cutoff7d },
  }, { userId: 1 }).limit(50);

  let sent = 0;
  for (const profile of profiles) {
    if (!profile.userId) continue;
    const user = await User.findOne({ firebaseUid: profile.userId }, { email: 1, firebaseUid: 1 });
    if (!user) continue;

    await sendEmail({
      to: user.email,
      subject: 'Finish Your Profile — Start Earning on KeepUsPostd',
      headline: 'Finish Your Profile',
      preheader: 'Complete your profile to start partnering with brands.',
      bodyHtml: `
        <p>You signed up for KeepUsPostd but haven't completed your profile yet.</p>
        <p>Finish your profile and get verified to unlock brand partnerships and start earning real money for your content.</p>
      `,
      ctaText: 'Complete Profile',
      ctaUrl: `${APP_URL}/app/profile.html`,
      variant: 'influencer',
    });
    push(user.firebaseUid, { title: 'Finish your profile!', body: 'Complete your profile to start earning.', link: '/app/profile.html' });
    sent++;
  }
  return { campaign: 'RE-I-008', sent };
}

// ═══════════════════════════════════════════════════════════
// BRAND CAMPAIGNS
// ═══════════════════════════════════════════════════════════

// RE-B-001: Unreviewed content 24hr+ — "Content awaiting review"
async function brandUnreviewedContent() {
  const ContentSubmission = require('../models/ContentSubmission');
  const Brand = require('../models/Brand');

  const cutoff = daysAgo(1);

  // Find brands with pending reviews older than 24 hours
  const pending = await ContentSubmission.aggregate([
    { $match: { status: 'pending', createdAt: { $lt: cutoff } } },
    { $group: { _id: '$brandId', count: { $sum: 1 } } },
    { $limit: 50 },
  ]);

  let sent = 0;
  for (const item of pending) {
    const brand = await Brand.findById(item._id);
    const brandEmail = brand?.ownerEmail || brand?.email;
    if (!brandEmail) continue;

    await sendEmail({
      to: brandEmail,
      subject: `📋 ${item.count} Content Submission${item.count > 1 ? 's' : ''} Awaiting Review`,
      headline: 'Content Awaiting Review',
      preheader: `You have ${item.count} pending review${item.count > 1 ? 's' : ''}.`,
      bodyHtml: `
        <p>You have <strong>${item.count}</strong> content submission${item.count > 1 ? 's' : ''} waiting for your review.</p>
        <p>Content not reviewed within 7 days may be auto-approved. Review now to maintain control over your brand content.</p>
      `,
      ctaText: 'Review Content',
      ctaUrl: `${APP_URL}/pages/inner/content.html`,
      variant: 'brand',
    });
    if (brand.ownerId) {
      push(brand.ownerId, { title: '📋 Content awaiting review', body: `${item.count} submission${item.count > 1 ? 's' : ''} pending.`, link: '/pages/inner/content.html' });
    }
    sent++;
  }
  return { campaign: 'RE-B-001', sent };
}

// RE-B-002: Inactive 5+ days — "Your creators are active"
async function brandInactive5Days() {
  const User = require('../models/User');

  const cutoff = daysAgo(5);
  const users = await User.find({
    hasBrandProfile: true,
    lastLoginAt: { $lt: cutoff, $gt: daysAgo(14) },
    status: 'active',
  }, { email: 1, firebaseUid: 1 }).limit(100);

  let sent = 0;
  for (const user of users) {
    await sendEmail({
      to: user.email,
      subject: 'Your Creators Are Active — KeepUsPostd',
      headline: 'Your Creators Are Active',
      preheader: 'Influencers are creating content — check in!',
      bodyHtml: `
        <p>While you've been away, influencers on KeepUsPostd have been creating content and looking for brand partnerships.</p>
        <p>Log in to check for new submissions, manage your campaigns, and keep the momentum going.</p>
      `,
      ctaText: 'Go to Dashboard',
      ctaUrl: `${APP_URL}/pages/inner/dashboard.html`,
      variant: 'brand',
    });
    sent++;
  }
  return { campaign: 'RE-B-002', sent };
}

// RE-B-004: No campaign created yet — "Launch your first campaign"
async function brandNoCampaign() {
  const Brand = require('../models/Brand');
  const Campaign = require('../models/Campaign');
  const User = require('../models/User');

  // Find brands with no campaigns (created 3+ days ago)
  const brands = await Brand.find({
    createdAt: { $lt: daysAgo(3) },
    status: 'active',
  }, { ownerId: 1, ownerEmail: 1, email: 1, name: 1 }).limit(50);

  let sent = 0;
  for (const brand of brands) {
    // Check if brand has any campaigns
    const campaignCount = await Campaign.countDocuments({ brandId: brand._id });
    if (campaignCount > 0) continue;

    const brandEmail = brand.ownerEmail || brand.email;
    if (!brandEmail) continue;

    await sendEmail({
      to: brandEmail,
      subject: `Launch Your First Campaign — ${brand.name}`,
      headline: 'Launch Your First Campaign',
      preheader: 'Get influencers creating content for your brand.',
      bodyHtml: `
        <p>Your brand <strong>${brand.name}</strong> is live on KeepUsPostd, but you haven't created a campaign yet.</p>
        <p>Campaigns help you organize your influencer partnerships and track content creation goals. Launch your first one to get started!</p>
      `,
      ctaText: 'Create Campaign',
      ctaUrl: `${APP_URL}/pages/inner/campaigns.html`,
      variant: 'brand',
    });
    sent++;
  }
  return { campaign: 'RE-B-004', sent };
}

// RE-B-005: Monthly performance digest — "Your monthly report"
async function brandMonthlyDigest() {
  const Brand = require('../models/Brand');
  const ContentSubmission = require('../models/ContentSubmission');
  const Transaction = require('../models/Transaction');

  const monthAgo = daysAgo(30);
  const brands = await Brand.find({ status: 'active' }, { ownerId: 1, ownerEmail: 1, email: 1, name: 1 }).limit(100);

  let sent = 0;
  for (const brand of brands) {
    const brandEmail = brand.ownerEmail || brand.email;
    if (!brandEmail) continue;

    // Get monthly stats
    const submissions = await ContentSubmission.countDocuments({ brandId: brand._id, createdAt: { $gte: monthAgo } });
    const approved = await ContentSubmission.countDocuments({ brandId: brand._id, status: 'approved', updatedAt: { $gte: monthAgo } });
    const spent = await Transaction.aggregate([
      { $match: { brandId: brand._id, status: 'paid', paidAt: { $gte: monthAgo } } },
      { $group: { _id: null, total: { $sum: '$brandPaysAmount' } } },
    ]);
    const totalSpent = spent.length > 0 ? spent[0].total : 0;

    // Only send if there's activity
    if (submissions === 0 && totalSpent === 0) continue;

    await sendEmail({
      to: brandEmail,
      subject: `Monthly Report — ${brand.name}`,
      headline: 'Your Monthly Report',
      preheader: `${brand.name} activity summary for the past 30 days.`,
      bodyHtml: `
        <p>Here's your monthly KeepUsPostd recap for <strong>${brand.name}</strong>:</p>
        <p>
          <strong>Content submissions:</strong> ${submissions}<br>
          <strong>Approved:</strong> ${approved}<br>
          <strong>Total spent:</strong> ${$(totalSpent)}
        </p>
        <p>Check your dashboard for detailed analytics.</p>
      `,
      ctaText: 'View Dashboard',
      ctaUrl: `${APP_URL}/pages/inner/dashboard.html`,
      variant: 'brand',
    });
    sent++;
  }
  return { campaign: 'RE-B-005', sent };
}

// RE-B-008: Reward program not set up — "Set up your rewards"
async function brandNoRewards() {
  const Brand = require('../models/Brand');
  const Reward = require('../models/Reward');

  const brands = await Brand.find({
    createdAt: { $lt: daysAgo(5) },
    status: 'active',
  }, { ownerId: 1, ownerEmail: 1, email: 1, name: 1 }).limit(50);

  let sent = 0;
  for (const brand of brands) {
    const rewardCount = await Reward.countDocuments({ brandId: brand._id });
    if (rewardCount > 0) continue;

    const brandEmail = brand.ownerEmail || brand.email;
    if (!brandEmail) continue;

    await sendEmail({
      to: brandEmail,
      subject: `Set Up Rewards for ${brand.name} — KeepUsPostd`,
      headline: 'Set Up Your Rewards',
      preheader: 'Attract more influencers with rewards.',
      bodyHtml: `
        <p>Your brand <strong>${brand.name}</strong> doesn't have a reward program set up yet.</p>
        <p>Brands with active rewards see <strong>2x more influencer engagement</strong>. Set up cash rewards, bonuses, or point-based incentives to attract top creators.</p>
      `,
      ctaText: 'Set Up Rewards',
      ctaUrl: `${APP_URL}/pages/inner/brand-reward-settings.html`,
      variant: 'brand',
    });
    sent++;
  }
  return { campaign: 'RE-B-008', sent };
}

// ═══════════════════════════════════════════════════════════
// PLATFORM-WIDE CAMPAIGNS (triggered manually)
// ═══════════════════════════════════════════════════════════

// RE-P-001: New feature launch
async function newFeatureLaunch({ featureName, description, ctaUrl }) {
  const User = require('../models/User');
  const users = await User.find({ status: 'active' }, { email: 1 }).limit(500);

  let sent = 0;
  for (const user of users) {
    await sendEmail({
      to: user.email,
      subject: `🆕 New on KUP — ${featureName}`,
      headline: featureName,
      preheader: description,
      bodyHtml: `<p>${description}</p>`,
      ctaText: 'Try It Now',
      ctaUrl: ctaUrl || `${APP_URL}`,
      variant: 'brand',
    });
    sent++;
  }
  return { campaign: 'RE-P-001', sent };
}

// RE-P-002: Platform milestone
async function platformMilestone({ milestone, description }) {
  const User = require('../models/User');
  const users = await User.find({ status: 'active' }, { email: 1 }).limit(500);

  let sent = 0;
  for (const user of users) {
    await sendEmail({
      to: user.email,
      subject: `🎉 ${milestone} — KeepUsPostd`,
      headline: milestone,
      preheader: description,
      bodyHtml: `<p>${description}</p><p>Thank you for being part of the KeepUsPostd community!</p>`,
      variant: 'brand',
    });
    sent++;
  }
  return { campaign: 'RE-P-002', sent };
}

// ═══════════════════════════════════════════════════════════
// CAMPAIGN RUNNERS
// ═══════════════════════════════════════════════════════════

// Run all automated campaigns (call from cron job)
async function runAll() {
  console.log('\n📣 Running all re-engagement campaigns...');
  const results = [];

  // Influencer campaigns
  results.push(await influencerInactive3Days().catch(e => ({ campaign: 'RE-I-001', error: e.message })));
  results.push(await influencerInactive7Days().catch(e => ({ campaign: 'RE-I-002', error: e.message })));
  results.push(await influencerEarningsWaiting().catch(e => ({ campaign: 'RE-I-004', error: e.message })));
  results.push(await influencerIncompleteProfile().catch(e => ({ campaign: 'RE-I-008', error: e.message })));

  // Brand campaigns
  results.push(await brandUnreviewedContent().catch(e => ({ campaign: 'RE-B-001', error: e.message })));
  results.push(await brandInactive5Days().catch(e => ({ campaign: 'RE-B-002', error: e.message })));
  results.push(await brandNoCampaign().catch(e => ({ campaign: 'RE-B-004', error: e.message })));
  results.push(await brandNoRewards().catch(e => ({ campaign: 'RE-B-008', error: e.message })));

  console.log('📣 Re-engagement results:', JSON.stringify(results, null, 2));
  return results;
}

// Run weekly campaigns (call from weekly cron)
async function runWeekly() {
  console.log('\n📣 Running weekly re-engagement campaigns...');
  const results = [];
  results.push(await influencerWeeklySummary().catch(e => ({ campaign: 'RE-I-007', error: e.message })));
  console.log('📣 Weekly results:', JSON.stringify(results, null, 2));
  return results;
}

// Run monthly campaigns (call from monthly cron)
async function runMonthly() {
  console.log('\n📣 Running monthly re-engagement campaigns...');
  const results = [];
  results.push(await brandMonthlyDigest().catch(e => ({ campaign: 'RE-B-005', error: e.message })));
  console.log('📣 Monthly results:', JSON.stringify(results, null, 2));
  return results;
}

// Run influencer campaigns only
async function runInfluencer() {
  const results = [];
  results.push(await influencerInactive3Days().catch(e => ({ campaign: 'RE-I-001', error: e.message })));
  results.push(await influencerInactive7Days().catch(e => ({ campaign: 'RE-I-002', error: e.message })));
  results.push(await influencerEarningsWaiting().catch(e => ({ campaign: 'RE-I-004', error: e.message })));
  results.push(await influencerIncompleteProfile().catch(e => ({ campaign: 'RE-I-008', error: e.message })));
  results.push(await influencerWeeklySummary().catch(e => ({ campaign: 'RE-I-007', error: e.message })));
  return results;
}

// Run brand campaigns only
async function runBrand() {
  const results = [];
  results.push(await brandUnreviewedContent().catch(e => ({ campaign: 'RE-B-001', error: e.message })));
  results.push(await brandInactive5Days().catch(e => ({ campaign: 'RE-B-002', error: e.message })));
  results.push(await brandNoCampaign().catch(e => ({ campaign: 'RE-B-004', error: e.message })));
  results.push(await brandNoRewards().catch(e => ({ campaign: 'RE-B-008', error: e.message })));
  results.push(await brandMonthlyDigest().catch(e => ({ campaign: 'RE-B-005', error: e.message })));
  return results;
}

// Run a specific campaign by ID
async function run(campaignId) {
  const map = {
    'RE-I-001': influencerInactive3Days,
    'RE-I-002': influencerInactive7Days,
    'RE-I-004': influencerEarningsWaiting,
    'RE-I-007': influencerWeeklySummary,
    'RE-I-008': influencerIncompleteProfile,
    'RE-B-001': brandUnreviewedContent,
    'RE-B-002': brandInactive5Days,
    'RE-B-004': brandNoCampaign,
    'RE-B-005': brandMonthlyDigest,
    'RE-B-008': brandNoRewards,
  };

  const fn = map[campaignId];
  if (!fn) throw new Error(`Unknown campaign: ${campaignId}`);
  return fn();
}

module.exports = {
  // Individual campaigns
  influencerInactive3Days,
  influencerInactive7Days,
  influencerEarningsWaiting,
  influencerWeeklySummary,
  influencerIncompleteProfile,
  brandUnreviewedContent,
  brandInactive5Days,
  brandNoCampaign,
  brandMonthlyDigest,
  brandNoRewards,
  newFeatureLaunch,
  platformMilestone,

  // Runners
  runAll,
  runWeekly,
  runMonthly,
  runInfluencer,
  runBrand,
  run,
};
