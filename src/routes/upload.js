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

    // Output filename: always .mp4 for browser compatibility
    // (.MOV/QuickTime files are served as video/quicktime which many browsers can't play)
    const trimmedFilename = `trimmed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
    const outputPath = path.join(uploadsDir, trimmedFilename);

    // FFmpeg command: remux to MP4 container with stream copy (fast, no quality loss)
    // -movflags +faststart: moves metadata to front for instant browser playback
    const args = [
      '-y',                       // Overwrite output if exists
      '-ss', String(startSec),    // Start time in seconds
      '-i', sourcePath,           // Input file
      '-t', String(durationSec),  // Duration in seconds
      '-c', 'copy',               // Copy streams (no re-encoding)
      '-movflags', '+faststart',  // Web-optimized: metadata at front of file
      '-avoid_negative_ts', '1',  // Fix timestamp issues
      outputPath,                 // Output file (always .mp4)
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

// POST /api/upload/save-image-edit — Save a canvas-rendered image edit
// The frontend draws the image with all edits (crop, zoom, text, logo) onto a
// <canvas>, converts it to a PNG blob, and uploads it here as a file.
// Takes: multipart form with field "editedImage" + optional "submissionId" and "originalUrl"
// Returns: { url: '/uploads/edited-filename.png' }
// Same original-preservation logic as trim: saves original on first edit, updates active URLs.
router.post('/save-image-edit', requireAuth, upload.single('editedImage'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No edited image uploaded' });
    }

    const outputUrl = `/uploads/${req.file.filename}`;
    const { submissionId, originalUrl } = req.body;

    console.log(`🖼️ Image edit saved: ${req.file.filename} by ${req.user.email}`);

    // If submissionId provided, update the database (same pattern as trim)
    if (submissionId) {
      try {
        const submission = await ContentSubmission.findById(submissionId);
        if (submission) {
          // Save original only on first edit (never overwrite)
          if (!submission.originalMediaUrls || submission.originalMediaUrls.length === 0) {
            submission.originalMediaUrls = [...submission.mediaUrls];
          }

          // Replace the edited image URL in both edited and active arrays
          const newMediaUrls = submission.mediaUrls.map(url =>
            url === originalUrl ? outputUrl : url
          );
          submission.editedMediaUrls = newMediaUrls;
          submission.mediaUrls = newMediaUrls;
          await submission.save();

          console.log(`💾 Submission ${submissionId} updated with edited image`);
        }
      } catch (dbErr) {
        console.error('DB update after image edit failed:', dbErr.message);
        // Don't fail — the upload itself succeeded
      }
    }

    res.json({
      message: 'Image edit saved',
      url: outputUrl,
      originalUrl: originalUrl || null,
    });
  } catch (error) {
    console.error('Save image edit error:', error.message);
    res.status(500).json({ error: 'Could not save image edit' });
  }
});

// POST /api/upload/revert-edit — Revert a submission back to its original media
// Restores originalMediaUrls as the active version, clears editedMediaUrls.
// The brand can always re-edit later — the original is never deleted.
router.post('/revert-edit', requireAuth, async (req, res) => {
  try {
    const { submissionId } = req.body;

    if (!submissionId) {
      return res.status(400).json({ error: 'submissionId is required' });
    }

    const submission = await ContentSubmission.findById(submissionId);
    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    if (!submission.originalMediaUrls || submission.originalMediaUrls.length === 0) {
      return res.status(400).json({ error: 'No original to revert to — content has not been edited' });
    }

    // Restore original as the active version
    submission.mediaUrls = [...submission.originalMediaUrls];
    submission.editedMediaUrls = [];
    submission.originalMediaUrls = []; // Clear so it can be set fresh on next edit
    await submission.save();

    console.log(`↩️ Submission ${submissionId} reverted to original by ${req.user.email}`);

    res.json({
      message: 'Reverted to original',
      urls: submission.mediaUrls,
    });
  } catch (error) {
    console.error('Revert error:', error.message);
    res.status(500).json({ error: 'Could not revert edit' });
  }
});

// POST /api/upload/generate-signature — Generate or retrieve a Content Signature for a submission
// The KUP ID is a unique, permanent identifier embedded in downloaded content.
// Format: KP-{YEAR}-{5-char alphanumeric} — e.g. KP-2026-A3F7X
router.post('/generate-signature', requireAuth, async (req, res) => {
  try {
    const { submissionId } = req.body;
    if (!submissionId) {
      return res.status(400).json({ error: 'submissionId is required' });
    }

    const submission = await ContentSubmission.findById(submissionId)
      .populate('influencerProfileId', 'displayName handle')
      .populate('campaignId', 'title');

    if (!submission) {
      return res.status(404).json({ error: 'Submission not found' });
    }

    // Generate KUP ID on first download (or reuse existing)
    if (!submission.contentSignature || !submission.contentSignature.kupId) {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // No I/O/0/1 to avoid confusion
      let kupCode = '';
      for (let i = 0; i < 5; i++) {
        kupCode += chars[Math.floor(Math.random() * chars.length)];
      }
      const year = new Date().getFullYear();
      submission.contentSignature = {
        kupId: `KP-${year}-${kupCode}`,
        generatedAt: new Date(),
        downloadCount: 1,
      };
    } else {
      submission.contentSignature.downloadCount = (submission.contentSignature.downloadCount || 0) + 1;
    }

    await submission.save();

    const influencer = submission.influencerProfileId || {};
    const handle = influencer.handle ? `@${influencer.handle}` : (influencer.displayName || 'Unknown');
    const campaign = submission.campaignId ? submission.campaignId.title : 'General';

    console.log(`🔏 Content Signature: ${submission.contentSignature.kupId} (download #${submission.contentSignature.downloadCount})`);

    res.json({
      kupId: submission.contentSignature.kupId,
      influencer: handle,
      campaign: campaign,
      approvedAt: submission.reviewedAt || submission.updatedAt,
      downloadCount: submission.contentSignature.downloadCount,
      // The full signature string that gets embedded in the file
      signaturePayload: JSON.stringify({
        kupId: submission.contentSignature.kupId,
        submissionId: String(submission._id),
        influencer: handle,
        campaign: campaign,
        brandId: String(submission.brandId),
        approved: submission.reviewedAt || submission.updatedAt,
        platform: 'keepuspostd.com',
      }),
    });
  } catch (error) {
    console.error('Generate signature error:', error.message);
    res.status(500).json({ error: 'Could not generate content signature' });
  }
});

