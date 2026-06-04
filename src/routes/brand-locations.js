// brand-locations.js — Locations CRUD + public locator for franchises.
//
// Two surfaces:
//
//   PUBLIC (in-app franchise locator)
//     GET  /api/brand-locations/brand/:brandId               — list active
//     GET  /api/brand-locations/brand/:brandId?lat=X&lon=Y   — distance-sorted
//
//   BRAND PORTAL (auth: active BrandMember on the brand)
//     POST   /api/brand-locations/brand/:brandId             — add location
//     PUT    /api/brand-locations/:locationId                — edit
//     DELETE /api/brand-locations/:locationId                — soft delete
//
// Geocoding fallback uses Nominatim (OpenStreetMap) when no Google Maps key
// is configured. Each geocode is rate-limited politely (no parallel calls).
//
// Primary-location invariant: exactly one isPrimary=true per brand. The
// create/update handlers enforce this by clearing other primaries when one
// is set.

const express = require('express');
const router = express.Router();
const { BrandLocation, BrandMember } = require('../models');
const { requireAuth } = require('../middleware/auth');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Verify the requester is an active member of the given brand. Returns the
 * BrandMember doc on success, sends 403 on failure (and returns null).
 */
async function requireBrandMember(req, res, brandId) {
  const member = await BrandMember.findOne({
    brandId,
    userId: req.user._id,
    status: 'active',
  }).lean();
  if (!member) {
    res.status(403).json({ error: 'You do not have access to this brand' });
    return null;
  }
  return member;
}

/**
 * Free geocoding fallback via Nominatim. Returns [lon, lat] or null on
 * failure. Uses native fetch (Node 18+). Polite rate via a small delay.
 *
 * Why this is fine for KUP volume: brand-portal location adds are low
 * frequency (humans editing forms). For high-volume use cases swap in
 * Google Geocoding by setting GOOGLE_MAPS_API_KEY.
 */
