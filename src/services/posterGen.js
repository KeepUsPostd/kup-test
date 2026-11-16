// Server-side poster (thumbnail) generation for video submissions.
//
// Why this exists: posterUrl used to come from the client or from a GUESSED
// "<video>-poster.jpg" filename, which was unreliable (missing files, or a
// wrong-aspect 200x200 square poster on a 9:16 video → blank thumbnails in the
// app). This generates a guaranteed, correctly-shaped poster from the actual
// video frame and stores it on R2. Used by the submit paths (ensurePoster, non
// -blocking) so every new submission ends up with a real thumbnail.
//
// The bundled ffmpeg cannot read https, so we download the video to a temp
// file first, then extract.

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ffmpegPath = require('ffmpeg-static');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');

const R2_OK = !!(process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_ENDPOINT);
const r2 = R2_OK ? new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT,
  credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
}) : null;
const R2_BUCKET = process.env.R2_BUCKET || 'keepuspostd-uploads';
const R2_PUBLIC = process.env.R2_PUBLIC_URL || '';

function _download(url, dest) {
  return (async () => {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('download ' + resp.status);
    fs.writeFileSync(dest, Buffer.from(await resp.arrayBuffer()));
  })();
}

// Extract one JPEG frame (fit within 720x720, aspect preserved) from a LOCAL
// video, trying later timestamps first so fade-from-black intros don't produce
// a black poster.
function _extract(videoPath, outPath, forcedTs) {
  const ladder = forcedTs != null ? [forcedTs] : [5, 3, 1, 0.5, 0];
  return new Promise((resolve, reject) => {
    const tryAt = (i) => {
      if (i >= ladder.length) return reject(new Error('no frame extracted'));
      const args = ['-y', '-ss', String(ladder[i]), '-i', videoPath, '-frames:v', '1',
        '-vf', 'scale=w=720:h=720:force_original_aspect_ratio=decrease', '-q:v', '3', outPath];
      execFile(ffmpegPath, args, { timeout: 60000 }, (err) => {
        if (!err && fs.existsSync(outPath) && fs.statSync(outPath).size > 0) return resolve(ladder[i]);
        tryAt(i + 1);
      });
    };
    tryAt(0);
  });
}

// Generate a poster from a video URL, upload to R2, return the public URL (or
// null on any failure — callers treat a null poster as "none yet").
async function generatePosterForVideo(videoUrl, opts = {}) {
  if (!R2_OK || !R2_PUBLIC || !videoUrl) return null;
  const rnd = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const tmpVid = path.join(os.tmpdir(), `pgvid-${rnd}`);
  const tmpImg = path.join(os.tmpdir(), `pgimg-${rnd}.jpg`);
  try {
    await _download(videoUrl, tmpVid);
    await _extract(tmpVid, tmpImg, opts.ts);
    const key = `poster-${rnd}.jpg`;
    await r2.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: fs.readFileSync(tmpImg), ContentType: 'image/jpeg' }));
    return `${R2_PUBLIC}/${key}`;
  } catch (e) {
    console.error('[posterGen] generate failed:', (e && e.message) || e);
    return null;
  } finally {
    try { if (fs.existsSync(tmpVid)) fs.unlinkSync(tmpVid); } catch (_) {}
    try { if (fs.existsSync(tmpImg)) fs.unlinkSync(tmpImg); } catch (_) {}
  }
}

// Ensure a submission has a poster. Generates from its video only when one is
// missing (an explicit client poster is kept). Safe to call fire-and-forget; it
// never throws. Reloads the model lazily to avoid require cycles.
async function ensurePoster(submissionId) {
  try {
    const { ContentSubmission } = require('../models');
    const s = await ContentSubmission.findById(submissionId).select('posterUrl mediaUrls contentType').lean();
    if (!s || s.posterUrl) return;                 // already has one
    if (s.contentType !== 'video') return;
    const video = (s.mediaUrls || [])[0];
    if (!video) return;
    const url = await generatePosterForVideo(video);
    if (url) await ContentSubmission.updateOne({ _id: submissionId }, { $set: { posterUrl: url } });
  } catch (e) {
    console.error('[posterGen] ensurePoster failed:', (e && e.message) || e);
  }
}

module.exports = { generatePosterForVideo, ensurePoster };
