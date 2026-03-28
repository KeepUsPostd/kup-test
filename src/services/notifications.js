// KUP Notification Service — Central Hub
// Maps platform events to email sends + in-app notifications + push (FCM).
// All routes call this service instead of sending emails directly.
//
// Three channels per notification:
//   📧 Email (SendGrid) — Transactional emails to inbox
//   🔔 In-App (MongoDB) — Bell icon / notification drawer
//   📱 Push (FCM) — Native iOS/Android lock screen banners
//
// Usage:
//   const notify = require('../services/notifications');
//   await notify.contentApproved({ influencer, brand, submission });
//
// Ref: NOTIFICATION_MAP.md → 15 Critical (Phase 1) notifications

const { sendEmail } = require('../config/email');
const { sendPushToUser } = require('../config/push');
const Notification = require('../models/Notification');

const APP_URL = process.env.APP_URL || 'http://localhost:3001';

// ── Helper: Create in-app notification ──────────────────
async function createInApp({ userId, title, message, type, link = null, metadata = {} }) {
  try {
    await Notification.create({
      userId,
      title,
      message,
      type,
      link,
      metadata,
    });
  } catch (err) {
    console.error('Failed to create in-app notification:', err.message);
  }
}

// ── Helper: Send push notification (non-blocking) ───────
// Wraps FCM call. Silently fails — push is best-effort.
async function push(userId, { title, body, data = {}, link = null }) {
  if (!userId) return;
  try {
    await sendPushToUser(userId, { title, body, data, link });
  } catch (err) {
    // Push failures are silent — user still gets email + in-app
    console.error('Push notification failed (non-blocking):', err.message);
  }
}

// ── Helper: Format dollar amounts ───────────────────────
function $(amount) {
  return `$${Number(amount).toFixed(2)}`;
}

// ═══════════════════════════════════════════════════════════
// 1. ACCOUNT & ONBOARDING
// ═══════════════════════════════════════════════════════════

// ACC-001: Brand account created (welcome email)
async function accountCreated({ user, brandName }) {
  await sendEmail({
    to: user.email,
    subject: `Welcome to KeepUsPostd, ${brandName}!`,
    headline: 'Welcome to KeepUsPostd!',
    preheader: 'Your brand is ready to grow with real influencer partnerships.',
    bodyHtml: `
      <p>Hey there! 👋</p>
      <p>Your brand <strong>${brandName}</strong> is now on KeepUsPostd. Here's what you can do next:</p>
      <p>
        ✅ Complete your brand profile<br>
        ✅ Set up your first campaign<br>
        ✅ Invite influencers to partner
      </p>
      <p>Let's get you better marketing results.</p>
    `,
    ctaText: 'Go to Dashboard',
    ctaUrl: `${APP_URL}/pages/inner/dashboard.html`,
    variant: 'brand',
  });
}

// ACC-002: Email verification sent
async function emailVerification({ email, verificationLink, variant = 'brand' }) {
  await sendEmail({
    to: email,
    subject: 'Verify Your Email — KeepUsPostd',
    headline: 'Verify Your Email',
    preheader: 'One quick step to activate your account.',
    bodyHtml: `
      <p>Thanks for signing up! Please verify your email address to activate your account.</p>
      <p>This link expires in 24 hours.</p>
    `,
    ctaText: 'Verify Email',
    ctaUrl: verificationLink,
    variant,
  });
}

// ACC-010: Password reset
async function passwordReset({ email, resetLink, variant = 'brand' }) {
  await sendEmail({
    to: email,
    subject: 'Reset Your Password — KeepUsPostd',
    headline: 'Reset Your Password',
    preheader: 'You requested a password reset.',
    bodyHtml: `
      <p>We received a request to reset your password. Click the button below to create a new one.</p>
      <p>If you didn't request this, you can safely ignore this email. Your password won't change.</p>
      <p style="font-size: 12px; color: #999;">This link expires in 1 hour.</p>
    `,
    ctaText: 'Reset Password',
    ctaUrl: resetLink,
    variant,
  });
}

