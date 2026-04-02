/**
 * seed-pure-juice-reviews.js
 * ─────────────────────────────────────────────────────────────
 * Seeds 8 approved video reviews for "The Pure Juice Joint" brand.
 * Videos are sourced from Google Drive (publicly shared).
 * Run ONCE from the kup-test directory:
 *   node scripts/seed-pure-juice-reviews.js
 *
 * Safe to re-run — idempotent (skips records that already exist).
 * ─────────────────────────────────────────────────────────────
 */

require('dotenv').config({ path: '.env.production' });
const mongoose = require('mongoose');

// ── Models ─────────────────────────────────────────────────────
const User              = require('../src/models/User');
const InfluencerProfile = require('../src/models/InfluencerProfile');
const Brand             = require('../src/models/Brand');
const ContentSubmission = require('../src/models/ContentSubmission');

// ── Google Drive video IDs (8 real review videos) ──────────────
// Public shared files → streamable via drive.usercontent.google.com
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

// Build streamable direct-download URL (public files, no auth needed)
const driveUrl = (id) =>
  `https://drive.usercontent.google.com/download?id=${id}&export=download&authuser=0&confirm=t`;

// ── Review copy for each video ──────────────────────────────────
const CAPTIONS = [
  'The mango-pineapple blend hits different 🥭🍍 fresh, cold-pressed, and no added sugar. This is my new go-to spot!',
  'Finally found a juice bar that actually uses real fruit. The green detox bowl was 🔥 — definitely coming back.',
  'Tried the daily wellness shot and wow. Ginger + turmeric combo is no joke. Pure Juice Joint knows what they\'re doing!',
  'The acai bowl is massive and so beautiful 😍 Tastes as good as it looks. Perfect post-workout fuel.',
  'Can\'t stop thinking about their tropical sunset blend. Fresh ingredients, fast service, great vibes ✨',
  'First time here and I\'m already a regular. The watermelon mint cooler is incredible. Zero regrets!',
  'Grabbed the immunity booster before a long week. Honestly felt the difference. Pure Juice Joint is legit 💪',
  'The Pure Juice Joint is the spot for real whole-food nutrition. Everything I tried was fresh and delicious. Highly recommend!',
];

// ── Placeholder influencer config ───────────────────────────────
const DEMO_USER = {
  email:               'kupreviewdemo@keepuspostd.com',
  authProvider:        'email',
  hasInfluencerProfile: true,
  onboardingComplete:   true,
  status:              'active',
};

const DEMO_INFLUENCER = {
  displayName:  'KUP Reviewer',
  handle:       'kupreviewer',
  bio:          'Official KUP platform reviewer — real reviews, real brands.',
  influenceTier: 'nano',
  creatorTier:   'reviewer',
  isVerified:    true,
};

// ── Brand config ────────────────────────────────────────────────
const BRAND_NAME = 'The Pure Juice Joint';
const BRAND_CONFIG = {
  name:          BRAND_NAME,
  brandType:     'admin',
  profileSource: 'manual',
  createdBy:     'platform',
  claimStatus:   'unclaimed',
  category:      'Food & Beverage',
  subcategory:   'Juice Bar',
  description:   'Cold-pressed juices, smoothies, and wellness bowls made with real whole-food ingredients.',
  generatedColor:'#2ECC71',
  initials:      'TPJ',
  brandColors: {
    primary:   '#2ECC71',
    secondary: '#27AE60',
  },
  status: 'active',
};

// ── Main ────────────────────────────────────────────────────────
async function main() {
  console.log('🥤 Seeding Pure Juice Joint reviews...\n');

  await mongoose.connect(process.env.MONGODB_URI);
  console.log('✅ Connected to MongoDB\n');

  // ── 1. Find or create demo User ──────────────────────────────
  let demoUser = await User.findOne({ email: DEMO_USER.email });
  if (demoUser) {
    console.log(`ℹ️  Demo user already exists: ${demoUser.email} (${demoUser._id})`);
  } else {
    demoUser = await User.create(DEMO_USER);
    console.log(`✅ Created demo user: ${demoUser.email} (${demoUser._id})`);
  }

  // ── 2. Find or create InfluencerProfile ─────────────────────
  let influencer = await InfluencerProfile.findOne({ userId: demoUser._id });
  if (influencer) {
    console.log(`ℹ️  Influencer profile already exists: @${influencer.handle} (${influencer._id})`);
  } else {
    influencer = await InfluencerProfile.create({
      ...DEMO_INFLUENCER,
      userId: demoUser._id,
    });
    console.log(`✅ Created influencer profile: @${influencer.handle} (${influencer._id})`);
  }

  // ── 3. Find or create The Pure Juice Joint brand ─────────────
  let brand = await Brand.findOne({ name: BRAND_NAME });
  if (brand) {
    console.log(`ℹ️  Brand already exists: "${brand.name}" (${brand._id})`);
  } else {
    brand = await Brand.create(BRAND_CONFIG);
    console.log(`✅ Created brand: "${brand.name}" (${brand._id})`);
  }

  console.log('');

  // ── 4. Seed 8 ContentSubmission records ─────────────────────
  let created = 0;
  let skipped = 0;

  for (let i = 0; i < DRIVE_FILE_IDS.length; i++) {
    const videoUrl = driveUrl(DRIVE_FILE_IDS[i]);
    const caption  = CAPTIONS[i];

    // Idempotency check — skip if this exact URL is already seeded
    const existing = await ContentSubmission.findOne({ mediaUrls: videoUrl });
    if (existing) {
      console.log(`⏭️  Skipping video ${i + 1} (already seeded)`);
      skipped++;
      continue;
    }

    // Stagger submittedAt/reviewedAt so they appear as different uploads
    const daysAgo    = 7 - i; // most recent last
    const submitted  = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    const reviewed   = new Date(submitted.getTime() + 30 * 60 * 1000); // approved 30min later

    const submission = await ContentSubmission.create({
      influencerProfileId: influencer._id,
      brandId:             brand._id,
      contentType:         'video',
      caption,
      mediaUrls:           [videoUrl],
      originalMediaUrls:   [videoUrl],
      status:              'approved',
      submittedAt:         submitted,
      reviewedAt:          reviewed,
      metrics: {
        likes:    Math.floor(Math.random() * 40) + 10,   // 10–49
        comments: Math.floor(Math.random() * 12) + 2,    // 2–13
        shares:   Math.floor(Math.random() * 8),
        views:    Math.floor(Math.random() * 200) + 50,  // 50–249
      },
    });

    console.log(`✅ Seeded video ${i + 1}/8 → ${submission._id}`);
    created++;
  }

  // ── 5. Update brand stats ─────────────────────────────────────
  if (created > 0) {
    await Brand.findByIdAndUpdate(brand._id, {
      $inc: {
        totalReviews:       created,
        totalContentPieces: created,
      },
    });
    console.log(`\n📊 Updated brand stats (+${created} reviews)`);
  }

  // ── Summary ──────────────────────────────────────────────────
  console.log('\n─────────────────────────────────────────────');
  console.log(`🎉 Done! Created: ${created}, Skipped: ${skipped}`);
  console.log(`   Brand:      "${brand.name}" (${brand._id})`);
  console.log(`   Influencer: @${influencer.handle} (${influencer._id})`);
  console.log('─────────────────────────────────────────────');

  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('❌ Seed failed:', err.message);
  process.exit(1);
});
