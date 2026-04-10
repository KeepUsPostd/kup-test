// KUP Test Server — Main Entry Point
// This is the "brain" of your backend. It starts the web server,
// connects to your database, initializes Firebase, and mounts all API routes.

// Load environment: .env.production if NODE_ENV=production, otherwise .env.test
const envFile = process.env.NODE_ENV === 'production' ? '.env.production' : '.env.test';
require('dotenv').config({ path: envFile });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const connectDB = require('./config/database');
const cron = require('node-cron');

// Security middleware (rate limiting, sanitization, CORS lockdown)
const {
  generalLimiter,
  authLimiter,
  passwordResetLimiter,
  uploadLimiter,
  cashoutLimiter,
  mongoSanitizeMiddleware,
  hppMiddleware,
  additionalSecurityHeaders,
  requestLogger,
  getCorsOptions,
  jsonLimit,
  urlencodedLimit,
} = require('./middleware/security');

// Initialize Firebase Admin SDK (must happen before routes that use it)
require('./config/firebase');

// Create the Express app (your web server)
const app = express();
const PORT = process.env.PORT || 3001;

// Trust Railway's proxy (required for rate limiting + IP detection behind Railway/Cloudflare)
// Without this, express-rate-limit throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR on every request
app.set('trust proxy', 1);

// --- Global Middleware (runs on every request) ---

// Security headers (CSP configured for KUP frontend)
const isProduction = process.env.NODE_ENV === 'production';

app.use(helmet({
  hsts: isProduction,  // Enable HSTS in production, disable for local dev
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "'unsafe-inline'",           // Allow inline <script> blocks
        "https://cdn.jsdelivr.net",  // Bootstrap JS
        "https://www.gstatic.com",   // Firebase SDK
        "https://apis.google.com",   // Firebase Auth
      ],
      scriptSrcAttr: [
        "'unsafe-inline'",           // Allow onclick/onchange handlers
      ],
      styleSrc: [
        "'self'",
        "'unsafe-inline'",           // Allow inline styles
        "https://cdn.jsdelivr.net",  // Bootstrap CSS
        "https://fonts.googleapis.com", // Google Fonts
      ],
      fontSrc: [
        "'self'",
        "https://fonts.gstatic.com", // Google Fonts files
        "https://cdn.jsdelivr.net",  // Phosphor Icons font files
      ],
      imgSrc: [
        "'self'",
        "data:",
        "blob:",                     // Camera/recorded media
        "https://*.r2.dev",          // Cloudflare R2 — brand logos & banners
        "https://firebasestorage.googleapis.com", // Firebase Storage
        "https://i.pravatar.cc",     // Demo avatar images
        "https://images.unsplash.com", // Demo post images
        "https://randomuser.me",     // Demo profile photos
      ],
      connectSrc: [
        "'self'",
        "https://firestore.googleapis.com",
        "https://www.googleapis.com",
        "https://securetoken.googleapis.com",
        "https://identitytoolkit.googleapis.com",
        "https://fcmregistrations.googleapis.com", // FCM push
        "https://firebase.googleapis.com",          // Firebase general
        "https://*.firebaseio.com",                 // Firebase Realtime DB
        "https://keepuspostd.com",
        "https://www.keepuspostd.com",
        "https://*.r2.dev",                         // Cloudflare R2 uploads
        "https://cdn.jsdelivr.net",                 // Bootstrap CDN (source maps + preload)
      ],
      mediaSrc: [
        "'self'",
        "blob:",                     // Camera preview via getUserMedia
        "https://*.r2.dev",          // Cloudflare R2 — video/audio content
      ],
      frameSrc: [
        "'self'",
        "https://keepuspostd.firebaseapp.com",
        "https://accounts.google.com",
      ],
      upgradeInsecureRequests: null,  // DISABLE — breaks local dev on phone (no HTTPS)
    },
  },
}));

app.use(cors(getCorsOptions()));                   // CORS — open in dev, locked in production
app.use(express.json(jsonLimit));                   // Parse JSON (10mb limit)
app.use(express.urlencoded(urlencodedLimit));       // Parse form data (10mb limit)
app.use(mongoSanitizeMiddleware);                   // Custom Express 5-compatible mongo sanitize
app.use(hppMiddleware);                              // Custom Express 5-compatible HPP protection
app.use(additionalSecurityHeaders);                 // Extra security headers on API routes
app.use(requestLogger);                             // Log failed requests in production

