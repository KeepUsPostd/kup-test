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
const notify = require('../services/notifications');

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
    const { planTier, billingCycle, returnUrl, cancelUrl, promoCode } = req.body;

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

    // Enterprise requires either (a) a free-type promo that covers it
    // (e.g. the founder code) or (b) contacting sales for custom pricing.
    // PayPal checkout isn't supported for enterprise; promo path handles it below.
    const enterpriseAllowedViaPromo = planTier === 'enterprise' && !!promoCode;
    if (planTier === 'enterprise' && !enterpriseAllowedViaPromo) {
      return res.status(400).json({
        error: 'Contact sales',
        message: 'Enterprise plans require custom pricing. Contact sales@keepuspostd.com.',
      });
    }

    const cycle = billingCycle === 'annual' ? 'annual' : 'monthly';
    // Enterprise has no public PayPal plan — price lookup only matters for paid tiers
    const price = planTier === 'enterprise' ? 0 : PLAN_PRICING[planTier][cycle];

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

    // ── Promo code validation ──
    let appliedPromo = null;
    if (promoCode) {
      const PromoCode = require('../models/PromoCode');
      const promo = await PromoCode.findOne({ code: promoCode.toUpperCase().replace(/\s/g, ''), isActive: true });
      if (!promo) {
        return res.status(400).json({ error: 'Invalid or expired promo code' });
      }
      if (promo.expiresAt && new Date() > promo.expiresAt) {
        return res.status(400).json({ error: 'This promo code has expired' });
      }
      if (promo.maxUses && promo.usedCount >= promo.maxUses) {
        return res.status(400).json({ error: 'This promo code has reached its usage limit' });
      }
      if (promo.usedBy.includes(req.user._id)) {
        return res.status(400).json({ error: 'You have already used this promo code' });
      }
      if (promo.appliesTo !== 'all' && promo.appliesTo !== planTier) {
        return res.status(400).json({ error: `This promo code only applies to the ${promo.appliesTo} plan` });
      }

      // Free promo = skip PayPal entirely, activate immediately
      if (promo.type === 'free') {
        const now = new Date();
        const subscription = await Subscription.create({
          brandProfileId: brandProfile._id,
          planTier,
          billingCycle: cycle,
          status: 'active',
          currentPeriodStart: now,
          currentPeriodEnd: null, // no expiry — free forever
          promoCode: promo.code,
        });
        brandProfile.planTier = planTier;
        brandProfile.billingCycle = cycle;
        brandProfile.planStartedAt = now;
        brandProfile.planExpiresAt = null;
        if (brandProfile.trialActive) brandProfile.trialActive = false;
        await brandProfile.save();

        promo.usedCount += 1;
        promo.usedBy.push(req.user._id);
        await promo.save();

        console.log(`🎁 FREE promo "${promo.code}" applied — ${planTier} plan activated for ${req.user.email}`);
        return res.json({ subscription, message: `${planTier} plan activated for free!`, promoApplied: promo.code });
      }

      appliedPromo = promo;
    }

    // If we got past the enterprise-promo gate but the promo wasn't free-type,
    // block here — there's no PayPal plan ID for enterprise.
    if (planTier === 'enterprise') {
      return res.status(400).json({
        error: 'Contact sales',
        message: 'Enterprise plans require custom pricing. Contact sales@keepuspostd.com.',
      });
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
    const APP_URL = process.env.APP_URL || 'https://keepuspostd.com';
    const defaultReturn = returnUrl || `${APP_URL}/app/payment-success.html?subscription=success`;
    const defaultCancel = cancelUrl || `${APP_URL}/app/pricing-payment.html?subscription=canceled`;

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

      // Update brand profile — deactivate trial if still running
      const brandProfile = await BrandProfile.findById(subscription.brandProfileId);
      if (brandProfile) {
        brandProfile.planTier = subscription.planTier;
        brandProfile.billingCycle = subscription.billingCycle;
        brandProfile.paypalCustomerId = ppSub.subscriber?.payer_id || null;
        brandProfile.paypalSubscriptionId = paypalSubscriptionId;
        brandProfile.planStartedAt = subscription.currentPeriodStart;
        brandProfile.planExpiresAt = subscription.currentPeriodEnd;
        if (brandProfile.trialActive) {
          brandProfile.trialActive = false; // Paid plan supersedes trial
        }
        await brandProfile.save();
      }

      console.log(`✅ Subscription activated: ${paypalSubscriptionId} → ${subscription.planTier}`);

      // Fire subscription purchased notification (non-blocking)
      notify.subscriptionPurchased({
        brand: brandProfile,
        planTier: subscription.planTier,
        amount: subscription.amount || 0,
      }).catch(err => console.error('[billing/activate] notify.subscriptionPurchased error:', err.message));

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

// GET /api/billing/history — Fetch subscription payment history from PayPal
// Returns last 12 months of charges normalized for the frontend table
router.get('/history', requireAuth, async (req, res) => {
  try {
    const brandProfile = await BrandProfile.findOne({ userId: req.user._id });
    if (!brandProfile) return res.status(404).json({ error: 'No brand profile found' });

    const subscription = await Subscription.findOne({ brandProfileId: brandProfile._id });
    if (!subscription || !subscription.paypalSubscriptionId) {
      return res.json({ transactions: [] });
    }

    const result = await paypal.getSubscriptionTransactions(subscription.paypalSubscriptionId);
    const rawTxns = (result && result.transactions) || [];

    const PLAN_LABELS = {
      starter: 'Starter Plan',
      growth: 'Growth Plan',
      pro: 'Pro Plan',
      agency: 'Agency Plan',
      enterprise: 'Enterprise Plan',
    };

    const transactions = rawTxns.map(txn => ({
      id: txn.id,
      date: txn.time,
      description: PLAN_LABELS[subscription.planTier] || 'KeepUsPostd Subscription',
      amount: txn.amount_with_breakdown
        ? parseFloat(txn.amount_with_breakdown.gross_amount.value)
        : null,
      currency: txn.amount_with_breakdown
        ? txn.amount_with_breakdown.gross_amount.currency_code
        : 'USD',
      status: txn.status, // COMPLETED, FAILED, PENDING, REFUNDED
    }));

    res.json({ transactions });
  } catch (error) {
    console.error('Billing history error:', error.message);
    // Don't fail — return empty so the page still loads
    res.json({ transactions: [] });
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

// ═══════════════════════════════════════════════════════════
// VAULT v3 — Save brand payment method for seamless content approval
// ═══════════════════════════════════════════════════════════

// GET /api/billing/payment-method — Check if brand has a saved payment method
router.get('/payment-method', requireAuth, async (req, res) => {
  try {
    const brandProfile = await BrandProfile.findOne({ userId: req.user._id });
    if (!brandProfile) return res.json({ connected: false });

    // Look up the vault payment token details from PayPal to get the email
    let paypalEmail = null;
    if (brandProfile.paypalVaultPaymentTokenId) {
      try {
        const tokenData = await paypal.paypalRequest('GET', `/v3/vault/payment-tokens/${brandProfile.paypalVaultPaymentTokenId}`);
        paypalEmail = tokenData?.payment_source?.paypal?.email_address || null;
      } catch (_) {
        // Token lookup failed — still return connected status
      }
    }

    // Connected = any form of PayPal linked (vault token OR PPCP merchant account)
    const connected = !!(brandProfile.paypalVaultPaymentTokenId || brandProfile.brandPaypalMerchantId);
    res.json({
      connected,
      setupAt: brandProfile.paypalVaultSetupAt || null,
      paypalEmail,
    });
  } catch (error) {
    console.error('Payment method check error:', error.message);
    res.status(500).json({ error: 'Could not check payment method' });
  }
});

// POST /api/billing/save-payment — Start Vault setup flow
// Creates a setup token and returns the PayPal approval URL.
// Brand visits the URL once to authorize KUP for future auto-charges.
router.post('/save-payment', requireAuth, async (req, res) => {
  try {
    const APP_URL = process.env.APP_URL || 'https://keepuspostd.com';
    const returnUrl = `${APP_URL}/api/billing/save-payment/return`;
    const cancelUrl = `${APP_URL}/app/owner-account.html?vault=canceled`;

    const setupToken = await paypal.createVaultSetupToken(returnUrl, cancelUrl);

    const approveLink = setupToken.links && setupToken.links.find(l => l.rel === 'approve');
    const approveUrl = approveLink ? approveLink.href : null;

    if (!approveUrl) {
      return res.status(500).json({ error: 'PayPal did not return an approval URL' });
    }

    console.log(`🔐 Vault setup token created: ${setupToken.id} for user ${req.user._id}`);

    res.json({
      setupTokenId: setupToken.id,
      approveUrl,
    });
  } catch (error) {
    console.error('Vault setup error:', error.message);
    res.status(500).json({ error: 'Could not start payment setup' });
  }
});

// GET /api/billing/save-payment/return — PayPal callback after brand approves
// NO auth required — this may run in a different browser (Firefox popup).
// Redirects back to the KUP owner-account page with the setup token in the URL.
// The owner-account page (in the main browser) detects the token and calls the exchange endpoint.
router.get('/save-payment/return', async (req, res) => {
  const APP_URL = process.env.APP_URL || 'https://keepuspostd.com';
  const setupTokenId = req.query.token || req.query.approval_token_id;
  // Show a page with the token displayed + auto-copy instructions
  res.send(`<!DOCTYPE html><html><head><title>PayPal Connected</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <style>body{font-family:-apple-system,sans-serif;text-align:center;padding:40px 20px;background:#f8f9fa}
    .card{max-width:400px;margin:0 auto;background:#fff;border-radius:16px;padding:32px;box-shadow:0 2px 12px rgba(0,0,0,0.08)}
    h2{color:#1a1a1a;margin:0 0 8px} p{color:#666;font-size:14px;margin:0 0 20px}
    .token{background:#f0f4ff;border:1px solid #d0d8f0;border-radius:8px;padding:12px;font-family:monospace;font-size:13px;word-break:break-all;margin:0 0 20px;color:#333}
    .btn{display:inline-block;padding:14px 28px;background:#2EA5DD;color:#fff;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;text-decoration:none}
    .btn:hover{background:#2590c4}
    .hint{font-size:12px;color:#999;margin-top:16px}</style></head><body>
    <div class="card">
      <h2>PayPal Authorized</h2>
      <p>Copy this code and paste it back in your KeepUsPostd billing page:</p>
      <div class="token" id="tokenBox">${setupTokenId || 'No token received'}</div>
      <button class="btn" onclick="navigator.clipboard.writeText('${setupTokenId || ''}');this.textContent='Copied!';this.style.background='#16a34a'">Copy Code</button>
      <p class="hint">Then go back to your Owner Account → Billing tab and paste it in the confirmation field.</p>
    </div>
  </body></html>`);
});

// POST /api/billing/save-payment/exchange — Exchange setup token for payment token (authenticated)
// Called from the main window after receiving the setup token from the popup.
router.post('/save-payment/exchange', requireAuth, async (req, res) => {
  try {
    const { setupTokenId } = req.body;
    if (!setupTokenId) {
      return res.status(400).json({ error: 'setupTokenId is required' });
    }

    // Exchange setup token for permanent payment token
    const paymentToken = await paypal.createVaultPaymentToken(setupTokenId);

    if (!paymentToken || !paymentToken.id) {
      return res.status(500).json({ error: 'Token exchange failed' });
    }

    // Store on the brand profile
    const brandProfile = await BrandProfile.findOne({ userId: req.user._id });
    if (brandProfile) {
      brandProfile.paypalVaultPaymentTokenId = paymentToken.id;
      brandProfile.paypalVaultSetupAt = new Date();
      await brandProfile.save();
      console.log(`✅ Vault payment token saved: ${paymentToken.id} for brand ${brandProfile._id}`);
    }

    res.json({ success: true, connectedAt: new Date().toISOString() });
  } catch (error) {
    console.error('Vault exchange error:', error.message);
    res.status(500).json({ error: 'Could not complete PayPal setup' });
  }
});

// DELETE /api/billing/payment-method — Remove saved payment method
router.delete('/payment-method', requireAuth, async (req, res) => {
  try {
    const brandProfile = await BrandProfile.findOne({ userId: req.user._id });
    if (brandProfile) {
      brandProfile.paypalVaultPaymentTokenId = null;
      brandProfile.paypalVaultSetupAt = null;
      await brandProfile.save();
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Remove payment method error:', error.message);
    res.status(500).json({ error: 'Could not remove payment method' });
  }
});

// ═══════════════════════════════════════════════════════════
// BRAND-DIRECT PPCP — Brand pays influencer directly
// Brand connects their PayPal as a PPCP merchant so payments
// route directly to influencers. KUP takes platform fee.
// ═══════════════════════════════════════════════════════════

// GET /api/billing/brand-paypal-onboard — Start brand PPCP onboarding
router.get('/brand-paypal-onboard', requireAuth, async (req, res) => {
  try {
    const brandProfile = await BrandProfile.findOne({ userId: req.user._id });
    if (!brandProfile) return res.status(404).json({ error: 'Brand profile not found' });

    // Already connected?
    if (brandProfile.brandPaypalMerchantId) {
      return res.json({ connected: true, merchantId: brandProfile.brandPaypalMerchantId });
    }

    const trackingId = `BRAND-${brandProfile._id}-${Date.now()}`;
    const APP_URL = process.env.APP_URL || 'https://keepuspostd.com';
    const returnUrl = `${APP_URL}/api/billing/brand-paypal-onboard/return`;

    const result = await paypal.createPartnerReferral(trackingId, returnUrl);

    // Save tracking ID
    brandProfile.brandPaypalTrackingId = trackingId;
    brandProfile.brandPaypalOnboardingStatus = 'pending';
    await brandProfile.save();

    // Find the action URL from PayPal response
    const actionUrl = result.links?.find(l => l.rel === 'action_url')?.href;

    console.log(`💳 Brand PPCP onboarding started: ${trackingId}`);
    res.json({ actionUrl, trackingId });
  } catch (error) {
    console.error('Brand PPCP onboard error:', error.message);
    res.status(500).json({ error: 'Could not start PayPal onboarding' });
  }
});

// GET /api/billing/brand-paypal-onboard/return — PayPal redirects here after brand authorizes
router.get('/brand-paypal-onboard/return', async (req, res) => {
  try {
    const merchantId = req.query.merchantIdInPayPal || req.query.merchantId;
    const trackingId = req.query.tracking_id;

    if (!merchantId || !trackingId) {
      const APP_URL = process.env.APP_URL || 'https://keepuspostd.com';
      return res.redirect(`${APP_URL}/app/cash-account.html?paypal_error=missing_params`);
    }

    // Find the brand profile by tracking ID
    const brandProfile = await BrandProfile.findOne({ brandPaypalTrackingId: trackingId });
    if (!brandProfile) {
      const APP_URL = process.env.APP_URL || 'https://keepuspostd.com';
      return res.redirect(`${APP_URL}/app/cash-account.html?paypal_error=profile_not_found`);
    }

    brandProfile.brandPaypalMerchantId = merchantId;
    brandProfile.brandPaypalOnboardingStatus = 'completed';
    brandProfile.brandPaypalConnectedAt = new Date();
    await brandProfile.save();

    console.log(`✅ Brand PPCP connected: merchant ${merchantId} for brand profile ${brandProfile._id}`);

    const APP_URL = process.env.APP_URL || 'https://keepuspostd.com';
    res.redirect(`${APP_URL}/app/cash-account.html?paypal_connected=true`);
  } catch (error) {
    console.error('Brand PPCP return error:', error.message);
    const APP_URL = process.env.APP_URL || 'https://keepuspostd.com';
    res.redirect(`${APP_URL}/app/cash-account.html?paypal_error=server_error`);
  }
});

// GET /api/billing/brand-paypal-status — Check brand's PPCP connection status
router.get('/brand-paypal-status', requireAuth, async (req, res) => {
  try {
    const brandProfile = await BrandProfile.findOne({ userId: req.user._id });
    if (!brandProfile) return res.json({ connected: false });

    res.json({
      connected: !!brandProfile.brandPaypalMerchantId,
      merchantId: brandProfile.brandPaypalMerchantId || null,
      status: brandProfile.brandPaypalOnboardingStatus || 'not_started',
      connectedAt: brandProfile.brandPaypalConnectedAt || null,
      // Also report vault status for reference
      vaultConnected: !!brandProfile.paypalVaultPaymentTokenId,
    });
  } catch (error) {
    console.error('Brand PayPal status error:', error.message);
    res.status(500).json({ error: 'Could not check status' });
  }
});

// POST /api/billing/validate-promo — Check if a promo code is valid
router.post('/validate-promo', requireAuth, async (req, res) => {
  try {
    const { code, planTier } = req.body;
    if (!code) return res.status(400).json({ valid: false, error: 'Code is required' });

    const PromoCode = require('../models/PromoCode');
    const promo = await PromoCode.findOne({ code: code.toUpperCase().replace(/\s/g, ''), isActive: true });

    if (!promo) return res.json({ valid: false, error: 'Invalid promo code' });
    if (promo.expiresAt && new Date() > promo.expiresAt) return res.json({ valid: false, error: 'Expired' });
    if (promo.maxUses && promo.usedCount >= promo.maxUses) return res.json({ valid: false, error: 'Usage limit reached' });
    if (promo.usedBy.includes(req.user._id)) return res.json({ valid: false, error: 'Already used' });
    if (planTier && promo.appliesTo !== 'all' && promo.appliesTo !== planTier) {
      return res.json({ valid: false, error: `Only applies to ${promo.appliesTo} plan` });
    }

    const label = promo.type === 'free' ? 'FREE' : `${promo.percentOff}% off`;
    const duration = promo.type === 'free' ? 'forever' : (promo.durationMonths ? `for ${promo.durationMonths} months` : 'forever');

    res.json({ valid: true, discount: label, duration, type: promo.type });
  } catch (error) {
    res.status(500).json({ valid: false, error: 'Could not validate code' });
  }
});

module.exports = router;
