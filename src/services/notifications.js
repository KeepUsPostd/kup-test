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
      metadata: {
        contentSubmissionId: submission._id?.toString(),
        brandName: brand.name,
        brandLogoUrl: brand.logoUrl || brand.avatarUrl || '',
        contentType: submission.contentType,
        thumbnailUrl: submission.posterUrl || (submission.mediaUrls && submission.mediaUrls[0]) || '',
      },
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

  // In-app notification
  if (influencer.userId) {
    const msg = `Your ${submission.contentType || 'content'} for ${brand.name} was submitted. The brand will review it soon.`;
    await createInApp({
      userId: influencer.userId,
      title: 'Content Submitted!',
      message: msg,
      type: 'content',
      link: '/app/submissions.html',
      metadata: {
        contentSubmissionId: submission._id?.toString(),
        brandName: brand.name,
        brandLogoUrl: brand.logoUrl || brand.avatarUrl || '',
        contentType: submission.contentType,
        thumbnailUrl: submission.posterUrl || (submission.mediaUrls && submission.mediaUrls[0]) || '',
      },
    });
    push(influencer.userId, {
      title: 'Content Submitted!',
      body: msg,
    });
  }
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
      type: 'approval',
      link: '/app/submissions.html',
      metadata: {
        contentSubmissionId: submission._id?.toString(),
        partnershipId: submission.partnershipId?.toString() || null,
        brandName: brand.name,
        brandLogoUrl: brand.logoUrl || brand.avatarUrl || '',
        contentType: submission.contentType,
        thumbnailUrl: submission.posterUrl || (submission.mediaUrls && submission.mediaUrls[0]) || '',
      },
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
      metadata: {
        contentSubmissionId: submission._id?.toString(),
        partnershipId: submission.partnershipId?.toString() || null,
        brandName: brand.name,
        brandLogoUrl: brand.logoUrl || brand.avatarUrl || '',
        contentType: submission.contentType,
        thumbnailUrl: submission.posterUrl || (submission.mediaUrls && submission.mediaUrls[0]) || '',
      },
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

