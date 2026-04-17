// Brand Routes — CRUD + Team Members
// Enforces: G1 (brand isolation), G2 (one owner), G9 (hard plan limits)
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requireBrandRole } = require('../middleware/brandAccess');
const { Brand, BrandProfile, BrandMember, BrandInvite, User } = require('../models');
const crypto = require('crypto');
const { startTrial, checkTrialStatus } = require('../services/trial');
const notify = require('../services/notifications');

// Auto-geocode a brand's city to GeoJSON coordinates (non-blocking)
async function geocodeBrand(brandId, city) {
  if (!city) return;
  try {
    const query = encodeURIComponent(city);
    const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${query}&format=json&limit=1`, {
      headers: { 'User-Agent': 'KeepUsPostd-Geocoder/1.0' },
    });
    const data = await res.json();
    if (data && data.length > 0) {
      const lat = parseFloat(data[0].lat);
      const lon = parseFloat(data[0].lon);
      await Brand.updateOne({ _id: brandId }, {
        coordinates: { type: 'Point', coordinates: [lon, lat] },
      });
      console.log(`📍 Geocoded brand ${brandId}: ${city} → [${lon}, ${lat}]`);
    }
  } catch (e) {
    console.error(`📍 Geocode failed for ${city}:`, e.message);
  }
}

// Generate consistent brand initials: single word → first letter, multi-word → first letter of each (max 3)
function computeInitials(name) {
  if (!name) return 'K';
  const words = name.trim().split(/\s+/);
  return words.length === 1
    ? words[0].charAt(0).toUpperCase()
    : words.map(w => w.charAt(0)).join('').toUpperCase().substring(0, 3);
}

// Plan limits from PLATFORM_ARCHITECTURE.md
const PLAN_LIMITS = {
  starter: { brands: 1, campaignsPerBrand: 1, influencers: 10, adminSeats: 1 },
  growth: { brands: 3, campaignsPerBrand: 5, influencers: 100, adminSeats: 3 },
  pro: { brands: 10, campaignsPerBrand: 20, influencers: 500, adminSeats: 10 },
  agency: { brands: 25, campaignsPerBrand: 50, influencers: 2000, adminSeats: 25 },
  enterprise: { brands: Infinity, campaignsPerBrand: Infinity, influencers: Infinity, adminSeats: Infinity },
};

// POST /api/brands — Create a new brand
// Reserved handles that can't be used as brand handles
const RESERVED_HANDLES = new Set([
  'api', 'brand', 'brands', 'pages', 'app', 'images', 'js', 'css',
  'privacy', 'help', 'delete-account', 'auth', 'admin', 'keepuspostd',
  'kup', 'support', 'login', 'register', 'signup', 'dashboard',
]);

function sanitizeHandle(raw) {
  return (raw || '').toLowerCase().replace(/[^a-z0-9_]/g, '').substring(0, 30);
}

router.post('/', requireAuth, async (req, res) => {
  try {
    const { name, category, description, websiteUrl, tags, brandColors, brandHandle: rawHandle } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({
        error: 'Brand name required',
        message: 'Please enter a name for your brand.',
      });
    }

    // Get or create brand profile
    let trialJustStarted = false;
    let brandProfile = await BrandProfile.findOne({ userId: req.user._id });
    if (!brandProfile) {
      const referralCode = 'BRD-' + Math.random().toString(36).substring(2, 8).toUpperCase();
      brandProfile = await BrandProfile.create({
        userId: req.user._id,
        referralCode,
      });
      // Start 14-day free trial (Pro-level access, no CC required)
      await startTrial(brandProfile);
      trialJustStarted = true;
      req.user.hasBrandProfile = true;
      req.user.activeProfile = req.user.activeProfile || 'brand';
      await req.user.save();
    }

    // Check plan limit using effective tier (respects active trial)
    const { effectiveTier: planTier } = checkTrialStatus(brandProfile);
    const limit = PLAN_LIMITS[planTier].brands;
    const currentCount = brandProfile.ownedBrandIds.length;

    if (currentCount >= limit) {
      return res.status(403).json({
        error: 'Plan limit reached',
        message: `Your ${planTier} plan allows ${limit} brand(s). Upgrade to add more.`,
        currentPlan: planTier,
        limit,
        current: currentCount,
      });
    }

    // Generate initials and color from name
    const initials = computeInitials(name);

    // Deterministic color from name hash
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const generatedColor = '#' + ((hash >> 0) & 0xFFFFFF).toString(16).padStart(6, '0');

    // Generate a unique kiosk brand code (avoids duplicate null index issue)
    const kioskBrandCode = 'KUP-' + Math.random().toString(36).substring(2, 8).toUpperCase();

    // Validate and assign brand handle if provided
    let brandHandle = null;
    if (rawHandle) {
      const handle = sanitizeHandle(rawHandle);
      if (handle.length < 3) {
        return res.status(400).json({ error: 'Handle must be at least 3 characters (letters, numbers, underscores only).' });
      }
      if (RESERVED_HANDLES.has(handle)) {
        return res.status(400).json({ error: 'That handle is reserved. Please choose another.' });
      }
      const taken = await Brand.findOne({ brandHandle: handle });
      if (taken) {
        return res.status(400).json({ error: 'That handle is already taken. Please choose another.' });
      }
      brandHandle = handle;
    }

    // Create the brand
    const brand = await Brand.create({
      name: name.trim(),
      brandType: 'user',
      profileSource: 'user',
      createdBy: req.user._id,
      claimStatus: 'n/a',
      category: category || null,
      description: description || null,
      websiteUrl: websiteUrl || null,
      tags: tags || [],
      initials,
      generatedColor,
      brandColors: brandColors || { primary: generatedColor, secondary: generatedColor },
      kioskBrandCode,
      ...(brandHandle ? { brandHandle } : {}),
    });

    // Auto-geocode city (non-blocking — doesn't delay response)
    if (req.body.city) {
      geocodeBrand(brand._id, req.body.city).catch(() => {});
    }

    // Create brand member with owner role (rule G2: one owner)
    await BrandMember.create({
      brandId: brand._id,
      userId: req.user._id,
      role: 'owner',
      status: 'active',
      acceptedAt: new Date(),
    });

    // Update brand profile
    brandProfile.ownedBrandIds.push(brand._id);
    if (!brandProfile.primaryBrandId) {
      brandProfile.primaryBrandId = brand._id;
    }
    await brandProfile.save();

    // Auto-complete onboarding when first brand is created (safety net)
    if (!req.user.onboardingComplete) {
      req.user.onboardingComplete = true;
      await req.user.save();
    }

    console.log(`✅ Brand created: "${brand.name}" by ${req.user.email}`);

    // Fire trial-started welcome notification for first brand (non-blocking)
    if (trialJustStarted) {
      notify.trialStarted({
        brand: { ...brand.toObject(), ownerEmail: req.user.email, ownerId: req.user._id },
        trialEndsAt: brandProfile.trialEndsAt,
        trialTier: brandProfile.trialTier,
      }).catch(err => console.error('[brands] notify.trialStarted error:', err.message));
    }

    res.status(201).json({
      message: 'Brand created successfully',
      brand,
    });
  } catch (error) {
    console.error('Create brand error:', error.message, error.stack);
    // Surface the actual error message for debugging (E11000 duplicate key, etc.)
    const msg = error.code === 11000
      ? 'A brand with that name or code already exists. Please try a different name.'
      : error.message || 'Could not create brand';
    res.status(500).json({ error: msg });
  }
});

// GET /api/brands — List brands for current user
router.get('/', requireAuth, async (req, res) => {
  try {
    // Find all brands where user is a member
    const memberships = await BrandMember.find({
      userId: req.user._id,
      status: 'active',
    });

    const brandIds = memberships.map(m => m.brandId);
    const brands = await Brand.find({
      _id: { $in: brandIds },
      status: { $ne: 'deleted' },
    });

    // Resolve plan + trial status from the user's BrandProfile (single lookup)
    const brandProfile = await BrandProfile.findOne({ userId: req.user._id });
    const trialStatus = brandProfile ? checkTrialStatus(brandProfile) : null;
    const effectiveTier  = trialStatus ? trialStatus.effectiveTier : 'starter';
    const trialActive    = !!(trialStatus && trialStatus.trial && trialStatus.trial.active);
    const trialTier      = trialActive ? trialStatus.trial.tier : null;
    const trialDaysLeft  = trialActive ? (trialStatus.trial.daysRemaining || 0) : 0;

    // Attach role, initials, plan info, and stats to every brand
    const { Campaign } = require('../models');
    const { Partnership, ContentSubmission } = require('../models');

    const brandsWithRoles = await Promise.all(brands.map(async (brand) => {
      const membership = memberships.find(m => m.brandId.equals(brand._id));
      const obj = brand.toObject();
      obj.initials = computeInitials(obj.name);

      // Fetch stats in parallel
      const [activeCampaigns, totalInfluencers, totalContent] = await Promise.all([
        Campaign.countDocuments({ brandId: brand._id, status: 'active' }).catch(() => 0),
        Partnership.countDocuments({ brandId: brand._id, status: 'active' }).catch(() => 0),
        ContentSubmission.countDocuments({ brandId: brand._id }).catch(() => 0),
      ]);

      return {
        ...obj,
        userRole:            membership ? membership.role : null,
        planTier:            effectiveTier,
        trialActive:         trialActive,
        trialTier:           trialTier,
        trialDaysRemaining:  trialDaysLeft,
        stats: { activeCampaigns, totalInfluencers, totalContent },
      };
    }));

    res.json({ brands: brandsWithRoles });
  } catch (error) {
    console.error('List brands error:', error.message);
    res.status(500).json({ error: 'Could not fetch brands' });
  }
});

// GET /api/brands/discover — All active brands for influencer discovery screen
// Returns every active brand regardless of membership. Used by Flutter Trending Brands.
// MUST be before /:brandId to prevent "discover" being treated as a brandId
router.get('/discover', requireAuth, async (req, res) => {
  try {
    const { category, search } = req.query;
    const filter = { status: { $ne: 'deleted' } };

    if (category && category !== 'all') filter.category = { $regex: category, $options: 'i' };
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: 'i' } },
        { category: { $regex: search, $options: 'i' } },
      ];
    }

    const brands = await Brand.find(filter)
      .select('name category description logoUrl heroImageUrl brandColors brandType claimStatus ownerId status')
      .sort({ createdAt: -1 })
      .limit(500)
      .lean();

    // Shuffle results so brands appear in random order on Discover
    for (let i = brands.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [brands[i], brands[j]] = [brands[j], brands[i]];
    }

    const brandsWithInitials = brands.map(b => ({
      ...b,
      initials: computeInitials(b.name),
    }));

    res.json({ brands: brandsWithInitials });
  } catch (error) {
    console.error('Discover brands error:', error.message);
    res.status(500).json({ error: 'Could not fetch brands' });
  }
});

// GET /api/brands/public/:identifier — lookup by @handle OR kioskBrandCode (no auth — QR landing page)
// MUST be before /:brandId to prevent "public" being treated as a brandId
router.get('/public/:identifier', async (req, res) => {
  try {
    const id = req.params.identifier.replace(/^@/, ''); // strip leading @ if present
    const selectFields = 'name initials generatedColor brandColors logoUrl heroImageUrl description category websiteUrl kioskBrandCode brandHandle ownerId claimStatus brandType';

    let brand;

    // If identifier looks like a MongoDB ObjectId (24-char hex), try _id first
    if (/^[a-f0-9]{24}$/i.test(id)) {
      brand = await Brand.findById(id).select(selectFields).lean();
    }

    // Fall back to handle or kiosk code lookup
    if (!brand) {
      brand = await Brand.findOne({
        $or: [
          { brandHandle: id.toLowerCase() },
          { kioskBrandCode: id.toUpperCase() },
        ],
      }).select(selectFields).lean();
    }

    if (!brand) return res.status(404).json({ error: 'Brand not found' });
    res.json({ brand });
  } catch (error) {
    console.error('Public brand lookup error:', error);
    res.status(500).json({ error: 'Failed to load brand' });
  }
});

// GET /api/brands/check-handle/:handle — check handle availability (no auth)
router.get('/check-handle/:handle', async (req, res) => {
  try {
    const handle = sanitizeHandle(req.params.handle);
    if (handle.length < 3) return res.json({ available: false, reason: 'Too short' });
    if (RESERVED_HANDLES.has(handle)) return res.json({ available: false, reason: 'Reserved' });
    const taken = await Brand.findOne({ brandHandle: handle });
    res.json({ available: !taken, handle });
  } catch (error) {
    res.status(500).json({ error: 'Check failed' });
  }
});

// ── Invite routes: MUST be before /:brandId to avoid param shadowing ──────────

// GET /api/brands/invite/preview?token=xxx — Public: returns brand + invite info for landing page
router.get('/invite/preview', async (req, res) => {
  try {
    const { token } = req.query;
    if (!token) return res.status(400).json({ error: 'Token required' });

    const invite = await BrandInvite.findOne({ token, inviteType: 'team_member' })
      .populate('brandId', 'name logoUrl heroImageUrl')
      .populate('sentBy', 'legalFirstName displayName email')
      .lean();

    if (!invite) return res.status(404).json({ error: 'Invite not found or already used' });
    if (invite.status !== 'pending') return res.status(410).json({ error: 'This invite has already been accepted' });
    if (new Date() > new Date(invite.expiresAt)) return res.status(410).json({ error: 'This invite link has expired' });

    const inviterName = invite.sentBy?.legalFirstName || invite.sentBy?.displayName || invite.sentBy?.email?.split('@')[0] || 'Someone';
    const brand = invite.brandId;

    res.json({
      brandName: brand?.name || 'Unknown Brand',
      brandLogo: brand?.logoUrl || null,
      role: invite.role,
      inviterName,
      email: invite.email,
      expiresAt: invite.expiresAt,
    });
  } catch (error) {
    console.error('Invite preview error:', error.message);
    res.status(500).json({ error: 'Could not load invite' });
  }
});

// POST /api/brands/invite/accept — Requires auth: accept a team invite by token
router.post('/invite/accept', requireAuth, async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });

    const invite = await BrandInvite.findOne({ token, inviteType: 'team_member' })
      .populate('brandId', 'name logoUrl')
      .lean();

    if (!invite) return res.status(404).json({ error: 'Invite not found or already used' });
    if (invite.status !== 'pending') return res.status(410).json({ error: 'This invite has already been accepted' });
    if (new Date() > new Date(invite.expiresAt)) return res.status(410).json({ error: 'This invite link has expired' });

    // Verify the logged-in user's email matches the invite email
    const userEmail = req.user.email?.toLowerCase();
    if (userEmail !== invite.email) {
      return res.status(403).json({
        error: 'This invite was sent to a different email address',
        detail: `This invite was sent to ${invite.email}. Please log in with that account to accept.`,
      });
    }

    // Check for existing active membership
    const existing = await BrandMember.findOne({ brandId: invite.brandId._id, userId: req.user._id });
    if (existing && existing.status === 'active') {
      return res.status(409).json({ error: 'You are already a member of this brand' });
    }

    // Create or update BrandMember → active
    await BrandMember.findOneAndUpdate(
      { brandId: invite.brandId._id, userId: req.user._id },
      {
        role: invite.role,
        status: 'active',
        invitedBy: invite.sentBy,
        invitedAt: invite.createdAt,
        acceptedAt: new Date(),
      },
      { upsert: true, new: true }
    );

    // Mark invite as accepted
    await BrandInvite.findByIdAndUpdate(invite._id, {
      status: 'accepted',
      acceptedAt: new Date(),
      acceptedByUserId: req.user._id,
    });

    console.log(`✅ Team invite accepted: ${req.user.email} joined brand ${invite.brandId.name} as ${invite.role}`);
    res.json({
      message: `Welcome to ${invite.brandId.name}!`,
      brandId: invite.brandId._id,
      brandName: invite.brandId.name,
      role: invite.role,
    });
  } catch (error) {
    console.error('Invite accept error:', error.message);
    res.status(500).json({ error: 'Could not accept invite' });
  }
});

// ── Brand CRUD ─────────────────────────────────────────────────────────────────

// GET /api/brands/:brandId — Get single brand details + live stats
// Any authenticated user can view a brand (influencers, partners, admins).
// Returns: brand, userRole, stats { influencerCount, reviewCount, rating }
router.get('/:brandId', requireAuth, async (req, res) => {
  try {
    const brand = await Brand.findById(req.params.brandId);

    if (!brand || brand.status === 'deleted') {
      return res.status(404).json({ error: 'Brand not found' });
    }

    // Recompute initials for consistency (single word = first letter only)
    const brandObj = brand.toObject();
    brandObj.initials = computeInitials(brandObj.name);

    // Load live stats + membership check in parallel
    const { Partnership, ContentSubmission } = require('../models');
    const [membership, influencerCount, reviewCount, ratedPartnerships] = await Promise.all([
      BrandMember.findOne({ brandId: brand._id, userId: req.user._id, status: 'active' }),
      Partnership.countDocuments({ brandId: brand._id, status: 'active' }),
      ContentSubmission.countDocuments({ brandId: brand._id }),
      // Ratings come from influencer feedback on partnerships
      Partnership.find(
        { brandId: brand._id, 'influencerRating.overall': { $ne: null } },
        'influencerRating.overall'
      ).lean(),
    ]);

    // Average brand rating across all submitted influencer ratings
    const rating = ratedPartnerships.length > 0
      ? Math.round(
          (ratedPartnerships.reduce((sum, p) => sum + (p.influencerRating?.overall ?? 0), 0) / ratedPartnerships.length) * 10
        ) / 10
      : null;

    res.json({
      brand: brandObj,
      userRole: membership ? membership.role : 'viewer',
      stats: {
        influencerCount,
        reviewCount,
        rating,
      },
    });
  } catch (error) {
    console.error('Get brand error:', error.message);
    res.status(500).json({ error: 'Could not fetch brand' });
  }
});

// PUT /api/brands/:brandId — Update brand
router.put('/:brandId', requireAuth, requireBrandRole('admin'), async (req, res) => {
  try {
    const allowedFields = ['name', 'category', 'subcategory', 'description',
      'websiteUrl', 'tags', 'logoUrl', 'heroImageUrl', 'location',
      'email', 'phone', 'address', 'city', 'state', 'zip', 'coordinates',
      'socialLinks', 'brandColors'];

    const updates = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    }

    const brand = await Brand.findByIdAndUpdate(
      req.params.brandId,
      { $set: updates },
      { new: true, runValidators: true }
    );

    res.json({ message: 'Brand updated', brand });
  } catch (error) {
    console.error('Update brand error:', error.message);
    res.status(500).json({ error: 'Could not update brand' });
  }
});

// GET /api/brands/:brandId/members — List team members
router.get('/:brandId/members', requireAuth, requireBrandRole('viewer'), async (req, res) => {
  try {
    const members = await BrandMember.find({
      brandId: req.params.brandId,
      status: { $ne: 'removed' },
    }).populate('userId', 'email legalFirstName legalLastName');

    res.json({ members });
  } catch (error) {
    console.error('List members error:', error.message);
    res.status(500).json({ error: 'Could not fetch members' });
  }
});

// POST /api/brands/:brandId/members/invite — Invite a team member by email (admin+ only)
router.post('/:brandId/members/invite', requireAuth, requireBrandRole('admin'), async (req, res) => {
  try {
    const { email, role } = req.body;
    if (!email || !role) return res.status(400).json({ error: 'email and role are required' });

    const validRoles = ['admin', 'manager', 'viewer'];
    if (!validRoles.includes(role)) return res.status(400).json({ error: 'Invalid role' });

    const brand = await Brand.findById(req.params.brandId).lean();
    if (!brand) return res.status(404).json({ error: 'Brand not found' });

    // ── Plan enforcement: team member seat limits ──
    const { checkTrialStatus } = require('../services/trial');
    const bp = await BrandProfile.findOne({ ownedBrandIds: brand._id });
    const { effectiveTier } = checkTrialStatus(bp);
    const seatLimit = (PLAN_LIMITS[effectiveTier] || PLAN_LIMITS.starter).adminSeats;
    const activeMembers = await BrandMember.countDocuments({ brandId: brand._id, status: 'active' });
    if (activeMembers >= seatLimit) {
      return res.status(403).json({
        error: 'plan_required',
        message: `Your ${effectiveTier} plan allows ${seatLimit} team member${seatLimit > 1 ? 's' : ''}. Upgrade to add more.`,
        currentMembers: activeMembers,
        seatLimit,
        currentPlan: effectiveTier,
      });
    }

    const { sendEmail } = require('../config/email');

    // Check if user already exists and is already an active member
    const existingUser = await User.findOne({ email: email.toLowerCase() }).lean();
    if (existingUser) {
      const existingMember = await BrandMember.findOne({ brandId: brand._id, userId: existingUser._id });
      if (existingMember && existingMember.status === 'active') {
        return res.status(409).json({ error: 'This user is already an active team member' });
      }
    }

    // Generate a secure invite token (works for both new + existing users)
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    // Upsert BrandInvite record keyed by brand + email
    await BrandInvite.findOneAndUpdate(
      { brandId: brand._id, email: email.toLowerCase(), inviteType: 'team_member' },
      {
        role,
        token,
        expiresAt,
        status: 'pending',
        sentBy: req.user._id,
        acceptedAt: null,
        acceptedByUserId: null,
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    // Build accept URL with token
    const acceptUrl = `${process.env.APP_URL || 'https://keepuspostd.com'}/app/invite-accept.html?token=${token}`;
    const inviterName = req.user.legalFirstName || req.user.displayName || req.user.email.split('@')[0];
    const roleName = role.charAt(0).toUpperCase() + role.slice(1);

    await sendEmail({
      to: email,
      subject: `${inviterName} invited you to manage ${brand.name} on KeepUsPostd`,
      preheader: `${inviterName} invited you to manage ${brand.name}`,
      headline: `You've been invited to join ${brand.name}`,
      bodyHtml: `<p><strong>${inviterName}</strong> has invited you to manage <strong>${brand.name}</strong> on KeepUsPostd as a <strong>${roleName}</strong>.</p>
        <p style="font-size:13px;color:#999;margin-top:16px;">This link expires in 7 days. If you don't have a KeepUsPostd account yet, you'll be prompted to create one.</p>`,
      ctaText: 'Accept Invitation →',
      ctaUrl: acceptUrl,
      variant: 'brand',
    });

    console.log(`📧 Team invite sent to ${email} for brand ${brand.name} (role: ${role})`);
    res.json({ message: `Invite sent to ${email}`, email, role });
  } catch (error) {
    console.error('Team invite error:', error.message);
    res.status(500).json({ error: 'Could not send invite' });
  }
});

