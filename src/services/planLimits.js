// Plan Limits — single source of truth for plan tier caps + enforcement helpers
//
// The KUP plan structure was restructured 2026-07-08 to be usage-based
// (monthly approvals) instead of seat-based (influencer slots). Reasons:
//
//   1. Rewards brands only for what they receive, not for how many creators
//      partnered once. A creator who partnered but never returned no longer
//      counts against the brand's limit.
//   2. Predictable monthly billing rhythm — aligns with how brands actually
//      budget for content.
//   3. Cleaner pricing story: "10 reviews/month on the free plan" reads better
//      than "10 influencer seats total ever".
//   4. Unlocks the Instant Review Widget model — any customer can partner via
//      the brand's own website without eating a "seat".
//
// Since there were no paying brands at the time of the switch, no
// grandfathering was required. The old INFLUENCER_SLOT_LIMITS constant lived
// in routes/partnerships.js and was ripped out — partnership creation is
// now unrestricted.
//
// Enforcement point moved from partnership creation to content approval:
//   - Before: creating the Nth+1 partnership returned 403
//   - After:  approving the Nth+1 submission this month returns 402
//     with `upgrade_required` error and clear guidance to bump plan tier.

const { ContentSubmission } = require('../models');

// Monthly approval limits per plan tier.
// Rolling calendar month — resets on the 1st.
// enterprise = Infinity (unlimited).
const MONTHLY_APPROVAL_LIMITS = {
  starter: 10,
  growth: 100,
  pro: 500,
  agency: 2000,
  enterprise: Infinity,
};

// Structural resource limits per plan tier (brands, campaigns, admin seats).
// These are lifetime caps, NOT monthly — they scope structural capacity.
// The old `influencers` field was retired 2026-07-08 in favor of the
// monthlyApprovals limit above (that's the real usage constraint now).
const PLAN_LIMITS = {
  starter:    { brands: 1,        campaignsPerBrand: 1,        monthlyApprovals: 10,       adminSeats: 1 },
  growth:     { brands: 3,        campaignsPerBrand: 5,        monthlyApprovals: 100,      adminSeats: 3 },
  pro:        { brands: 10,       campaignsPerBrand: 20,       monthlyApprovals: 500,      adminSeats: 10 },
  agency:     { brands: 25,       campaignsPerBrand: 50,       monthlyApprovals: 2000,     adminSeats: 25 },
  enterprise: { brands: Infinity, campaignsPerBrand: Infinity, monthlyApprovals: Infinity, adminSeats: Infinity },
};

// ── Helper: count approvals for a brand in the current calendar month
async function currentMonthApprovalCount(brandId) {
  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  return ContentSubmission.countDocuments({
    brandId,
    status: 'approved',
    reviewedAt: { $gte: startOfMonth },
  });
}

// ── Helper: check whether a brand can approve one more submission this month.
// Returns { allowed, used, limit, tier }.
// Callers should return a 402 upgrade_required response when allowed === false.
async function checkMonthlyApprovalCap(brandId, tier) {
  const limit = MONTHLY_APPROVAL_LIMITS[tier] ?? MONTHLY_APPROVAL_LIMITS.starter;
  if (limit === Infinity) {
    return { allowed: true, used: null, limit: Infinity, tier };
  }
  const used = await currentMonthApprovalCount(brandId);
  return {
    allowed: used < limit,
    used,
    limit,
    tier,
  };
}

// ── Helper: build the standard 402 payload for a cap-exceeded response.
// Used by both /api/content/:id/approve and /api/admin-panel/content/:id/moderate.
function capExceededPayload(check) {
  const upgradeTargets = {
    starter: 'growth',
    growth: 'pro',
    pro: 'agency',
    agency: 'enterprise',
  };
  const nextTier = upgradeTargets[check.tier] || 'enterprise';
  const nextLimit = MONTHLY_APPROVAL_LIMITS[nextTier];
  const nextLimitLabel = nextLimit === Infinity ? 'unlimited' : nextLimit.toString();

  return {
    error: 'upgrade_required',
    message: `This brand has reached the ${check.limit}-approval monthly limit on the ${check.tier} plan.`,
    detail: `Approvals reset on the 1st of each month. Upgrade to ${nextTier} to unlock ${nextLimitLabel} approvals/month, or wait until next month.`,
    currentPlan: check.tier,
    limit: check.limit,
    used: check.used,
    action: 'Go to Settings → Plan to upgrade.',
  };
}

module.exports = {
  MONTHLY_APPROVAL_LIMITS,
  PLAN_LIMITS,
  currentMonthApprovalCount,
  checkMonthlyApprovalCap,
  capExceededPayload,
};