// PAY-006b: Money waiting — influencer approved but no PPCP connected yet
// Also used for weekly cron reminders (isWeeklyReminder: true)
async function paypalMoneyWaiting({ influencer, brand, amount, isWeeklyReminder = false, hasPendingCash = false }) {
  if (!influencer.email) return;

  const connectUrl = `${APP_URL}/app/influencer-earn.html`;

  let subject, headline, preheader, bodyHtml, pushTitle, pushBody;

  if (isWeeklyReminder) {
    if (hasPendingCash && amount > 0) {
      // Weekly — specific pending amount
      subject   = `⏰ Reminder: ${$(amount)} is waiting for you — connect PayPal`;
      headline  = `You Still Have ${$(amount)} Waiting!`;
      preheader = `Your cash reward is sitting unclaimed. Connect PayPal to receive it.`;
      bodyHtml  = `
        <p>You currently have <strong>${$(amount)}</strong> in cash rewards waiting to be paid out — but we can't send it until you connect your PayPal account.</p>
        <p>It only takes a few minutes. Once connected, you'll receive payments automatically every time a brand approves your content.</p>
        <p>Don't let your earnings sit unclaimed!</p>
      `;
      pushTitle = `⏰ ${$(amount)} still waiting for you!`;
      pushBody  = 'Connect PayPal now to claim your cash reward.';
    } else {
      // Weekly — general reminder, no specific pending amount yet
      subject   = '💡 Reminder: Connect PayPal to get paid on KeepUsPostd';
      headline  = 'Get Paid for Your Reviews';
      preheader = 'Some brands pay cash — connect PayPal so you never miss a payout.';
      bodyHtml  = `
        <p>Many brands on KeepUsPostd offer <strong>cash payments</strong> for approved reviews. To receive those payments, you'll need to connect your PayPal Business account.</p>
        <p>It only takes a few minutes — and once you're connected, any cash rewards you earn will be sent directly to your PayPal account automatically.</p>
        <p>Don't miss out on cash payouts!</p>
      `;
      pushTitle = '💡 Connect PayPal to get paid';
      pushBody  = 'Some brands on KUP pay cash — connect PayPal to receive your rewards.';
    }
  } else {
    // Immediate trigger — brand just approved content, cash is ready
    subject   = `💰 You have ${$(amount)} waiting — connect PayPal to receive it`;
    headline  = `${$(amount)} is Waiting for You!`;
    preheader = `${brand?.name || 'A brand'} approved your content and wants to pay you.`;
    bodyHtml  = `
      <p><strong>${brand?.name || 'A brand partner'}</strong> just approved your content and has <strong>${$(amount)}</strong> ready to send you directly.</p>
      <p>To receive cash payments, you need to connect your PayPal Business account. It only takes a few minutes — and once connected, you'll get paid automatically every time a brand approves your content.</p>
      <p>Some brands on KeepUsPostd pay cash per approved review. Don't leave money on the table!</p>
    `;
    pushTitle = `💰 ${$(amount)} waiting for you!`;
    pushBody  = 'Connect your PayPal to receive your cash reward.';
  }

  await sendEmail({
    to: influencer.email,
    subject,
    headline,
    preheader,
    bodyHtml,
    ctaText: 'Connect PayPal & Get Paid',
    ctaUrl: connectUrl,
    variant: 'influencer',
  });

  // In-app + push notification
  if (influencer.userId) {
    await createInApp({
      userId: influencer.userId,
      title: pushTitle,
      message: isWeeklyReminder
        ? (hasPendingCash ? `You have ${$(amount)} in cash rewards waiting. Connect PayPal to claim it.` : 'Some brands on KUP pay cash. Connect PayPal so you never miss a payout.')
        : `${brand?.name || 'A brand'} approved your content. Connect PayPal to receive your payment.`,
      type: 'payment',
      link: '/app/influencer-earn.html',
    });
    push(influencer.userId, {
      title: pushTitle,
      body: pushBody,
      link: '/app/influencer-earn.html',
    });
  }
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
async function cashRewardEarned({ influencer, brand, amount, type = 'cash_per_approval', partnershipId = null }) {
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
      link: '/app/influencer-earn.html',
      metadata: {
        brandName: brand?.name || 'KeepUsPostd',
        brandLogoUrl: brand?.logoUrl || brand?.avatarUrl || '',
        partnershipId: partnershipId || null,
        amount,
        paymentType: type,
      },
    });
    push(influencer.userId, {
      title: `You earned ${$(amount)}!`,
      body: msg,
      link: '/app/influencer-earn.html',
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

// ═══════════════════════════════════════════════════════════
// 5. ACCOUNT — PHASE 2 (Standard Priority)
// ═══════════════════════════════════════════════════════════

// ACC-003: Email verified successfully
async function emailVerified({ user, variant = 'brand' }) {
  await sendEmail({
    to: user.email,
    subject: '✅ Email Verified — KeepUsPostd',
    headline: 'Email Verified!',
    preheader: 'Your email has been confirmed.',
    bodyHtml: `
      <p>Your email address has been verified successfully. Your account is now fully activated.</p>
      <p>You're all set to start using KeepUsPostd!</p>
    `,
    ctaText: variant === 'brand' ? 'Go to Dashboard' : 'Open the App',
    ctaUrl: variant === 'brand' ? `${APP_URL}/pages/inner/dashboard.html` : `${APP_URL}/app/home.html`,
    variant,
  });

  if (user._id || user.firebaseUid) {
    const userId = user.firebaseUid || user._id?.toString();
    await createInApp({
      userId,
      title: 'Email Verified',
      message: 'Your email has been verified. Account fully activated!',
      type: 'account',
    });
  }
}

// ACC-011: Password changed successfully
async function passwordChanged({ user, variant = 'brand' }) {
  await sendEmail({
    to: user.email,
    subject: '🔐 Password Changed — KeepUsPostd',
    headline: 'Password Updated',
    preheader: 'Your password has been changed successfully.',
    bodyHtml: `
      <p>Your KeepUsPostd password has been changed successfully.</p>
      <p>If you didn't make this change, please reset your password immediately and contact our support team.</p>
    `,
    ctaText: 'Secure My Account',
    ctaUrl: `${APP_URL}/pages/inner/settings.html`,
    variant,
  });
}

// ACC-013: Account email changed
async function emailChanged({ oldEmail, newEmail, variant = 'brand' }) {
  // Notify BOTH the old and new email addresses
  await sendEmail({
    to: oldEmail,
    subject: '⚠️ Email Address Changed — KeepUsPostd',
    headline: 'Your Email Was Changed',
    preheader: 'Your account email address has been updated.',
    bodyHtml: `
      <p>The email address on your KeepUsPostd account has been changed to a new address.</p>
      <p>If you did not make this change, please contact support immediately.</p>
    `,
    variant,
  });

  await sendEmail({
    to: newEmail,
    subject: '✅ Email Updated — KeepUsPostd',
    headline: 'Email Address Updated',
    preheader: 'Your new email is now active on KeepUsPostd.',
    bodyHtml: `
      <p>Your KeepUsPostd account email has been updated to this address.</p>
      <p>All future notifications will be sent here.</p>
    `,
    variant,
  });
}

// ACC-015: Account deletion requested
async function accountDeletionRequested({ user, deletionDate, variant = 'brand' }) {
  await sendEmail({
    to: user.email,
    subject: 'Account Deletion Requested — KeepUsPostd',
    headline: 'Account Deletion Scheduled',
    preheader: `Your account is scheduled for deletion on ${deletionDate}.`,
    bodyHtml: `
      <p>We received your request to delete your KeepUsPostd account.</p>
      <p>Your account and all associated data will be permanently deleted on <strong>${deletionDate}</strong>.</p>
      <p>If you change your mind, you can cancel the deletion from your settings before that date.</p>
    `,
    ctaText: 'Cancel Deletion',
    ctaUrl: `${APP_URL}/pages/inner/settings.html`,
    variant,
  });
}

// ACC-016: Account deletion canceled
async function accountDeletionCanceled({ user, variant = 'brand' }) {
  await sendEmail({
    to: user.email,
    subject: '✅ Account Deletion Canceled — KeepUsPostd',
    headline: 'Deletion Canceled',
    preheader: 'Your account will not be deleted.',
    bodyHtml: `
      <p>Great news — your account deletion has been canceled. Your account is fully active again.</p>
      <p>Welcome back! All your data and partnerships are intact.</p>
    `,
    ctaText: variant === 'brand' ? 'Go to Dashboard' : 'Open the App',
    ctaUrl: variant === 'brand' ? `${APP_URL}/pages/inner/dashboard.html` : `${APP_URL}/app/home.html`,
    variant,
  });
}

// ACC-006: Onboarding incomplete reminder (24hr)
async function onboardingReminder24h({ user, brandName }) {
  await sendEmail({
    to: user.email,
    subject: `Almost there, ${brandName || 'friend'}! Finish setting up your brand`,
    headline: 'Finish Setting Up Your Brand',
    preheader: 'You\'re just a few steps away from going live.',
    bodyHtml: `
      <p>You started setting up <strong>${brandName || 'your brand'}</strong> on KeepUsPostd but didn't finish.</p>
      <p>Complete your profile to start connecting with influencers and growing your brand.</p>
    `,
    ctaText: 'Continue Setup',
    ctaUrl: `${APP_URL}/pages/onboarding.html`,
    variant: 'brand',
  });

  if (user._id || user.firebaseUid) {
    push(user.firebaseUid || user._id?.toString(), {
      title: 'Finish Your Setup',
      body: `Complete your ${brandName || 'brand'} profile to start connecting with influencers.`,
      link: '/pages/onboarding.html',
    });
  }
}

// ACC-007: Onboarding incomplete reminder (72hr)
async function onboardingReminder72h({ user, brandName }) {
  await sendEmail({
    to: user.email,
    subject: `Don't miss out — ${brandName || 'your brand'} is waiting`,
    headline: 'Your Brand is Waiting',
    preheader: 'Complete your setup and start partnering with influencers.',
    bodyHtml: `
      <p>It's been a few days since you started setting up <strong>${brandName || 'your brand'}</strong> on KeepUsPostd.</p>
      <p>Brands that complete setup within the first week see <strong>3x more influencer interest</strong>. Don't miss your window!</p>
    `,
    ctaText: 'Complete Setup Now',
    ctaUrl: `${APP_URL}/pages/onboarding.html`,
    variant: 'brand',
  });
}

// ACC-009: Draft brand reminder — publish nudge (48hr)
async function draftBrandReminder({ user, brandName }) {
  await sendEmail({
    to: user.email,
    subject: `${brandName || 'Your brand'} is saved as a draft`,
    headline: 'Ready to Publish?',
    preheader: 'Your brand profile is saved. Publish it to go live on the marketplace.',
    bodyHtml: `
      <p>Your brand <strong>${brandName || ''}</strong> is saved as a draft. It won't appear on the marketplace until you publish it.</p>
      <p>When you're ready, hit publish and influencers can start discovering your brand.</p>
    `,
    ctaText: 'Publish Now',
    ctaUrl: `${APP_URL}/pages/inner/brand-profile.html`,
    variant: 'brand',
  });
}

// ═══════════════════════════════════════════════════════════
// 6. BRAND PROFILE — PHASE 2
// ═══════════════════════════════════════════════════════════

// BRD-002: Brand published to marketplace
async function brandPublished({ user, brand }) {
  const brandEmail = brand.ownerEmail || brand.email || user?.email;
  if (!brandEmail) return;

  await sendEmail({
    to: brandEmail,
    subject: `🎉 ${brand.name} is Live on the Marketplace!`,
    headline: 'Your Brand is Live!',
    preheader: `${brand.name} is now visible to influencers on KeepUsPostd.`,
    bodyHtml: `
      <p>Congratulations! <strong>${brand.name}</strong> is now published on the KeepUsPostd marketplace.</p>
      <p>Influencers can now discover your brand, apply for partnerships, and start creating content for you.</p>
      <p>
        ✅ Set up your first campaign<br>
        ✅ Browse and invite influencers<br>
        ✅ Configure your reward settings
      </p>
    `,
    ctaText: 'View Your Brand',
    ctaUrl: `${APP_URL}/pages/inner/brand-profile.html`,
    variant: 'brand',
  });

  if (brand.ownerId) {
    await createInApp({
      userId: brand.ownerId,
      title: 'Brand Published!',
      message: `${brand.name} is now live on the marketplace.`,
      type: 'account',
      link: '/pages/inner/brand-profile.html',
    });
  }
}

// BRD-004: Brand verification status changed
async function brandVerificationChanged({ brand, status }) {
  const brandEmail = brand.ownerEmail || brand.email;
  if (!brandEmail) return;

  const isVerified = status === 'verified';
  await sendEmail({
    to: brandEmail,
    subject: isVerified
      ? `✅ ${brand.name} is Verified!`
      : `Brand Verification Update — ${brand.name}`,
    headline: isVerified ? 'Brand Verified!' : 'Verification Update',
    preheader: isVerified
      ? 'Your brand has been verified on KeepUsPostd.'
      : 'There\'s an update on your brand verification.',
    bodyHtml: isVerified
      ? `<p><strong>${brand.name}</strong> has been verified! Verified brands get a badge on their profile and rank higher in influencer searches.</p>`
      : `<p>We reviewed <strong>${brand.name}</strong> and need additional information to complete verification. Please check your brand settings for details.</p>`,
    ctaText: 'View Brand Profile',
    ctaUrl: `${APP_URL}/pages/inner/brand-profile.html`,
    variant: 'brand',
  });

  if (brand.ownerId) {
    await createInApp({
      userId: brand.ownerId,
      title: isVerified ? 'Brand Verified!' : 'Verification Update',
      message: isVerified
        ? `${brand.name} is now verified.`
        : `${brand.name} needs additional info for verification.`,
      type: 'account',
      link: '/pages/inner/brand-profile.html',
    });
  }
}

// ═══════════════════════════════════════════════════════════
// 7. CONTENT — PHASE 2 (Additional)
// ═══════════════════════════════════════════════════════════

// CON-005: Content revision requested
async function contentRevisionRequested({ influencer, brand, submission, feedback = '' }) {
  if (!influencer.email) return;

  await sendEmail({
    to: influencer.email,
    subject: `Revision Requested — ${brand.name}`,
    headline: 'Revision Requested',
    preheader: `${brand.name} wants a small change to your content.`,
    bodyHtml: `
      <p><strong>${brand.name}</strong> reviewed your ${submission.contentType || 'content'} and is requesting a revision.</p>
      ${feedback ? `<p><strong>Feedback:</strong> ${feedback}</p>` : ''}
      <p>Make the requested changes and resubmit. Your original submission is saved.</p>
    `,
    ctaText: 'View Feedback',
    ctaUrl: `${APP_URL}/app/submissions.html`,
    variant: 'influencer',
  });

  if (influencer.userId) {
    const msg = `${brand.name} requested changes to your ${submission.contentType || 'content'}.`;
    await createInApp({
      userId: influencer.userId,
      title: 'Revision Requested',
      message: msg,
      type: 'content',
      link: '/app/submissions.html',
    });
    push(influencer.userId, {
      title: 'Revision Requested',
      body: msg,
      link: '/app/submissions.html',
    });
  }
}

// CON-006: Revised content resubmitted
async function contentResubmitted({ brand, influencer, submission }) {
  const brandEmail = brand.ownerEmail || brand.email;
  if (!brandEmail) return;

  await sendEmail({
    to: brandEmail,
    subject: `Revised Content from ${influencer.displayName || 'an influencer'}`,
    headline: 'Revised Content Submitted',
    preheader: `${influencer.displayName || 'An influencer'} resubmitted revised content.`,
    bodyHtml: `
      <p><strong>${influencer.displayName || 'An influencer'}</strong> has resubmitted revised ${submission.contentType || 'content'} for <strong>${brand.name}</strong>.</p>
      <p>Review the updated submission at your convenience.</p>
    `,
    ctaText: 'Review Now',
    ctaUrl: `${APP_URL}/pages/inner/content.html`,
    variant: 'brand',
  });

  if (brand.ownerId) {
    await createInApp({
      userId: brand.ownerId,
      title: 'Revised Content Submitted',
      message: `${influencer.displayName || 'An influencer'} resubmitted revised content.`,
      type: 'content',
      link: '/pages/inner/content.html',
    });
    push(brand.ownerId, {
      title: 'Revised Content',
      body: `${influencer.displayName || 'An influencer'} resubmitted revised content for review.`,
      link: '/pages/inner/content.html',
    });
  }
}

// CON-009: Content auto-approved (7-day timeout)
async function contentAutoApproved({ influencer, brand, submission, reward = null }) {
  if (!influencer.email) return;

  let rewardLine = '';
  if (reward) {
    rewardLine = `<p>🎉 <strong>Reward earned:</strong> ${$(reward.amount)} has been added to your wallet!</p>`;
  }

  await sendEmail({
    to: influencer.email,
    subject: `✅ Content Auto-Approved — ${brand.name}`,
    headline: 'Content Auto-Approved!',
    preheader: `Your content for ${brand.name} was approved automatically.`,
    bodyHtml: `
      <p>Your ${submission.contentType || 'content'} for <strong>${brand.name}</strong> was automatically approved after the 7-day review period.</p>
      ${rewardLine}
    `,
    ctaText: 'View Details',
    ctaUrl: `${APP_URL}/app/submissions.html`,
    variant: 'influencer',
  });

  if (influencer.userId) {
    await createInApp({
      userId: influencer.userId,
      title: 'Content Auto-Approved',
      message: `Your content for ${brand.name} was auto-approved.${reward ? ` You earned ${$(reward.amount)}!` : ''}`,
      type: 'content',
      link: '/app/submissions.html',
    });
    push(influencer.userId, {
      title: '✅ Auto-Approved!',
      body: `Your content for ${brand.name} was approved automatically.`,
      link: '/app/submissions.html',
    });
  }
}

// ═══════════════════════════════════════════════════════════
// 8. CAMPAIGNS — PHASE 2 (Entire Category)
// ═══════════════════════════════════════════════════════════

// CMP-002: Campaign goes live
async function campaignLive({ brand, campaign }) {
  const brandEmail = brand.ownerEmail || brand.email;
  if (!brandEmail) return;

  await sendEmail({
    to: brandEmail,
    subject: `🚀 Campaign "${campaign.name}" is Live!`,
    headline: 'Your Campaign is Live!',
    preheader: `${campaign.name} is now active and visible to influencers.`,
    bodyHtml: `
      <p>Your campaign <strong>${campaign.name}</strong> is now live on KeepUsPostd.</p>
      <p>Influencers can now discover it, apply, and start creating content. You'll get notified when submissions come in.</p>
    `,
    ctaText: 'View Campaign',
    ctaUrl: `${APP_URL}/pages/inner/campaigns.html`,
    variant: 'brand',
  });

  if (brand.ownerId) {
    await createInApp({
      userId: brand.ownerId,
      title: 'Campaign is Live!',
      message: `${campaign.name} is now active.`,
      type: 'campaign',
      link: '/pages/inner/campaigns.html',
    });
  }
}

// CMP-003: Campaign invitation to influencer
async function campaignInvitation({ influencer, brand, campaign }) {
  if (!influencer.email) return;

  await sendEmail({
    to: influencer.email,
    subject: `🎯 ${brand.name} Invited You to a Campaign!`,
    headline: 'You\'re Invited!',
    preheader: `${brand.name} wants you in their "${campaign.name}" campaign.`,
    bodyHtml: `
      <p><strong>${brand.name}</strong> invited you to participate in their campaign: <strong>${campaign.name}</strong>.</p>
      ${campaign.description ? `<p>${campaign.description}</p>` : ''}
      <p>Accept the invitation to start creating content and earning rewards.</p>
    `,
    ctaText: 'View Invitation',
    ctaUrl: `${APP_URL}/app/campaigns.html`,
    variant: 'influencer',
  });

  if (influencer.userId) {
    await createInApp({
      userId: influencer.userId,
      title: 'Campaign Invitation!',
      message: `${brand.name} invited you to "${campaign.name}"`,
      type: 'campaign',
      link: '/app/campaigns.html',
    });
    push(influencer.userId, {
      title: '🎯 Campaign Invitation',
      body: `${brand.name} invited you to "${campaign.name}"`,
      link: '/app/campaigns.html',
    });
  }
}

// CMP-004: Influencer applies to campaign
async function campaignApplication({ brand, influencer, campaign }) {
  const brandEmail = brand.ownerEmail || brand.email;
  if (!brandEmail) return;

  await sendEmail({
    to: brandEmail,
    subject: `New Applicant — ${influencer.displayName || 'An influencer'} for "${campaign.name}"`,
    headline: 'New Campaign Application',
    preheader: `${influencer.displayName || 'An influencer'} applied to your campaign.`,
    bodyHtml: `
      <p><strong>${influencer.displayName || 'An influencer'}</strong> has applied to join your campaign <strong>${campaign.name}</strong>.</p>
      <p>Review their profile and decide whether to accept or decline their application.</p>
    `,
    ctaText: 'Review Application',
    ctaUrl: `${APP_URL}/pages/inner/campaigns.html`,
    variant: 'brand',
  });

  if (brand.ownerId) {
    await createInApp({
      userId: brand.ownerId,
      title: 'New Campaign Application',
      message: `${influencer.displayName || 'An influencer'} applied to "${campaign.name}"`,
      type: 'campaign',
      link: '/pages/inner/campaigns.html',
    });
    push(brand.ownerId, {
      title: 'New Application',
      body: `${influencer.displayName || 'An influencer'} applied to "${campaign.name}"`,
      link: '/pages/inner/campaigns.html',
    });
  }
}

// CMP-005: Brand accepts campaign application
async function campaignApplicationAccepted({ influencer, brand, campaign }) {
  if (!influencer.email) return;

  await sendEmail({
    to: influencer.email,
    subject: `✅ You're In! ${brand.name} Accepted You`,
    headline: 'Application Accepted!',
    preheader: `You've been accepted into "${campaign.name}" by ${brand.name}.`,
    bodyHtml: `
      <p>Great news! <strong>${brand.name}</strong> accepted your application to the campaign <strong>${campaign.name}</strong>.</p>
      <p>You can now start creating and submitting content. Check the campaign guidelines for what the brand is looking for.</p>
    `,
    ctaText: 'View Campaign',
    ctaUrl: `${APP_URL}/app/campaigns.html`,
    variant: 'influencer',
  });

  if (influencer.userId) {
    await createInApp({
      userId: influencer.userId,
      title: 'Application Accepted!',
      message: `${brand.name} accepted you into "${campaign.name}"`,
      type: 'campaign',
      link: '/app/campaigns.html',
    });
    push(influencer.userId, {
      title: '✅ You\'re In!',
      body: `${brand.name} accepted you into "${campaign.name}"`,
      link: '/app/campaigns.html',
    });
  }
}

// CMP-006: Brand declines campaign application
async function campaignApplicationDeclined({ influencer, brand, campaign }) {
  if (!influencer.email) return;

  await sendEmail({
    to: influencer.email,
    subject: `Campaign Update — ${brand.name}`,
    headline: 'Application Not Accepted',
    preheader: `${brand.name} did not accept your application this time.`,
    bodyHtml: `
      <p><strong>${brand.name}</strong> reviewed your application to <strong>${campaign.name}</strong> and decided not to accept it at this time.</p>
      <p>Don't worry — there are plenty of other campaigns and brands to partner with. Keep building your profile!</p>
    `,
    ctaText: 'Browse Campaigns',
    ctaUrl: `${APP_URL}/app/campaigns.html`,
    variant: 'influencer',
  });

  if (influencer.userId) {
    await createInApp({
      userId: influencer.userId,
      title: 'Application Update',
      message: `${brand.name} did not accept your application to "${campaign.name}".`,
      type: 'campaign',
      link: '/app/campaigns.html',
    });
  }
}

// CMP-007: Campaign paused
async function campaignPaused({ influencer, brand, campaign }) {
  if (!influencer.email) return;

  await sendEmail({
    to: influencer.email,
    subject: `Campaign Paused — ${campaign.name}`,
    headline: 'Campaign Paused',
    preheader: `${brand.name} has paused "${campaign.name}".`,
    bodyHtml: `
      <p><strong>${brand.name}</strong> has temporarily paused the campaign <strong>${campaign.name}</strong>.</p>
      <p>You don't need to do anything. You'll be notified when the campaign resumes. Any pending submissions are saved.</p>
    `,
    variant: 'influencer',
  });

  if (influencer.userId) {
    await createInApp({
      userId: influencer.userId,
      title: 'Campaign Paused',
      message: `"${campaign.name}" has been paused by ${brand.name}.`,
      type: 'campaign',
      link: '/app/campaigns.html',
    });
  }
}

// CMP-008: Campaign resumed (push + in-app only)
async function campaignResumed({ influencer, brand, campaign }) {
  if (influencer.userId) {
    await createInApp({
      userId: influencer.userId,
      title: 'Campaign Resumed!',
      message: `"${campaign.name}" by ${brand.name} is active again.`,
      type: 'campaign',
      link: '/app/campaigns.html',
    });
    push(influencer.userId, {
      title: '▶️ Campaign Resumed',
      body: `"${campaign.name}" by ${brand.name} is active again.`,
      link: '/app/campaigns.html',
    });
  }
}

// CMP-009: Campaign ended
async function campaignEnded({ brand, campaign, influencerIds = [] }) {
  const brandEmail = brand.ownerEmail || brand.email;
  if (brandEmail) {
    await sendEmail({
      to: brandEmail,
      subject: `Campaign Ended — ${campaign.name}`,
      headline: 'Campaign Complete',
      preheader: `"${campaign.name}" has ended.`,
      bodyHtml: `
        <p>Your campaign <strong>${campaign.name}</strong> has ended.</p>
        <p>View your campaign results and download approved content from the campaign dashboard.</p>
      `,
      ctaText: 'View Results',
      ctaUrl: `${APP_URL}/pages/inner/campaigns.html`,
      variant: 'brand',
    });
  }

  // Notify participating influencers (in-app only — batch)
  for (const userId of influencerIds) {
    await createInApp({
      userId,
      title: 'Campaign Ended',
      message: `"${campaign.name}" by ${brand.name} has ended.`,
      type: 'campaign',
      link: '/app/campaigns.html',
    });
  }
}

// CMP-012: 100% target milestone
async function campaignMilestone100({ brand, campaign }) {
  const brandEmail = brand.ownerEmail || brand.email;
  if (!brandEmail) return;

  await sendEmail({
    to: brandEmail,
    subject: `🎉 Campaign Goal Reached — ${campaign.name}`,
    headline: '100% Target Reached!',
    preheader: `${campaign.name} hit its goal!`,
    bodyHtml: `
      <p>Amazing! Your campaign <strong>${campaign.name}</strong> has reached <strong>100% of its target</strong>.</p>
      <p>All campaign goals have been met. You can choose to extend the campaign or let it end on schedule.</p>
    `,
    ctaText: 'View Campaign',
    ctaUrl: `${APP_URL}/pages/inner/campaigns.html`,
    variant: 'brand',
  });

  if (brand.ownerId) {
    push(brand.ownerId, {
      title: '🎉 Goal Reached!',
      body: `"${campaign.name}" hit 100% of its target!`,
      link: '/pages/inner/campaigns.html',
    });
  }
}

// CMP-013: Campaign expiring soon (7 days)
async function campaignExpiringSoon({ brand, campaign }) {
  const brandEmail = brand.ownerEmail || brand.email;
  if (!brandEmail) return;

  await sendEmail({
    to: brandEmail,
    subject: `⏰ Campaign Ending in 7 Days — ${campaign.name}`,
    headline: 'Campaign Ending Soon',
    preheader: `"${campaign.name}" ends in 7 days.`,
    bodyHtml: `
      <p>Your campaign <strong>${campaign.name}</strong> will end in <strong>7 days</strong>.</p>
      <p>Make sure all pending content has been reviewed. You can extend the campaign from your dashboard if needed.</p>
    `,
    ctaText: 'View Campaign',
    ctaUrl: `${APP_URL}/pages/inner/campaigns.html`,
    variant: 'brand',
  });
}

// CMP-014: Campaign expired
async function campaignExpired({ brand, campaign, influencerIds = [] }) {
  const brandEmail = brand.ownerEmail || brand.email;
  if (brandEmail) {
    await sendEmail({
      to: brandEmail,
      subject: `Campaign Expired — ${campaign.name}`,
      headline: 'Campaign Expired',
      preheader: `"${campaign.name}" has expired.`,
      bodyHtml: `
        <p>Your campaign <strong>${campaign.name}</strong> has expired. No new submissions will be accepted.</p>
        <p>View your results and download any approved content from the campaign dashboard.</p>
      `,
      ctaText: 'View Results',
      ctaUrl: `${APP_URL}/pages/inner/campaigns.html`,
      variant: 'brand',
    });
  }

  for (const userId of influencerIds) {
    await createInApp({
      userId,
      title: 'Campaign Expired',
      message: `"${campaign.name}" by ${brand.name} has expired.`,
      type: 'campaign',
      link: '/app/campaigns.html',
    });
  }
}

// ═══════════════════════════════════════════════════════════
// 9. PARTNERSHIPS — PHASE 2
// ═══════════════════════════════════════════════════════════

// New influencer partner notification → brand
async function newInfluencerPartner({ brand, influencer }) {
  const brandEmail = brand.ownerEmail || brand.email;
  if (!brandEmail) return;

  await sendEmail({
    to: brandEmail,
    subject: `New Partner — ${influencer.displayName || 'An influencer'} joined ${brand.name}`,
    headline: 'New Influencer Partner!',
    preheader: `${influencer.displayName || 'An influencer'} wants to partner with ${brand.name}.`,
    bodyHtml: `
      <p><strong>${influencer.displayName || 'An influencer'}</strong> has partnered with <strong>${brand.name}</strong>!</p>
      <p>View their profile and start collaborating on content.</p>
    `,
    ctaText: 'View Partner',
    ctaUrl: `${APP_URL}/pages/inner/influencers.html`,
    variant: 'brand',
  });

  if (brand.ownerId) {
    await createInApp({
      userId: brand.ownerId,
      title: 'New Partner!',
      message: `${influencer.displayName || 'An influencer'} partnered with ${brand.name}.`,
      type: 'partnership',
      link: '/pages/inner/influencers.html',
      metadata: { brandName: brand.name, brandLogoUrl: brand.logoUrl || brand.avatarUrl || '' },
    });
    push(brand.ownerId, {
      title: 'New Partner!',
      body: `${influencer.displayName || 'An influencer'} wants to partner with ${brand.name}.`,
      link: '/pages/inner/influencers.html',
    });
  }
}

// New brand partnership notification → influencer
async function newBrandPartnership({ influencer, brand }) {
  console.log(`🔔 newBrandPartnership called — email: ${influencer.email}, userId: ${influencer.userId}, brand: ${brand.name}`);
  if (!influencer.email) {
    console.warn('🔔 newBrandPartnership skipped — no influencer email');
    return;
  }

  const emailResult = await sendEmail({
    to: influencer.email,
    subject: `Partnership Update — ${brand.name}`,
    headline: 'New Partnership',
    preheader: `Your partnership with ${brand.name} is now active.`,
    bodyHtml: `
      <p>Your partnership with <strong>${brand.name}</strong> is now active on KeepUsPostd.</p>
      <p>You can submit content and earn rewards from this brand.</p>
    `,
    ctaText: 'View Partnership',
    ctaUrl: `${APP_URL}/app/brands.html`,
    variant: 'influencer',
  });
  console.log(`🔔 newBrandPartnership email result:`, JSON.stringify(emailResult));

  if (influencer.userId) {
    await createInApp({
      userId: influencer.userId,
      title: 'Partnership Accepted!',
      message: `${brand.name} accepted your partnership.`,
      type: 'partnership',
      link: '/app/brands.html',
      metadata: { brandName: brand.name, brandLogoUrl: brand.logoUrl || brand.avatarUrl || '' },
    });
    push(influencer.userId, {
      title: '🤝 Partnership Accepted!',
      body: `${brand.name} accepted your partnership!`,
      link: '/app/brands.html',
    });
  }
}

// Partnership removed → influencer
async function partnershipRemoved({ influencer, brand, reason = '' }) {
  if (!influencer.email) return;

  await sendEmail({
    to: influencer.email,
    subject: `Partnership Update — ${brand.name}`,
    headline: 'Partnership Ended',
    preheader: `Your partnership with ${brand.name} has ended.`,
    bodyHtml: `
      <p>Your partnership with <strong>${brand.name}</strong> has been ended by the brand.</p>
      ${reason ? `<p><strong>Reason:</strong> ${reason}</p>` : ''}
      <p>Any pending earnings will still be processed. You can explore other brands to partner with.</p>
    `,
    ctaText: 'Browse Brands',
    ctaUrl: `${APP_URL}/app/marketplace.html`,
    variant: 'influencer',
  });

  if (influencer.userId) {
    await createInApp({
      userId: influencer.userId,
      title: 'Partnership Ended',
      message: `${brand.name} ended the partnership.`,
      type: 'partnership',
      link: '/app/brands.html',
      metadata: { brandName: brand.name, brandLogoUrl: brand.logoUrl || brand.avatarUrl || '' },
    });
  }
}

// Influencer invite → from brand
async function influencerInvite({ influencer, brand }) {
  if (!influencer.email) return;

  await sendEmail({
    to: influencer.email,
    subject: `🎯 ${brand.name} Wants to Partner With You!`,
    headline: 'Brand Invitation!',
    preheader: `${brand.name} invited you to partner on KeepUsPostd.`,
    bodyHtml: `
      <p><strong>${brand.name}</strong> wants to partner with you on KeepUsPostd!</p>
      <p>Accept the invitation to start creating content and earning rewards from this brand.</p>
    `,
    ctaText: 'View Invitation',
    ctaUrl: `${APP_URL}/app/invitations.html`,
    variant: 'influencer',
  });

  if (influencer.userId) {
    await createInApp({
      userId: influencer.userId,
      title: 'Brand Invitation!',
      message: `${brand.name} wants to partner with you.`,
      type: 'partnership',
      link: '/app/invitations.html',
    });
    push(influencer.userId, {
      title: '🎯 Brand Invitation',
      body: `${brand.name} wants to partner with you!`,
      link: '/app/invitations.html',
    });
  }
}

// ═══════════════════════════════════════════════════════════
// 10. MESSAGING
// ═══════════════════════════════════════════════════════════

// New message → brand (from influencer)
async function newInfluencerMessage({ brand, influencer }) {
  const brandEmail = brand.ownerEmail || brand.email;
  if (!brandEmail) return;

  await sendEmail({
    to: brandEmail,
    subject: `New Message from ${influencer.displayName || 'an influencer'}`,
    headline: 'New Message',
    preheader: `${influencer.displayName || 'An influencer'} sent you a message.`,
    bodyHtml: `
      <p>You have a new message from <strong>${influencer.displayName || 'an influencer'}</strong>.</p>
      <p>Open your messages to read and reply.</p>
    `,
    ctaText: 'Read Message',
    ctaUrl: `${APP_URL}/pages/inner/messages.html`,
    variant: 'brand',
  });

  if (brand.ownerId) {
    push(brand.ownerId, {
      title: 'New Message',
      body: `${influencer.displayName || 'An influencer'} sent you a message.`,
      link: '/pages/inner/messages.html',
    });
  }
}

// New message → influencer (from brand)
async function newBrandMessage({ influencer, brand }) {
  if (!influencer.email) return;

  await sendEmail({
    to: influencer.email,
    subject: `New Message from ${brand.name}`,
    headline: 'New Message',
    preheader: `${brand.name} sent you a message.`,
    bodyHtml: `
      <p>You have a new message from <strong>${brand.name}</strong>.</p>
      <p>Open your messages to read and reply.</p>
    `,
    ctaText: 'Read Message',
    ctaUrl: `${APP_URL}/app/messages.html`,
    variant: 'influencer',
  });

  if (influencer.userId) {
    push(influencer.userId, {
      title: 'New Message',
      body: `${brand.name} sent you a message.`,
      link: '/app/messages.html',
    });
  }
}

// ═══════════════════════════════════════════════════════════
// 11. PAYMENTS — PHASE 2 (Additional)
// ═══════════════════════════════════════════════════════════

// PAY-001: Subscription purchased
async function subscriptionPurchased({ brand, planTier, amount }) {
  const brandEmail = brand.ownerEmail || brand.email;
  if (!brandEmail) return;

  await sendEmail({
    to: brandEmail,
    subject: `✅ Subscription Activated — ${planTier} Plan`,
    headline: 'Subscription Activated!',
    preheader: `Your ${planTier} plan is now active.`,
    bodyHtml: `
      <p>Welcome to the <strong>${planTier}</strong> plan! Your subscription is now active.</p>
      ${amount ? `<p><strong>Amount:</strong> ${$(amount)}</p>` : ''}
      <p>You now have access to all ${planTier}-tier features. Check your dashboard to get started.</p>
    `,
    ctaText: 'Go to Dashboard',
    ctaUrl: `${APP_URL}/pages/inner/dashboard.html`,
    variant: 'brand',
  });
}

// PAY-002: Subscription upgraded
async function subscriptionUpgraded({ brand, oldTier, newTier }) {
  const brandEmail = brand.ownerEmail || brand.email;
  if (!brandEmail) return;

  await sendEmail({
    to: brandEmail,
    subject: `⬆️ Upgraded to ${newTier} Plan!`,
    headline: 'Plan Upgraded!',
    preheader: `You've upgraded from ${oldTier} to ${newTier}.`,
    bodyHtml: `
      <p>You've successfully upgraded from <strong>${oldTier}</strong> to <strong>${newTier}</strong>!</p>
      <p>Your new features are available immediately. Check what's new in your plan.</p>
    `,
    ctaText: 'View Plan Details',
    ctaUrl: `${APP_URL}/pages/inner/cash-account.html`,
    variant: 'brand',
  });

  if (brand.ownerId) {
    await createInApp({
      userId: brand.ownerId,
      title: 'Plan Upgraded!',
      message: `Upgraded to ${newTier} plan.`,
      type: 'payment',
      link: '/pages/inner/cash-account.html',
    });
  }
}

// PAY-003: Subscription downgraded
async function subscriptionDowngraded({ brand, oldTier, newTier }) {
  const brandEmail = brand.ownerEmail || brand.email;
  if (!brandEmail) return;

  await sendEmail({
    to: brandEmail,
    subject: `Plan Changed to ${newTier}`,
    headline: 'Plan Downgraded',
    preheader: `Your plan has been changed from ${oldTier} to ${newTier}.`,
    bodyHtml: `
      <p>Your plan has been changed from <strong>${oldTier}</strong> to <strong>${newTier}</strong>.</p>
      <p>Some features from your previous plan may no longer be available. The change takes effect at the end of your current billing period.</p>
    `,
    ctaText: 'View Plan',
    ctaUrl: `${APP_URL}/pages/inner/cash-account.html`,
    variant: 'brand',
  });
}

// PAY-004: Subscription renewal success
async function subscriptionRenewed({ brand, planTier, amount }) {
  const brandEmail = brand.ownerEmail || brand.email;
  if (!brandEmail) return;

  await sendEmail({
    to: brandEmail,
    subject: `Subscription Renewed — ${planTier} Plan`,
    headline: 'Subscription Renewed',
    preheader: `Your ${planTier} plan has been renewed.`,
    bodyHtml: `
      <p>Your <strong>${planTier}</strong> plan subscription has been renewed successfully.</p>
      ${amount ? `<p><strong>Amount charged:</strong> ${$(amount)}</p>` : ''}
      <p>No action needed — your account continues without interruption.</p>
    `,
    variant: 'brand',
  });
}

// PAY-008: Payment method removed
async function paypalDisconnected({ user, variant = 'brand' }) {
  await sendEmail({
    to: user.email,
    subject: 'PayPal Account Disconnected — KeepUsPostd',
    headline: 'PayPal Disconnected',
    preheader: 'Your PayPal account has been removed from KeepUsPostd.',
    bodyHtml: `
      <p>Your PayPal account has been disconnected from your KeepUsPostd profile.</p>
      <p>You'll need to connect a PayPal account to receive payments or cash out your earnings.</p>
    `,
    ctaText: 'Reconnect PayPal',
    ctaUrl: variant === 'brand' ? `${APP_URL}/pages/inner/cash-account.html` : `${APP_URL}/app/wallet.html`,
    variant,
  });
}

// PAY-009: Cash withdrawal requested
async function cashoutRequested({ influencer, amount }) {
  if (!influencer.email) return;

  await sendEmail({
    to: influencer.email,
    subject: `Cash Out Processing — ${$(amount)}`,
    headline: 'Cash Out Requested',
    preheader: `Your ${$(amount)} cash out is being processed.`,
    bodyHtml: `
      <p>Your cash out of <strong>${$(amount)}</strong> has been submitted and is being processed.</p>
      <p>You'll receive a confirmation email once the funds have been sent to your PayPal account. This usually takes a few minutes.</p>
    `,
    ctaText: 'View Wallet',
    ctaUrl: `${APP_URL}/app/wallet.html`,
    variant: 'influencer',
  });

  if (influencer.userId) {
    await createInApp({
      userId: influencer.userId,
      title: 'Cash Out Processing',
      message: `${$(amount)} cash out is being processed.`,
      type: 'payment',
      link: '/app/wallet.html',
    });
  }
}

// PAY-014: Trial ending soon (3 days)
async function trialEndingSoon({ brand, trialEndDate }) {
  const brandEmail = brand.ownerEmail || brand.email;
  if (!brandEmail) return;

  await sendEmail({
    to: brandEmail,
    subject: '⏰ Your Free Trial Ends in 3 Days',
    headline: 'Trial Ending Soon',
    preheader: 'Subscribe to keep all your features active.',
    bodyHtml: `
      <p>Your free trial ends on <strong>${trialEndDate}</strong>.</p>
      <p>Subscribe now to keep access to all your campaigns, influencer partnerships, and content management tools.</p>
    `,
    ctaText: 'Choose a Plan',
    ctaUrl: `${APP_URL}/pages/inner/cash-account.html`,
    variant: 'brand',
  });

  if (brand.ownerId) {
    push(brand.ownerId, {
      title: '⏰ Trial Ending Soon',
      body: 'Your free trial ends in 3 days. Subscribe to keep your features.',
      link: '/pages/inner/cash-account.html',
    });
  }
}

// PAY-016: Trial started — welcome email sent when first brand is created
async function trialStarted({ brand, trialEndsAt, trialTier = 'pro' }) {
  const brandEmail = brand.ownerEmail || brand.email;
  if (!brandEmail) return;

  const endDate = new Date(trialEndsAt).toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });

  await sendEmail({
    to: brandEmail,
    subject: '🎉 Your 14-Day Free Trial Is Active — KeepUsPostd',
    headline: 'Your Free Trial Is Live!',
    preheader: `Full Pro access for 14 days. No credit card required.`,
    bodyHtml: `
      <p>Welcome to KeepUsPostd! Your 14-day free trial is active and you have full <strong>Pro plan</strong> access — no credit card required.</p>
      <p>Your trial ends on <strong>${endDate}</strong>. After that, your account moves to the free Starter plan unless you subscribe.</p>
      <p>With your Pro trial you can:</p>
      <ul>
        <li>Manage up to <strong>10 brands</strong></li>
        <li>Run up to <strong>20 campaigns</strong> per brand</li>
        <li>Partner with up to <strong>500 influencers</strong></li>
        <li>Access <strong>advanced analytics</strong></li>
      </ul>
    `,
    ctaText: 'Go to Dashboard',
    ctaUrl: `${APP_URL}/pages/inner/manage-brands.html`,
    variant: 'brand',
  });

  if (brand.ownerId) {
    push(brand.ownerId, {
      title: '🎉 14-Day Free Trial Started',
      body: `You have full Pro access until ${endDate}. No credit card needed.`,
      link: '/pages/inner/manage-brands.html',
    });
  }
}

