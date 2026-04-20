// Brand Website Scraping Service
// Fetches a public URL, parses HTML for brand info (name, description, logo,
// colors, social handles). Designed with SSRF protection, timeouts, and
// strict size limits to prevent abuse.
//
// Exported: scrapeBrandFromUrl(url) → { name, description, logoUrl, imageUrl, themeColor, socials }

const cheerio = require('cheerio');
const dns = require('dns').promises;
const net = require('net');
const { Image, createCanvas } = require('canvas');

const FETCH_TIMEOUT_MS = 8000;          // 8s network timeout
const IMAGE_FETCH_TIMEOUT_MS = 5000;    // 5s for image downloads
const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2 MB max HTML
const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // 3 MB max image
const USER_AGENT = 'KeepUsPostd-BrandScraper/1.0 (+https://keepuspostd.com)';

// ── URL Validation ────────────────────────────────────────
function validateAndNormalizeUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let candidate = raw.trim();
  if (!candidate) return null;
  // Prepend https:// if no protocol
  if (!/^https?:\/\//i.test(candidate)) candidate = 'https://' + candidate;
  let parsed;
  try { parsed = new URL(candidate); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;
  // Reject credentialed URLs (potential SSRF vector)
  if (parsed.username || parsed.password) return null;
  return parsed;
}

// ── SSRF: Private-IP Check ────────────────────────────────
// Blocks private, loopback, link-local, multicast, and metadata-service ranges.
function isPrivateIPv4(ip) {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  if (a === 10) return true;                      // 10.0.0.0/8
  if (a === 127) return true;                     // loopback
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;        // 192.168.0.0/16
  if (a === 169 && b === 254) return true;        // link-local + AWS metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 0) return true;                       // 0.0.0.0/8
  if (a >= 224) return true;                      // multicast + reserved
  return false;
}

function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  if (lower.startsWith('fe80:') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
  if (lower.startsWith('ff')) return true; // multicast
  // IPv4-mapped (::ffff:a.b.c.d)
  if (lower.startsWith('::ffff:')) {
    const v4 = lower.slice(7);
    if (v4.includes('.')) return isPrivateIPv4(v4);
  }
  return false;
}

async function checkSSRFSafe(hostname) {
  // Block literal private IPs and common localhost variants at the string level
  if (/^(localhost|localhost\.localdomain|0|0\.0\.0\.0)$/i.test(hostname)) return false;
  // Resolve hostname to IPs and check each
  let addrs;
  try { addrs = await dns.lookup(hostname, { all: true, verbatim: true }); }
  catch { return false; }
  if (!addrs || addrs.length === 0) return false;
  for (const { address, family } of addrs) {
    if (family === 4 && isPrivateIPv4(address)) return false;
    if (family === 6 && isPrivateIPv6(address)) return false;
    if (!net.isIP(address)) return false;
  }
  return true;
}

// ── Safe Fetch with Timeout + Size Cap ────────────────────
async function safeFetch(url, { followRedirect = true, maxRedirects = 3 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let currentUrl = url;
  let redirects = 0;

  try {
    while (redirects <= maxRedirects) {
      const parsed = validateAndNormalizeUrl(currentUrl);
      if (!parsed) throw new Error('Invalid URL during fetch');
      const safe = await checkSSRFSafe(parsed.hostname);
      if (!safe) throw new Error('URL resolves to a blocked address');

      const res = await fetch(parsed.href, {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,*/*;q=0.8' },
      });

      // Follow 3xx manually (so we can re-run SSRF checks on redirect targets)
      if (res.status >= 300 && res.status < 400 && followRedirect) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error('Redirect without Location header');
        currentUrl = new URL(loc, parsed).href;
        redirects++;
        continue;
      }

      if (!res.ok) throw new Error('Upstream returned ' + res.status);

      // Cap the body size to prevent memory exhaustion
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_HTML_BYTES) {
          reader.cancel();
          break; // silently truncate — we probably have enough of the <head> by now
        }
        chunks.push(value);
      }
      const buf = Buffer.concat(chunks.map(c => Buffer.from(c)));
      return { html: buf.toString('utf8'), finalUrl: parsed };
    }
    throw new Error('Too many redirects');
  } finally {
    clearTimeout(timer);
  }
}

// ── Helpers ───────────────────────────────────────────────
function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

function absolutize(maybeRelative, baseUrl) {
  if (!maybeRelative) return '';
  try { return new URL(maybeRelative, baseUrl).href; } catch { return ''; }
}

function normalizeThemeColor(c) {
  if (!c || typeof c !== 'string') return '';
  const s = c.trim().toLowerCase();
  // Accept #rgb or #rrggbb; reject named colors / rgb()/hsl() for now
  if (!/^#([0-9a-f]{3}){1,2}$/.test(s)) return '';
  // Expand #rgb to #rrggbb
  const hex = s.length === 4
    ? '#' + s[1] + s[1] + s[2] + s[2] + s[3] + s[3]
    : s;
  // Reject near-white / near-black / neutral-grey values. Those are almost
  // always page backgrounds or browser-chrome hints, not brand colors.
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const saturation = max === 0 ? 0 : (max - min) / max; // 0 = fully desaturated
  if (max > 235) return '';        // too close to white (covers #f5f5f5, #fff, etc.)
  if (max < 30) return '';         // too close to black
  if (saturation < 0.1) return ''; // neutral grey regardless of brightness
  return hex;
}

function extractSocialHandle(href, pattern) {
  const m = href.match(pattern);
  return m ? m[1] : '';
}

// ── HTML Parsing ──────────────────────────────────────────
function parseBrandFromHtml(html, baseUrl) {
  const $ = cheerio.load(html);
  const meta = (name) => $('meta[property="' + name + '"]').attr('content') || $('meta[name="' + name + '"]').attr('content') || '';

  const name = firstNonEmpty(
    meta('og:site_name'),
    meta('og:title'),
    $('title').first().text(),
  );

  const description = firstNonEmpty(
    meta('og:description'),
    meta('twitter:description'),
    meta('description'),
  );

  // Logo detection — try progressively, ordered by likelihood of being the
  // real brand logo (biggest/clearest first). Candidates flow into color
  // extraction one-by-one until one yields a usable dominant color.
  const iconCandidates = [
    $('link[rel="apple-touch-icon"]').first().attr('href'),
    $('link[rel="apple-touch-icon-precomposed"]').first().attr('href'),
    $('link[rel="icon"][sizes="192x192"]').first().attr('href'),
    $('link[rel="icon"][sizes="180x180"]').first().attr('href'),
    $('link[rel="icon"][sizes="128x128"]').first().attr('href'),
    $('link[rel="icon"]').first().attr('href'),
    $('link[rel="shortcut icon"]').first().attr('href'),
    $('link[rel="mask-icon"]').first().attr('href'),
  ];

  // Scan <header> and <nav> for <img> tags that look like a logo
  // (alt text matching the brand name, class/src/alt containing "logo", etc.)
  const siteName = firstNonEmpty(
    meta('og:site_name'),
    meta('og:title'),
    $('title').first().text(),
  ).toLowerCase();
  const inlineLogoCandidates = [];
  $('header img, nav img, [class*="logo" i] img, img[class*="logo" i], img[alt*="logo" i]').each((_, el) => {
    const src = $(el).attr('src');
    const alt = String($(el).attr('alt') || '').toLowerCase();
    if (!src) return;
    // Heuristic: alt or src mentions "logo" or matches the brand name
    const srcL = src.toLowerCase();
    const brandWords = siteName.split(/\s+/).filter(w => w.length >= 4);
    const altMatches = brandWords.some(w => alt.includes(w));
    const srcMatches = /logo/i.test(srcL) || brandWords.some(w => srcL.includes(w));
    if (altMatches || srcMatches) inlineLogoCandidates.push(src);
  });

  const logoCandidates = [
    ...iconCandidates,
    ...inlineLogoCandidates,
    // og:image as a last-resort color source — not actually a logo, but often
    // a brand-colored hero image good enough for dominant-color extraction
    meta('og:image'),
    meta('twitter:image'),
    '/favicon.ico',
  ].map(href => absolutize(href, baseUrl.href)).filter(Boolean);
  // Deduplicate while preserving order
  const seenUrls = new Set();
  const dedupedCandidates = logoCandidates.filter(u => {
    if (seenUrls.has(u)) return false;
    seenUrls.add(u);
    return true;
  });
  const logoUrl = iconCandidates.map(h => absolutize(h, baseUrl.href)).filter(Boolean)[0]
    || inlineLogoCandidates.map(h => absolutize(h, baseUrl.href)).filter(Boolean)[0]
    || '';

  const imageUrl = absolutize(
    firstNonEmpty(meta('og:image'), meta('twitter:image')),
    baseUrl.href,
  );

  const themeColor = normalizeThemeColor(meta('theme-color'));

  // Scan all anchor hrefs for known social platforms — prefer first non-empty
  const socials = { instagram: '', twitter: '', tiktok: '', facebook: '', linkedin: '', youtube: '' };
  $('a[href]').each((_, el) => {
    const href = String($(el).attr('href') || '').trim();
    if (!href) return;
    if (!socials.instagram) {
      const h = extractSocialHandle(href, /instagram\.com\/([A-Za-z0-9_.]+)/i);
      if (h && h !== 'p' && h !== 'reel') socials.instagram = '@' + h;
    }
    if (!socials.twitter) {
      const h = extractSocialHandle(href, /(?:twitter|x)\.com\/([A-Za-z0-9_]+)/i);
      if (h && h !== 'intent' && h !== 'share') socials.twitter = '@' + h;
    }
    if (!socials.tiktok) {
      const h = extractSocialHandle(href, /tiktok\.com\/@([A-Za-z0-9_.]+)/i);
      if (h) socials.tiktok = '@' + h;
    }
    if (!socials.facebook) {
      const h = extractSocialHandle(href, /facebook\.com\/([A-Za-z0-9_.-]+)/i);
      if (h && h !== 'sharer') socials.facebook = href;
    }
    if (!socials.linkedin) {
      if (/linkedin\.com\/(company|in)\//i.test(href)) socials.linkedin = href;
    }
    if (!socials.youtube) {
      if (/youtube\.com\/(channel|user|c|@)/i.test(href)) socials.youtube = href;
    }
  });

  return {
    name,
    description: description.substring(0, 500),
    logoUrl,
    logoCandidates: dedupedCandidates,
    imageUrl,
    themeColor,
    socials,
  };
}

// ── Image Fetching (with SSRF, size, type guards) ─────────
async function fetchImageBuffer(rawUrl) {
  const parsed = validateAndNormalizeUrl(rawUrl);
  if (!parsed) return null;
  const safe = await checkSSRFSafe(parsed.hostname);
  if (!safe) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(parsed.href, {
      method: 'GET',
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'image/*' },
    });
    if (!res.ok) return null;
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    // Skip SVG (canvas can't decode vectors natively) and anything non-image
    if (!ct.startsWith('image/') || ct.includes('svg')) return null;

    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_IMAGE_BYTES) {
        reader.cancel();
        return null; // too big
      }
      chunks.push(value);
    }
    return { buffer: Buffer.concat(chunks.map(c => Buffer.from(c))), contentType: ct };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Dominant Color Extraction ─────────────────────────────
// Decodes image with canvas, samples 64×64 pixels, buckets colors coarsely,
// filters out near-white/black/transparent, picks the most-frequent bucket,
// and returns its average color as #rrggbb.
function extractDominantColor(imageBuffer) {
  if (!imageBuffer || !Buffer.isBuffer(imageBuffer)) return '';
  let img;
  try {
    img = new Image();
    img.src = imageBuffer;
    if (!img.width || !img.height) return '';
  } catch {
    return '';
  }

  const SIZE = 64;
  let canvas, ctx, pixels;
  try {
    canvas = createCanvas(SIZE, SIZE);
    ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, SIZE, SIZE);
    pixels = ctx.getImageData(0, 0, SIZE, SIZE).data;
  } catch {
    return '';
  }

  // Bucket each pixel into a coarse grid (5 bits/channel → 32^3 = 32k buckets).
  // Keep sum + count per bucket so we can return the bucket's average at the end.
  const buckets = new Map();
  for (let i = 0; i < pixels.length; i += 4) {
    const r = pixels[i], g = pixels[i + 1], b = pixels[i + 2], a = pixels[i + 3];
    if (a < 128) continue;                    // skip transparent
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    if (max > 240 && min > 220) continue;     // near-white
    if (max < 25) continue;                   // near-black
    const sat = max === 0 ? 0 : (max - min) / max;
    if (sat < 0.15) continue;                 // too grey
    const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    let entry = buckets.get(key);
    if (!entry) { entry = { r: 0, g: 0, b: 0, n: 0 }; buckets.set(key, entry); }
    entry.r += r; entry.g += g; entry.b += b; entry.n++;
  }

  if (buckets.size === 0) return '';
  let best = null;
  for (const entry of buckets.values()) {
    if (!best || entry.n > best.n) best = entry;
  }
  if (!best) return '';
  const r = Math.round(best.r / best.n);
  const g = Math.round(best.g / best.n);
  const b = Math.round(best.b / best.n);
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('').toLowerCase();
}

// Try each logo candidate until one yields a usable color.
async function colorFromLogoCandidates(candidates) {
  for (const url of (candidates || [])) {
    if (!url) continue;
    // Skip obvious SVGs by extension (content-type check happens in fetch too)
    if (/\.svg(\?|$)/i.test(url)) continue;
    const result = await fetchImageBuffer(url);
    if (!result) continue;
    const color = extractDominantColor(result.buffer);
    if (color && normalizeThemeColor(color)) {
      return { color: normalizeThemeColor(color), sourceUrl: url };
    }
  }
  return null;
}

// ── Public API ────────────────────────────────────────────
async function scrapeBrandFromUrl(rawUrl) {
  const parsed = validateAndNormalizeUrl(rawUrl);
  if (!parsed) throw Object.assign(new Error('Invalid URL'), { status: 400 });

  const safe = await checkSSRFSafe(parsed.hostname);
  if (!safe) throw Object.assign(new Error('URL is not reachable or is blocked'), { status: 400 });

  const { html, finalUrl } = await safeFetch(parsed.href);
  const parsedData = parseBrandFromHtml(html, finalUrl);

  // If no usable meta theme-color, try extracting from the logo image.
  // Keeps page alive if extraction fails — color just stays empty.
  let colorSource = parsedData.themeColor ? 'meta' : '';
  if (!parsedData.themeColor && parsedData.logoCandidates.length > 0) {
    try {
      const extracted = await colorFromLogoCandidates(parsedData.logoCandidates);
      if (extracted) {
        parsedData.themeColor = extracted.color;
        colorSource = 'logo';
      }
    } catch (err) {
      // Swallow — the scrape is still useful without color
      console.warn('[scrape] color extraction failed:', err.message);
    }
  }

  // Clean up the internal field before responding
  const { logoCandidates, ...response } = parsedData;
  response.colorSource = colorSource; // 'meta' | 'logo' | ''
  return response;
}

module.exports = {
  scrapeBrandFromUrl,
  // Exposed for tests / other services
  _internals: { validateAndNormalizeUrl, checkSSRFSafe, parseBrandFromHtml },
};
