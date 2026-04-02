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
        "https://keepuspostd.com",
        "https://www.keepuspostd.com",
        "https://*.r2.dev",          // Cloudflare R2 uploads
      ],
      mediaSrc: [
        "'self'",
        "blob:",                     // Camera preview via getUserMedia
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
      if (isProduction) {
        // Short cache in production (5 min) — allows quick updates
        res.setHeader('Cache-Control', 'public, max-age=300');
      } else {
        // No cache in development
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      }
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
app.get('/help', (req, res) => {
  res.redirect(301, '/pages/help.html');
});
app.get('/delete-account', (req, res) => {
  res.redirect(301, '/pages/delete-account.html');
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

    console.log('⏰ Cron: Trial expiry scheduled daily at 2:00 AM UTC\n');
  });
};

startServer();