// PAY-015: Trial expired
async function trialExpired({ brand }) {
  const brandEmail = brand.ownerEmail || brand.email;
  if (!brandEmail) return;

  await sendEmail({
    to: brandEmail,
    subject: 'Free Trial Expired — KeepUsPostd',
    headline: 'Trial Expired',
    preheader: 'Subscribe to restore your premium features.',
    bodyHtml: `
      <p>Your free trial has expired. Your brand has been moved to the <strong>Starter</strong> (free) tier.</p>
      <p>Your data and partnerships are safe — subscribe to restore full access to campaigns, analytics, and premium features.</p>
    `,
    ctaText: 'Subscribe Now',
    ctaUrl: `${APP_URL}/pages/inner/cash-account.html`,
    variant: 'brand',
  });
}

// ═══════════════════════════════════════════════════════════
// 12. REFERRALS — PHASE 2
// ═══════════════════════════════════════════════════════════

// REF-003: Referred user signs up
async function referralSignup({ referrer, referredName }) {
  if (!referrer.email) return;

  await sendEmail({
    to: referrer.email,
    subject: `🎉 ${referredName || 'Someone'} Signed Up Using Your Referral!`,
    headline: 'Referral Signed Up!',
    preheader: `${referredName || 'Someone'} joined KeepUsPostd through your link.`,
    bodyHtml: `
      <p><strong>${referredName || 'Someone'}</strong> signed up for KeepUsPostd using your referral link!</p>
      <p>When they complete onboarding, you'll earn your referral reward.</p>
    `,
    ctaText: 'View Referrals',
    ctaUrl: `${APP_URL}/pages/inner/referrals.html`,
    variant: 'brand',
  });

  if (referrer._id || referrer.firebaseUid) {
    const userId = referrer.firebaseUid || referrer._id?.toString();
    await createInApp({
      userId,
      title: 'Referral Signed Up!',
      message: `${referredName || 'Someone'} joined using your referral link.`,
      type: 'account',
      link: '/pages/inner/referrals.html',
    });
    push(userId, {
      title: '🎉 Referral Signed Up!',
      body: `${referredName || 'Someone'} joined KeepUsPostd through your link.`,
      link: '/pages/inner/referrals.html',
    });
  }
}

