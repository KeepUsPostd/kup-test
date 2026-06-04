// Payout reminder service — Build 146
//
// Background: until PayPal Vault is enabled for KUP, creator payouts get
// stuck at status='pending'. Creators with no PayPal email connected have
// money waiting on the platform but no way to claim it. This service nudges
// them once a week.
//
// Two entry points:
//   1) sendRemindersForUnclaimedPayouts()  — daily cron; sweeps the platform
//   2) sweepCreatorOnPayPalConnect(userId) — called from /api/auth/paypal-connect
//      after the email is saved. Flags newly-claimable transactions to the
//      admin so they can process the manual payout immediately.

const InfluencerProfile = require('../models/InfluencerProfile');
const Transaction = require('../models/Transaction');
const Brand = require('../models/Brand');
const Notification = require('../models/Notification');

const REMINDER_COOLDOWN_DAYS = 7;

/** Sum pending payouts owed to one creator. */
async function _pendingTotalFor(influencerProfileId) {
  const result = await Transaction.aggregate([
    {
      $match: {
        payeeInfluencerId: influencerProfileId,
        status: { $in: ['pending', 'processing'] },
      },
    },
    { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);
  if (result.length === 0) return { total: 0, count: 0 };
  return { total: result[0].total || 0, count: result[0].count || 0 };
}

/**
 * Daily cron entry. Finds every InfluencerProfile with at least one pending
 * Transaction AND no PayPal email connected AND no reminder sent in the
 * past REMINDER_COOLDOWN_DAYS. Sends an in-app + push notification,
 * stamps lastPayoutReminderSentAt.
 *
 * Returns a small report { reminded, skippedThrottled, totalDollars }.
 */
async function sendRemindersForUnclaimedPayouts({ notifySvc } = {}) {
  // Resolve notification service lazily so this module is import-safe even
  // if notifications.js isn't ready (e.g. during tests).
  const notify = notifySvc || require('./notifications');

  const cooldownCutoff = new Date(Date.now() - REMINDER_COOLDOWN_DAYS * 86400000);

  // Find candidates: profiles with at least one pending Tx, no PayPal,
  // and either never-reminded or last-reminded before the cooldown cutoff.
  const candidateIds = await Transaction.distinct('payeeInfluencerId', {
    status: { $in: ['pending', 'processing'] },
  });
  if (candidateIds.length === 0) return { reminded: 0, skippedThrottled: 0, skippedConnected: 0, totalDollars: 0 };

  const profiles = await InfluencerProfile.find({
    _id: { $in: candidateIds },
    $or: [{ paypalEmail: null }, { paypalEmail: { $exists: false } }, { paypalEmail: '' }],
    $or: [
      { paypalEmail: null }, { paypalEmail: { $exists: false } }, { paypalEmail: '' },
      // The above $or duplicated to be a single condition with a sibling
      // condition on the throttle date — Mongo requires this nesting.
    ],
  }, 'displayName handle userId paypalEmail lastPayoutReminderSentAt').lean();

  // Apply throttle in code (clearer than nested $or with $and).
  const eligible = profiles
    .filter(p => !p.paypalEmail) // belt + suspenders
    .filter(p => !p.lastPayoutReminderSentAt || new Date(p.lastPayoutReminderSentAt) < cooldownCutoff);

  const skippedConnected = profiles.length - profiles.filter(p => !p.paypalEmail).length;
  const skippedThrottled = profiles.filter(p => !!p.paypalEmail ? false : (p.lastPayoutReminderSentAt && new Date(p.lastPayoutReminderSentAt) >= cooldownCutoff)).length;

  let reminded = 0;
  let totalDollars = 0;

  for (const profile of eligible) {
    const { total, count } = await _pendingTotalFor(profile._id);
    if (total <= 0 || count === 0) continue;

    const amount = (Math.round(total * 100) / 100).toFixed(2);
    const title = `You have $${amount} waiting on KUP`;
    const message = count === 1
      ? `One brand payout is ready. Connect your PayPal in Settings to claim it.`
      : `${count} brand payouts are ready ($${amount} total). Connect your PayPal in Settings to claim them.`;

    try {
      if (notify.createInApp) {
        await notify.createInApp({
          userId: profile.userId,
          title,
          message,
          type: 'payment',
          metadata: { kind: 'payout_reminder', pendingTotal: total, pendingCount: count },
        });
      }
      if (notify.sendPushToUser) {
        await notify.sendPushToUser(profile.userId, { title, body: message }).catch(() => {});
      }
      await InfluencerProfile.updateOne(
        { _id: profile._id },
        { $set: { lastPayoutReminderSentAt: new Date() } }
      );
      reminded += 1;
      totalDollars += total;
      console.log(`💸 Payout reminder sent → @${profile.handle || profile.displayName}: $${amount} (${count} tx)`);
    } catch (err) {
      console.warn(`[payoutReminders] failed to remind ${profile._id}:`, err.message);
    }
  }

  return {
    reminded,
    skippedThrottled,
    skippedConnected,
    totalDollars: Math.round(totalDollars * 100) / 100,
  };
}

/**
 * Called from the PayPal connect endpoint AFTER the email has been saved.
 * Finds every pending Transaction belonging to this creator, alerts the
 * admin team that they're now ready to process, and confirms to the
 * creator. Once vault is enabled in the future, the "alert admin" step
 * gets replaced with "fire auto-payout via brand's vault token".
 */
async function sweepCreatorOnPayPalConnect(userId, { notifySvc } = {}) {
  const notify = notifySvc || require('./notifications');
  const profile = await InfluencerProfile.findOne({ userId }).lean();
  if (!profile || !profile.paypalEmail) return { swept: 0, total: 0 };

  const pending = await Transaction.find({
    payeeInfluencerId: profile._id,
    status: { $in: ['pending', 'processing'] },
  }).lean();
  if (pending.length === 0) return { swept: 0, total: 0 };

  const total = pending.reduce((s, t) => s + (t.amount || 0), 0);
  const dollars = (Math.round(total * 100) / 100).toFixed(2);

  // Tell the creator their payout is queued.
  try {
    if (notify.createInApp) {
      await notify.createInApp({
        userId,
        title: `Your $${dollars} payout is queued`,
        message: pending.length === 1
          ? `Your PayPal is connected. We'll send your payout shortly.`
          : `Your PayPal is connected. We'll send your ${pending.length} pending payouts ($${dollars} total) shortly.`,
        type: 'payment',
        metadata: { kind: 'payout_queued', pendingTotal: total, pendingCount: pending.length },
      });
    }
  } catch (_) {/* non-fatal */}

  // Alert admins. Look up admin user IDs from ADMIN_EMAILS to deliver
  // in-app notifications they'll see in the admin panel.
  try {
    const adminEmails = (process.env.ADMIN_EMAILS || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (adminEmails.length > 0) {
      const User = require('../models/User');
      const admins = await User.find({ email: { $in: adminEmails } }, '_id').lean();
      for (const a of admins) {
        if (notify.createInApp) {
          await notify.createInApp({
            userId: a._id,
            title: `Payout sweep: ${profile.displayName || '@' + profile.handle} ready`,
            message: `${pending.length} pending payout${pending.length === 1 ? '' : 's'} ($${dollars}) for @${profile.handle}. PayPal just connected → process from Admin → Financials.`,
            type: 'payment',
            metadata: { kind: 'payout_sweep', influencerProfileId: profile._id, pendingTotal: total },
          });
        }
      }
    }
  } catch (err) {
    console.warn('[sweepCreatorOnPayPalConnect] admin notify error:', err.message);
  }

  console.log(`🧹 Payout sweep on connect → @${profile.handle}: ${pending.length} tx, $${dollars} ready`);
  return { swept: pending.length, total };
}

module.exports = {
  sendRemindersForUnclaimedPayouts,
  sweepCreatorOnPayPalConnect,
  REMINDER_COOLDOWN_DAYS,
};
