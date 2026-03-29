// Billing Routes — Subscription management + PayPal integration
// Rule G5: PayPal Business ONLY — no Stripe, no bank transfer
// Rule G9: Hard plan limits — no silent overages
// Ref: PLATFORM_ARCHITECTURE.md → Cash & Payments
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { Subscription, BrandProfile, Brand } = require('../models');
const paypal = require('../config/paypal');
const { checkTrialStatus, processExpiredTrials } = require('../services/trial');

// Plan pricing (USD)
const PLAN_PRICING = {
  starter: { monthly: 0, annual: 0 },
  growth: { monthly: 29, annual: 290 },   // ~17% savings annual
  pro: { monthly: 79, annual: 790 },       // ~17% savings annual
  agency: { monthly: 149, annual: 1490 },  // ~17% savings annual
  enterprise: { monthly: null, annual: null }, // custom pricing
};

// Plan feature matrix
const PLAN_FEATURES = {
  starter: {
    maxBrands: 1,
    maxCampaigns: 1,
    maxKioskLocations: 0,
    teamMembers: 1,
    analytics: 'basic',
    whiteLabel: false,
    apiAccess: false,
    prioritySupport: false,
  },
  growth: {
    maxBrands: 3,
    maxCampaigns: 5,
    maxKioskLocations: 1,
    teamMembers: 3,
    analytics: 'standard',
    whiteLabel: false,
    apiAccess: false,
    prioritySupport: false,
  },
  pro: {
    maxBrands: 10,
    maxCampaigns: 20,
    maxKioskLocations: 5,
    teamMembers: 10,
    analytics: 'advanced',
    whiteLabel: false,
    apiAccess: true,
    prioritySupport: true,
  },
  agency: {
    maxBrands: 25,
    maxCampaigns: 50,
    maxKioskLocations: 25,
    teamMembers: 50,
    analytics: 'full',
    whiteLabel: true,
    apiAccess: true,
    prioritySupport: true,
  },
  enterprise: {
    maxBrands: Infinity,
    maxCampaigns: Infinity,
    maxKioskLocations: Infinity,
    teamMembers: Infinity,
    analytics: 'full',
    whiteLabel: true,
    apiAccess: true,
    prioritySupport: true,
  },
};

// ── PayPal Plan IDs ──────────────────────────────────────
// Loaded from env (created via POST /api/billing/setup-plans).
// Format: PAYPAL_PLAN_{TIER}_{CYCLE} = P-xxxxx
const PAYPAL_PLAN_IDS = {
  growth_monthly:  process.env.PAYPAL_PLAN_GROWTH_MONTHLY  || null,
  growth_annual:   process.env.PAYPAL_PLAN_GROWTH_ANNUAL   || null,
  pro_monthly:     process.env.PAYPAL_PLAN_PRO_MONTHLY     || null,
  pro_annual:      process.env.PAYPAL_PLAN_PRO_ANNUAL      || null,
  agency_monthly:  process.env.PAYPAL_PLAN_AGENCY_MONTHLY  || null,
  agency_annual:   process.env.PAYPAL_PLAN_AGENCY_ANNUAL   || null,
};

// GET /api/billing/plans — Public endpoint, returns plan pricing + features
router.get('/plans', (req, res) => {
  const plans = Object.keys(PLAN_PRICING).map(tier => ({
    tier,
    pricing: PLAN_PRICING[tier],
    features: PLAN_FEATURES[tier],
  }));
  res.json({ plans });
});