// REF-004: Referred user completes onboarding
async function referralOnboarded({ referrer, referredName }) {
  if (!referrer.email) return;

  await sendEmail({
    to: referrer.email,
    subject: `Referral Complete — ${referredName || 'Your referral'} is all set up!`,
    headline: 'Referral Complete!',
    preheader: `${referredName || 'Your referral'} completed their setup.`,
    bodyHtml: `
      <p><strong>${referredName || 'Your referral'}</strong> has completed their onboarding on KeepUsPostd.</p>
      <p>Your referral reward is being processed!</p>
    `,
    ctaText: 'View Referrals',
    ctaUrl: `${APP_URL}/pages/inner/referrals.html`,
    variant: 'brand',
  });

  if (referrer._id || referrer.firebaseUid) {
    push(referrer.firebaseUid || referrer._id?.toString(), {
      title: 'Referral Complete!',
      body: `${referredName || 'Your referral'} finished setup. Reward incoming!`,
      link: '/pages/inner/referrals.html',
    });
  }
}

// REF-005: Referral reward earned
async function referralRewardEarned({ referrer, amount, referredName }) {
  if (!referrer.email) return;

  await sendEmail({
    to: referrer.email,
    subject: `💰 You Earned ${$(amount)} — Referral Reward!`,
    headline: `You Earned ${$(amount)}!`,
    preheader: `Referral reward from ${referredName || 'your referral'}.`,
    bodyHtml: `
      <p>You earned <strong>${$(amount)}</strong> for referring <strong>${referredName || 'a new user'}</strong> to KeepUsPostd!</p>
      <p>Keep sharing your referral link to earn more rewards.</p>
    `,
    ctaText: 'View Referrals',
    ctaUrl: `${APP_URL}/pages/inner/referrals.html`,
    variant: 'brand',
  });

  if (referrer._id || referrer.firebaseUid) {
    const userId = referrer.firebaseUid || referrer._id?.toString();
    await createInApp({
      userId,
      title: `Referral Reward: ${$(amount)}`,
      message: `You earned ${$(amount)} for referring ${referredName || 'a new user'}.`,
      type: 'payment',
      link: '/pages/inner/referrals.html',
    });
    push(userId, {
      title: `💰 ${$(amount)} Referral Reward!`,
      body: `You earned ${$(amount)} for referring ${referredName || 'a new user'}.`,
      link: '/pages/inner/referrals.html',
    });
  }
}

