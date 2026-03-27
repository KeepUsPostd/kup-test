// KUP Test Server — Main Entry Point
// This is the "brain" of your backend. It starts the web server,
// connects to your database, initializes Firebase, and mounts all API routes.

require('dotenv').config({ path: '.env.test' });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const connectDB = require('./config/database');

// Initialize Firebase Admin SDK (must happen before routes that use it)
require('./config/firebase');

// Create the Express app (your web server)
const app = express();
const PORT = process.env.PORT || 3001;

// --- Middleware (things that run on every request) ---
app.use(helmet({
  hsts: false,  // DISABLE for local dev — no HTTPS on localhost/LAN
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
        "https://i.pravatar.cc",     // Demo avatar images
        "https://images.unsplash.com", // Demo post images
        "https://randomuser.me",     // Demo profile photos
        "blob:",                     // Camera/recorded media
      ],
      connectSrc: [
        "'self'",
        "https://firestore.googleapis.com",
        "https://www.googleapis.com",
        "https://securetoken.googleapis.com",
        "https://identitytoolkit.googleapis.com",
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
}));  // Security headers (CSP configured for KUP frontend)
app.use(cors());             // Allow cross-origin requests
app.use(express.json());     // Parse JSON request bodies
app.use(express.urlencoded({ extended: true })); // Parse form data

// --- Serve static files (HTML, CSS, JS, images) ---
// Override MIME types: .MOV/.mov → video/mp4 so browsers can play them
// (video/quicktime is not supported in most browsers)
app.use(express.static(path.join(__dirname, '..', 'public'), {
  etag: false,
  setHeaders: (res, filePath) => {
    if (/\.mov$/i.test(filePath)) {
      res.setHeader('Content-Type', 'video/mp4');
    }
    // Prevent browser caching of HTML and JS files during development
    if (/\.(html|js)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// --- API Routes ---

// Health check (no auth required)
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'KUP Test Server is running!',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'test',
  });
});

// Auth routes (register, login, profile)
app.use('/api/auth', require('./routes/auth'));

// Brand routes (CRUD, team members)
app.use('/api/brands', require('./routes/brands'));

// Campaign routes (stub — Phase 3)
app.use('/api/campaigns', require('./routes/campaigns'));

// Reward routes (stub — Phase 3)
app.use('/api/rewards', require('./routes/rewards'));

// Content routes (stub — Phase 4)
app.use('/api/content', require('./routes/content'));

// Upload routes (media file uploads for content submissions)
app.use('/api/upload', require('./routes/upload'));

// Partnership routes (stub — Phase 4)
app.use('/api/partnerships', require('./routes/partnerships'));

// Kiosk routes (Phase 5 — guest reviews + instant rewards)
app.use('/api/kiosk', require('./routes/kiosk'));

// Billing routes (Phase 6 — subscriptions + PayPal)
app.use('/api/billing', require('./routes/billing'));

// Payout routes (Phase 6 — transactions + payout batches)
app.use('/api/payouts', require('./routes/payouts'));

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
    console.log(`📁 API Routes: /api/auth, /api/brands, /api/campaigns, /api/rewards, /api/content, /api/partnerships, /api/kiosk, /api/billing, /api/payouts\n`);
  });
};

startServer();