// General rate limit on all API routes
app.use('/api/', generalLimiter);

// --- Root redirect — send visitors straight to home, never show test dashboard ---
app.get('/', (req, res) => {
  res.redirect(301, '/pages/home.html');
});

// --- Serve static files (HTML, CSS, JS, images) ---
// Override MIME types: .MOV/.mov → video/mp4 so browsers can play them
// (video/quicktime is not supported in most browsers)
app.use(express.static(path.join(__dirname, '..', 'public'), {
  etag: false,
  setHeaders: (res, filePath) => {
    if (/\.mov$/i.test(filePath)) {
      res.setHeader('Content-Type', 'video/mp4');
    }
    if (/\.(html|js)$/i.test(filePath)) {
      // No cache on HTML/JS — ensures latest code is always served after deploy
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// --- Firebase Auth Action Redirect ---
// Firebase sends users to /auth/action for password reset + email verification.
// Redirect to our branded auth-action page.
app.get('/auth/action', (req, res) => {
  const query = new URLSearchParams(req.query).toString();
  res.redirect(`/pages/auth-action.html${query ? '?' + query : ''}`);
});

// --- Legal / Public Pages ---
// Clean URLs for App Store review and in-app WebView links
app.get('/privacy', (req, res) => {
  res.redirect(301, '/pages/policy.html');
});
app.get('/privacy-policy', (req, res) => {
  res.redirect(301, '/pages/policy.html');
});
app.get('/policy', (req, res) => {
  res.redirect(301, '/pages/policy.html');
});
app.get('/terms', (req, res) => {
  res.redirect(301, '/pages/terms.html');
});
app.get('/terms-of-service', (req, res) => {
  res.redirect(301, '/pages/terms.html');
});
app.get('/help', (req, res) => {
  res.redirect(301, '/pages/help.html');
});
app.get('/delete-account', (req, res) => {
  res.redirect(301, '/pages/delete-account.html');
});

// Kiosk reward redemption page — staff scans guest QR to redeem
app.get('/redeem/:code', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'pages', 'redeem.html'));
});

// Legacy QR redirect — old platform used /download-app?brand-id=XXXX
// Maps numeric brand IDs from printed materials to current brand kiosk codes
// New users see the download page with brand context; existing app users deep link in
const LEGACY_BRAND_ID_MAP = {
  '0129': 'KUP-SXA139',  // The Pure Juice Joint
  // Additional mappings added as remaining QR codes are confirmed:
  // '0XXX': 'KUP-XXXXXX',  // Butterfly Uprising
  // '0XXX': 'KUP-XXXXXX',  // The Silk Screen Machine
  // '0XXX': 'KUP-XXXXXX',  // Nelsons Bespoke
  // '0XXX': 'KUP-XXXXXX',  // Ted X Marvila
  // '0XXX': 'KUP-XXXXXX',  // Chaney's Pralines
  // '0XXX': 'KUP-XXXXXX',  // MTWF
  // '0XXX': 'KUP-XXXXXX',  // AI Powered Dahlia Imanbay
  // '0XXX': 'KUP-XXXXXX',  // Into Beauty
  // '0XXX': 'KUP-XXXXXX',  // Fatherhood Leadership Initiatives
  // '0XXX': 'KUP-XXXXXX',  // KeepUsPostd
};

app.get('/download-app', (req, res) => {
  const brandId = req.query['brand-id'];
  if (brandId && LEGACY_BRAND_ID_MAP[brandId]) {
    // Redirect to brand profile page — handles deep link + download flow
    return res.redirect(301, '/brand/' + LEGACY_BRAND_ID_MAP[brandId]);
  }
  // No brand-id or unmapped — serve normal download page
  res.sendFile(path.join(__dirname, '..', 'public', 'pages', 'download-app.html'));
});

// Public brand profile page — scanned from QR codes on market materials
// Supports both /brand/KUP-XXXXXX (kiosk code) and /@handle (vanity handle)
app.get('/brand/:code', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'pages', 'brand-profile.html'));
});
app.get('/@:handle', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'pages', 'brand-profile.html'));
});