// ═══════════════════════════════════════════════════════════
// 13. VERIFICATION — PHASE 2
// ═══════════════════════════════════════════════════════════

// Social influence verified
async function socialInfluenceVerified({ influencer, tier }) {
  if (!influencer.email) return;

  const tierDisplay = {
    unverified: 'Startup',
    nano: 'Nano',
    micro: 'Micro',
    rising: 'Mid',
    established: 'Macro',
    premium: 'Mega',
    celebrity: 'Celebrity',
  }[tier] || tier;

  await sendEmail({
    to: influencer.email,
    subject: `✅ Social Influence Verified — ${tierDisplay} Tier!`,
    headline: 'You\'re Verified!',
    preheader: `Your social influence has been verified at the ${tierDisplay} level.`,
    bodyHtml: `
      <p>Congratulations! Your social influence has been verified and you've been placed in the <strong>${tierDisplay}</strong> tier.</p>
      <p>This determines your content pay rates. Higher engagement and follower growth can move you up to a higher tier.</p>
    `,
    ctaText: 'View My Profile',
    ctaUrl: `${APP_URL}/app/profile.html`,
    variant: 'influencer',
  });

  if (influencer.userId) {
    await createInApp({
      userId: influencer.userId,
      title: 'Social Influence Verified!',
      message: `You're verified at the ${tierDisplay} tier.`,
      type: 'account',
      link: '/app/profile.html',
    });
    push(influencer.userId, {
      title: '✅ Verified!',
      body: `Your social influence is verified — ${tierDisplay} tier. Start earning!`,
      link: '/app/profile.html',
    });
  }
}