// ACC-012: Login from new device
async function newDeviceLogin({ user, device, ip, variant = 'brand' }) {
  await sendEmail({
    to: user.email,
    subject: '🔐 New Login Detected — KeepUsPostd',
    headline: 'New Login Detected',
    preheader: 'Someone signed into your account from a new device.',
    bodyHtml: `
      <p>We detected a new sign-in to your KeepUsPostd account:</p>
      <p>
        <strong>Device:</strong> ${device || 'Unknown'}<br>
        <strong>IP Address:</strong> ${ip || 'Unknown'}<br>
        <strong>Time:</strong> ${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })}
      </p>
      <p>If this was you, you're all good. If not, please change your password immediately.</p>
    `,
    ctaText: 'Secure My Account',
    ctaUrl: `${APP_URL}/pages/inner/settings.html`,
    variant,
  });
}

// Influencer welcome (ACC-001 influencer variant)
async function influencerWelcome({ user }) {
  await sendEmail({
    to: user.email,
    subject: 'Welcome to KeepUsPostd!',
    headline: 'Welcome to KeepUsPostd!',
    preheader: 'Start partnering with the brands you love.',
    bodyHtml: `
      <p>Hey ${user.displayName || 'there'}! 👋</p>
      <p>Welcome to KeepUsPostd — where your influence earns real rewards.</p>
      <p>
        ✅ Complete your profile<br>
        ✅ Connect your social accounts for verification<br>
        ✅ Browse brands and apply for partnerships
      </p>
      <p>Let's get you earning.</p>
    `,
    ctaText: 'Open the App',
    ctaUrl: `${APP_URL}/app/home.html`,
    variant: 'influencer',
  });
}

// ═══════════════════════════════════════════════════════════
// 2. CONTENT LIFECYCLE
// ═══════════════════════════════════════════════════════════

// CON-001: Content submitted for review → notify brand
async function contentSubmitted({ brand, influencer, submission }) {
  const brandEmail = brand.ownerEmail || brand.email;
  if (!brandEmail) return;

  await sendEmail({
    to: brandEmail,
    subject: `New Content Submitted — ${influencer.displayName || 'An influencer'}`,
    headline: 'New Pending Review',
    preheader: `${influencer.displayName || 'An influencer'} submitted content for ${brand.name}`,
    bodyHtml: `
      <p><strong>${influencer.displayName || 'An influencer'}</strong> just submitted ${submission.contentType || 'content'} for <strong>${brand.name}</strong>.</p>
      <p>You have <strong>7 days</strong> to review and approve or reject this submission.</p>
    `,
    ctaText: 'Review Now',
    ctaUrl: `${APP_URL}/pages/inner/content.html`,
    variant: 'brand',
  });

  // In-app + push notification for brand owner
  if (brand.ownerId) {
    await createInApp({
      userId: brand.ownerId,
      title: 'New Content Submitted',
      message: `${influencer.displayName || 'An influencer'} submitted ${submission.contentType || 'content'} for review.`,
      type: 'content',
      link: '/pages/inner/content.html',
      metadata: { contentSubmissionId: submission._id?.toString() },
    });
    push(brand.ownerId, {
      title: 'New Content Submitted',
      body: `${influencer.displayName || 'An influencer'} submitted ${submission.contentType || 'content'} for review.`,
      link: '/pages/inner/content.html',
    });
  }
}

// CON-002: Content submission confirmation → notify influencer
async function contentSubmissionConfirmed({ influencer, brand, submission }) {
  if (!influencer.email) return;

  await sendEmail({
    to: influencer.email,
    subject: `Content Submitted to ${brand.name}`,
    headline: 'Successfully Submitted!',
    preheader: `Your ${submission.contentType || 'content'} has been submitted for review.`,
    bodyHtml: `
      <p>Your ${submission.contentType || 'content'} for <strong>${brand.name}</strong> has been submitted successfully!</p>
      <p>The brand will review your submission within 7 days. You'll get a notification when they respond.</p>
    `,
    ctaText: 'View My Submissions',
    ctaUrl: `${APP_URL}/app/submissions.html`,
    variant: 'influencer',
  });
}

