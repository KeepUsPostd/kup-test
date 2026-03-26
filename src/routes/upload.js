// Upload Routes — File upload for content submissions
// Saves media files to public/uploads/ and returns their URLs.
// Uses multer for multipart/form-data handling.
// Protected by Firebase auth — only logged-in users can upload.

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { requireAuth } = require('../middleware/auth');

// Configure where files go and how they're named
const storage = multer.diskStorage({
  // Save files to public/uploads/ so they're served as static files
  destination: path.join(__dirname, '..', '..', 'public', 'uploads'),

  // Name files with timestamp + random string to avoid collisions
  // Example: 1711234567890-abc123.jpg
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const uniqueName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    cb(null, uniqueName);
  },
});

// Set up multer with limits and file type filtering
const upload = multer({
  storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max per file (video needs room)
    files: 5,                    // Max 5 files per upload
  },
  fileFilter: (req, file, cb) => {
    // Only allow images and videos
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image and video files are allowed'));
    }
  },
});

// POST /api/upload — Upload media files
// Expects multipart form data with field name "media"
// Returns: { urls: ['/uploads/filename1.jpg', '/uploads/filename2.mp4'] }
router.post('/', requireAuth, upload.array('media', 5), (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded' });
  }

  // Build public URLs for each uploaded file
  const urls = req.files.map(f => `/uploads/${f.filename}`);

  console.log(`📤 ${req.files.length} file(s) uploaded by user ${req.user.email}`);

  res.json({
    message: `${req.files.length} file(s) uploaded`,
    urls,
  });
});

// Error handling for multer (file too large, wrong type, etc.)
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'File too large. Maximum size is 50MB.' });
    }
    if (err.code === 'LIMIT_FILE_COUNT') {
      return res.status(400).json({ error: 'Too many files. Maximum is 5 per upload.' });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});

module.exports = router;