// Social influence did not match
async function socialInfluenceNotMatched({ influencer, reason = '' }) {
  if (!influencer.email) return;

  await sendEmail({
    to: influencer.email,
    subject: 'Verification Update — KeepUsPostd',
    headline: 'Verification Update',
    preheader: 'We couldn\'t verify your social influence at this time.',
    bodyHtml: `
      <p>We reviewed your social accounts and were unable to verify your social influence at this time.</p>
      ${reason ? `<p><strong>Details:</strong> ${reason}</p>` : ''}
      <p>Make sure your social profiles are public and linked correctly. You can retry verification from your profile settings.</p>
    `,
    ctaText: 'Update Profile',
    ctaUrl: `${APP_URL}/app/profile.html`,
    variant: 'influencer',
  });

  if (influencer.userId) {
    await createInApp({
      userId: influencer.userId,
      title: 'Verification Update',
      message: 'We couldn\'t verify your social influence. Check your profile settings.',
      type: 'account',
      link: '/app/profile.html',
    });
  }
}

// ═══════════════════════════════════════════════════════════
// 14. DISCOVERY — PHASE 3
// ═══════════════════════════════════════════════════════════

// New brand on marketplace → notify matched influencers
async function newBrandOnMarketplace({ influencer, brand }) {
  if (!influencer.email) return;

  await sendEmail({
    to: influencer.email,
    subject: `New Brand Alert — ${brand.name} is on KeepUsPostd!`,
    headline: 'New Brand Available!',
    preheader: `${brand.name} just joined the marketplace.`,
    bodyHtml: `
      <p>A new brand just joined KeepUsPostd: <strong>${brand.name}</strong></p>
      ${brand.industry ? `<p><strong>Industry:</strong> ${brand.industry}</p>` : ''}
      <p>Check them out and apply for a partnership!</p>
    `,
    ctaText: 'View Brand',
    ctaUrl: `${APP_URL}/app/marketplace.html`,
    variant: 'influencer',
  });
}

