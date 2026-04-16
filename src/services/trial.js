// KUP 14-Day Free Trial Service
// Flow: Sign up → 14 days full Pro access (no CC) → auto-downgrade to Starter
//
// Usage:
//   const { startTrial, checkTrialStatus, processExpiredTrials } = require('../services/trial');
//   await startTrial(brandProfile);                   // Called when brand profile created
//   const status = await checkTrialStatus(brandProfile); // Check current trial state
//   await processExpiredTrials();                     // Cron: downgrade expired trials

const TRIAL_DURATION_DAYS = 14;
const TRIAL_TIER = 'pro'; // Full Pro features during trial

// ── Start Trial ───────────────────────────────────────────
// Called when a new BrandProfile is created.
// Gives the brand full Pro-level access for 14 days.
async function startTrial(brandProfile) {
  const now = new Date();
  const trialEnd = new Date(now.getTime() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000);

  brandProfile.trialActive = true;
  brandProfile.trialTier = TRIAL_TIER;
  brandProfile.trialStartedAt = now;
  brandProfile.trialEndsAt = trialEnd;
  brandProfile.trialExpired = false;
  // During trial, planTier reflects the trial tier for feature gating
  brandProfile.planTier = TRIAL_TIER;
  await brandProfile.save();

  console.log(`🎉 Trial started for brand profile ${brandProfile._id} — expires ${trialEnd.toISOString()}`);
  return brandProfile;
}

// ── Check Trial Status ────────────────────────────────────
// Returns the current effective plan tier and trial state.
// Used by billing/subscription endpoints to resolve what the user actually has access to.
function checkTrialStatus(brandProfile) {
  if (!brandProfile) return { effectiveTier: 'starter', trial: null };

  // If they have an active paid subscription, that takes priority
  if (brandProfile.paypalSubscriptionId && brandProfile.planTier !== 'starter') {
    return {
      effectiveTier: brandProfile.planTier,
      trial: brandProfile.trialActive ? {
        active: true,
        tier: brandProfile.trialTier,
        endsAt: brandProfile.trialEndsAt,
        daysRemaining: Math.max(0, Math.ceil((brandProfile.trialEndsAt - Date.now()) / (24 * 60 * 60 * 1000))),
      } : null,
    };
  }

  // Active trial — return trial tier
  if (brandProfile.trialActive && brandProfile.trialEndsAt > new Date()) {
    const daysRemaining = Math.max(0, Math.ceil((brandProfile.trialEndsAt - Date.now()) / (24 * 60 * 60 * 1000)));
    return {
      effectiveTier: brandProfile.trialTier,
      trial: {
        active: true,
        tier: brandProfile.trialTier,
        endsAt: brandProfile.trialEndsAt,
        startedAt: brandProfile.trialStartedAt,
        daysRemaining,
      },
    };
  }

  // Trial expired or no trial — starter
  return {
    effectiveTier: brandProfile.planTier || 'starter',
    trial: brandProfile.trialExpired ? {
      active: false,
      expired: true,
      expiredAt: brandProfile.trialEndsAt,
    } : null,
  };
}

// ── Process Expired Trials ────────────────────────────────
// Run daily via cron or admin endpoint.
// Finds all brand profiles with expired trials and downgrades them to Starter.
async function processExpiredTrials() {
  const BrandProfile = require('../models/BrandProfile');
  const notifications = require('./notifications');

  const now = new Date();

  // Find active trials that have expired
  const expiredTrials = await BrandProfile.find({
    trialActive: true,
    trialEndsAt: { $lte: now },
  }).limit(200);

  let downgraded = 0;
  let notified = 0;

  for (const profile of expiredTrials) {
    // Skip if they subscribed during the trial
    if (profile.paypalSubscriptionId) {
      // They paid — just deactivate the trial flag, keep their paid tier
      profile.trialActive = false;
      await profile.save();
      console.log(`  ⏭️ Trial deactivated (already subscribed): ${profile._id}`);
      continue;
    }

    // Downgrade to starter
    profile.trialActive = false;
    profile.trialExpired = true;
    profile.planTier = 'starter';
    await profile.save();
    downgraded++;

    // Enforce Starter limits on downgrade
    try {
      const Campaign = require('../models/Campaign');
      const Brand = require('../models/Brand');
      const brandIds = profile.ownedBrandIds || [];

      for (const brandId of brandIds) {
        // Pause excess active campaigns (Starter allows 1)
        const activeCampaigns = await Campaign.find({ brandId, status: 'active' }).sort({ createdAt: 1 });
        if (activeCampaigns.length > 1) {
          // Keep the oldest, pause the rest
          for (let i = 1; i < activeCampaigns.length; i++) {
            activeCampaigns[i].status = 'paused';
            await activeCampaigns[i].save();
          }
          console.log(`  ⏸️ Paused ${activeCampaigns.length - 1} excess campaigns for brand ${brandId}`);
        }

        // Disable kiosk mode (Starter allows 0 locations)
        await Brand.updateOne({ _id: brandId, kioskEnabled: true }, { kioskEnabled: false });
      }
    } catch (enforceErr) {
      console.error(`  ⚠️ Downgrade enforcement error: ${enforceErr.message}`);
    }

    // Send trial expired notification
    try {
      const Brand = require('../models/Brand');
      const brand = await Brand.findById(profile.primaryBrandId);
      if (brand) {
        await notifications.trialExpired({ brand });
        notified++;
      }
    } catch (err) {
      console.error(`  ⚠️ Could not send trial expired notification: ${err.message}`);
    }
  }

  // Also send "trial ending soon" (3 days before expiry) to active trials
  const threeDaysFromNow = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);
  const twoDaysFromNow = new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000);

  const endingSoon = await BrandProfile.find({
    trialActive: true,
    trialEndsAt: { $gte: twoDaysFromNow, $lte: threeDaysFromNow },
    paypalSubscriptionId: null, // Only notify if they haven't subscribed
  }).limit(100);

  let warned = 0;
  for (const profile of endingSoon) {
    try {
      const Brand = require('../models/Brand');
      const brand = await Brand.findById(profile.primaryBrandId);
      if (brand) {
        const endDate = profile.trialEndsAt.toLocaleDateString('en-US', {
          weekday: 'long', month: 'long', day: 'numeric',
        });
        await notifications.trialEndingSoon({ brand, trialEndDate: endDate });
        warned++;
      }
    } catch (err) {
      console.error(`  ⚠️ Could not send trial ending soon notification: ${err.message}`);
    }
  }

  const result = { downgraded, notified, warned, total: expiredTrials.length };
  console.log(`⏰ Trial expiry run: ${JSON.stringify(result)}`);
  return result;
}

module.exports = {
  TRIAL_DURATION_DAYS,
  TRIAL_TIER,
  startTrial,
  checkTrialStatus,
  processExpiredTrials,
};
