#!/usr/bin/env node
/**
 * geocode-brands.js
 * Adds GeoJSON coordinates to brands that have city+state but no coordinates.
 * Uses Nominatim (OpenStreetMap) — free, no API key needed.
 * Rate limit: 1 request per 1.1 seconds.
 *
 * Usage (run from kup-test/ root):
 *   node scripts/geocode-brands.js
 *
 * Safe to re-run — skips brands that already have coordinates.
 */

require('dotenv').config({ path: '.env.test' });
const mongoose = require('mongoose');
const https = require('https');
const { Brand } = require('../src/models');

// ── Nominatim geocoder ──────────────────────────────────────────────────────
function geocode(query) {
  return new Promise((resolve, reject) => {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
    const options = {
      headers: { 'User-Agent': 'KeepUsPostd-Geocoder/1.0 (santana@keepuspostd.com)' },
    };
    https.get(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const results = JSON.parse(data);
          if (results.length > 0) {
            resolve({
              lat: parseFloat(results[0].lat),
              lon: parseFloat(results[0].lon),
              display: results[0].display_name,
            });
          } else {
            resolve(null);
          }
        } catch (e) {
          reject(e);
        }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('🌐 Geocode Brands — Starting...\n');

  await mongoose.connect(process.env.MONGODB_URI, {
    dbName: process.env.MONGODB_DB_NAME || 'keepuspostd_test',
  });
  console.log('✅ Connected to MongoDB\n');

  // Find brands with city+state but no coordinates
  const brands = await Brand.find({
    city: { $ne: null, $ne: '' },
    state: { $ne: null, $ne: '' },
    $or: [
      { 'coordinates.coordinates': { $exists: false } },
      { 'coordinates.coordinates': null },
      { 'coordinates.coordinates': { $size: 0 } },
    ],
  }).lean();

  console.log(`Found ${brands.length} brand(s) to geocode.\n`);

  let success = 0;
  let failed = 0;

  for (const brand of brands) {
    const parts = [brand.address, brand.city, brand.state, brand.zip].filter(Boolean);
    const query = parts.join(', ');
    process.stdout.write(`  ${brand.name} → "${query}" ... `);

    try {
      const result = await geocode(query);
      if (result) {
        await Brand.updateOne(
          { _id: brand._id },
          {
            $set: {
              coordinates: {
                type: 'Point',
                coordinates: [result.lon, result.lat], // GeoJSON: [longitude, latitude]
              },
            },
          },
        );
        console.log(`✅ [${result.lat}, ${result.lon}]`);
        success++;
      } else {
        console.log('❌ No results');
        failed++;
      }
    } catch (err) {
      console.log(`❌ Error: ${err.message}`);
      failed++;
    }

    // Rate limit: 1 req / 1.1s
    await sleep(1100);
  }

  console.log(`\n── Done ──`);
  console.log(`  ✅ Geocoded: ${success}`);
  console.log(`  ❌ Failed:   ${failed}`);
  console.log(`  ⏭  Skipped:  (brands already with coordinates)\n`);

  await mongoose.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