// ═══════════════════════════════════════════════════════════
// 15. SYSTEM & ADMIN — PHASE 3
// ═══════════════════════════════════════════════════════════

// SYS-001: Maintenance scheduled
async function maintenanceScheduled({ recipients, startTime, duration }) {
  for (const email of recipients) {
    await sendEmail({
      to: email,
      subject: '🔧 Scheduled Maintenance — KeepUsPostd',
      headline: 'Scheduled Maintenance',
      preheader: `Maintenance scheduled for ${startTime}.`,
      bodyHtml: `
        <p>KeepUsPostd will undergo scheduled maintenance:</p>
        <p>
          <strong>Start:</strong> ${startTime}<br>
          <strong>Duration:</strong> ${duration || 'Approximately 1 hour'}
        </p>
        <p>The platform may be temporarily unavailable during this window. All your data is safe.</p>
      `,
      variant: 'brand',
    });
  }
}

// SYS-002: New feature announcement
async function featureAnnouncement({ recipients, featureName, description, ctaUrl = null }) {
  for (const email of recipients) {
    await sendEmail({
      to: email,
      subject: `🆕 New Feature — ${featureName}`,
      headline: featureName,
      preheader: description,
      bodyHtml: `<p>${description}</p>`,
      ctaText: ctaUrl ? 'Try It Now' : null,
      ctaUrl,
      variant: 'brand',
    });
  }
}

