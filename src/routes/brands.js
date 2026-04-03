// Brand Routes — CRUD + Team Members
// Enforces: G1 (brand isolation), G2 (one owner), G9 (hard plan limits)
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requireBrandRole } = require('../middleware/brandAccess');
const { Brand, BrandProfile, BrandMember } = require('../models');
const { startTrial, checkTrialStatus } = require('../services/trial');
const notify = require('../services/notifications');

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
      brandColors: brandColors || undefined,
      kioskBrandCode,
      brandHandle,
    });

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
    console.error('Create brand error:', error.message);
    res.status(500).json({ error: 'Could not create brand' });
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

    // Attach role, initials, and plan info to every brand
    const brandsWithRoles = brands.map(brand => {
      const membership = memberships.find(m => m.brandId.equals(brand._id));
      const obj = brand.toObject();
      obj.initials = computeInitials(obj.name);
      return {
        ...obj,
        userRole:            membership ? membership.role : null,
        planTier:            effectiveTier,
        trialActive:         trialActive,
        trialTier:           trialTier,
        trialDaysRemaining:  trialDaysLeft,
      };
    });

    res.json({ brands: brandsWithRoles });
  } catch (error) {
    console.error('List brands error:', error.message);
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

// GET /api/brands/:brandId — Get single brand details
router.get('/:brandId', requireAuth, requireBrandRole('viewer'), async (req, res) => {
  try {
    const brand = await Brand.findById(req.params.brandId);

    if (!brand || brand.status === 'deleted') {
      return res.status(404).json({ error: 'Brand not found' });
    }

    // Recompute initials for consistency (single word = first letter only)
    const brandObj = brand.toObject();
    brandObj.initials = computeInitials(brandObj.name);
    res.json({
      brand: brandObj,
      userRole: req.brandMembership.role,
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
      'email', 'phone', 'address', 'city', 'state', 'zip', 'socialLinks',
      'brandColors'];

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
    const brandDomain = brand.websiteUrl ? new URL(brand.websiteUrl).hostname.replace('www.', '') : null;
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
