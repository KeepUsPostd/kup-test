const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { GoogleBusinessConfig, Brand } = require('../models');

// ── Helpers ──────────────────────────────────────────────

const GBP_SCOPES = 'https://www.googleapis.com/auth/business.manage';

function getRedirectUri() {
  return process.env.GOOGLE_REDIRECT_URI || 'https://keepuspostd.com/api/google-business/callback';
}

async function exchangeCodeForTokens(code) {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri:  getRedirectUri(),
      grant_type:    'authorization_code',
    }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error('Token exchange failed: ' + err);
  }
  return resp.json(); // { access_token, refresh_token, expires_in, token_type }
}

async function refreshAccessToken(refreshToken) {
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id:     process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type:    'refresh_token',
    }),
  });
  if (!resp.ok) throw new Error('Token refresh failed');
  return resp.json();
}

// Get a valid access token (auto-refresh if expired)
async function getValidAccessToken(config) {
  const configWithTokens = await GoogleBusinessConfig
    .findById(config._id)
    .select('+accessToken +refreshToken');

  if (!configWithTokens.accessToken) throw new Error('No access token stored');

  // Refresh if within 5 minutes of expiry
  if (configWithTokens.tokenExpiry && new Date() > new Date(configWithTokens.tokenExpiry.getTime() - 5 * 60 * 1000)) {
    if (!configWithTokens.refreshToken) throw new Error('No refresh token — reconnect required');
    const tokens = await refreshAccessToken(configWithTokens.refreshToken);
    configWithTokens.accessToken = tokens.access_token;
    configWithTokens.tokenExpiry = new Date(Date.now() + (tokens.expires_in - 60) * 1000);
    await configWithTokens.save();
    return tokens.access_token;
  }

  return configWithTokens.accessToken;
}

async function gbpFetch(url, accessToken, options = {}) {
  const resp = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`GBP API error ${resp.status}: ${err}`);
  }
  return resp.json();
}

// ── Routes ───────────────────────────────────────────────

// GET /api/google-business/auth-url
// Redirects to Google OAuth consent screen
// Query: ?brandId=<mongoId>
router.get('/auth-url', requireAuth, async (req, res) => {
  try {
    const brandId = req.query.brandId;
    if (!brandId) return res.status(400).json({ error: 'brandId required' });

    // Encode brandId + userId in state for callback verification
    const state = Buffer.from(JSON.stringify({ brandId, userId: req.user._id.toString() })).toString('base64url');

    const params = new URLSearchParams({
      client_id:    process.env.GOOGLE_CLIENT_ID,
      redirect_uri: getRedirectUri(),
      response_type:'code',
      scope:        GBP_SCOPES,
      access_type:  'offline',
      prompt:       'consent',
      state,
    });

    res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
  } catch (err) {
    console.error('[GBP] auth-url error:', err.message);
    res.status(500).json({ error: 'Could not generate auth URL' });
  }
});