// DELETE /api/brands/:brandId/members/:memberId — Remove a team member (owner/admin only)
router.delete('/:brandId/members/:memberId', requireAuth, requireBrandRole('admin'), async (req, res) => {
  try {
    const member = await BrandMember.findOne({
      _id: req.params.memberId,
      brandId: req.params.brandId,
    });

    if (!member) {
      return res.status(404).json({ error: 'Team member not found' });
    }

    if (member.role === 'owner') {
      return res.status(400).json({ error: 'Cannot remove the brand owner' });
    }

    member.status = 'removed';
    await member.save();

    console.log(`🗑️ Team member ${req.params.memberId} removed from brand ${req.params.brandId}`);
    res.json({ message: 'Team member removed' });
  } catch (error) {
    console.error('Remove member error:', error.message);
    res.status(500).json({ error: 'Could not remove team member' });
  }
});

// ── Claim Your Brand (public-facing) ──────────────────────
// POST /api/brands/:id/claim — Submit a claim request for an admin brand
router.post('/:id/claim', async (req, res) => {
  try {
    const brand = await Brand.findById(req.params.id);
    if (!brand) return res.status(404).json({ error: 'Brand not found' });
    if (brand.brandType !== 'admin' || brand.claimStatus !== 'unclaimed') {
      return res.status(400).json({ error: 'This brand is not available for claiming' });
    }

    const { claimerName, claimerTitle, claimerEmail, claimerPhone, authorizationStatement } = req.body;
    if (!claimerName || !claimerEmail) {
      return res.status(400).json({ error: 'Name and email are required' });
    }

    // Check for duplicate pending claim
    const existingClaim = await require('../models/ClaimRequest').findOne({
      brandId: brand._id,
      status: 'pending',
    });
    if (existingClaim) {
      return res.status(409).json({ error: 'A claim request is already pending for this brand' });
    }

    // Auto-validate email domain
    let brandDomain = null;
    try { if (brand.websiteUrl) brandDomain = new URL(brand.websiteUrl).hostname.replace('www.', ''); } catch (_) {}
    const emailDomain = claimerEmail.split('@')[1];
    const emailDomainMatch = brandDomain ? emailDomain === brandDomain : false;

    const claim = await require('../models/ClaimRequest').create({
      brandId: brand._id,
      claimerName,
      claimerTitle: claimerTitle || null,
      claimerEmail,
      claimerPhone: claimerPhone || null,
      authorizationStatement: authorizationStatement || null,
      emailDomainMatch,
      duplicateClaim: false,
    });

    // Update brand claim status to pending
    brand.claimStatus = 'pending';
    await brand.save();

    res.status(201).json({ success: true, message: 'Claim submitted for review', claimId: claim._id });
  } catch (error) {
    console.error('Brand claim error:', error);
    res.status(500).json({ error: 'Failed to submit claim' });
  }
});

module.exports = router;
