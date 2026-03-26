// Billing Routes — Subscription management + PayPal integration
// Rule G5: PayPal Business ONLY — no Stripe, no bank transfer
// Rule G9: Hard plan limits — no silent overages
// Ref: PLATFORM_ARCHITECTURE.md → Cash & Payments
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { Subscription, BrandProfile, Brand } = require('../models');

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
    // Find the user's brand profile
    const brandProfile = await BrandProfile.findOne({ userId: req.user._id });
    if (!brandProfile) {
      return res.json({
        subscription: null,
        plan: 'starter',
        message: 'No brand profile found. Using free Starter plan.',
      });
    }

    // Find active subscription
    const subscription = await Subscription.findOne({
      brandProfileId: brandProfile._id,
      status: { $in: ['active', 'trialing', 'past_due'] },
    }).sort({ createdAt: -1 });

    if (!subscription) {
      return res.json({
        subscription: null,
        plan: brandProfile.planTier || 'starter',
        features: PLAN_FEATURES[brandProfile.planTier || 'starter'],
        message: 'No active subscription. Using free Starter plan.',
      });
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
    });
  } catch (error) {
    console.error('Get subscription error:', error.message);
    res.status(500).json({ error: 'Could not fetch subscription' });
  }
});

// POST /api/billing/subscribe — Create/upgrade subscription
// In production, this would redirect to PayPal checkout
// For now, it creates a subscription record directly (test mode)
router.post('/subscribe', requireAuth, async (req, res) => {
  try {
    const { planTier, billingCycle } = req.body;

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

    // Find or create brand profile
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
      // Upgrade/downgrade existing subscription
      existingSub.planTier = planTier;
      existingSub.billingCycle = cycle;
      existingSub.currentPeriodStart = new Date();
      existingSub.currentPeriodEnd = cycle === 'annual'
        ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
        : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      await existingSub.save();

      // Update brand profile
      brandProfile.planTier = planTier;
      brandProfile.billingCycle = cycle;
      await brandProfile.save();

      console.log(`📋 Subscription updated: ${planTier} (${cycle}) for user ${req.user._id}`);

      return res.json({
        message: `Plan updated to ${planTier} (${cycle})`,
        subscription: existingSub,
        // In production: paypalCheckoutUrl would be returned here
        // paypalCheckoutUrl: 'https://www.paypal.com/checkout/...',
      });
    }

    // Create new subscription (test mode — in production, PayPal handles this)
    const now = new Date();
    const periodEnd = cycle === 'annual'
      ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
      : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const subscription = await Subscription.create({
      brandProfileId: brandProfile._id,
      planTier,
      billingCycle: cycle,
      status: 'active', // In production: 'trialing' with 7-day grace
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      gracePeriodEligible: true,
    });

    // Update brand profile
    brandProfile.planTier = planTier;
    brandProfile.billingCycle = cycle;
    brandProfile.planStartedAt = now;
    brandProfile.planExpiresAt = periodEnd;
    await brandProfile.save();

    console.log(`✅ New subscription: ${planTier} (${cycle}) for user ${req.user._id}`);

    res.status(201).json({
      message: `Subscribed to ${planTier} plan (${cycle})`,
      subscription,
      features: PLAN_FEATURES[planTier],
      pricing: PLAN_PRICING[planTier],
      // In production: paypalCheckoutUrl
    });
  } catch (error) {
    console.error('Subscribe error:', error.message);
    res.status(500).json({ error: 'Could not create subscription' });
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

    // Mark for cancellation at end of current period (no immediate cancellation)
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

module.exports = router;