// GET /api/billing/subscription — Get current user's subscription
router.get('/subscription', requireAuth, async (req, res) => {
  try {
    const brandProfile = await BrandProfile.findOne({ userId: req.user._id });
    if (!brandProfile) {
      return res.json({
        subscription: null,
        plan: 'starter',
        trial: null,
        message: 'No brand profile found. Using free Starter plan.',
      });
    }

    // Check trial status
    const trialStatus = checkTrialStatus(brandProfile);

    const subscription = await Subscription.findOne({
      brandProfileId: brandProfile._id,
      status: { $in: ['active', 'trialing', 'past_due'] },
    }).sort({ createdAt: -1 });

    if (!subscription) {
      return res.json({
        subscription: null,
        plan: trialStatus.effectiveTier,
        features: PLAN_FEATURES[trialStatus.effectiveTier] || PLAN_FEATURES.starter,
        trial: trialStatus.trial,
        message: trialStatus.trial?.active
          ? `Free trial active — ${trialStatus.trial.daysRemaining} day${trialStatus.trial.daysRemaining !== 1 ? 's' : ''} remaining.`
          : 'No active subscription. Using free Starter plan.',
      });
    }

    // If we have a PayPal subscription, sync the latest status
    if (subscription.paypalSubscriptionId) {
      try {
        const ppSub = await paypal.getSubscription(subscription.paypalSubscriptionId);
        if (ppSub.status === 'ACTIVE' && subscription.status !== 'active') {
          subscription.status = 'active';
          await subscription.save();
        } else if (ppSub.status === 'SUSPENDED' && subscription.status !== 'past_due') {
          subscription.status = 'past_due';
          await subscription.save();
        } else if (ppSub.status === 'CANCELLED' && subscription.status !== 'canceled') {
          subscription.status = 'canceled';
          await subscription.save();
        }
      } catch (syncErr) {
        // Non-blocking — return local data if PayPal sync fails
        console.error('PayPal subscription sync error:', syncErr.message);
      }
    }

    res.json({
      subscription: {
        id: subscription._id,
        planTier: subscription.planTier,
        billingCycle: subscription.billingCycle,
        status: subscription.status,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        paypalPayerEmail: subscription.paypalPayerEmail
          ? subscription.paypalPayerEmail.replace(/(.{2}).+(@.+)/, '$1***$2')
          : null,
      },
      plan: subscription.planTier,
      features: PLAN_FEATURES[subscription.planTier],
      pricing: PLAN_PRICING[subscription.planTier],
      trial: trialStatus.trial,
    });
  } catch (error) {
    console.error('Get subscription error:', error.message);
    res.status(500).json({ error: 'Could not fetch subscription' });
  }
});

// POST /api/billing/subscribe — Start PayPal subscription checkout
// Returns an approval URL — brand owner clicks it to pay via PayPal.
// After approval, PayPal redirects to returnUrl, and we activate.
router.post('/subscribe', requireAuth, async (req, res) => {
  try {
    const { planTier, billingCycle, returnUrl, cancelUrl } = req.body;

    if (!planTier) {
      return res.status(400).json({ error: 'planTier is required' });
    }

    const validTiers = ['growth', 'pro', 'agency', 'enterprise'];
    if (!validTiers.includes(planTier)) {
      return res.status(400).json({
        error: 'Invalid plan tier',
        message: `Choose one of: ${validTiers.join(', ')}. Starter is the free tier.`,
      });
    }

    if (planTier === 'enterprise') {
      return res.status(400).json({
        error: 'Contact sales',
        message: 'Enterprise plans require custom pricing. Contact sales@keepuspostd.com.',
      });
    }

    const cycle = billingCycle === 'annual' ? 'annual' : 'monthly';
    const price = PLAN_PRICING[planTier][cycle];

    // Find brand profile
    let brandProfile = await BrandProfile.findOne({ userId: req.user._id });
    if (!brandProfile) {
      return res.status(400).json({
        error: 'No brand profile',
        message: 'Create a brand profile before subscribing.',
      });
    }

    // Check for existing active subscription
    const existingSub = await Subscription.findOne({
      brandProfileId: brandProfile._id,
      status: { $in: ['active', 'trialing'] },
    });

    if (existingSub) {
      // If upgrading, cancel the old PayPal sub first
      if (existingSub.paypalSubscriptionId) {
        try {
          await paypal.cancelSubscription(existingSub.paypalSubscriptionId, 'Upgrading plan');
        } catch (cancelErr) {
          console.error('Could not cancel old PayPal subscription:', cancelErr.message);
        }
      }
      existingSub.status = 'canceled';
      await existingSub.save();
    }

    // Look up the PayPal plan ID for this tier + cycle
    const planKey = `${planTier}_${cycle}`;
    const paypalPlanId = PAYPAL_PLAN_IDS[planKey];

    if (!paypalPlanId) {
      // Fallback: create subscription record locally (plans not set up yet)
      console.log(`⚠️ No PayPal plan ID for ${planKey} — creating local subscription`);
      const now = new Date();
      const periodEnd = cycle === 'annual'
        ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
        : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      const subscription = await Subscription.create({
        brandProfileId: brandProfile._id,
        planTier,
        billingCycle: cycle,
        status: 'active',
        currentPeriodStart: now,
        currentPeriodEnd: periodEnd,
        gracePeriodEligible: true,
      });

      brandProfile.planTier = planTier;
      brandProfile.billingCycle = cycle;
      brandProfile.planStartedAt = now;
      brandProfile.planExpiresAt = periodEnd;
      await brandProfile.save();

      return res.status(201).json({
        message: `Subscribed to ${planTier} plan (${cycle}) — local mode (PayPal plans not configured yet)`,
        subscription,
        features: PLAN_FEATURES[planTier],
        pricing: PLAN_PRICING[planTier],
        note: 'Run POST /api/billing/setup-plans to create PayPal plans, then subscriptions will use PayPal checkout.',
      });
    }

    // Create PayPal subscription → returns approval URL
    const defaultReturn = returnUrl || `http://localhost:3001/pages/inner/billing.html?subscription=success`;
    const defaultCancel = cancelUrl || `http://localhost:3001/pages/inner/billing.html?subscription=canceled`;

    const ppSubscription = await paypal.createSubscription(
      paypalPlanId,
      defaultReturn,
      defaultCancel,
      req.user.email
    );

    // Find the approval URL in PayPal's response
    const approvalLink = ppSubscription.links?.find(l => l.rel === 'approve');
    const approvalUrl = approvalLink ? approvalLink.href : null;

    // Create a pending subscription record locally
    const now = new Date();
    const periodEnd = cycle === 'annual'
      ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const subscription = await Subscription.create({
      brandProfileId: brandProfile._id,
      paypalSubscriptionId: ppSubscription.id,
      planTier,
      billingCycle: cycle,
      status: 'trialing', // Becomes 'active' after PayPal approval webhook
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      gracePeriodEligible: true,
    });

    console.log(`📋 PayPal subscription created: ${ppSubscription.id} → awaiting approval`);

    res.status(201).json({
      message: `Redirecting to PayPal for ${planTier} plan (${cycle}) at $${price}/mo`,
      subscription,
      paypalSubscriptionId: ppSubscription.id,
      approvalUrl,
      features: PLAN_FEATURES[planTier],
      pricing: PLAN_PRICING[planTier],
    });
  } catch (error) {
    console.error('Subscribe error:', error.message);
    res.status(500).json({ error: 'Could not create subscription' });
  }
});

