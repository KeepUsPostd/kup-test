// KUP Security Middleware
// Production-ready security layers added on top of existing functionality.
// Nothing changes how the app works — just adds protection.
//
// What each piece does (in plain English):
//   - Rate limiting: Prevents someone from hammering your API (brute force attacks)
//   - Mongo sanitize: Stops hackers from injecting database commands through form fields
//   - HPP: Prevents parameter pollution (sending ?sort=name&sort=email to confuse queries)
//   - Input size limits: Stops oversized requests that could crash the server
//   - CORS lockdown: In production, only YOUR domain can call the API

const rateLimit = require('express-rate-limit');
// express-mongo-sanitize and hpp replaced with custom Express 5-compatible versions below

// ── Environment Detection ─────────────────────────────────
const isProduction = process.env.NODE_ENV === 'production';
const APP_URL = process.env.APP_URL || 'http://localhost:3001';

// ═══════════════════════════════════════════════════════════
// 1. RATE LIMITING
// ═══════════════════════════════════════════════════════════
// Limits how many requests a single IP can make in a time window.
// Different limits for different route types.

// General API — 500 requests per 15 minutes per IP
// Real browsing fires 5–10 API calls per page load (brand sync, subscription
// check, billing status, user profile, etc.), so 100/15min was far too
// tight and caused false-empty states when a legit user hit the cap mid-
// session. 500 still blocks abuse (~1 req/1.8s sustained) but accommodates
// normal interactive use without friction.
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: isProduction ? 500 : 5000, // relaxed in dev
  message: {
    error: 'Too many requests',
    message: 'Please try again in a few minutes.',
  },
  standardHeaders: true, // Return rate limit info in headers
  legacyHeaders: false,
  skip: (req) => {
    // Don't rate limit health checks or static files
    return req.path === '/api/health';
  },
});