// Deep link share page — shared from the KUP app (brand share button)
// URL: keepuspostd.com/brands/:id — handles Universal Link handoff from iOS
app.get('/brands/:id', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'pages', 'deep-link.html'));
});

// Staff PIN scan page — mobile-first, PIN-protected purchase points scanner
// URL: keepuspostd.com/staff/:brandCode
// No Firebase auth — only the 4-digit staff PIN is required.
// Multiple staffers can use this on their personal phones at events / food trucks.
app.get('/staff/:brandCode', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'pages', 'staff-scan.html'));
});

// Apple App Site Association — required for iOS Universal Links
// Must be served as application/json WITHOUT redirect
app.get('/.well-known/apple-app-site-association', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.json({
    applinks: {
      details: [
        {
          appIDs: ['793733237X.com.keepuspostd.reviews'],
          components: [
            { '/': '/brands/*', comment: 'Brand deep links shared from KUP app' },
          ],
        },
      ],
    },
  });
});

// --- API Routes ---

// Health check (no auth required, no rate limit)
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'KUP Test Server is running!',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'test',
  });
});

// Auth routes — stricter rate limit (20/15min in production)
app.use('/api/auth', authLimiter, require('./routes/auth'));

// Brand routes (CRUD, team members)
app.use('/api/brands', require('./routes/brands'));

// Campaign routes (stub — Phase 3)
app.use('/api/campaigns', require('./routes/campaigns'));

// Reward routes (stub — Phase 3)
app.use('/api/rewards', require('./routes/rewards'));

// Content routes (stub — Phase 4)
app.use('/api/content', require('./routes/content'));

// Upload routes — rate limited (30/hour in production)
app.use('/api/upload', uploadLimiter, require('./routes/upload'));

// Partnership routes (stub — Phase 4)
app.use('/api/partnerships', require('./routes/partnerships'));

// Referral routes — influencer referral program
app.use('/api/referrals', require('./routes/referrals'));

// Kiosk routes (Phase 5 — guest reviews + instant rewards)
app.use('/api/kiosk', require('./routes/kiosk'));

// Billing routes (Phase 6 — subscriptions + PayPal)
app.use('/api/billing', require('./routes/billing'));

// Payout routes (Phase 6 — transactions + payout batches)
app.use('/api/payouts', require('./routes/payouts'));

// Wallet routes — cashout has stricter rate limit (5/hour in production)
app.use('/api/wallet', cashoutLimiter, require('./routes/wallet'));

// Notification routes (in-app notification center)
app.use('/api/notifications', require('./routes/notifications'));

// Comments routes (user comments on content submissions)
app.use('/api/comments', require('./routes/comments'));

// Saved content routes (user bookmarks)
app.use('/api/saved', require('./routes/saved'));

// Admin routes (re-engagement campaigns, platform management)
app.use('/api/admin', require('./routes/admin'));

// Admin Panel routes (dashboard, user mgmt, content mod, financials)
app.use('/api/admin-panel', require('./routes/admin-panel'));

// Webhook routes (PayPal event notifications — no auth, signature-verified)
// NO rate limit — PayPal needs unrestricted access
app.use('/api/webhooks', require('./routes/webhooks'));

// Scan Analytics routes (QR code / market link tracking)
app.use('/api/scan-analytics', require('./routes/scan-analytics'));

// Purchase Points routes (brand config, award, stats, history)
app.use('/api/purchase-points', require('./routes/purchasePoints'));

// Google Business Profile routes (OAuth + config + post creation)
app.use('/api/google-business', require('./routes/googleBusiness'));

// Content moderation routes (Apple Guideline 1.2 — flag + block)
app.use('/api/reports', require('./routes/reports'));
app.use('/api/blocks', require('./routes/blocks'));

// Public kiosk display route — serves the tablet-facing kiosk screen
// /kiosk/:brandCode → kiosk-display.html (no auth required)
app.get('/kiosk/:brandCode', (req, res) => {
  res.redirect(`/pages/inner/kiosk-display.html?brandCode=${encodeURIComponent(req.params.brandCode)}`);
});

// --- Error Handling Middleware ---
app.use((err, req, res, next) => {
  console.error('Server error:', err.message);
  res.status(500).json({
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'test' ? err.message : 'Something went wrong.',
  });
});