// POST /api/upload/render-with-overlays — Burn text/logo overlays into a video using FFmpeg
// Called when brand downloads a video that has overlays applied.
// Two modes:
//   1. DB mode: { submissionId } — reads overlay data from the submission record
//   2. Direct mode: { videoUrl, textOverlays, logoOverlay } — overlays passed inline (for demo/preview)
// Returns: { url: '/uploads/rendered-xxx.mp4' } with overlays burned into the video
router.post('/render-with-overlays', requireAuth, async (req, res) => {
  try {
    const { submissionId, signaturePayload } = req.body;

    // Resolve overlay data from either DB submission or direct request body
    let textOverlays, logoOverlay, videoUrl;

    if (submissionId) {
      // DB mode: load from submission record + resolve brand logo
      const submission = await ContentSubmission.findById(submissionId);
      if (!submission) {
        return res.status(404).json({ error: 'Submission not found' });
      }
      textOverlays = submission.textOverlays || [];
      logoOverlay = submission.logoOverlay || null;
      videoUrl = submission.mediaUrls[0];

      // Resolve brand logo URL and brand initials for fallback
      if (logoOverlay && submission.brandId) {
        try {
          const { Brand } = require('../models');
          const brand = await Brand.findById(submission.brandId).select('logoUrl name');
          if (brand) {
            if (brand.logoUrl && !logoOverlay.logoUrl) {
              logoOverlay.logoUrl = brand.logoUrl;
            }
            // Generate brand initials for fallback text
            if (brand.name && !logoOverlay.brandInitials) {
              const words = brand.name.trim().split(/\s+/);
              logoOverlay.brandInitials = words.length === 1
                ? words[0].substring(0, 2).toUpperCase()
                : words.map(w => w.charAt(0)).join('').toUpperCase().substring(0, 3);
            }
          }
        } catch (brandErr) {
          console.warn('Could not resolve brand logo:', brandErr.message);
        }
      }
    } else if (req.body.videoUrl) {
      // Direct mode: overlays passed in request body (demo/preview)
      textOverlays = req.body.textOverlays || [];
      logoOverlay = req.body.logoOverlay || null;
      videoUrl = req.body.videoUrl;
    } else {
      return res.status(400).json({ error: 'submissionId or videoUrl is required' });
    }

    const hasText = textOverlays && textOverlays.length > 0;
    const hasLogo = !!logoOverlay;

    if (!videoUrl || !videoUrl.startsWith('/uploads/')) {
      return res.status(400).json({ error: 'Invalid video URL' });
    }

    const uploadsDir = path.join(__dirname, '..', '..', 'public', 'uploads');
    const sourcePath = path.join(uploadsDir, path.basename(videoUrl));

    if (!fs.existsSync(sourcePath)) {
      return res.status(404).json({ error: 'Video file not found' });
    }

    // If no overlays AND no signature to embed, just return the existing URL
    if (!hasText && !hasLogo && !signaturePayload) {
      return res.json({ url: videoUrl, noOverlays: true });
    }

    // Signature-only mode (no visual overlays): fast stream copy with embedded metadata
    if (!hasText && !hasLogo && signaturePayload) {
      const sigFilename = `signed-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
      const sigOutputPath = path.join(uploadsDir, sigFilename);
      try {
        await execFile('ffmpeg', [
          '-y', '-i', sourcePath,
          '-c', 'copy',
          '-metadata', `comment=${signaturePayload}`,
          '-metadata', `description=KeepUsPostd Content Signature`,
          '-movflags', '+faststart',
          sigOutputPath,
        ], { timeout: 30000 });
        console.log(`🔏 Signature embedded (no overlays): ${sigFilename}`);
        return res.json({ url: `/uploads/${sigFilename}`, message: 'Signature embedded' });
      } catch (sigErr) {
        console.error('Signature embed error:', sigErr.message);
        // Fallback: return original
        return res.json({ url: videoUrl, noOverlays: true });
      }
    }

    // Probe video dimensions AND rotation
    // Phone videos often have rotation metadata: raw stream is landscape (e.g. 480x360)
    // but display matrix says -90° rotation → actual display is portrait (360x480).
    // FFmpeg auto-rotates when re-encoding, so our overlay PNG must match DISPLAYED dimensions.
    let videoWidth = 1080, videoHeight = 1920; // default 9:16 portrait
    let rotation = 0;
    try {
      // Get stream dimensions
      const probeResult = await execFile('ffprobe', [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=width,height',
        '-of', 'csv=p=0',
        sourcePath,
      ], { timeout: 10000 });
      const dims = probeResult.stdout.trim().split(',');
      if (dims.length >= 2) {
        videoWidth = parseInt(dims[0]) || 1080;
        videoHeight = parseInt(dims[1]) || 1920;
      }

      // Get rotation from side_data (display matrix) or stream tags
      try {
        const rotResult = await execFile('ffprobe', [
          '-v', 'error',
          '-select_streams', 'v:0',
          '-show_entries', 'stream_side_data=rotation:stream_tags=rotate',
          '-of', 'csv=p=0',
          sourcePath,
        ], { timeout: 10000 });
        const rotStr = rotResult.stdout.trim();
        if (rotStr) {
          // Parse rotation value — could be "-90" or "90" or "180"
          const rotNum = parseInt(rotStr.replace(/[^-\d]/g, ''));
          if (!isNaN(rotNum)) rotation = rotNum;
        }
      } catch (rotErr) {
        // Some videos don't have rotation — that's fine
      }
    } catch (probeErr) {
      console.warn('Could not probe video dimensions, using defaults:', probeErr.message);
    }

    // If video has ±90° rotation, FFmpeg auto-rotates during re-encode
    // so the OUTPUT dimensions are swapped — our overlay must match the output
    let overlayWidth = videoWidth;
    let overlayHeight = videoHeight;
    if (Math.abs(rotation) === 90 || Math.abs(rotation) === 270) {
      overlayWidth = videoHeight;
      overlayHeight = videoWidth;
      console.log(`🔄 Video has ${rotation}° rotation — swapping overlay dims to ${overlayWidth}x${overlayHeight}`);
    }
    console.log(`📐 Video raw: ${videoWidth}x${videoHeight}, rotation: ${rotation}°, overlay: ${overlayWidth}x${overlayHeight}`);

    // === GENERATE PNG OVERLAY IMAGE ===
    // Instead of FFmpeg drawtext (which requires libfreetype), we create a transparent PNG
    // with the text/logo rendered on it, then use FFmpeg's overlay filter to composite it.
    const { createCanvas } = require('canvas');
    const overlayCanvas = createCanvas(overlayWidth, overlayHeight);
    const ctx = overlayCanvas.getContext('2d');

    // Text overlays
    if (hasText) {
      textOverlays.forEach((overlay) => {
        const text = overlay.text || '';
        // Scale font relative to the shorter dimension for consistent sizing
        const refDim = Math.min(overlayWidth, overlayHeight);
        const fontSize = Math.max(16, Math.round(refDim * 0.05));
        ctx.font = `bold ${fontSize}px Helvetica, Arial, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';

        let yPos;
        if (overlay.position === 'top') {
          yPos = Math.round(overlayHeight * 0.08);
        } else if (overlay.position === 'bottom') {
          yPos = Math.round(overlayHeight * 0.92);
        } else {
          yPos = Math.round(overlayHeight / 2);
        }

        // Semi-transparent background bar
        const barHeight = Math.round(fontSize * 2);
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(0, yPos - barHeight / 2, overlayWidth, barHeight);

        // White text — centered both horizontally and vertically in the bar
        ctx.fillStyle = '#ffffff';
        ctx.fillText(text, overlayWidth / 2, yPos);
      });
    }

    // Logo overlay — uses real brand logo image if available, falls back to "LOGO" text
    if (hasLogo) {
      const lo = logoOverlay;
      const refDim = Math.min(overlayWidth, overlayHeight);
      const opacity = lo.opacity || 0.7;
      const pos = lo.position || 'bottom-right';
      const margin = Math.round(refDim * 0.04);

      // Try to load real brand logo image
      let logoImageLoaded = false;
      const logoUrl = lo.logoUrl || null; // passed from frontend or resolved from brand
      if (logoUrl && logoUrl.startsWith('/uploads/')) {
        try {
          const { loadImage } = require('canvas');
          const logoPath = path.join(uploadsDir, path.basename(logoUrl));
          if (fs.existsSync(logoPath)) {
            const logoImg = await loadImage(logoPath);
            // Scale logo to fit — max height ~8% of overlay height
            const maxH = Math.round(overlayHeight * 0.08);
            const scale = Math.min(1, maxH / logoImg.height);
            const drawW = Math.round(logoImg.width * scale);
            const drawH = Math.round(logoImg.height * scale);

            let lx, ly;
            if (pos === 'top-left') { lx = margin; ly = margin; }
            else if (pos === 'top-right') { lx = overlayWidth - drawW - margin; ly = margin; }
            else if (pos === 'bottom-left') { lx = margin; ly = overlayHeight - drawH - margin; }
            else { lx = overlayWidth - drawW - margin; ly = overlayHeight - drawH - margin; }

            ctx.globalAlpha = opacity;
            ctx.drawImage(logoImg, lx, ly, drawW, drawH);
            ctx.globalAlpha = 1.0;
            logoImageLoaded = true;
            console.log(`🖼️ Real brand logo rendered: ${drawW}x${drawH} at ${pos}`);
          }
        } catch (logoErr) {
          console.warn('Could not load brand logo image, using text fallback:', logoErr.message);
        }
      }

      // Fallback: render brand initials if no logo image available
      if (!logoImageLoaded) {
        const logoFontSize = Math.max(12, Math.round(refDim * 0.04));
        const padding = Math.round(logoFontSize * 0.6);

        ctx.font = `800 ${logoFontSize}px Helvetica, Arial, sans-serif`;
        ctx.textBaseline = 'middle';
        const logoText = lo.brandInitials || 'KP';
        const lw = ctx.measureText(logoText).width;
        const boxW = lw + padding * 2;
        const boxH = logoFontSize + padding * 1.5;

        let boxX, boxY;
        if (pos === 'top-left') { boxX = margin; boxY = margin; }
        else if (pos === 'top-right') { boxX = overlayWidth - boxW - margin; boxY = margin; }
        else if (pos === 'bottom-left') { boxX = margin; boxY = overlayHeight - boxH - margin; }
        else { boxX = overlayWidth - boxW - margin; boxY = overlayHeight - boxH - margin; }

        ctx.globalAlpha = opacity;
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.fillRect(boxX, boxY, boxW, boxH);
        ctx.fillStyle = '#1a1a2e';
        ctx.fillText(logoText, boxX + padding, boxY + boxH / 2);
        ctx.globalAlpha = 1.0;
      }
    }

    // Save overlay PNG to a temp file
    const overlayFilename = `overlay-${Date.now()}.png`;
    const overlayPath = path.join(uploadsDir, overlayFilename);
    const pngBuffer = overlayCanvas.toBuffer('image/png');
    fs.writeFileSync(overlayPath, pngBuffer);

    const outputFilename = `rendered-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
    const outputPath = path.join(uploadsDir, outputFilename);

    // FFmpeg: overlay the PNG on top of the video
    // When using -filter_complex, FFmpeg does NOT auto-rotate the video input.
    // We must handle rotation explicitly so the overlay aligns with the final output.
    let filterComplex;
    // Normalize rotation to 0-359 range
    const normRot = ((rotation % 360) + 360) % 360;
    if (normRot === 90 || normRot === 270) {
      // rotation=270° (or -90°, typical iPhone portrait) → rotate 90° CW to display correctly → transpose=1
      // rotation=90° → rotate 90° CCW to display correctly → transpose=2
      const transposeVal = normRot === 270 ? 1 : 2;
      filterComplex = `[0:v]transpose=${transposeVal}[rotated];[rotated][1:v]overlay=0:0`;
    } else if (normRot === 180) {
      filterComplex = `[0:v]transpose=1,transpose=1[rotated];[rotated][1:v]overlay=0:0`;
    } else {
      // No rotation needed (0°)
      filterComplex = `[0:v][1:v]overlay=0:0`;
    }

    // -noautorotate is an INPUT option — must go BEFORE -i
    const args = [
      '-y',
      '-noautorotate',        // Disable auto-rotation (we handle it via transpose in filter)
      '-i', sourcePath,
      '-i', overlayPath,
      '-filter_complex', filterComplex,
      '-c:v', 'libx264',
      '-preset', 'fast',
      '-crf', '23',
      '-c:a', 'copy',
    ];

    // Embed Content Signature as MP4 metadata
    if (signaturePayload) {
      args.push('-metadata', `comment=${signaturePayload}`);
      args.push('-metadata', `description=KeepUsPostd Content Signature`);
    }

    args.push('-movflags', '+faststart', outputPath);

    console.log(`🎨 Rendering video with PNG overlay: ${path.basename(videoUrl)} → ${outputFilename}`);

    try {
      await execFile('ffmpeg', args, { timeout: 120000 });
    } catch (ffErr) {
      console.error('FFmpeg overlay render error:', ffErr.message);
      // Clean up overlay file
      try { fs.unlinkSync(overlayPath); } catch (e) {}
      return res.status(500).json({ error: 'Could not render video with overlays' });
    }

    // Clean up the temporary overlay PNG
    try { fs.unlinkSync(overlayPath); } catch (e) {}

    if (!fs.existsSync(outputPath)) {
      return res.status(500).json({ error: 'Rendered file was not created' });
    }

    const outputUrl = `/uploads/${outputFilename}`;
    console.log(`✅ Render complete: ${outputFilename}`);

    res.json({ url: outputUrl, message: 'Video rendered with overlays' });
  } catch (error) {
    console.error('Render with overlays error:', error.message);
    res.status(500).json({ error: 'Could not render video' });
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