// CON-003: Content approved → notify influencer
async function contentApproved({ influencer, brand, submission, reward = null }) {
  if (!influencer.email) return;

  let rewardLine = '';
  if (reward) {
    rewardLine = `<p>🎉 <strong>Reward earned:</strong> ${$(reward.amount)} has been added to your wallet!</p>`;
  }

  await sendEmail({
    to: influencer.email,
    subject: `✅ Content Approved — ${brand.name}`,
    headline: 'Your Content Was Approved!',
    preheader: `${brand.name} approved your ${submission.contentType || 'content'}.`,
    bodyHtml: `
      <p>Great news! <strong>${brand.name}</strong> has approved your ${submission.contentType || 'content'}.</p>
      ${rewardLine}
      <p>Keep up the great work — the brand can now use your content in their marketing.</p>
    `,
    ctaText: 'View Details',
    ctaUrl: `${APP_URL}/app/submissions.html`,
    variant: 'influencer',
  });

  // In-app + push notification
  if (influencer.userId) {
    const msg = `${brand.name} approved your ${submission.contentType || 'content'}.${reward ? ` You earned ${$(reward.amount)}!` : ''}`;
    await createInApp({
      userId: influencer.userId,
      title: 'Content Approved!',
      message: msg,
      type: 'content',
      link: '/app/submissions.html',
      metadata: { contentSubmissionId: submission._id?.toString() },
    });
    push(influencer.userId, {
      title: '✅ Content Approved!',
      body: msg,
      link: '/app/submissions.html',
    });
  }
}

// CON-004: Content rejected → notify influencer
async function contentRejected({ influencer, brand, submission, reason = '' }) {
  if (!influencer.email) return;

  const reasonLine = reason
    ? `<p><strong>Reason:</strong> ${reason}</p>`
    : '<p>No specific reason was provided.</p>';

  await sendEmail({
    to: influencer.email,
    subject: `Content Update — ${brand.name}`,
    headline: 'Content Not Approved',
    preheader: `${brand.name} reviewed your submission.`,
    bodyHtml: `
      <p><strong>${brand.name}</strong> reviewed your ${submission.contentType || 'content'} and decided not to approve it at this time.</p>
      ${reasonLine}
      <p>Don't worry — you can always submit new content. Check the campaign guidelines for tips on what the brand is looking for.</p>
    `,
    ctaText: 'View Feedback',
    ctaUrl: `${APP_URL}/app/submissions.html`,
    variant: 'influencer',
  });

  // In-app + push notification
  if (influencer.userId) {
    const msg = `${brand.name} did not approve your ${submission.contentType || 'content'}.${reason ? ` Reason: ${reason}` : ''}`;
    await createInApp({
      userId: influencer.userId,
      title: 'Content Not Approved',
      message: msg,
      type: 'content',
      link: '/app/submissions.html',
      metadata: { contentSubmissionId: submission._id?.toString() },
    });
    push(influencer.userId, {
      title: 'Content Update',
      body: msg,
      link: '/app/submissions.html',
    });
  }
}

// CON-007: Content marked as "Postd" → notify influencer
async function contentPostd({ influencer, brand, submission, bonusAmount = null }) {
  if (!influencer.email) return;

  let bonusLine = '';
  if (bonusAmount) {
    bonusLine = `<p>💰 <strong>Postd Bonus:</strong> ${$(bonusAmount)} added to your wallet!</p>`;
  }

  await sendEmail({
    to: influencer.email,
    subject: `🎉 Your Content Was Posted — ${brand.name}`,
    headline: 'Your Content is Live!',
    preheader: `${brand.name} posted your content!`,
    bodyHtml: `
      <p>Awesome! <strong>${brand.name}</strong> has posted your ${submission.contentType || 'content'} on their channels.</p>
      ${bonusLine}
      <p>This is a great look for your portfolio. Keep creating!</p>
    `,
    ctaText: 'View My Portfolio',
    ctaUrl: `${APP_URL}/app/submissions.html`,
    variant: 'influencer',
  });
}

// ═══════════════════════════════════════════════════════════
// 3. PAYMENTS & BILLING
// ═══════════════════════════════════════════════════════════