// --- Start Server ---
const startServer = async () => {
  // Connect to MongoDB
  await connectDB();

  // Register all Mongoose models (ensures indexes are created)
  require('./models');

  app.listen(PORT, () => {
    console.log(`\n🚀 KUP Test Server running on http://localhost:${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'test'}`);
    console.log(`🔒 Security: Rate limiting, mongo sanitize, HPP, CORS ${process.env.NODE_ENV === 'production' ? '(locked)' : '(open — dev mode)'}`);
    console.log(`📁 API Routes: /api/auth, /api/brands, /api/campaigns, /api/rewards, /api/content, /api/partnerships, /api/kiosk, /api/billing, /api/payouts, /api/wallet, /api/notifications, /api/webhooks\n`);

    // ── Daily Cron Jobs ─────────────────────────────────────────
    // Run at 2:00 AM UTC every day
    const { processExpiredTrials } = require('./services/trial');
    cron.schedule('0 2 * * *', async () => {
      console.log('⏰ [CRON] Running daily trial expiry check...');
      try {
        const result = await processExpiredTrials();
        console.log(`⏰ [CRON] Trial expiry done: ${JSON.stringify(result)}`);
      } catch (err) {
        console.error('⏰ [CRON] Trial expiry failed:', err.message);
      }
    }, { timezone: 'UTC' });

    console.log('⏰ Cron: Trial expiry scheduled daily at 2:00 AM UTC');

    // ── Weekly Cron — PayPal Connect Reminder ───────────────────
    // Every Monday at 9:00 AM UTC
    // Notifies influencers who haven't connected PayPal PPCP:
    //   Group A — have pending cash transactions (money literally waiting)
    //   Group B — no pending transactions yet (proactive reminder, brands do pay cash)
    cron.schedule('0 9 * * 1', async () => {
      console.log('⏰ [CRON] Running weekly PayPal connect reminder...');
      try {
        const InfluencerProfile = require('./models/InfluencerProfile');
        const Transaction       = require('./models/Transaction');
        const notify            = require('./services/notifications');

        // All influencers without a completed PPCP merchant ID
        const unconnected = await InfluencerProfile.find({
          $or: [
            { paypalMerchantId: { $exists: false } },
            { paypalMerchantId: null },
            { paypalMerchantId: '' },
          ],
          paypalOnboardingStatus: { $ne: 'completed' },
        }).lean();

        if (!unconnected.length) {
          console.log('⏰ [CRON] PayPal reminder: all influencers connected — nothing to do.');
          return;
        }

        let sentWithPending  = 0;
        let sentGeneral      = 0;
        let errors           = 0;

        for (const influencer of unconnected) {
          try {
            // Check for pending transactions (money waiting)
            const pendingTxns = await Transaction.find({
              influencerProfileId: influencer._id,
              status: 'pending',
            }).lean();

            const hasPending = pendingTxns.length > 0;
            const totalPending = pendingTxns.reduce((sum, t) => sum + (t.influencerAmount || t.amount || 0), 0);

            await notify.paypalMoneyWaiting({
              influencer: {
                ...influencer,
                // paypalMoneyWaiting expects email & userId
                email:  influencer.paypalEmail || influencer.email || '',
                userId: influencer.userId,
              },
              brand: hasPending ? null : null,   // generic — no specific brand for weekly reminder
              amount: hasPending ? totalPending : 0,
              isWeeklyReminder: true,
              hasPendingCash: hasPending,
            });

            if (hasPending) sentWithPending++;
            else sentGeneral++;
          } catch (innerErr) {
            console.error(`⏰ [CRON] PayPal reminder failed for influencer ${influencer._id}: ${innerErr.message}`);
            errors++;
          }
        }

        console.log(`⏰ [CRON] PayPal reminder done — sent: ${sentWithPending} with pending cash, ${sentGeneral} general reminders, ${errors} errors`);
      } catch (err) {
        console.error('⏰ [CRON] PayPal connect reminder failed:', err.message);
      }
    }, { timezone: 'UTC' });

    console.log('⏰ Cron: PayPal connect reminder scheduled weekly — Mondays at 9:00 AM UTC\n');
  });
};

startServer();
