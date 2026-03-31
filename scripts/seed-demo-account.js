#!/usr/bin/env node
/**
 * seed-demo-account.js
 * Creates (or resets) the App Store / Google Play demo account.
 *
 * What it builds:
 *   • Firebase Auth user  — demo@keepuspostd.com / KupDemo2024!
 *   • MongoDB User + InfluencerProfile
 *   • One demo brand       — "The Local Café"
 *   • One active partnership between the influencer and the brand
 *   • One approved content submission (so Watch Feed has data)
 *   • Two activity notifications  (so Activity screen isn't empty)
 *   • PayPal email connected       (so Connect to Earn shows "Connected")
 *   • Social links pre-filled      (so Social Verification shows handles)
 *
 * Usage (run from kup-test/ root):
 *   node scripts/seed-demo-account.js
 *
 * It is SAFE to re-run — it deletes the old demo data first.
 */

require('dotenv').config({ path: '.env.test' });
const mongoose = require('mongoose');
const https = require('https');

const {
  User,
  InfluencerProfile,
  Brand,
  BrandProfile,
  Partnership,
  ContentSubmission,
  Notification,
} = require('../src/models');

// ─── Config ──────────────────────────────────────────────────────────────────
const DEMO_EMAIL    = 'demo@keepuspostd.com';
const DEMO_PASSWORD = 'KupDemo2024!';
const DEMO_HANDLE   = 'demoreviewer';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** POST to Firebase Auth REST API */
function firebasePost(path, body) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.FIREBASE_API_KEY;
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname: 'identitytoolkit.googleapis.com',
        path: `/v1/accounts:${path}?key=${apiKey}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          const parsed = JSON.parse(raw);
          if (parsed.error) reject(new Error(parsed.error.message));
          else resolve(parsed);
        });
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function getOrCreateFirebaseUser() {
  // Try sign-in first (user already exists)
  try {
    const result = await firebasePost('signInWithPassword', {
      email: DEMO_EMAIL,
      password: DEMO_PASSWORD,
      returnSecureToken: true,
    });
    console.log(`  Found existing Firebase user: ${result.localId}`);
    return result.localId;
  } catch (_) {}

  // Create new user
  const result = await firebasePost('signUp', {
    email: DEMO_EMAIL,
    password: DEMO_PASSWORD,
    returnSecureToken: true,
  });
  console.log(`  Created Firebase user: ${result.localId}`);
  return result.localId;
}

async function clearOldDemoData(firebaseUid) {
  const user = await User.findOne({ firebaseUid });
  if (!user) return null;

  const profile = await InfluencerProfile.findOne({ userId: user._id });
  if (profile) {
    await Partnership.deleteMany({ influencerProfileId: profile._id });
    await ContentSubmission.deleteMany({ influencerProfileId: profile._id });
    await Notification.deleteMany({ userId: user._id });
    await profile.deleteOne();
  }
  await user.deleteOne();

  // Remove old demo brand
  const brand = await Brand.findOne({ name: 'The Local Café' });
  if (brand) {
    await BrandProfile.deleteMany({ brandId: brand._id });
    await brand.deleteOne();
  }

  console.log('  Cleared old demo data');
  return null;
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🌱  Seeding demo account...\n');

  await mongoose.connect(process.env.MONGODB_URI, {
    dbName: process.env.MONGODB_DB_NAME || 'keepuspostd_test',
  });
  console.log('  Connected to MongoDB');

  // 1. Firebase user
  const firebaseUid = await getOrCreateFirebaseUser();

  // 2. Clear old records
  await clearOldDemoData(firebaseUid);

  // 3. MongoDB User
  const user = await User.create({
    firebaseUid,
    email: DEMO_EMAIL,
    firstName: 'Demo',
    lastName: 'Reviewer',
    profileType: 'influencer',
  });
  console.log(`  Created User: ${user._id}`);

  // 4. InfluencerProfile
  const profile = await InfluencerProfile.create({
    userId: user._id,
    displayName: 'Demo Reviewer',
    handle: DEMO_HANDLE,
    bio: 'App Store review account — used for App Review testing.',
    avatarUrl: null,
    influenceTier: 'micro',
    realFollowerCount: 12000,
    influenceScore: 62,
    isVerified: true,
    verifiedAt: new Date(),
    creatorTier: 'verified_reviewer',
    totalReviews: 5,
    adminBrandReviews: 3,
    campaignAccessUnlocked: true,
    totalBrandsPartnered: 1,
    totalPointsEarned: 850,
    totalCashEarned: 24.50,
    averageRating: 4.6,
    ratingCount: 3,
    socialLinks: new Map([
      ['instagram', 'demoreviewer'],
      ['tiktok', 'demoreviewer'],
    ]),
    paypalEmail: 'demo-paypal@keepuspostd.com',
    paypalConnectedAt: new Date(),
    referralCode: 'DEMO2024',
  });
  console.log(`  Created InfluencerProfile: @${profile.handle}`);

  // 5. Demo Brand
  const brand = await Brand.create({
    name: 'The Local Café',
    initials: 'TL',
    generatedColor: '#5B3A2A',
    category: 'Food & Beverage',
    description: 'A warm neighbourhood café serving specialty coffee and seasonal pastries.',
    website: 'https://keepuspostd.com',
    kioskBrandCode: 'demo-cafe',
    brandColors: { primary: '#5B3A2A', secondary: '#D4A96A' },
    isActive: true,
    isVerified: true,
    createdBy: user._id,
  });
  console.log(`  Created Brand: ${brand.name}`);

  await BrandProfile.create({
    userId: user._id,
    primaryBrandId: brand._id,
    ownedBrandIds: [brand._id],
    onboardingComplete: true,
    trialActive: true,
    trialTier: 'pro',
    trialStartedAt: new Date(),
    trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
  });

  // 6. Active partnership
  const partnership = await Partnership.create({
    brandId: brand._id,
    influencerProfileId: profile._id,
    status: 'active',
    source: 'discovery',
    totalSubmissions: 2,
    totalApproved: 2,
    totalCashEarned: 24.50,
    totalPointsEarned: 850,
    startedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000),
  });
  console.log(`  Created Partnership: ${partnership._id}`);

  // 7. Approved content submission (shows in Watch Feed)
  await ContentSubmission.create({
    brandId: brand._id,
    influencerProfileId: profile._id,
    partnershipId: partnership._id,
    userId: user._id,
    contentType: 'video',
    mediaUrls: [],
    caption: 'The cortado at The Local Café is unreal ☕ Highly recommend stopping by.',
    status: 'approved',
    pointsAwarded: 450,
    cashAwarded: 12.50,
    submittedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
    reviewedAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000),
  });
  console.log('  Created approved ContentSubmission');

  // 8. Activity notifications (so Activity screen has content)
  await Notification.insertMany([
    {
      userId: user.firebaseUid,
      type: 'content',
      title: 'Content Approved! 🎉',
      message: 'Your review for The Local Café was approved. You earned 450 points ($12.50).',
      isRead: false,
      metadata: { brandId: brand._id.toString(), points: 450, cash: 12.50 },
      createdAt: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000),
    },
    {
      userId: user.firebaseUid,
      type: 'account',
      title: 'Social Verified ✅',
      message: 'Your social accounts were verified. You\'re now a Micro Influencer!',
      isRead: false,
      metadata: { tier: 'micro', followers: 12000 },
      createdAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
    },
  ]);
  console.log('  Created Activity notifications');

  // ─── Summary ───────────────────────────────────────────────────────────────
  console.log('\n✅  Demo account ready!\n');
  console.log('  ┌─────────────────────────────────────────────┐');
  console.log(`  │  Email    : ${DEMO_EMAIL.padEnd(33)}│`);
  console.log(`  │  Password : ${DEMO_PASSWORD.padEnd(33)}│`);
  console.log('  ├─────────────────────────────────────────────┤');
  console.log('  │  Enter these in App Store Connect:          │');
  console.log('  │  App Review Info → Demo Account             │');
  console.log('  │                                             │');
  console.log('  │  And Google Play Console:                   │');
  console.log('  │  App content → App access → Add login info  │');
  console.log('  └─────────────────────────────────────────────┘\n');

  await mongoose.disconnect();
  process.exit(0);
}

main().catch(err => {
  console.error('\n❌ Seed failed:', err.message);
  process.exit(1);
});
