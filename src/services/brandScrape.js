// Brand Website Scraping Service
// Fetches a public URL, parses HTML for brand info (name, description, logo,
// colors, social handles). Designed with SSRF protection, timeouts, and
// strict size limits to prevent abuse.
//
// Exported: scrapeBrandFromUrl(url) → { name, description, logoUrl, imageUrl, themeColor, socials }

const cheerio = require('cheerio');
const dns = require('dns').promises;
const net = require('net');

const FETCH_TIMEOUT_MS = 8000;          // 8s network timeout
const MAX_HTML_BYTES = 2 * 1024 * 1024; // 2 MB max HTML
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

  const logoUrl = absolutize(
    firstNonEmpty(
      $('link[rel="apple-touch-icon"]').first().attr('href'),
      $('link[rel="icon"][sizes="192x192"]').first().attr('href'),
      $('link[rel="icon"]').first().attr('href'),
      $('link[rel="shortcut icon"]').first().attr('href'),
    ),
    baseUrl.href,
  );

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
    imageUrl,
    themeColor,
    socials,
  };
}

// ── Public API ────────────────────────────────────────────
async function scrapeBrandFromUrl(rawUrl) {
  const parsed = validateAndNormalizeUrl(rawUrl);
  if (!parsed) throw Object.assign(new Error('Invalid URL'), { status: 400 });

  const safe = await checkSSRFSafe(parsed.hostname);
  if (!safe) throw Object.assign(new Error('URL is not reachable or is blocked'), { status: 400 });

  const { html, finalUrl } = await safeFetch(parsed.href);
  return parseBrandFromHtml(html, finalUrl);
}

module.exports = {
  scrapeBrandFromUrl,
  // Exposed for tests / other services
  _internals: { validateAndNormalizeUrl, checkSSRFSafe, parseBrandFromHtml },
};
