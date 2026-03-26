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
app.use(helmet());           // Security headers
app.use(cors());             // Allow cross-origin requests
app.use(express.json());     // Parse JSON request bodies
app.use(express.urlencoded({ extended: true })); // Parse form data

// --- Serve static files (HTML, CSS, JS, images) ---
app.use(express.static(path.join(__dirname, '..', 'public')));

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