// PAY-005: Subscription renewal/payment failed → notify brand
async function subscriptionPaymentFailed({ brand, planTier }) {
  const brandEmail = brand.ownerEmail || brand.email;
  if (!brandEmail) return;

  await sendEmail({
    to: brandEmail,
    subject: '⚠️ Subscription Payment Failed — KeepUsPostd',
    headline: 'Payment Failed',
    preheader: 'Your subscription payment could not be processed.',
    bodyHtml: `
      <p>We were unable to process the payment for your <strong>${planTier || ''} plan</strong> subscription.</p>
      <p>PayPal will automatically retry the payment. If the issue persists, please update your payment method to avoid service interruption.</p>
      <p>Your account will remain active during the retry period, but features may be limited if payment is not resolved.</p>
    `,
    ctaText: 'Update Payment Method',
    ctaUrl: `${APP_URL}/pages/inner/cash-account.html`,
    variant: 'brand',
  });
}

// PAY-006: Subscription canceled → notify brand
async function subscriptionCanceled({ brand, planTier }) {
  const brandEmail = brand.ownerEmail || brand.email;
  if (!brandEmail) return;

  await sendEmail({
    to: brandEmail,
    subject: 'Subscription Canceled — KeepUsPostd',
    headline: 'Your Subscription Has Been Canceled',
    preheader: `Your ${planTier || ''} plan has been canceled.`,
    bodyHtml: `
      <p>Your <strong>${planTier || ''} plan</strong> subscription has been canceled.</p>
      <p>Your brand has been moved to the <strong>Starter</strong> (free) tier. You can still access basic features, but premium features are no longer available.</p>
      <p>Want to come back? You can resubscribe anytime.</p>
    `,
    ctaText: 'View Plans',
    ctaUrl: `${APP_URL}/pages/inner/cash-account.html`,
    variant: 'brand',
  });
}

// PAY-007: PayPal connected → notify influencer
async function paypalConnected({ influencer, maskedEmail }) {
  if (!influencer.email) return;

  await sendEmail({
    to: influencer.email,
    subject: '✅ PayPal Connected — KeepUsPostd',
    headline: 'PayPal Account Connected!',
    preheader: 'You can now receive payments through KeepUsPostd.',
    bodyHtml: `
      <p>Your PayPal account <strong>${maskedEmail}</strong> has been connected to your KeepUsPostd profile.</p>
      <p>When you earn money from brand partnerships, it will appear in your wallet. You can cash out to this PayPal account anytime (minimum ${$('5.00')}).</p>
    `,
    ctaText: 'View My Wallet',
    ctaUrl: `${APP_URL}/app/wallet.html`,
    variant: 'influencer',
  });
}

// PAY-011: Cash withdrawal completed → notify influencer
async function cashoutCompleted({ influencer, amount, paypalEmail }) {
  if (!influencer.email) return;

  await sendEmail({
    to: influencer.email,
    subject: `💰 ${$(amount)} Sent to Your PayPal`,
    headline: 'Cash Out Complete!',
    preheader: `${$(amount)} has been sent to your PayPal account.`,
    bodyHtml: `
      <p>Your cash out of <strong>${$(amount)}</strong> has been sent to your PayPal account at <strong>${paypalEmail}</strong>.</p>
      <p>It may take a few minutes to appear in your PayPal balance. Check your PayPal app or email for the deposit notification.</p>
    `,
    ctaText: 'View Wallet',
    ctaUrl: `${APP_URL}/app/wallet.html`,
    variant: 'influencer',
  });
}

// PAY-012: Cash withdrawal failed → notify influencer
async function cashoutFailed({ influencer, amount, reason = '' }) {
  if (!influencer.email) return;

  await sendEmail({
    to: influencer.email,
    subject: '⚠️ Cash Out Failed — KeepUsPostd',
    headline: 'Cash Out Failed',
    preheader: 'There was an issue processing your cash out.',
    bodyHtml: `
      <p>We were unable to send your cash out of <strong>${$(amount)}</strong> to your PayPal account.</p>
      ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
      <p>Your balance has been restored — the money is still safely in your wallet. Please verify your PayPal email is correct and try again.</p>
    `,
    ctaText: 'Check PayPal Settings',
    ctaUrl: `${APP_URL}/app/settings.html`,
    variant: 'influencer',
  });
}