// Auth routes — stricter: 20 attempts per 15 minutes
// Prevents brute force login/register attacks
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProduction ? 20 : 200,
  message: {
    error: 'Too many login attempts',
    message: 'Too many attempts. Please wait 15 minutes before trying again.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Password reset — very strict: 5 per hour
// Prevents email flooding
const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: isProduction ? 5 : 50,
  message: {
    error: 'Too many password reset requests',
    message: 'Please wait before requesting another password reset.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// File uploads — 30 per hour
// Prevents storage abuse
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: isProduction ? 30 : 300,
  message: {
    error: 'Upload limit reached',
    message: 'Too many uploads. Please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Webhooks — no rate limit (PayPal needs to reach us freely)
// But we verify signatures instead

// Cashout — 5 per hour (financial safety)
const cashoutLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: isProduction ? 5 : 50,
  message: {
    error: 'Too many cashout attempts',
    message: 'Please wait before trying another cashout.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// ═══════════════════════════════════════════════════════════
// 2. MONGO SANITIZE (Express 5 compatible — custom)
// ═══════════════════════════════════════════════════════════
// Strips $ and . prefixes from user input to prevent MongoDB
// operator injection (e.g., { $gt: "" } bypassing auth).
//
// express-mongo-sanitize is incompatible with Express 5 because
// req.query is a read-only getter. This custom version sanitizes
// req.body and req.params (writable) and deep-clones query for checking.

function sanitizeValue(val) {
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) return val.map(sanitizeValue);
  if (val && typeof val === 'object') {
    const clean = {};
    for (const key of Object.keys(val)) {
      if (key.startsWith('$') || key.includes('.')) {
        const safeKey = key.replace(/[\$\.]/g, '_');
        console.warn(`⚠️ Sanitized key "${key}" → "${safeKey}"`);
        clean[safeKey] = sanitizeValue(val[key]);
      } else {
        clean[key] = sanitizeValue(val[key]);
      }
    }
    return clean;
  }
  return val;
}

function mongoSanitizeMiddleware(req, res, next) {
  if (req.body) req.body = sanitizeValue(req.body);
  if (req.params) {
    const sanitized = sanitizeValue(req.params);
    for (const key of Object.keys(sanitized)) {
      req.params[key] = sanitized[key];
    }
  }
  // req.query is read-only in Express 5 — validate but don't reassign
  const q = req.query;
  if (q && typeof q === 'object') {
    for (const key of Object.keys(q)) {
      if (key.startsWith('$') || key.includes('.')) {
        return res.status(400).json({ error: 'Invalid query parameter' });
      }
      if (typeof q[key] === 'object' && q[key] !== null) {
        const str = JSON.stringify(q[key]);
        if (str.includes('"$')) {
          return res.status(400).json({ error: 'Invalid query parameter' });
        }
      }
    }
  }
  next();
}

// ═══════════════════════════════════════════════════════════
// 3. HTTP PARAMETER POLLUTION (Express 5 compatible — custom)
// ═══════════════════════════════════════════════════════════
// Prevents duplicate query parameters (e.g., ?status=active&status=deleted).
// In Express 5, req.query is read-only, so instead of modifying it
// we reject requests with array values on non-whitelisted params.

const HPP_WHITELIST = new Set(['tags', 'categories', 'type']);

function hppMiddleware(req, res, next) {
  const q = req.query;
  if (q && typeof q === 'object') {
    for (const key of Object.keys(q)) {
      if (Array.isArray(q[key]) && !HPP_WHITELIST.has(key)) {
        return res.status(400).json({
          error: 'Duplicate query parameter',
          message: `Parameter "${key}" must not be repeated.`,
        });
      }
    }
  }
  next();
}

// ═══════════════════════════════════════════════════════════
// 4. CORS CONFIGURATION (Production-Ready)
// ═══════════════════════════════════════════════════════════
// In dev: allow everything (easy testing)
// In production: only YOUR domain can call the API

function getCorsOptions() {
  if (!isProduction) {
    // Dev mode — allow all origins for easy testing
    return {
      origin: true,
      credentials: true,
    };
  }

  // Production — lock down to known domains
  const allowedOrigins = [
    APP_URL,
    'https://keepuspostd.com',
    'https://www.keepuspostd.com',
    'https://app.keepuspostd.com',
    // Add your native app's origin if needed
  ].filter(Boolean);

  return {
    origin: (origin, callback) => {
      // Allow requests with no origin (mobile apps, server-to-server)
      if (!origin) return callback(null, true);

      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        console.warn(`⚠️ CORS blocked request from: ${origin}`);
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400, // Cache preflight for 24 hours
  };
}

// ═══════════════════════════════════════════════════════════
// 5. REQUEST SIZE LIMITS
// ═══════════════════════════════════════════════════════════
// Prevents oversized payloads that could crash the server

const jsonLimit = { limit: '10mb' };   // JSON bodies (content submissions can have base64)
const urlencodedLimit = { limit: '10mb', extended: true };

// ═══════════════════════════════════════════════════════════
// 6. SECURITY HEADERS (Additional)
// ═══════════════════════════════════════════════════════════
// Extra headers beyond what Helmet provides

function additionalSecurityHeaders(req, res, next) {
  // Prevent browsers from caching sensitive API responses
  if (req.path.startsWith('/api/')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  }

  // Prevent clickjacking on API responses
  res.setHeader('X-Frame-Options', 'DENY');

  // Prevent MIME type sniffing (Helmet does this too, belt + suspenders)
  res.setHeader('X-Content-Type-Options', 'nosniff');

  next();
}

// ═══════════════════════════════════════════════════════════
// 7. REQUEST LOGGING (Security Audit Trail)
// ═══════════════════════════════════════════════════════════
// Logs API requests for security monitoring (production only)

function requestLogger(req, res, next) {
  if (!isProduction) return next();

  // Only log API routes, not static files
  if (req.path.startsWith('/api/')) {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      // Log suspicious activity
      if (res.statusCode >= 400) {
        console.warn(`🔍 ${req.method} ${req.path} → ${res.statusCode} (${duration}ms) IP: ${req.ip}`);
      }
    });
  }
  next();
}

module.exports = {
  // Rate limiters (applied per-route)
  generalLimiter,
  authLimiter,
  passwordResetLimiter,
  uploadLimiter,
  cashoutLimiter,

  // Global middleware (applied to all routes)
  mongoSanitizeMiddleware,
  hppMiddleware,
  additionalSecurityHeaders,
  requestLogger,

  // Config
  getCorsOptions,
  jsonLimit,
  urlencodedLimit,
};
