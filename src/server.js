// KUP Test Server — Main Entry Point
// This is the "brain" of your backend. It starts the web server
// and connects to your database and Firebase.

require('dotenv').config({ path: '.env.test' });

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const connectDB = require('./config/database');

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
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    message: 'KUP Test Server is running!',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'test'
  });
});

// --- Start Server ---
const startServer = async () => {
  // Connect to MongoDB
  await connectDB();

  app.listen(PORT, () => {
    console.log(`\n🚀 KUP Test Server running on http://localhost:${PORT}`);
    console.log(`📊 Health check: http://localhost:${PORT}/api/health`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'test'}\n`);
  });
};

startServer();
