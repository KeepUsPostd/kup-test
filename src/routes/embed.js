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
const { requireAuth } = require('../middleware/auth');
const {
  Brand,
  BrandProfile,
  BrandMember,
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

// Set of file extensions we accept for embed video uploads. Kept in sync
// with what MediaRecorder can produce across the major browsers.
const VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm', '.mkv', '.ogg', '.ogv']);

const embedUploader = multer({
  storage: uploadStorage,
  limits: {
    fileSize: EMBED_MAX_UPLOAD_MB * 1024 * 1024,
    files: 1,
  },
  // Accept the upload when EITHER the browser sends a proper video/* mimetype
  // OR the filename has a known video extension. Rationale:
  //   * Chrome/Firefox on desktop → mimetype "video/webm;codecs=vp9,opus" ✓
  //   * iOS Safari → MediaRecorder-produced blobs sometimes come through with
  //     an empty or 'application/octet-stream' mimetype even when the payload
  //     is genuine video. The client always names the file with a video
  //     extension though, so extension-based acceptance is the safety net.
  //   * Non-video uploads (e.g. someone hitting the endpoint with a JPEG)
  //     still get rejected because neither branch passes.
  fileFilter: (req, file, cb) => {
    const mimeOK = file.mimetype && file.mimetype.startsWith('video/');
    const ext = path.extname(file.originalname || '').toLowerCase();
    const extOK = VIDEO_EXTENSIONS.has(ext);
    if (mimeOK || extOK) return cb(null, true);
    return cb(new Error('Only video files are allowed'));
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

// ── Helper: is the caller a KUP platform admin?
// Same source of truth as brand-locations.js — ADMIN_EMAILS env var. Admins
// can read/edit any brand's widget config so they can help brands set up
// their widget without needing a per-brand grant.
function isPlatformAdmin(req) {
  const adminEmails = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const email = (req.user?.email || '').toLowerCase();
  return email && adminEmails.includes(email);
}

// ── Helper: is the caller an active member of this brand?
// Returns truthy on success, sends 403 + returns null on failure. Mirrors
// brand-locations.js's requireBrandMember so widget config auth behaves
// consistently with the locations, kiosk, and other brand-tool endpoints.
async function requireBrandMember(req, res, brandId) {
  if (isPlatformAdmin(req)) return { role: 'admin', platformAdmin: true };
  const member = await BrandMember.findOne({
    brandId,
    userId: req.user._id,
    status: 'active',
  }).lean();
  if (!member) {
    res.status(403).json({ error: 'forbidden', message: 'You do not have access to this brand.' });
    return null;
  }
  return member;
}

// ── Helper: resolve a brandCode (KUP-XXXXXX) OR @handle to a Brand doc
// Selects every field the widget config endpoint AND the submit endpoint
// need, so callers don't have to re-query for brandColors etc.
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
// Includes BOTH image fields: bannerImageUrl (the wide reward-card banner
// uploaded via brand-reward.html — what we want most of the time) AND
// imageUrl (legacy/small icon field, kept as fallback).
async function getFeaturedReward(brandId) {
  return Reward.findOne({
    brandId,
    status: 'active',
  })
    .sort({ createdAt: -1 })
    .select('rewardType title description value pointsRequired imageUrl bannerImageUrl')
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

// ══════════════════════════════════════════════════════════════════════
// BRAND-AUTHED CONFIG ENDPOINTS
// MUST be declared BEFORE the /:brandCode/... routes below — Express
// matches routes in registration order and /:brandCode/config would
// otherwise swallow /admin/config (with brandCode = 'admin').
//
// The brand-portal Instant Review Widget page reads + edits these fields
// on BrandProfile:
//   - embedWidgetEnabled  (Boolean, on/off toggle)
//   - reviewBriefing      (String, brand-authored guidance shown on the
//                          widget between the reward and the CTA)
// Payload also returns the widget's public URL + monthly-approval usage
// so the panel can render a copy-paste button, a QR code target, and a
// live usage counter without extra requests.
// ══════════════════════════════════════════════════════════════════════

// GET /api/embed/admin/config?brandId=<id>
router.get('/admin/config', requireAuth, async (req, res) => {
  try {
    const { brandId } = req.query;
    if (!brandId) return res.status(400).json({ error: 'missing_brand', message: 'brandId is required.' });

    const brand = await Brand.findById(brandId).select('name kioskBrandCode brandHandle ownerId').lean();
    if (!brand) return res.status(404).json({ error: 'brand_not_found', message: 'Brand not found.' });

    const member = await requireBrandMember(req, res, brand._id);
    if (!member) return; // 403 already sent

    const brandProfile = await BrandProfile.findOne({ ownedBrandIds: brand._id })
      .select('embedWidgetEnabled reviewBriefing embedApprovalsLifetime planTier trialActive trialTier trialEndsAt')
      .lean();

    // Effective monthly cap (Phase 2 shipped this — reuse the shared service).
    const { PLAN_LIMITS, currentMonthApprovalCount } = require('../services/planLimits');
    const { checkTrialStatus } = require('../services/trial');
    const effectiveTier = brandProfile ? checkTrialStatus(brandProfile).effectiveTier : 'starter';
    const monthlyCap = (PLAN_LIMITS[effectiveTier] || PLAN_LIMITS.starter).monthlyApprovals;
    const monthlyUsed = await currentMonthApprovalCount(brand._id);

    // Public widget URL — prefer the vanity handle when set, fall back to
    // the kiosk brand code so every brand always has a usable URL.
    const widgetPath = brand.brandHandle ? `/@${brand.brandHandle}/review` : `/brand/${brand.kioskBrandCode}/review`;
    const widgetUrl = `${APP_URL}${widgetPath}`;

    return res.json({
      brand: {
        id: brand._id,
        name: brand.name,
        kioskBrandCode: brand.kioskBrandCode,
        brandHandle: brand.brandHandle,
      },
      widget: {
        enabled: brandProfile ? brandProfile.embedWidgetEnabled !== false : true,
        reviewBriefing: (brandProfile && brandProfile.reviewBriefing) || '',
        url: widgetUrl,
      },
      usage: {
        lifetimeApprovals: (brandProfile && brandProfile.embedApprovalsLifetime) || 0,
        monthApprovalsUsed: monthlyUsed,
        monthApprovalsCap: monthlyCap,
        planTier: effectiveTier,
      },
    });
  } catch (err) {
    console.error('[GET /api/embed/admin/config]', err.message);
    return res.status(500).json({ error: 'server_error', message: 'Could not load widget config.' });
  }
});

// PUT /api/embed/admin/config
// Body: { brandId, enabled?, reviewBriefing? }
// Only the fields supplied are updated. Payload validated to prevent
// accidental clears (e.g. undefined vs empty string is meaningful).
router.put('/admin/config', requireAuth, async (req, res) => {
  try {
    const { brandId, enabled, reviewBriefing } = req.body || {};
    if (!brandId) return res.status(400).json({ error: 'missing_brand', message: 'brandId is required.' });

    const brand = await Brand.findById(brandId).select('_id').lean();
    if (!brand) return res.status(404).json({ error: 'brand_not_found', message: 'Brand not found.' });

    const member = await requireBrandMember(req, res, brand._id);
    if (!member) return; // 403 already sent

    const brandProfile = await BrandProfile.findOne({ ownedBrandIds: brand._id });
    if (!brandProfile) {
      return res.status(404).json({ error: 'brand_profile_not_found', message: 'This brand does not have a profile record.' });
    }

    // Coalesce updates — only touch what was actually sent.
    const update = {};
    if (typeof enabled === 'boolean') {
      update.embedWidgetEnabled = enabled;
    }
    if (typeof reviewBriefing === 'string') {
      // Truncate to schema cap (maxlength 1000). Empty string is allowed
      // — brands may want to clear a briefing back to the KUP default.
      update.reviewBriefing = reviewBriefing.slice(0, 1000);
    }

    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'no_updates', message: 'Nothing to update. Send enabled or reviewBriefing.' });
    }

    Object.assign(brandProfile, update);
    await brandProfile.save();

    console.log(`⚙️ [embed admin] Widget config updated for brand ${brand._id} by user ${req.user._id}`);

    return res.json({
      ok: true,
      widget: {
        enabled: brandProfile.embedWidgetEnabled !== false,
        reviewBriefing: brandProfile.reviewBriefing || '',
      },
    });
  } catch (err) {
    console.error('[PUT /api/embed/admin/config]', err.message);
    return res.status(500).json({ error: 'server_error', message: 'Could not save widget config.' });
  }
});

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

    // Load the brand's profile once — used for widget-enabled check AND
    // for reading brand-authored review briefing further down.
    let brandProfile = null;
    if (brand.ownerId) {
      brandProfile = await BrandProfile.findOne({ ownedBrandIds: brand._id })
        .select('embedWidgetEnabled reviewBriefing')
        .lean();
    }
    if (brandProfile && brandProfile.embedWidgetEnabled === false) {
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

    // Prefer explicit brandColors.primary; fall back to generatedColor;
    // fall back to KUP default blue. Same for secondary — used to build
    // a two-stop gradient on the reward banner client-side.
    const primaryColor =
      (brand.brandColors && brand.brandColors.primary) ||
      brand.generatedColor ||
      '#2EA5DD';
    const secondaryColor =
      (brand.brandColors && brand.brandColors.secondary) ||
      null; // client picks a sensible complement when null

    return res.json({
      brand: {
        id: brand._id,
        name: brand.name,
        initials: brand.initials,
        brandColor: primaryColor, // legacy — same as brandColors.primary
        brandColors: {
          primary: primaryColor,
          secondary: secondaryColor,
        },
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
            // Prefer bannerImageUrl (what brand-reward.html actually saves
            // when a brand uploads a reward image via the portal — the wide
            // banner asset). Fall back to imageUrl for legacy rewards that
            // used the older single-image field. Client renders whichever
            // is non-null; if both are null the widget shows the gradient
            // overlay layout.
            imageUrl: reward.bannerImageUrl || reward.imageUrl || null,
            _debug: process.env.NODE_ENV === 'production' ? {
              bannerImageUrl: reward.bannerImageUrl,
              imageUrl: reward.imageUrl,
            } : undefined,
          }
        : null,
      stats: {
        approvedReviews: reviewCount,
      },
      // Widget-specific configuration (Phase 3.1):
      //   maxDurationSeconds — hard cap on video length. Uniform across all
      //     brands for now (3 minutes) but exposed here so we can vary per
      //     brand later without a re-deploy of the web page.
      //   reviewBriefing — brand-authored guidance shown right below the
      //     reward. When a brand hasn't authored a custom brief we DO NOT
      //     fall back to Brand.description (that's marketing copy, not
      //     review guidance). Instead we return a KUP-authored default that
      //     tells the reviewer HOW to make a good review. Phase 4 adds a
      //     dedicated BrandProfile.reviewBriefing field editable from the
      //     brand portal so brands can override this default with their own.
      //   reviewBriefingIsDefault — true when we're returning the KUP
      //     default; false when a brand has authored their own. Lets the
      //     client render slightly different treatment (e.g. more subdued
      //     for the default).
      widget: {
        maxDurationSeconds: 180,
        // Brand-authored briefing takes precedence. When absent we return
        // a KUP-authored default that INCLUDES the brand's name — makes the
        // guidance feel written for this brand specifically rather than
        // generic UGC advice. Brands can override this entirely from the
        // portal (Phase 4).
        reviewBriefing: (brandProfile && brandProfile.reviewBriefing && brandProfile.reviewBriefing.trim())
          ? brandProfile.reviewBriefing.trim()
          : `Share your honest experience about ${brand.name} — a quick intro, what stood out, and why it mattered. Real reactions perform best.`,
        reviewBriefingIsDefault: !(brandProfile && brandProfile.reviewBriefing && brandProfile.reviewBriefing.trim()),
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
    let partnershipWasCreated = false;
    if (!partnership) {
      partnership = await Partnership.create({
        brandId: brand._id,
        influencerProfileId: influencerProfile._id,
        status: 'active',
        startedAt: new Date(),
      });
      partnershipWasCreated = true;
    } else if (partnership.status === 'ended') {
      partnership.status = 'active';
      partnership.startedAt = new Date();
      partnership.endedAt = null;
      partnership.endedBy = null;
      await partnership.save();
      partnershipWasCreated = true; // reactivation counts as a new partnership event
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
    // Reuses the same notification helpers as the app-path signup + submission
    // flows. All wrapped in try/catch — a notification failure must NEVER
    // hold up the submission. Fires (in order):
    //   1. New-user welcome email (only when the User was just created)
    //   2. Admin new-signup email to every ADMIN_EMAILS entry (only new users)
    //   3. New-brand-partnership email + in-app + push to the reviewer
    //      (only when the Partnership was just created)
    //   4. Content-submitted email + in-app + push to the brand owner
    const notify = require('../services/notifications');
    const { sendEmail } = require('../config/email');

    // 1 + 2 — welcome + admin new-signup notifications (only for new users)
    if (userWasCreated) {
      try {
        notify.influencerWelcome({ user }).catch(e => console.error('[embed] influencerWelcome error:', e.message));
      } catch (e) {
        console.error('[embed submit] welcome notify error:', e.message);
      }

      try {
        const adminEmails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim()).filter(Boolean);
        if (adminEmails.length > 0) {
          for (const adminEmail of adminEmails) {
            sendEmail({
              to: adminEmail,
              subject: `New Creator (via Instant Review) — ${user.email}`,
              headline: `New Creator Account`,
              preheader: `${user.email} just joined KUP via the Instant Review Widget on ${brand.name}`,
              bodyHtml: `
                <p>A new creator just joined KeepUsPostd by leaving a review through the <strong>Instant Review Widget</strong>.</p>
                <p><strong>Email:</strong> ${user.email}</p>
                <p><strong>Name:</strong> ${[user.legalFirstName, user.legalLastName].filter(Boolean).join(' ') || 'Not provided'}</p>
                <p><strong>Handle:</strong> @${influencerProfile.handle}</p>
                <p><strong>Partnered brand:</strong> ${brand.name}</p>
                <p><strong>Signup source:</strong> embed (Instant Review Widget)</p>
                <p><strong>Auth status:</strong> not yet claimed (no password / no PayPal — Phase 5 flow will handle claim on app download)</p>
                <p><strong>Joined:</strong> ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })} CT</p>
              `,
              ctaText: 'View in Admin Panel',
              ctaUrl: 'https://keepuspostd.com/pages/admin/creators.html',
              variant: 'brand',
            }).catch(e => console.error(`[embed] admin notify error: ${e.message}`));
          }
        }
      } catch (e) {
        console.error('[embed submit] admin notify error:', e.message);
      }
    }

    // 3 — new brand partnership notification (only when partnership was
    // just created — skip on re-submissions from an existing partner)
    if (partnershipWasCreated) {
      try {
        notify.newBrandPartnership({
          influencer: {
            email: user.email,
            userId: user._id,
            displayName: influencerProfile.displayName,
          },
          brand: { name: brand.name, logoUrl: brand.logoUrl || null },
        }).catch(e => console.error('[embed] newBrandPartnership error:', e.message));
      } catch (e) {
        console.error('[embed submit] partnership notify error:', e.message);
      }
    }

    // 4 — content-submitted notification to the brand
    try {
      notify.contentSubmitted({
        brand: { ...brand, ownerEmail: brand.ownerEmail, email: brand.email },
        influencer: influencerProfile,
        submission,
      }).catch(e => console.error('[embed] contentSubmitted error:', e.message));
    } catch (e) {
      console.error('[embed submit] content notify error:', e.message);
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
