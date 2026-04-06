// PayPal Webhook Routes — Receives events from PayPal
// Handles: subscription lifecycle, payment captures, payout status
// PayPal sends POST requests here when things happen on their side.
const express = require('express');
const router = express.Router();
const { Subscription, BrandProfile, Transaction, Payout, Withdrawal, InfluencerProfile, Brand } = require('../models');
const paypal = require('../config/paypal');
const notify = require('../services/notifications');
const { sendPushToUser } = require('../config/push');

const isProduction = process.env.NODE_ENV === 'production';

// POST /api/webhooks/paypal — PayPal event receiver
// No auth middleware — PayPal can't send our Firebase token.
// Security: we verify the webhook signature instead (production only).
//
// How signature verification works (plain English):
// PayPal signs every webhook with a secret key. When we receive it,
// we send the signature back to PayPal and ask "did you actually send this?"
// If PayPal says yes → we process it. If no → we reject it.
// This prevents anyone from faking PayPal events to mess with your data.
router.post('/paypal', express.json({ verify: (req, res, buf) => { req.rawBody = buf.toString(); } }), async (req, res) => {
  try {
    const event = req.body;
    const eventType = event.event_type;

    console.log(`📬 PayPal webhook received: ${eventType}`);

    // Verify webhook signature in production
    // In sandbox/dev, we skip this because sandbox signatures are unreliable
    if (isProduction) {
      const webhookId = process.env.PAYPAL_WEBHOOK_ID;
      if (!webhookId) {
        console.error('❌ PAYPAL_WEBHOOK_ID not set — cannot verify webhook');
        return res.status(500).json({ error: 'Webhook configuration error' });
      }

      try {
        const verification = await paypal.verifyWebhook(req.headers, req.rawBody || req.body, webhookId);
        if (verification.verification_status !== 'SUCCESS') {
          console.error(`❌ Webhook signature verification FAILED for event: ${eventType}`);
          return res.status(401).json({ error: 'Invalid webhook signature' });
        }
        console.log(`🔒 Webhook signature verified: ${eventType}`);
      } catch (verifyError) {
        console.error('❌ Webhook verification error:', verifyError.message);
        return res.status(401).json({ error: 'Webhook verification failed' });
      }
    }

    // Route to handler based on event type
    switch (eventType) {

      // ── Subscription Events ──────────────────────────
      case 'BILLING.SUBSCRIPTION.ACTIVATED': {
        const subId = event.resource.id;
        const sub = await Subscription.findOne({ paypalSubscriptionId: subId });
        if (sub) {
          sub.status = 'active';
          sub.currentPeriodStart = new Date(event.resource.start_time);
          sub.paypalPayerEmail = event.resource.subscriber?.email_address || sub.paypalPayerEmail;
          await sub.save();
          console.log(`✅ Subscription activated: ${subId}`);
        }
        break;
      }

      case 'BILLING.SUBSCRIPTION.CANCELLED': {
        const subId = event.resource.id;
        const sub = await Subscription.findOne({ paypalSubscriptionId: subId });
        if (sub) {
          sub.status = 'canceled';
          sub.cancelAtPeriodEnd = false; // Already canceled
          const oldTier = sub.planTier;
          await sub.save();

          // Downgrade brand to starter
          const bp = await BrandProfile.findById(sub.brandProfileId);
          if (bp) {
            bp.planTier = 'starter';
            bp.billingCycle = null;
            await bp.save();

            // 📧 Notify brand: subscription canceled
            const brand = await Brand.findOne({ brandProfileId: bp._id });
            if (brand) {
              notify.subscriptionCanceled({ brand, planTier: oldTier }).catch(() => {});
            }
          }
          console.log(`❌ Subscription canceled: ${subId}`);
        }
        break;
      }

      case 'BILLING.SUBSCRIPTION.SUSPENDED': {
        // Payment failed — subscription suspended (past_due)
        const subId = event.resource.id;
        const sub = await Subscription.findOne({ paypalSubscriptionId: subId });
        if (sub) {
          sub.status = 'past_due';
          await sub.save();

          // 📧 Notify brand: payment failed
          try {
            const bp = await BrandProfile.findById(sub.brandProfileId);
            if (bp) {
              const brand = await Brand.findOne({ brandProfileId: bp._id });
              if (brand) {
                notify.subscriptionPaymentFailed({ brand, planTier: sub.planTier }).catch(() => {});
              }
            }
          } catch (e) { /* non-blocking */ }

          console.log(`⚠️ Subscription suspended (past_due): ${subId}`);
        }
        break;
      }

      case 'BILLING.SUBSCRIPTION.PAYMENT.FAILED': {
        const subId = event.resource.id;
        console.log(`⚠️ Subscription payment failed: ${subId}`);
        // PayPal auto-retries per payment_failure_threshold (set to 3)
        break;
      }

      case 'BILLING.SUBSCRIPTION.RENEWED': {
        const subId = event.resource.id;
        const sub = await Subscription.findOne({ paypalSubscriptionId: subId });
        if (sub) {
          sub.status = 'active';
          sub.currentPeriodStart = new Date();
          sub.currentPeriodEnd = sub.billingCycle === 'annual'
            ? new Date(Date.now() + 365 * 24 * 60 * 60 * 1000)
            : new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
          await sub.save();
          console.log(`🔄 Subscription renewed: ${subId}`);
        }
        break;
      }

      // ── PPCP Merchant Onboarding ──────────────────────────
      case 'MERCHANT.ONBOARDING.COMPLETED': {
        // Fires when an influencer finishes PayPal PPCP merchant onboarding.
        // Stores merchant ID so future CPA/PostdPay orders can route directly to them.
        const merchantId = event.resource?.merchant_id;
        const trackingId = event.resource?.tracking_id;

        if (merchantId && trackingId) {
          const influencer = await InfluencerProfile.findOneAndUpdate(
            { paypalTrackingId: trackingId },
            { $set: { paypalMerchantId: merchantId, paypalOnboardingStatus: 'completed' } },
            { new: true }
          );

          if (influencer) {
            console.log(`✅ PPCP onboarding completed (webhook): ${influencer.displayName} → merchantId=${merchantId}`);

            // 📱 Push: PayPal Business connected
            sendPushToUser(influencer.userId, {
              title: '✅ PayPal Ready!',
              body: 'Your PayPal Business account is connected. You\'ll receive payments automatically.',
              data: { type: 'paypal_connected' },
            }).catch(() => {});
          }
        }
        break;
      }

      // ── Payment Capture Events (Brand → Influencer) ──────
      case 'CHECKOUT.ORDER.APPROVED': {
        // Brand authorized the PayPal checkout — auto-capture immediately.
        // This is what makes the flow "automatic": brand approves once, capture fires here.
        const orderId = event.resource.id;
        console.log(`📋 Order approved, auto-capturing: ${orderId}`);

        try {
          const capture = await paypal.captureOrder(orderId);
          const captureId = capture?.purchase_units?.[0]?.payments?.captures?.[0]?.id;
          console.log(`✅ Auto-capture complete: orderId=${orderId}, captureId=${captureId}`);
        } catch (captureErr) {
          // Non-fatal: PAYMENT.CAPTURE.COMPLETED will fire if capture succeeds,
          // or PAYMENT.CAPTURE.DENIED if it fails. We handle both below.
          console.error(`❌ Auto-capture failed for order ${orderId}:`, captureErr.message);
        }
        break;
      }

      case 'PAYMENT.CAPTURE.COMPLETED': {
        // Payment captured successfully — mark transaction paid + notify influencer.
        // customId = our transaction._id (stored via purchase_unit.custom_id on order creation).
        const captureId = event.resource.id;
        const customId = event.resource.custom_id;

        if (customId) {
          const tx = await Transaction.findById(customId);
          if (tx && tx.status !== 'paid') {
            tx.status = 'paid';
            tx.paypalTransactionId = captureId;
            tx.paidAt = new Date();
            await tx.save();

            // Update influencer's lifetime cash earned stat
            const influencer = await InfluencerProfile.findByIdAndUpdate(
              tx.payeeInfluencerId,
              { $inc: { totalCashEarned: tx.amount } },
              { new: true }
            );

            // 📱 Push + email: payment landed in PayPal
            if (influencer) {
              const brand = tx.payerBrandId ? await Brand.findById(tx.payerBrandId) : null;
              const brandName = brand?.name || 'your brand partner';

              // Push notification — real-time "money arrived" feel
              sendPushToUser(influencer.userId, {
                title: '💰 Payment Received!',
                body: `$${tx.amount.toFixed(2)} from ${brandName} is in your PayPal`,
                data: { type: 'payment_received', transactionId: String(tx._id), amount: String(tx.amount) },
              }).catch(err => console.error('[webhook] Push failed:', err.message));

              // Email notification
              notify.cashRewardEarned({
                influencer: { ...influencer.toObject(), email: influencer.paypalEmail || '' },
                brand: { name: brandName },
                amount: tx.amount,
                type: tx.type,
              }).catch(() => {});
            }

            console.log(`✅ Payment confirmed: $${tx.amount} → transaction ${customId} (captureId: ${captureId})`);
          }
        }
        break;
      }

      case 'PAYMENT.CAPTURE.DENIED':
      case 'PAYMENT.CAPTURE.REFUNDED': {
        const captureId = event.resource.id;
        const customId = event.resource.custom_id;
        if (customId) {
          const tx = await Transaction.findById(customId);
          if (tx) {
            tx.status = eventType.includes('REFUNDED') ? 'refunded' : 'failed';
            tx.failedReason = eventType;
            await tx.save();
            console.log(`⚠️ Payment ${eventType}: transaction ${customId}`);
          }
        }
        break;
      }

      // ── Payout Events (KUP → Influencer platform bonuses) ──
      case 'PAYMENT.PAYOUTSBATCH.SUCCESS': {
        const batchId = event.resource.batch_header?.payout_batch_id;
        if (batchId) {
          const payout = await Payout.findOne({ paypalBatchId: batchId });
          if (payout) {
            payout.status = 'completed';
            payout.completedAt = new Date();
            payout.paypalResponse = event.resource;
            await payout.save();

            // Mark all transactions as paid
            await Transaction.updateMany(
              { _id: { $in: payout.transactionIds } },
              { $set: { status: 'paid', paidAt: new Date() } }
            );
            console.log(`✅ Payout batch completed: ${batchId}`);
          }
        }
        break;
      }

      case 'PAYMENT.PAYOUTSBATCH.DENIED': {
        const batchId = event.resource.batch_header?.payout_batch_id;
        if (batchId) {
          const payout = await Payout.findOne({ paypalBatchId: batchId });
          if (payout) {
            payout.status = 'failed';
            payout.paypalResponse = event.resource;
            await payout.save();

            await Transaction.updateMany(
              { _id: { $in: payout.transactionIds } },
              { $set: { status: 'failed', failedReason: 'Payout batch denied by PayPal' } }
            );
            console.log(`❌ Payout batch denied: ${batchId}`);
          }

          // Also check if this batch belongs to a Withdrawal (cashout)
          const withdrawal = await Withdrawal.findOne({ paypalBatchId: batchId });
          if (withdrawal && withdrawal.status === 'processing') {
            withdrawal.status = 'failed';
            withdrawal.failedReason = 'Payout batch denied by PayPal';
            await withdrawal.save();

            // Un-link transactions so they're available for cashout again
            await Transaction.updateMany(
              { _id: { $in: withdrawal.transactionIds } },
              { $set: { withdrawalId: null } }
            );
            console.log(`❌ Cashout failed (batch denied): ${batchId}`);
          }
        }
        break;
      }

      // ── Payout Item Events (Wallet Cashout Status) ──
      case 'PAYMENT.PAYOUTS-ITEM.SUCCEEDED': {
        const item = event.resource;
        const batchId = item.payout_batch_id;
        const payoutItemId = item.payout_item_id;

        if (batchId) {
          // Update Withdrawal record if this is a cashout
          const withdrawal = await Withdrawal.findOne({ paypalBatchId: batchId });
          if (withdrawal && withdrawal.status === 'processing') {
            withdrawal.status = 'completed';
            withdrawal.completedAt = new Date();
            withdrawal.paypalPayoutItemId = payoutItemId || withdrawal.paypalPayoutItemId;
            await withdrawal.save();

            // 📧 Notify influencer: cashout completed
            try {
              const influencer = await InfluencerProfile.findById(withdrawal.influencerProfileId);
              if (influencer) {
                notify.cashoutCompleted({
                  influencer: { ...influencer.toObject(), email: influencer.paypalEmail || '', userId: influencer.userId },
                  amount: withdrawal.amount,
                  paypalEmail: withdrawal.paypalEmail,
                }).catch(() => {});
              }
            } catch (e) { /* non-blocking */ }

            console.log(`✅ Cashout completed: $${withdrawal.amount} → ${withdrawal.paypalEmail} (item: ${payoutItemId})`);
          }
        }
        break;
      }

      case 'PAYMENT.PAYOUTS-ITEM.FAILED':
      case 'PAYMENT.PAYOUTS-ITEM.BLOCKED':
      case 'PAYMENT.PAYOUTS-ITEM.RETURNED':
      case 'PAYMENT.PAYOUTS-ITEM.REFUNDED': {
        const item = event.resource;
        const batchId = item.payout_batch_id;
        const reason = item.errors?.message || item.transaction_status || eventType;

        if (batchId) {
          const withdrawal = await Withdrawal.findOne({ paypalBatchId: batchId });
          if (withdrawal && withdrawal.status === 'processing') {
            withdrawal.status = eventType.includes('RETURNED') ? 'returned' : 'failed';
            withdrawal.failedReason = reason;
            await withdrawal.save();

            // Un-link transactions so they're available for cashout again
            await Transaction.updateMany(
              { _id: { $in: withdrawal.transactionIds } },
              { $set: { withdrawalId: null } }
            );

            // 📧 Notify influencer: cashout failed
            try {
              const influencer = await InfluencerProfile.findById(withdrawal.influencerProfileId);
              if (influencer) {
                notify.cashoutFailed({
                  influencer: { ...influencer.toObject(), email: influencer.paypalEmail || '', userId: influencer.userId },
                  amount: withdrawal.amount,
                  reason,
                }).catch(() => {});
              }
            } catch (e) { /* non-blocking */ }

            console.log(`❌ Cashout ${withdrawal.status}: ${batchId} — ${reason}`);
          }
        }
        break;
      }

      default:
        console.log(`📬 Unhandled PayPal event: ${eventType}`);
    }

    // Always return 200 to PayPal — otherwise they retry
    res.status(200).json({ received: true });
  } catch (error) {
    console.error('Webhook processing error:', error.message);
    // Still return 200 so PayPal doesn't keep retrying a broken event
    res.status(200).json({ received: true, error: 'Processing failed' });
  }
});

module.exports = router;