// POST /api/billing/activate — Called after PayPal redirects back with approval
// The frontend calls this with the PayPal subscription ID to finalize.
router.post('/activate', requireAuth, async (req, res) => {
  try {
    const { paypalSubscriptionId } = req.body;

    if (!paypalSubscriptionId) {
      return res.status(400).json({ error: 'paypalSubscriptionId is required' });
    }

    // Find the pending subscription
    const subscription = await Subscription.findOne({ paypalSubscriptionId });
    if (!subscription) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    // Verify status with PayPal
    const ppSub = await paypal.getSubscription(paypalSubscriptionId);

    if (ppSub.status === 'ACTIVE' || ppSub.status === 'APPROVED') {
      subscription.status = 'active';
      subscription.paypalPayerEmail = ppSub.subscriber?.email_address || null;
      subscription.paypalCustomerId = ppSub.subscriber?.payer_id || null;
      await subscription.save();

      // Update brand profile
      const brandProfile = await BrandProfile.findById(subscription.brandProfileId);
      if (brandProfile) {
        brandProfile.planTier = subscription.planTier;
        brandProfile.billingCycle = subscription.billingCycle;
        brandProfile.paypalCustomerId = ppSub.subscriber?.payer_id || null;
        brandProfile.paypalSubscriptionId = paypalSubscriptionId;
        brandProfile.planStartedAt = subscription.currentPeriodStart;
        brandProfile.planExpiresAt = subscription.currentPeriodEnd;
        await brandProfile.save();
      }

      console.log(`✅ Subscription activated: ${paypalSubscriptionId} → ${subscription.planTier}`);

      return res.json({
        message: 'Subscription activated!',
        subscription,
        plan: subscription.planTier,
        features: PLAN_FEATURES[subscription.planTier],
      });
    }

    res.status(400).json({
      error: 'Subscription not yet approved',
      paypalStatus: ppSub.status,
      message: 'The subscription has not been approved on PayPal yet.',
    });
  } catch (error) {
    console.error('Activate subscription error:', error.message);
    res.status(500).json({ error: 'Could not activate subscription' });
  }
});

