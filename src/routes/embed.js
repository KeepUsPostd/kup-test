// Embed Routes — Instant Review Widget (public, no auth required)
//
// Powers the "Instant Review Widget" — a zero-friction video review capture
// flow embedded on a brand's own website. Anyone can leave a video review
// without downloading the KeepUsPostd app.
//
// Public endpoints:
//   GET  /api/embed/:brandCode/config   — brand info + reward preview for the widget page
//   POST /api/embed/:brandCode/submit   — full submission: name+email+video → auto-register + review
//
// Design principles:
//   1. NEVER trust client-supplied identity — always resolve brand server-side
//   2. Auto-created users get authMethod:'embed' so they can be merged into
//      a real account when they later download the app with the same email
//   3. Uses the SAME ContentSubmission pipeline as the app — no new moderation
//      workflow needed. Brands see embed reviews in their normal queue,
//      differentiated by source:'embed'.
//   4. Rate limited + captcha-guarded to prevent abuse
//
// Refs: memory/project_kup_instant_review_widget.md

const express = require('express');
const router = express.Router();
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const {
  Brand,
  BrandProfile,
  User,
  InfluencerProfile,
  Partnership,
  ContentSubmission,
  Reward,
} = require('../models');

const APP_URL = process.env.APP_URL || 'https://keepuspostd.com';

// ── R2 (Cloudflare) upload config — mirrors src/routes/upload.js so embed
// uploads land in the same bucket as app-path uploads and get served from the
// same CDN URL. If R2 isn't configured, we fall back to local disk so the
// endpoint still works in development.
const R2_CONFIGURED = !!(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_ENDPOINT);
const r2Client = R2_CONFIGURED
  ? new S3Client({
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
      },
    })
  : null;
const R2_BUCKET = process.env.R2_BUCKET || 'keepuspostd-uploads';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || '';

const embedUploadsDir = path.join(__dirname, '..', '..', 'uploads', 'embed');
if (!fs.existsSync(embedUploadsDir)) fs.mkdirSync(embedUploadsDir, { recursive: true });