// RWD-003: Cash reward distributed → notify influencer
async function cashRewardEarned({ influencer, brand, amount, type = 'cash_per_approval' }) {
  if (!influencer.email) return;

  const typeLabel = {
    cash_per_approval: 'Content Approval Pay',
    bonus_cash: 'Bonus Cash',
    postd_pay: 'Postd Pay',
    viral_bonus: 'Viral Bonus',
    platform_bonus: 'Platform Bonus',
    referral_bonus: 'Referral Bonus',
  }[type] || 'Payment';

  await sendEmail({
    to: influencer.email,
    subject: `💰 You Earned ${$(amount)} — ${typeLabel}`,
    headline: `You Earned ${$(amount)}!`,
    preheader: `${$(amount)} ${typeLabel} from ${brand?.name || 'KeepUsPostd'}`,
    bodyHtml: `
      <p>You just earned <strong>${$(amount)}</strong> from <strong>${brand?.name || 'KeepUsPostd'}</strong>!</p>
      <p><strong>Type:</strong> ${typeLabel}</p>
      <p>This has been added to your wallet balance. Cash out anytime to your connected PayPal account.</p>
    `,
    ctaText: 'View My Wallet',
    ctaUrl: `${APP_URL}/app/wallet.html`,
    variant: 'influencer',
  });

  // In-app + push notification
  if (influencer.userId) {
    const msg = `${typeLabel} from ${brand?.name || 'KeepUsPostd'}`;
    await createInApp({
      userId: influencer.userId,
      title: `You earned ${$(amount)}!`,
      message: msg,
      type: 'payment',
      link: '/app/wallet.html',
    });
    push(influencer.userId, {
      title: `💰 You earned ${$(amount)}!`,
      body: msg,
      link: '/app/wallet.html',
    });
  }
}

// Brand payment confirmation (when brand pays for content)
async function brandPaymentConfirmed({ brand, influencer, amount, brandPaysAmount }) {
  const brandEmail = brand.ownerEmail || brand.email;
  if (!brandEmail) return;

  await sendEmail({
    to: brandEmail,
    subject: `Payment Sent — ${$(brandPaysAmount)} to ${influencer.displayName || 'Influencer'}`,
    headline: 'Payment Confirmed',
    preheader: `You paid ${$(brandPaysAmount)} for approved content.`,
    bodyHtml: `
      <p>Your payment of <strong>${$(brandPaysAmount)}</strong> for content from <strong>${influencer.displayName || 'an influencer'}</strong> has been processed.</p>
      <p>
        <strong>Influencer receives:</strong> ${$(amount)}<br>
        <strong>Platform fee:</strong> $0.50<br>
        <strong>Processing fee:</strong> included
      </p>
    `,
    ctaText: 'View Transactions',
    ctaUrl: `${APP_URL}/pages/inner/cash-account.html`,
    variant: 'brand',
  });
}

// ═══════════════════════════════════════════════════════════
// 4. REVIEW REMINDERS
// ═══════════════════════════════════════════════════════════

// CON-007 variant: 3 days remaining to review
async function reviewReminder({ brand, pendingCount }) {
  const brandEmail = brand.ownerEmail || brand.email;
  if (!brandEmail) return;

  await sendEmail({
    to: brandEmail,
    subject: `⏰ ${pendingCount} Submission${pendingCount > 1 ? 's' : ''} Awaiting Review`,
    headline: '3 Days Remaining to Review',
    preheader: `You have ${pendingCount} pending content review${pendingCount > 1 ? 's' : ''}.`,
    bodyHtml: `
      <p>You have <strong>${pendingCount}</strong> content submission${pendingCount > 1 ? 's' : ''} waiting for your review.</p>
      <p>Content not reviewed within 7 days may be auto-approved per platform policy. Review now to maintain quality control over your brand content.</p>
    `,
    ctaText: 'Review Content',
    ctaUrl: `${APP_URL}/pages/inner/content.html`,
    variant: 'brand',
  });
}

module.exports = {
  // Account
  accountCreated,
  emailVerification,
  passwordReset,
  newDeviceLogin,
  influencerWelcome,

  // Content
  contentSubmitted,
  contentSubmissionConfirmed,
  contentApproved,
  contentRejected,
  contentPostd,

  // Payments
  subscriptionPaymentFailed,
  subscriptionCanceled,
  paypalConnected,
  cashoutCompleted,
  cashoutFailed,
  cashRewardEarned,
  brandPaymentConfirmed,

  // Reminders
  reviewReminder,
};
