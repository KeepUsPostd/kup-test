const express = require('express');
const router = express.Router();
const geoip = require('geoip-lite');
const { requireAuth } = require('../middleware/auth');
const { Brand, BrandProfile } = require('../models');
const BrandScan = require('../models/BrandScan');

// Helper: detect device from user-agent
function detectDevice(ua) {
  if (!ua) return 'desktop';
  ua = ua.toLowerCase();
  if (/tablet|ipad/.test(ua)) return 'tablet';
  if (/mobile|iphone|android|phone/.test(ua)) return 'mobile';
  return 'desktop';
}

// Helper: get plan tier for a brand
async function getBrandPlanTier(brandId) {
  const { BrandMember } = require('../models');
  const member = await BrandMember.findOne({ brandId, role: 'owner', status: 'active' });
  if (!member) return 'starter';
  const profile = await BrandProfile.findOne({ userId: member.userId });
  return (profile && profile.planTier) || 'starter';
}

const PLAN_DAYS = { starter: 30, growth: 90, pro: 365, agency: 365, enterprise: 365 };
const CAN_EXPORT = ['growth', 'pro', 'agency', 'enterprise'];
const CAN_GEO    = ['pro', 'agency', 'enterprise'];
const CAN_DEVICE = ['growth', 'pro', 'agency', 'enterprise'];
const CAN_CONVERSION = ['pro', 'agency', 'enterprise'];

// POST /api/scan-analytics/track — silent beacon fired from brand-profile.html (no auth)
router.post('/track', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.json({ ok: true });

    // Look up brand by handle or kiosk code
    const { Brand: BrandModel } = require('../models');
    const id = (code || '').replace(/^@/, '');
    const brand = await BrandModel.findOne({
      $or: [
        { brandHandle: id.toLowerCase() },
        { kioskBrandCode: id.toUpperCase() },
      ],
    }).select('_id').lean();
    if (!brand) return res.json({ ok: true });

    // Geo lookup from client IP
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip;
    const geo = geoip.lookup(ip) || {};

    await BrandScan.create({
      brandId:  brand._id,
      device:   detectDevice(req.headers['user-agent']),
      city:     geo.city || null,
      state:    geo.region || null,
      country:  geo.country || 'US',
      scanCode: id,
    });

    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: true }); // never error — this is a silent beacon
  }
});

// GET /api/scan-analytics/:brandId — get scan analytics (auth required, plan-gated)
router.get('/:brandId', requireAuth, async (req, res) => {
  try {
    const planTier = await getBrandPlanTier(req.params.brandId);
    const days = PLAN_DAYS[planTier] || 30;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const scans = await BrandScan.find({
      brandId:   req.params.brandId,
      timestamp: { $gte: since },
    }).sort({ timestamp: -1 }).lean();

    // Total + 7-day trend (all plans)
    const now = Date.now();
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;
    const trend = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now - i * 24 * 60 * 60 * 1000);
      trend[d.toISOString().slice(0, 10)] = 0;
    }
    scans.filter(s => new Date(s.timestamp) >= sevenDaysAgo).forEach(s => {
      const day = new Date(s.timestamp).toISOString().slice(0, 10);
      if (day in trend) trend[day]++;
    });

    const response = {
      planTier,
      days,
      total: scans.length,
      trend: Object.entries(trend).map(([date, count]) => ({ date, count })),
    };

    // Device breakdown (Growth+)
    if (CAN_DEVICE.includes(planTier)) {
      const deviceCounts = { mobile: 0, tablet: 0, desktop: 0 };
      scans.forEach(s => { if (s.device in deviceCounts) deviceCounts[s.device]++; });
      response.devices = deviceCounts;
    }

    // Geo data (Pro+)
    if (CAN_GEO.includes(planTier)) {
      const geoCounts = {};
      scans.forEach(s => {
        if (s.state) {
          geoCounts[s.state] = (geoCounts[s.state] || 0) + 1;
        }
      });
      response.geo = Object.entries(geoCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([state, count]) => ({ state, count }));
    }

    // Conversion data (Pro+)
    if (CAN_CONVERSION.includes(planTier)) {
      const converted = scans.filter(s => s.converted).length;
      response.conversions = { total: converted, rate: scans.length > 0 ? Math.round((converted / scans.length) * 100) : 0 };
    }

    // Daily breakdown for chart (Growth+)
    if (CAN_DEVICE.includes(planTier)) {
      const daily = {};
      scans.forEach(s => {
        const day = new Date(s.timestamp).toISOString().slice(0, 10);
        daily[day] = (daily[day] || 0) + 1;
      });
      response.daily = Object.entries(daily).sort((a, b) => a[0].localeCompare(b[0])).map(([date, count]) => ({ date, count }));
    }

    res.json(response);
  } catch (e) {
    console.error('Scan analytics error:', e);
    res.status(500).json({ error: 'Failed to load analytics' });
  }
});

// GET /api/scan-analytics/:brandId/export — CSV export (Growth+)
router.get('/:brandId/export', requireAuth, async (req, res) => {
  try {
    const planTier = await getBrandPlanTier(req.params.brandId);
    if (!CAN_EXPORT.includes(planTier)) {
      return res.status(403).json({ error: 'CSV export requires Growth plan or higher.' });
    }

    const days = PLAN_DAYS[planTier] || 90;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const scans = await BrandScan.find({ brandId: req.params.brandId, timestamp: { $gte: since } })
      .sort({ timestamp: -1 }).lean();

    const headers = ['Date', 'Time', 'Device', 'City', 'State', 'Country', 'Converted'];
    const rows = scans.map(s => {
      const d = new Date(s.timestamp);
      return [
        d.toISOString().slice(0, 10),
        d.toTimeString().slice(0, 8),
        s.device || '',
        s.city || '',
        s.state || '',
        s.country || '',
        s.converted ? 'Yes' : 'No',
      ].join(',');
    });

    const csv = [headers.join(','), ...rows].join('\n');
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="scan-analytics-${req.params.brandId}.csv"`);
    res.send(csv);
  } catch (e) {
    res.status(500).json({ error: 'Export failed' });
  }
});

module.exports = router;