const uploadStorage = multer.diskStorage({
  destination: embedUploadsDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.mp4';
    const uniqueName = `embed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    cb(null, uniqueName);
  },
});

// Embed uploads capped smaller than app uploads. A 3-minute phone recording
// at 720p 30fps is ~60-120MB (VP9 webm) or ~90-180MB (H.264 mp4), so 200MB
// gives ample headroom for 3-min clips while keeping abuse + Railway temp-
// disk usage bounded. Env-tunable so we can dial down if needed.
const EMBED_MAX_UPLOAD_MB = parseInt(process.env.EMBED_MAX_UPLOAD_MB, 10) || 200;

const embedUploader = multer({
  storage: uploadStorage,
  limits: {
    fileSize: EMBED_MAX_UPLOAD_MB * 1024 * 1024,
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('video/')) cb(null, true);
    else cb(new Error('Only video files are allowed'));
  },
});

// ── Rate limiter — protect the public embed endpoints from abuse
// Per IP: max 5 submissions per 15 minutes.
const embedSubmitLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: {
    error: 'too_many_requests',
    message: 'Please wait a few minutes before submitting another review.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Helper: resolve a brandCode (KUP-XXXXXX) OR @handle to a Brand doc
async function resolveBrand(brandCode) {
  if (!brandCode) return null;
  const code = brandCode.replace(/^@/, '').trim();
  const selectFields = 'name initials generatedColor brandColors logoUrl heroImageUrl description category websiteUrl kioskBrandCode brandHandle ownerId claimStatus brandType status';

  // ObjectId lookup
  if (/^[a-f0-9]{24}$/i.test(code)) {
    const byId = await Brand.findById(code).select(selectFields).lean();
    if (byId) return byId;
  }

  // Kiosk brand code OR @handle
  return Brand.findOne({
    $or: [
      { kioskBrandCode: code.toUpperCase() },
      { brandHandle: code.toLowerCase() },
    ],
  }).select(selectFields).lean();
}

// ── Helper: get the current-month approval count for a brand
// Used to enforce the monthly approval cap (Phase 2). For now returns count
// only — enforcement wires in when the cap logic lands.
async function getCurrentMonthApprovals(brandId) {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  return ContentSubmission.countDocuments({
    brandId,
    status: 'approved',
    reviewedAt: { $gte: startOfMonth },
  });
}

// ── Helper: pull the primary active reward for a brand (for widget preview)
async function getFeaturedReward(brandId) {
  return Reward.findOne({
    brandId,
    status: 'active',
  })
    .sort({ createdAt: -1 })
    .select('rewardType title description value pointsRequired imageUrl')
    .lean();
}

// ── Helper: generate a unique handle from name+email
function generateHandleSeed(fullName, email) {
  const nameSeed = (fullName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const emailSeed = (email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  const base = nameSeed || emailSeed || 'reviewer';
  return base.substring(0, 15);
}

async function generateUniqueHandle(seed) {
  let handle = seed;
  let attempt = 0;
  // eslint-disable-next-line no-await-in-loop
  while (await InfluencerProfile.exists({ handle })) {
    attempt += 1;
    handle = `${seed}${Math.floor(Math.random() * 9000) + 1000}`;
    if (attempt > 5) {
      handle = `${seed}${Date.now().toString().slice(-6)}`;
      break;
    }
  }
  return handle;
}

// ══════════════════════════════════════════════
// GET /api/embed/:brandCode/config
// Public. Returns the brand info + reward + stats needed to render the
// Instant Review Widget page. No auth. Safe to call from any origin.
// ══════════════════════════════════════════════
router.get('/:brandCode/config', async (req, res) => {
  try {
    const brand = await resolveBrand(req.params.brandCode);
    if (!brand) {
      return res.status(404).json({ error: 'brand_not_found', message: 'This brand does not exist on KeepUsPostd.' });
    }
    if (brand.status && brand.status !== 'active') {
      return res.status(404).json({ error: 'brand_inactive', message: 'This brand is not currently accepting reviews.' });
    }

    // Check widget-enabled flag on the brand's profile
    let widgetEnabled = true;
    if (brand.ownerId) {
      const profile = await BrandProfile.findOne({ ownedBrandIds: brand._id })
        .select('embedWidgetEnabled')
        .lean();
      if (profile && profile.embedWidgetEnabled === false) {
        widgetEnabled = false;
      }
    }
    if (!widgetEnabled) {
      return res.status(403).json({
        error: 'widget_disabled',
        message: 'This brand has not enabled instant reviews.',
      });
    }

    // Rollup counts for social proof on the widget page
    const [reviewCount, reward] = await Promise.all([
      ContentSubmission.countDocuments({ brandId: brand._id, status: { $in: ['approved', 'postd'] } }),
      getFeaturedReward(brand._id),
    ]);

    return res.json({
      brand: {
        id: brand._id,
        name: brand.name,
        initials: brand.initials,
        brandColor: brand.generatedColor || (brand.brandColors && brand.brandColors.primary) || '#2EA5DD',
        logoUrl: brand.logoUrl,
        heroImageUrl: brand.heroImageUrl,
        description: brand.description,
        category: brand.category,
        websiteUrl: brand.websiteUrl,
        kioskBrandCode: brand.kioskBrandCode,
        brandHandle: brand.brandHandle,
      },
      reward: reward
        ? {
            type: reward.rewardType,
            title: reward.title,
            description: reward.description,
            value: reward.value,
            pointsRequired: reward.pointsRequired,
            imageUrl: reward.imageUrl,
          }
        : null,
      stats: {
        approvedReviews: reviewCount,
      },
      // Widget-specific configuration (Phase 3.1):
      //   maxDurationSeconds — hard cap on video length. Uniform across all
      //     brands for now (3 minutes) but exposed here so we can vary by
      //     brand later if needed without a re-deploy of the web page.
      //   reviewBriefing — optional brand-authored guidance shown right below
      //     the reward. Sourced from Brand.description as a sensible default;
      //     later phases can promote this to a dedicated BrandProfile field.
      widget: {
        maxDurationSeconds: 180,
        reviewBriefing: brand.description || null,
      },
    });
  } catch (err) {
    console.error('[GET /api/embed/:brandCode/config]', err.message);
    return res.status(500).json({ error: 'server_error', message: 'Could not load brand.' });
  }
});

// ══════════════════════════════════════════════
// POST /api/embed/:brandCode/upload
// Public. Accepts a single video file (multipart/form-data field "video"),
// uploads it to R2, returns { mediaUrl }. The client then includes that URL
// in the follow-up POST /submit call. Split into two endpoints so the video
// blob upload can be retried independently of the metadata submit.
// Same 15-min window / 5 uploads per IP as the submit endpoint.
// ══════════════════════════════════════════════
const embedUploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: {
    error: 'too_many_requests',
    message: 'Please wait a few minutes before uploading another video.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

router.post(
  '/:brandCode/upload',
  embedUploadLimiter,
  (req, res, next) => {
    embedUploader.single('video')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({
            error: 'file_too_large',
            message: `Video is too large. Maximum size is ${EMBED_MAX_UPLOAD_MB}MB.`,
          });
        }
        return res.status(400).json({ error: 'upload_failed', message: err.message });
      }
      next();
    });
  },
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: 'missing_file', message: 'No video file uploaded.' });
      }

      // Resolve brand — same validation as /submit so bad brandCodes reject early.
      const brand = await resolveBrand(req.params.brandCode);
      if (!brand) {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
        return res.status(404).json({ error: 'brand_not_found', message: 'This brand does not exist on KeepUsPostd.' });
      }

      let mediaUrl;
      if (r2Client) {
        // Upload to R2 (same bucket + public URL as app-path uploads)
        const buffer = fs.readFileSync(req.file.path);
        await r2Client.send(new PutObjectCommand({
          Bucket: R2_BUCKET,
          Key: req.file.filename,
          Body: buffer,
          ContentType: req.file.mimetype || 'video/mp4',
        }));
        mediaUrl = R2_PUBLIC_URL ? `${R2_PUBLIC_URL}/${req.file.filename}` : `/uploads/embed/${req.file.filename}`;
        try { fs.unlinkSync(req.file.path); } catch (_) {}
      } else {
        // Dev fallback — serve from local uploads dir. Not for production.
        mediaUrl = `${APP_URL}/uploads/embed/${req.file.filename}`;
      }

      console.log(`📤 [embed] Video uploaded for brand ${brand._id}: ${mediaUrl}`);
      return res.status(201).json({ ok: true, mediaUrl });
    } catch (err) {
      console.error('[POST /api/embed/:brandCode/upload]', err.message);
      try { if (req.file?.path) fs.unlinkSync(req.file.path); } catch (_) {}
      return res.status(500).json({ error: 'server_error', message: 'Could not upload video. Please try again.' });
    }
  }
);

// ══════════════════════════════════════════════
// POST /api/embed/:brandCode/submit
// Public. The one-and-done submission endpoint:
//   1. Validate input (name, email, mediaUrls)
//   2. Resolve brand (kiosk-code or handle)
//   3. Find-or-create User (email match) with authMethod:'embed' when new
//   4. Find-or-create InfluencerProfile (unique handle)
//   5. Find-or-create Partnership (brand ↔ influencer)
//   6. Create ContentSubmission with source:'embed'
//   7. Trigger the normal brand-notification pipeline
// Video upload itself goes through the standard /api/upload endpoint first
// (client uploads the blob to R2, gets back a URL, then hits this endpoint
// with { mediaUrls: [url], posterUrl }).
// ══════════════════════════════════════════════
router.post('/:brandCode/submit', embedSubmitLimiter, async (req, res) => {
  try {
    const {
      fullName,
      email,
      mediaUrls,
      posterUrl,
      caption,
      brandLocationId,
      captureLat,
      captureLon,
      agreedToTerms,
    } = req.body || {};

    // ── Input validation
    if (!fullName || typeof fullName !== 'string' || fullName.trim().length < 2) {
      return res.status(400).json({ error: 'invalid_name', message: 'Please enter your full name.' });
    }
    if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'invalid_email', message: 'Please enter a valid email address.' });
    }
    if (!mediaUrls || !Array.isArray(mediaUrls) || mediaUrls.length === 0) {
      return res.status(400).json({ error: 'missing_media', message: 'Please record a review video before submitting.' });
    }
    if (agreedToTerms !== true) {
      return res.status(400).json({ error: 'terms_required', message: 'Please agree to the terms before submitting.' });
    }

    const normalizedEmail = email.toLowerCase().trim();
    const cleanName = fullName.trim().substring(0, 60);

    // ── Resolve brand
    const brand = await resolveBrand(req.params.brandCode);
    if (!brand) {
      return res.status(404).json({ error: 'brand_not_found', message: 'This brand does not exist on KeepUsPostd.' });
    }

    // Check widget-enabled flag
    if (brand.ownerId) {
      const profile = await BrandProfile.findOne({ ownedBrandIds: brand._id })
        .select('embedWidgetEnabled')
        .lean();
      if (profile && profile.embedWidgetEnabled === false) {
        return res.status(403).json({
          error: 'widget_disabled',
          message: 'This brand has paused instant reviews.',
        });
      }
    }

    // ── Find or create the User
    let user = await User.findOne({ email: normalizedEmail });
    let userWasCreated = false;
    if (!user) {
      const [legalFirstName, ...rest] = cleanName.split(/\s+/);
      user = await User.create({
        email: normalizedEmail,
        legalFirstName: legalFirstName || cleanName,
        legalLastName: rest.length ? rest.join(' ') : null,
        authMethod: 'embed',
        authProvider: 'email',
        status: 'active',
        // No passwordHash + no firebaseUid — user claims account on app signup
      });
      userWasCreated = true;
    }

    // ── Find or create the InfluencerProfile
    let influencerProfile = await InfluencerProfile.findOne({ userId: user._id });
    if (!influencerProfile) {
      const seed = generateHandleSeed(cleanName, normalizedEmail);
      const uniqueHandle = await generateUniqueHandle(seed);
      influencerProfile = await InfluencerProfile.create({
        userId: user._id,
        displayName: cleanName,
        handle: uniqueHandle,
      });
    }

    // ── Find or create the Partnership (brand ↔ influencer)
    let partnership = await Partnership.findOne({
      brandId: brand._id,
      influencerProfileId: influencerProfile._id,
    });
    if (!partnership) {
      partnership = await Partnership.create({
        brandId: brand._id,
        influencerProfileId: influencerProfile._id,
        status: 'active',
        startedAt: new Date(),
      });
    } else if (partnership.status === 'ended') {
      partnership.status = 'active';
      partnership.startedAt = new Date();
      partnership.endedAt = null;
      partnership.endedBy = null;
      await partnership.save();
    }

    // ── Create the ContentSubmission with source:'embed'
    const submission = await ContentSubmission.create({
      influencerProfileId: influencerProfile._id,
      brandId: brand._id,
      partnershipId: partnership._id,
      contentType: 'video',
      caption: (caption || '').substring(0, 500) || null,
      mediaUrls,
      posterUrl: posterUrl || null,
      status: 'submitted',
      submittedAt: new Date(),
      source: 'embed',
      brandLocationId: brandLocationId || null,
      captureLat: typeof captureLat === 'number' ? captureLat : null,
      captureLon: typeof captureLon === 'number' ? captureLon : null,
    });

    // ── Increment counters (mirrors the standard content-submit flow)
    await Partnership.findByIdAndUpdate(partnership._id, { $inc: { totalSubmissions: 1 } });
    await InfluencerProfile.findByIdAndUpdate(influencerProfile._id, { $inc: { totalReviews: 1 } });

    console.log(`📸 [embed] Content submitted for brand ${brand._id} — user ${user._id} (${userWasCreated ? 'NEW' : 'existing'})`);

    // ── Notifications
    // Reuses the same notification helpers as the app submission flow. Wrapped
    // in try/catch — a notification failure must NEVER hold up the submission.
    try {
      const notify = require('../services/notifications');
      if (typeof notify.contentSubmittedToBrand === 'function') {
        notify.contentSubmittedToBrand({ influencer: influencerProfile, brand, submission }).catch(() => {});
      }
    } catch (e) {
      console.error('[embed submit] notify error (non-fatal):', e.message);
    }

    return res.status(201).json({
      ok: true,
      submissionId: submission._id,
      brand: {
        name: brand.name,
        kioskBrandCode: brand.kioskBrandCode,
      },
      user: {
        email: user.email,
        wasCreated: userWasCreated,
        needsClaim: user.authMethod === 'embed' && !user.passwordHash && !user.firebaseUid,
      },
      nextSteps: {
        confirmationEmailSent: false, // Phase 5 will wire this up
        downloadAppUrl: `${APP_URL}/download`,
        claimAccountUrl: `${APP_URL}/claim?email=${encodeURIComponent(user.email)}`,
      },
    });
  } catch (err) {
    console.error('[POST /api/embed/:brandCode/submit]', err.message, err.stack);
    return res.status(500).json({ error: 'server_error', message: 'Something went wrong. Please try again.' });
  }
});

module.exports = router;