// PUT /api/billing/cancel — Cancel subscription (at period end)
router.put('/cancel', requireAuth, async (req, res) => {
  try {
    const brandProfile = await BrandProfile.findOne({ userId: req.user._id });
    if (!brandProfile) {
      return res.status(404).json({ error: 'No brand profile found' });
    }

    const subscription = await Subscription.findOne({
      brandProfileId: brandProfile._id,
      status: { $in: ['active', 'trialing'] },
    });

    if (!subscription) {
      return res.status(404).json({ error: 'No active subscription to cancel' });
    }

    // Cancel on PayPal
    if (subscription.paypalSubscriptionId) {
      try {
        await paypal.cancelSubscription(
          subscription.paypalSubscriptionId,
          req.body.reason || 'Customer requested cancellation via KUP'
        );
        console.log(`📤 PayPal subscription canceled: ${subscription.paypalSubscriptionId}`);
      } catch (ppErr) {
        console.error('PayPal cancel error:', ppErr.message);
        // Continue with local cancellation even if PayPal call fails
      }
    }

    // Mark for cancellation at end of current period
    subscription.cancelAtPeriodEnd = true;
    await subscription.save();

    console.log(`❌ Subscription cancellation scheduled for ${subscription.currentPeriodEnd}`);

    res.json({
      message: 'Subscription will be canceled at the end of your current billing period',
      cancelDate: subscription.currentPeriodEnd,
      subscription,
    });
  } catch (error) {
    console.error('Cancel subscription error:', error.message);
    res.status(500).json({ error: 'Could not cancel subscription' });
  }
});

// PUT /api/billing/reactivate — Undo pending cancellation
router.put('/reactivate', requireAuth, async (req, res) => {
  try {
    const brandProfile = await BrandProfile.findOne({ userId: req.user._id });
    if (!brandProfile) {
      return res.status(404).json({ error: 'No brand profile found' });
    }

    const subscription = await Subscription.findOne({
      brandProfileId: brandProfile._id,
      cancelAtPeriodEnd: true,
    });

    if (!subscription) {
      return res.status(404).json({ error: 'No pending cancellation to reactivate' });
    }

    subscription.cancelAtPeriodEnd = false;
    await subscription.save();

    console.log(`✅ Subscription reactivated for user ${req.user._id}`);

    res.json({
      message: 'Subscription reactivated — cancellation undone',
      subscription,
    });
  } catch (error) {
    console.error('Reactivate subscription error:', error.message);
    res.status(500).json({ error: 'Could not reactivate subscription' });
  }
});

// POST /api/billing/setup-plans — One-time setup: creates PayPal products + plans
// Run this once to register KUP subscription plans with PayPal.
// Stores the plan IDs in memory (in production, save to DB or env).
router.post('/setup-plans', requireAuth, async (req, res) => {
  try {
    console.log('🔧 Setting up PayPal subscription plans...');

    // Create a PayPal product for KUP
    const product = await paypal.createProduct(
      'KeepUsPostd Platform',
      'Influencer partnership management platform — subscription access'
    );
    console.log(`📦 Product created: ${product.id}`);

    // Create plans for each paid tier × billing cycle
    const results = {};
    const paidTiers = ['growth', 'pro', 'agency'];

    for (const tier of paidTiers) {
      for (const cycle of ['monthly', 'annual']) {
        const price = PLAN_PRICING[tier][cycle];
        const interval = cycle === 'annual' ? 'YEAR' : 'MONTH';
        const planName = `KUP ${tier.charAt(0).toUpperCase() + tier.slice(1)} (${cycle})`;

        const plan = await paypal.createPlan(product.id, planName, price, interval);
        const key = `${tier}_${cycle}`;
        PAYPAL_PLAN_IDS[key] = plan.id;
        results[key] = { planId: plan.id, price, interval };

        console.log(`  ✅ ${planName}: ${plan.id} — $${price}/${cycle}`);
      }
    }

    console.log('🎉 All PayPal plans created!');

    res.json({
      message: 'PayPal subscription plans created successfully',
      productId: product.id,
      plans: results,
      note: 'Plan IDs are stored in memory. Restart the server and run this again if needed.',
    });
  } catch (error) {
    console.error('Setup plans error:', error.message);
    res.status(500).json({ error: 'Could not set up PayPal plans', detail: error.message });
  }
});

module.exports = router;
