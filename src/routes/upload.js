// Upload Routes — File upload for content submissions
// Saves media files to public/uploads/ and returns their URLs.
// Uses multer for multipart/form-data handling.
// Protected by Firebase auth — only logged-in users can upload.

const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { execFile: execFileCb } = require('child_process');
const { promisify } = require('util');
const execFile = promisify(execFileCb);
const { requireAuth } = require('../middleware/auth');
const { ContentSubmission } = require('../models');

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

// POST /api/upload/trim — Trim a video using FFmpeg
// Takes: { videoUrl, startTime, endTime, submissionId (optional) }
// If submissionId provided: saves original, updates submission with trimmed version
// Returns: { url: '/uploads/trimmed-filename.mp4', duration: '0:07' }
// FFmpeg cuts the video without re-encoding (instant, no quality loss)
router.post('/trim', requireAuth, async (req, res) => {
  try {
    const { videoUrl, startTime, endTime, submissionId } = req.body;

    if (!videoUrl || !startTime || !endTime) {
      return res.status(400).json({ error: 'videoUrl, startTime, and endTime are required' });
    }

    // Security: only allow trimming files in /uploads/
    if (!videoUrl.startsWith('/uploads/')) {
      return res.status(400).json({ error: 'Can only trim uploaded files' });
    }

    // Build file paths
    const uploadsDir = path.join(__dirname, '..', '..', 'public', 'uploads');
    const sourceFilename = path.basename(videoUrl);
    const sourcePath = path.join(uploadsDir, sourceFilename);

    // Check source exists
    if (!fs.existsSync(sourcePath)) {
      return res.status(404).json({ error: 'Video file not found' });
    }

    // Parse times (format: "M:SS" or "MM:SS") to seconds for FFmpeg
    function parseTime(t) {
      const parts = t.split(':');
      return parseInt(parts[0]) * 60 + parseInt(parts[1]);
    }

    const startSec = parseTime(startTime);
    const endSec = parseTime(endTime);
    const durationSec = endSec - startSec;

    if (durationSec <= 0) {
      return res.status(400).json({ error: 'End time must be after start time' });
    }
    if (durationSec < 1) {
      return res.status(400).json({ error: 'Trimmed video must be at least 1 second' });
    }

    // Output filename: trimmed-{timestamp}-{random}.{ext}
    const ext = path.extname(sourceFilename);
    const trimmedFilename = `trimmed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    const outputPath = path.join(uploadsDir, trimmedFilename);

    // FFmpeg command: copy streams (no re-encoding = fast + no quality loss)
    // -ss: start time, -t: duration, -c copy: stream copy (no re-encode)
    const args = [
      '-y',                       // Overwrite output if exists
      '-ss', String(startSec),    // Start time in seconds
      '-i', sourcePath,           // Input file
      '-t', String(durationSec),  // Duration in seconds
      '-c', 'copy',               // Copy streams (no re-encoding)
      '-avoid_negative_ts', '1',  // Fix timestamp issues
      outputPath,                 // Output file
    ];

    console.log(`✂️ Trimming video: ${sourceFilename} (${startTime} to ${endTime}, ${durationSec}s)`);

    try {
      await execFile('ffmpeg', args, { timeout: 30000 });
    } catch (ffmpegErr) {
      console.error('FFmpeg trim error:', ffmpegErr.message);
      return res.status(500).json({ error: 'Failed to trim video' });
    }

    // Verify output file was created
    if (!fs.existsSync(outputPath)) {
      return res.status(500).json({ error: 'Trimmed file was not created' });
    }

    const outputUrl = `/uploads/${trimmedFilename}`;
    const durationFormatted = Math.floor(durationSec / 60) + ':' + String(durationSec % 60).padStart(2, '0');

    console.log(`✅ Trim complete: ${trimmedFilename} (${durationFormatted})`);

    // If submissionId provided, save to database
    // - originalMediaUrls: preserve the influencer's original (only set once, never overwritten)
    // - editedMediaUrls: the brand's latest edited version
    // - mediaUrls: always points to the latest/active version (edited if exists)
    if (submissionId) {
      try {
        const submission = await ContentSubmission.findById(submissionId);
        if (submission) {
          // Save original only on first edit (never overwrite)
          if (!submission.originalMediaUrls || submission.originalMediaUrls.length === 0) {
            submission.originalMediaUrls = [...submission.mediaUrls];
          }

          // Replace the trimmed video URL in both edited and active arrays
          const newMediaUrls = submission.mediaUrls.map(url =>
            url === videoUrl ? outputUrl : url
          );
          submission.editedMediaUrls = newMediaUrls;
          submission.mediaUrls = newMediaUrls;
          await submission.save();

          console.log(`💾 Submission ${submissionId} updated with trimmed video`);
        }
      } catch (dbErr) {
        console.error('DB update after trim failed:', dbErr.message);
        // Don't fail the request — the trim itself succeeded
      }
    }

    res.json({
      message: 'Video trimmed successfully',
      url: outputUrl,
      originalUrl: videoUrl,
      duration: durationFormatted,
      durationSeconds: durationSec,
    });
  } catch (error) {
    console.error('Trim error:', error.message);
    res.status(500).json({ error: 'Could not trim video' });
  }
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