async function geocodeAddress({ address, city, state, zip, country }) {
  const parts = [address, city, state, zip, country].filter(Boolean);
  if (parts.length === 0) return null;
  const query = encodeURIComponent(parts.join(', '));

  // Prefer Google if a key is configured. Cleaner data, better rate limits.
  if (process.env.GOOGLE_MAPS_API_KEY) {
    try {
      const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${query}&key=${process.env.GOOGLE_MAPS_API_KEY}`;
      const r = await fetch(url);
      const data = await r.json();
      const loc = data?.results?.[0]?.geometry?.location;
      if (loc && typeof loc.lat === 'number' && typeof loc.lng === 'number') {
        return [loc.lng, loc.lat];
      }
    } catch (err) {
      console.warn('[geocode google]', err.message);
    }
  }

  // Free fallback — Nominatim. Requires a User-Agent per their TOS.
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${query}`;
    const r = await fetch(url, {
      headers: { 'User-Agent': 'KeepUsPostd/1.0 (santana@keepuspostd.com)' },
    });
    const data = await r.json();
    if (Array.isArray(data) && data.length > 0) {
      const lat = parseFloat(data[0].lat);
      const lon = parseFloat(data[0].lon);
      if (!isNaN(lat) && !isNaN(lon)) return [lon, lat];
    }
  } catch (err) {
    console.warn('[geocode nominatim]', err.message);
  }
  return null;
}

/**
 * Clear primary flag on every other active location for this brand. Used
 * before setting a new primary so the "exactly one" invariant holds.
 */
async function clearOtherPrimaries(brandId, exceptId) {
  await BrandLocation.updateMany(
    {
      brandId,
      isActive: true,
      _id: { $ne: exceptId },
      isPrimary: true,
    },
    { $set: { isPrimary: false } }
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC: list locations for a brand
// ─────────────────────────────────────────────────────────────────────────────
//
// GET /api/brand-locations/brand/:brandId
// Optional ?lat=X&lon=Y → returns distance-sorted (closest first) with
// distanceMi computed per row. Without lat/lon, returns isPrimary-first then
// alphabetical name.
//
// Only active locations are returned. Closed locations stay in the DB for
// historical reference but are never surfaced to viewers.
router.get('/brand/:brandId', async (req, res) => {
  try {
    const { brandId } = req.params;
    const { lat, lon } = req.query;

    const hasGeo = lat && lon && !isNaN(parseFloat(lat)) && !isNaN(parseFloat(lon));

    if (hasGeo) {
      const latitude = parseFloat(lat);
      const longitude = parseFloat(lon);
      // Use aggregation with $geoNear so we get distance per row in one query.
      const docs = await BrandLocation.aggregate([
        {
          $geoNear: {
            near: { type: 'Point', coordinates: [longitude, latitude] },
            distanceField: 'distanceMeters',
            spherical: true,
            query: { brandId: new (require('mongoose')).Types.ObjectId(brandId), isActive: true },
          },
        },
      ]);
      const locations = docs.map(d => ({
        ...d,
        // Convert to miles + round to 1 decimal — what the locator UI shows.
        distanceMi: d.distanceMeters != null ? Math.round((d.distanceMeters / 1609.34) * 10) / 10 : null,
      }));
      return res.json({ locations });
    }

    const docs = await BrandLocation.find({ brandId, isActive: true })
      .sort({ isPrimary: -1, name: 1 })
      .lean();
    res.json({ locations: docs });
  } catch (err) {
    console.error('[GET /brand-locations/brand]', err.message);
    res.status(500).json({ error: 'Could not load locations' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// BRAND PORTAL: add a location
// ─────────────────────────────────────────────────────────────────────────────
router.post('/brand/:brandId', requireAuth, async (req, res) => {
  try {
    const { brandId } = req.params;
    const member = await requireBrandMember(req, res, brandId);
    if (!member) return;

    const {
      name, address, city, state, zip, country,
      placeId, coordinates: providedCoords, isPrimary,
    } = req.body;

    // Resolve coordinates: if the client sent valid coords (e.g. from Places
    // autocomplete), use them; otherwise geocode from the address fields.
    let coordinates = null;
    if (providedCoords && Array.isArray(providedCoords.coordinates) && providedCoords.coordinates.length === 2) {
      coordinates = { type: 'Point', coordinates: providedCoords.coordinates };
    } else if (address || city) {
      const geo = await geocodeAddress({ address, city, state, zip, country });
      if (geo) coordinates = { type: 'Point', coordinates: geo };
    }

    // First location for a brand is auto-primary even if caller doesn't ask.
    const existingCount = await BrandLocation.countDocuments({ brandId, isActive: true });
    const shouldBePrimary = !!isPrimary || existingCount === 0;

    const created = await BrandLocation.create({
      brandId,
      name:      name || city || 'Main location',
      address:   address || '',
      city:      city || '',
      state:     state || '',
      zip:       zip || '',
      country:   country || 'US',
      placeId:   placeId || null,
      coordinates,
      isPrimary: shouldBePrimary,
      isActive:  true,
    });

    if (shouldBePrimary) await clearOtherPrimaries(brandId, created._id);

    res.json({ location: created });
  } catch (err) {
    console.error('[POST /brand-locations/brand]', err);
    res.status(500).json({ error: 'Could not add location' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// BRAND PORTAL: update a location
// ─────────────────────────────────────────────────────────────────────────────
//
// PUT-only-what-changed semantics: any field omitted from the request body is
// left alone. Mirrors the field-level edit pattern used in add-brand.html so
// the portal can do per-field saves without sending the full doc.
router.put('/:locationId', requireAuth, async (req, res) => {
  try {
    const location = await BrandLocation.findById(req.params.locationId);
    if (!location) return res.status(404).json({ error: 'Location not found' });

    const member = await requireBrandMember(req, res, location.brandId);
    if (!member) return;

    const fields = ['name', 'address', 'city', 'state', 'zip', 'country', 'placeId'];
    const changed = {};
    for (const f of fields) {
      if (Object.prototype.hasOwnProperty.call(req.body, f)) {
        location[f] = req.body[f] || '';
        changed[f] = true;
      }
    }

    // If any address component changed and we don't have client-supplied
    // coordinates this turn, re-geocode. Avoids stale coords after an edit.
    const addressChanged = ['address', 'city', 'state', 'zip', 'country'].some(f => changed[f]);
    if (req.body.coordinates && Array.isArray(req.body.coordinates.coordinates) && req.body.coordinates.coordinates.length === 2) {
      location.coordinates = { type: 'Point', coordinates: req.body.coordinates.coordinates };
    } else if (addressChanged) {
      const geo = await geocodeAddress({
        address: location.address,
        city:    location.city,
        state:   location.state,
        zip:     location.zip,
        country: location.country,
      });
      if (geo) location.coordinates = { type: 'Point', coordinates: geo };
    }

    if (Object.prototype.hasOwnProperty.call(req.body, 'isPrimary')) {
      location.isPrimary = !!req.body.isPrimary;
    }

    await location.save();

    if (location.isPrimary) await clearOtherPrimaries(location.brandId, location._id);

    res.json({ location });
  } catch (err) {
    console.error('[PUT /brand-locations]', err);
    res.status(500).json({ error: 'Could not update location' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// BRAND PORTAL: soft-delete a location
// ─────────────────────────────────────────────────────────────────────────────
//
// Hard rule: refuse to delete the LAST active location. The brand always has
// at least one primary location while it exists. To "close" a brand entirely
// the brand should deactivate at the Brand level, not by deleting locations.
router.delete('/:locationId', requireAuth, async (req, res) => {
  try {
    const location = await BrandLocation.findById(req.params.locationId);
    if (!location) return res.status(404).json({ error: 'Location not found' });

    const member = await requireBrandMember(req, res, location.brandId);
    if (!member) return;

    const activeCount = await BrandLocation.countDocuments({
      brandId:  location.brandId,
      isActive: true,
    });
    if (activeCount <= 1) {
      return res.status(400).json({
        error: 'A brand must keep at least one active location. Add another location before removing this one.',
      });
    }

    location.isActive = false;
    location.isPrimary = false; // can't be primary if deactivated
    await location.save();

    // If we just removed the primary, promote the most-recently-created
    // remaining active location to primary so the invariant holds.
    const stillHasPrimary = await BrandLocation.exists({
      brandId: location.brandId, isActive: true, isPrimary: true,
    });
    if (!stillHasPrimary) {
      const next = await BrandLocation.findOne({
        brandId: location.brandId, isActive: true,
      }).sort({ createdAt: -1 });
      if (next) {
        next.isPrimary = true;
        await next.save();
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('[DELETE /brand-locations]', err);
    res.status(500).json({ error: 'Could not delete location' });
  }
});

module.exports = router;