// GET /api/google-business/callback
// Google redirects here after user grants consent
router.get('/callback', async (req, res) => {
  try {
    const { code, state, error } = req.query;

    if (error) {
      console.error('[GBP] OAuth denied:', error);
      return res.redirect('/pages/inner/google-business.html?error=access_denied');
    }

    if (!code || !state) return res.redirect('/pages/inner/google-business.html?error=invalid_callback');

    // Decode state
    let stateData;
    try {
      stateData = JSON.parse(Buffer.from(state, 'base64url').toString());
    } catch (e) {
      return res.redirect('/pages/inner/google-business.html?error=invalid_state');
    }

    const { brandId, userId } = stateData;

    // Exchange code for tokens
    const tokens = await exchangeCodeForTokens(code);

    // Get the Google account ID
    const accountsResp = await gbpFetch(
      'https://mybusinessaccountmanagement.googleapis.com/v1/accounts',
      tokens.access_token
    );
    const googleAccountId = accountsResp.accounts?.[0]?.name || null; // e.g. "accounts/123456789"

    // Upsert config
    await GoogleBusinessConfig.findOneAndUpdate(
      { brandId },
      {
        brandId,
        googleAccountId,
        accessToken:       tokens.access_token,
        refreshToken:      tokens.refresh_token || undefined, // preserve existing refresh token if not returned
        tokenExpiry:       new Date(Date.now() + (tokens.expires_in - 60) * 1000),
        connectedAt:       new Date(),
        connectedByUserId: userId,
        // Reset location — user must select after connecting
        locationId:      null,
        locationName:    null,
        locationAddress: null,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    console.log(`[GBP] Connected brand ${brandId} → Google account ${googleAccountId}`);
    res.redirect('/pages/inner/google-business.html?connected=true');
  } catch (err) {
    console.error('[GBP] callback error:', err.message);
    res.redirect('/pages/inner/google-business.html?error=callback_failed');
  }
});

// GET /api/google-business/config
// Returns current GBP config for a brand (no tokens)
router.get('/config', requireAuth, async (req, res) => {
  try {
    const brandId = req.query.brandId;
    if (!brandId) return res.status(400).json({ error: 'brandId required' });

    const config = await GoogleBusinessConfig.findOne({ brandId });
    if (!config) return res.json({ connected: false, config: null });

    res.json({
      connected: !!(config.locationId),
      pendingLocation: !!(config.googleAccountId && !config.locationId),
      config: {
        locationName:    config.locationName,
        locationAddress: config.locationAddress,
        connectedAt:     config.connectedAt,
        settings:        config.settings,
      },
    });
  } catch (err) {
    console.error('[GBP] config error:', err.message);
    res.status(500).json({ error: 'Could not fetch GBP config' });
  }
});

// PUT /api/google-business/config
// Save settings
router.put('/config', requireAuth, async (req, res) => {
  try {
    const { brandId, settings } = req.body;
    if (!brandId) return res.status(400).json({ error: 'brandId required' });

    const config = await GoogleBusinessConfig.findOneAndUpdate(
      { brandId },
      { $set: { settings } },
      { new: true }
    );

    if (!config) return res.status(404).json({ error: 'GBP config not found' });

    res.json({ message: 'Settings saved', settings: config.settings });
  } catch (err) {
    console.error('[GBP] save config error:', err.message);
    res.status(500).json({ error: 'Could not save settings' });
  }
});

// GET /api/google-business/locations
// List all GBP locations for the connected account
router.get('/locations', requireAuth, async (req, res) => {
  try {
    const brandId = req.query.brandId;
    if (!brandId) return res.status(400).json({ error: 'brandId required' });

    const config = await GoogleBusinessConfig.findOne({ brandId });
    if (!config || !config.googleAccountId) {
      return res.status(400).json({ error: 'Google account not connected' });
    }

    const accessToken = await getValidAccessToken(config);

    const data = await gbpFetch(
      `https://mybusinessbusinessinformation.googleapis.com/v1/${config.googleAccountId}/locations?readMask=name,title,storefrontAddress`,
      accessToken
    );

    const locations = (data.locations || []).map(loc => ({
      resourceName: loc.name,
      title: loc.title,
      address: loc.storefrontAddress
        ? [loc.storefrontAddress.addressLines?.[0], loc.storefrontAddress.locality, loc.storefrontAddress.administrativeArea].filter(Boolean).join(', ')
        : '',
    }));

    res.json({ locations });
  } catch (err) {
    console.error('[GBP] locations error:', err.message);
    res.status(500).json({ error: 'Could not fetch locations' });
  }
});

// POST /api/google-business/select-location
// Save the selected location
router.post('/select-location', requireAuth, async (req, res) => {
  try {
    const { brandId, locationId, locationName, locationAddress } = req.body;
    if (!brandId || !locationId) return res.status(400).json({ error: 'brandId and locationId required' });

    const config = await GoogleBusinessConfig.findOneAndUpdate(
      { brandId },
      { locationId, locationName, locationAddress },
      { new: true }
    );

    if (!config) return res.status(404).json({ error: 'GBP config not found' });

    res.json({ message: 'Location saved', locationName, locationAddress });
  } catch (err) {
    console.error('[GBP] select-location error:', err.message);
    res.status(500).json({ error: 'Could not save location' });
  }
});

// DELETE /api/google-business/disconnect
// Revoke tokens and remove config
router.delete('/disconnect', requireAuth, async (req, res) => {
  try {
    const { brandId } = req.body;
    if (!brandId) return res.status(400).json({ error: 'brandId required' });

    const config = await GoogleBusinessConfig.findOne({ brandId }).select('+accessToken +refreshToken');
    if (!config) return res.status(404).json({ error: 'Not connected' });

    // Revoke the token with Google
    const tokenToRevoke = config.refreshToken || config.accessToken;
    if (tokenToRevoke) {
      try {
        await fetch(`https://oauth2.googleapis.com/revoke?token=${tokenToRevoke}`, { method: 'POST' });
      } catch (e) {
        console.warn('[GBP] Token revocation failed (continuing):', e.message);
      }
    }

    await GoogleBusinessConfig.deleteOne({ brandId });

    console.log(`[GBP] Disconnected brand ${brandId}`);
    res.json({ message: 'Google Business Profile disconnected' });
  } catch (err) {
    console.error('[GBP] disconnect error:', err.message);
    res.status(500).json({ error: 'Could not disconnect' });
  }
});

// POST /api/google-business/post
// Create a local post on GBP (called internally when influencer content is approved)
// Body: { brandId, summary, callToActionType, callToActionUrl, mediaUrl }
router.post('/post', requireAuth, async (req, res) => {
  try {
    const { brandId, summary, callToActionType, callToActionUrl, mediaUrl } = req.body;
    if (!brandId || !summary) return res.status(400).json({ error: 'brandId and summary required' });

    const config = await GoogleBusinessConfig.findOne({ brandId });
    if (!config || !config.locationId) {
      return res.status(400).json({ error: 'Google Business not connected or no location selected' });
    }

    const accessToken = await getValidAccessToken(config);

    // Build the local post payload
    // locationId format: "accounts/123/locations/456"
    const postPayload = {
      languageCode: 'en-US',
      summary,
      topicType: 'STANDARD',
    };

    if (callToActionType && callToActionUrl) {
      postPayload.callToAction = { actionType: callToActionType, url: callToActionUrl };
    }

    if (mediaUrl) {
      postPayload.media = [{ mediaFormat: 'PHOTO', sourceUrl: mediaUrl }];
    }

    const result = await gbpFetch(
      `https://mybusiness.googleapis.com/v4/${config.locationId}/localPosts`,
      accessToken,
      { method: 'POST', body: JSON.stringify(postPayload) }
    );

    console.log(`[GBP] Post created for brand ${brandId}: ${result.name}`);
    res.json({ message: 'Post created on Google Business Profile', post: result });
  } catch (err) {
    console.error('[GBP] post error:', err.message);
    res.status(500).json({ error: 'Could not create GBP post', detail: err.message });
  }
});

module.exports = router;