// SYS-003: Terms of service updated
async function termsUpdated({ recipients, effectiveDate }) {
  for (const email of recipients) {
    await sendEmail({
      to: email,
      subject: 'Terms of Service Updated — KeepUsPostd',
      headline: 'Terms of Service Updated',
      preheader: `Updated terms effective ${effectiveDate}.`,
      bodyHtml: `
        <p>We've updated our Terms of Service. The updated terms will be effective on <strong>${effectiveDate}</strong>.</p>
        <p>By continuing to use KeepUsPostd after this date, you agree to the updated terms.</p>
      `,
      ctaText: 'View Terms',
      ctaUrl: `${APP_URL}/terms`,
      variant: 'brand',
    });
  }
}

// SYS-004: Privacy policy updated
async function privacyPolicyUpdated({ recipients, effectiveDate }) {
  for (const email of recipients) {
    await sendEmail({
      to: email,
      subject: 'Privacy Policy Updated — KeepUsPostd',
      headline: 'Privacy Policy Updated',
      preheader: `Updated privacy policy effective ${effectiveDate}.`,
      bodyHtml: `
        <p>We've updated our Privacy Policy. The updated policy will be effective on <strong>${effectiveDate}</strong>.</p>
        <p>We're committed to protecting your data and being transparent about how it's used.</p>
      `,
      ctaText: 'View Privacy Policy',
      ctaUrl: `${APP_URL}/privacy`,
      variant: 'brand',
    });
  }
}

// Brand deactivation
async function brandDeactivated({ brand }) {
  const brandEmail = brand.ownerEmail || brand.email;
  if (!brandEmail) return;

  await sendEmail({
    to: brandEmail,
    subject: 'Brand Deactivated — KeepUsPostd',
    headline: 'Brand Deactivated',
    preheader: `${brand.name} has been deactivated.`,
    bodyHtml: `
      <p>Your brand <strong>${brand.name}</strong> has been deactivated on KeepUsPostd.</p>
      <p>Your data is preserved and you can reactivate at any time from your account settings.</p>
    `,
    ctaText: 'Reactivate Brand',
    ctaUrl: `${APP_URL}/pages/inner/settings.html`,
    variant: 'brand',
  });
}

// Brand reactivated
async function brandReactivated({ brand }) {
  const brandEmail = brand.ownerEmail || brand.email;
  if (!brandEmail) return;

  await sendEmail({
    to: brandEmail,
    subject: `✅ ${brand.name} is Back! — KeepUsPostd`,
    headline: 'Welcome Back!',
    preheader: `${brand.name} has been reactivated.`,
    bodyHtml: `
      <p>Your brand <strong>${brand.name}</strong> has been reactivated on KeepUsPostd!</p>
      <p>All your data, campaigns, and partnerships have been restored. You're ready to go.</p>
    `,
    ctaText: 'Go to Dashboard',
    ctaUrl: `${APP_URL}/pages/inner/dashboard.html`,
    variant: 'brand',
  });
}

// PAY-020: Payout received + rate your brand prompt
async function payoutReceived({ influencer, brand, amount, partnershipId, contentType }) {
  if (!influencer.userId) return;

  const msg = `You earned $${amount.toFixed(2)} from ${brand.name} for your ${contentType || 'content'}! Rate your experience.`;

  // In-app notification with rating_request type — Flutter handles the routing
  await createInApp({
    userId: influencer.userId,
    title: `You got paid $${amount.toFixed(2)}!`,
    message: msg,
    type: 'rating_request',
    link: '/app/rate-partnership.html',
    metadata: {
      partnershipId: partnershipId?.toString(),
      brandName: brand.name,
      brandLogoUrl: brand.logoUrl || brand.avatarUrl || '',
      amount,
    },
  });

  push(influencer.userId, {
    title: `You earned $${amount.toFixed(2)} from ${brand.name}!`,
    body: `Tap to rate your experience with ${brand.name}`,
    link: '/app/rate-partnership.html',
    data: { type: 'rating_request', partnershipId: partnershipId?.toString() },
  });
}

// POINTS-001: Points earned toward a reward → notify influencer
// Triggered at each content lifecycle stage: submitted, approved, postd, bonus
async function pointsEarned({ influencer, brand, rewardTitle, points, stage, totalPoints, unlockThreshold }) {
  if (!influencer?.userId) return;

  const stageLabels = {
    submitted: 'submitting content',
    approved: 'content approval',
    published: 'posting your review',
    bonus: 'bonus',
  };
  const stageLabel = stageLabels[stage] || stage;
  const msg = `+${points} pts toward ${rewardTitle} for ${stageLabel}! (${totalPoints}/${unlockThreshold} pts)`;

  await createInApp({
    userId: influencer.userId,
    title: `+${points} Points Earned!`,
    message: msg,
    type: 'reward',
    link: '/app/rewards.html',
    metadata: {
      brandName: brand?.name || '',
      brandLogoUrl: brand?.logoUrl || brand?.avatarUrl || '',
      rewardTitle,
      points,
      stage,
      totalPoints,
      unlockThreshold,
    },
  });
  push(influencer.userId, {
    title: `+${points} Points!`,
    body: msg,
  });
}

module.exports = {
  // ── Phase 1: Account (Critical) ──
  accountCreated,
  emailVerification,
  passwordReset,
  newDeviceLogin,
  influencerWelcome,

  // ── Phase 1: Content (Critical) ──
  contentSubmitted,
  contentSubmissionConfirmed,
  contentApproved,
  contentRejected,
  contentPostd,
  reviewReminder,

  // ── Phase 1: Payments (Critical) ──
  subscriptionPaymentFailed,
  subscriptionCanceled,
  paypalMoneyWaiting,
  paypalConnected,
  cashoutCompleted,
  cashoutFailed,
  cashRewardEarned,
  brandPaymentConfirmed,
  payoutReceived,
  pointsEarned,

  // ── Phase 2: Account (Standard) ──
  emailVerified,
  passwordChanged,
  emailChanged,
  accountDeletionRequested,
  accountDeletionCanceled,
  onboardingReminder24h,
  onboardingReminder72h,
  draftBrandReminder,

  // ── Phase 2: Brand Profile ──
  brandPublished,
  brandVerificationChanged,

  // ── Phase 2: Content (Additional) ──
  contentRevisionRequested,
  contentResubmitted,
  contentAutoApproved,

  // ── Phase 2: Campaigns (Full Category) ──
  campaignLive,
  campaignInvitation,
  campaignApplication,
  campaignApplicationAccepted,
  campaignApplicationDeclined,
  campaignPaused,
  campaignResumed,
  campaignEnded,
  campaignMilestone100,
  campaignExpiringSoon,
  campaignExpired,

  // ── Phase 2: Partnerships ──
  newInfluencerPartner,
  newBrandPartnership,
  partnershipRemoved,
  influencerInvite,

  // ── Phase 2: Messaging ──
  newInfluencerMessage,
  newBrandMessage,

  // ── Phase 2: Payments (Additional) ──
  subscriptionPurchased,
  subscriptionUpgraded,
  subscriptionDowngraded,
  subscriptionRenewed,
  paypalDisconnected,
  cashoutRequested,
  trialStarted,
  trialEndingSoon,
  trialExpired,

  // ── Phase 2: Referrals ──
  referralSignup,
  referralOnboarded,
  referralRewardEarned,

  // ── Phase 2: Verification ──
  socialInfluenceVerified,
  socialInfluenceNotMatched,

  // ── Phase 3: Discovery ──
  newBrandOnMarketplace,

  // ── Phase 3: System & Admin ──
  maintenanceScheduled,
  featureAnnouncement,
  termsUpdated,
  privacyPolicyUpdated,
  brandDeactivated,
  brandReactivated,
};
