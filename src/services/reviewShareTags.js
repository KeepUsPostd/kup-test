// Writes link-preview tags (Open Graph + Twitter) into the Instant Review page
// for a specific brand, so shared recorder links show the brand instead of the
// generic KeepUsPostd text. Pure function: takes the page HTML, returns new HTML.

// Per-brand preview overrides, keyed by brandHandle. Brands not listed here
// get their own name, logo or hero image automatically.
const SHARE_OVERRIDES = {
  risewithwells: {
    title: 'Ida B. Wells · Rise With Wells',
    description: 'Tell us what Ida B. Wells means to you and why you want to see her story on screen. The first 50 approved videos get a free Rise With Wells tee.',
    image: 'https://risewithwells.org/assets/because-of-ida-og.jpg',
    imageWidth: 1200,
    imageHeight: 630,
  },
};

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function httpsUrl(u) {
  return typeof u === 'string' && /^https:\/\//i.test(u) ? u : null;
}

function buildReviewPageHtml(html, brand, pageUrl) {
  if (!html || !brand || !brand.name) return html;
  const o = SHARE_OVERRIDES[(brand.brandHandle || '').toLowerCase()] || {};
  const title = o.title || `${brand.name} · KeepUsPostd`;
  const description = o.description || `Record a quick video for ${brand.name}. No app required.`;
  const image = o.image || httpsUrl(brand.heroImageUrl) || httpsUrl(brand.logoUrl);

  const tags = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="KeepUsPostd">`,
    `<meta property="og:title" content="${esc(title)}">`,
    `<meta property="og:description" content="${esc(description)}">`,
    `<meta property="og:url" content="${esc(pageUrl)}">`,
    image ? `<meta property="og:image" content="${esc(image)}">` : '',
    o.imageWidth ? `<meta property="og:image:width" content="${o.imageWidth}">` : '',
    o.imageHeight ? `<meta property="og:image:height" content="${o.imageHeight}">` : '',
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">`,
    `<meta name="twitter:title" content="${esc(title)}">`,
    `<meta name="twitter:description" content="${esc(description)}">`,
    image ? `<meta name="twitter:image" content="${esc(image)}">` : '',
  ].filter(Boolean).join('\n');

  let out = html.replace(/<title>[^<]*<\/title>/i, `<title>${esc(title)}</title>`);
  out = out.replace(/<meta name="description" content="[^"]*">/i, `<meta name="description" content="${esc(description)}">`);
  return out.replace(/<\/head>/i, `${tags}\n</head>`);
}

module.exports = { buildReviewPageHtml, SHARE_OVERRIDES };
