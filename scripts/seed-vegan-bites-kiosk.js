/**
 * seed-vegan-bites-kiosk.js
 * ─────────────────────────────────────────────────────────────
 * Seeds 8 approved video reviews for the Vegan Bites brand
 * so the kiosk display reel has content to loop.
 * Uses the same Google Drive video URLs as the Pure Juice seed.
 *
 * Run: node scripts/seed-vegan-bites-kiosk.js
 * Safe to re-run — idempotent.
 * ─────────────────────────────────────────────────────────────
 */

require('dotenv').config({ path: '.env.production' });
const mongoose = require('mongoose');

const User              = require('../src/models/User');
const InfluencerProfile = require('../src/models/InfluencerProfile');
const Brand             = require('../src/models/Brand');
const ContentSubmission = require('../src/models/ContentSubmission');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb+srv://kup_admin:opC9nABk3MUrcmt1@kup-test.vnix9or.mongodb.net/keepuspostd_production';

// Same Google Drive video IDs used in the Pure Juice seed
const DRIVE_FILE_IDS = [
  '1eUbgokBZhAva61cSJfXW1vLQ8zi3oUy4',
  '1q9e7C-fEeiIDLBOcZnVd1FykfJqwZnMw',
  '1yGZDDrLuPtXr_6-ILDWRD6-W5uINdGEX',
  '1ua3z8cAFWbelIZTU5i0rBcNwdxE5iG_7',
  '1lnYwXuleZnn1zuCCpntxgY9IKBGTn2ia',
  '1TtxoYn1TNiDeEmbLhu5rpbpeMpcNDowT',
  '10H7OrhYfxGP3tZX6FzxTPl02CyJVBkzp',
  '1meDd0YDUstG1xgZSfqZkjo8JYlRyvjL6',
];

const driveUrl = (id) =>
  `https://drive.usercontent.google.com/download?id=${id}&export=download&authuser=0&confirm=t`;

const CAPTIONS = [
  'The mango-pineapple smoothie bowl is everything 🥭🍍 fresh, plant-based, and absolutely delicious!',
  'Finally a vegan spot that actually tastes amazing. The green goddess bowl is 🔥 — already planning my next visit.',
  'Tried the daily wellness shot and I\'m obsessed. Ginger + turmeric — Vegan Bites knows what they\'re doing!',
  'The acai bowl is massive, beautiful, and SO good 😍 Perfect post-workout fuel right here.',
  'Can\'t stop thinking about the tropical blend. Fresh ingredients, fast service, great vibes ✨',
  'First visit and I\'m already a regular. The watermelon mint bowl is incredible. Zero regrets!',
  'Grabbed the immunity booster before a long week. Honestly felt the difference. Vegan Bites is legit 💪',
  'Vegan Bites is the spot for real whole-food nutrition. Everything I tried was fresh and delicious. Highly recommend!',
];

async function main() {
  console.log('🌱 Seeding Vegan Bites kiosk demo reviews...\n');
  await mongoose.connect(MONGODB_URI);
  console.log('✅ Connected to MongoDB\n');

  // 1. Find Santana's brand by kioskBrandCode
  let brand = await Brand.findOne({ kioskBrandCode: 'KUP-QG3PUT' });
  if (!brand) {
    console.error('❌ Could not find brand with kioskBrandCode KUP-QG3PUT.');
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`✅ Found brand: "${brand.name}" (${brand._id})`);

  // 2. Find or create demo influencer
  let demoUser = await User.findOne({ email: 'kupreviewdemo@keepuspostd.com' });
  if (!demoUser) {
    demoUser = await User.create({
      email: 'kupreviewdemo@keepuspostd.com',
      authProvider: 'email',
      hasInfluencerProfile: true,
      onboardingComplete: true,
      status: 'active',
    });
    console.log(`✅ Created demo user (${demoUser._id})`);
  } else {
    console.log(`ℹ️  Demo user exists (${demoUser._id})`);
  }

  let influencer = await InfluencerProfile.findOne({ userId: demoUser._id });
  if (!influencer) {
    influencer = await InfluencerProfile.create({
      userId: demoUser._id,
      displayName: 'KUP Reviewer',
      handle: 'kupreviewer',
      bio: 'Official KUP platform reviewer — real reviews, real brands.',
      influenceTier: 'nano',
      creatorTier: 'reviewer',
      isVerified: true,
    });
    console.log(`✅ Created influencer @${influencer.handle}`);
  } else {
    console.log(`ℹ️  Influencer @${influencer.handle} exists`);
  }

  console.log('');

  // 3. Seed ContentSubmission records for Vegan Bites
  let created = 0;
  let skipped = 0;

  for (let i = 0; i < DRIVE_FILE_IDS.length; i++) {
    const videoUrl = driveUrl(DRIVE_FILE_IDS[i]);

    // Idempotency — skip if already seeded for this brand
    const existing = await ContentSubmission.findOne({
      brandId: brand._id,
      mediaUrls: videoUrl,
    });
    if (existing) {
      console.log(`⏭️  Skipping video ${i + 1} (already seeded for this brand)`);
      skipped++;
      continue;
    }

    const daysAgo   = 7 - i;
    const submitted = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    const reviewed  = new Date(submitted.getTime() + 30 * 60 * 1000);

    await ContentSubmission.create({
      influencerProfileId: influencer._id,
      brandId:             brand._id,
      contentType:         'video',
      caption:             CAPTIONS[i],
      mediaUrls:           [videoUrl],
      originalMediaUrls:   [videoUrl],
      status:              'approved',
      submittedAt:         submitted,
      reviewedAt:          reviewed,
      metrics: {
        likes:    Math.floor(Math.random() * 40) + 10,
        comments: Math.floor(Math.random() * 12) + 2,
        shares:   Math.floor(Math.random() * 8),
        views:    Math.floor(Math.random() * 200) + 50,
      },
    });

    console.log(`✅ Seeded video ${i + 1}/8`);
    created++;
  }

  if (created > 0) {
    await Brand.findByIdAndUpdate(brand._id, {
      $inc: { totalReviews: created, totalContentPieces: created },
    });
    console.log(`\n📊 Updated brand stats (+${created} reviews)`);
  }

  console.log('\n─────────────────────────────────────────────');
  console.log(`🎉 Done! Created: ${created}, Skipped: ${skipped}`);
  console.log(`   Brand: "${brand.name}" (${brand._id})`);
  console.log('─────────────────────────────────────────────');

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('❌ Seed failed:', err.message);
  process.exit(1);
});
