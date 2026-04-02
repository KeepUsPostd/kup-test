// KUP Email Service — SendGrid Integration
// Sends transactional emails using the KUP design system from Figma.
// Two template variants: Brand (gradient footer) and Influencer (purple footer).
//
// Usage:
//   const { sendEmail } = require('../config/email');
//   await sendEmail({ to, subject, headline, body, ctaText, ctaUrl, variant: 'brand' });

const sgMail = require('@sendgrid/mail');

// Initialize SendGrid with API key (silent fail if not configured — local dev)
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY;
if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY);
  console.log('📧 SendGrid email service initialized');
} else {
  console.log('📧 SendGrid not configured — emails will be logged to console only');
}

const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'noreply@keepuspostd.com';
const FROM_NAME = 'KeepUsPostd';

// ── KUP Design System Colors ────────────────────────────
const COLORS = {
  kupBlue: '#2EA5DD',
  kupPurple: '#707BBB',
  darkGray: '#333333',
  medGray: '#666666',
  lightGray: '#E0E0E0',
  white: '#FFFFFF',
  darkFooter: '#1A1A2E',
};

// ── Build HTML Email ────────────────────────────────────
// Matches the Figma template structure:
// 1. Blue pre-header bar
// 2. KUP logo (centered)
// 3. Headline
// 4. Body copy
// 5. CTA button
// 6. Footer banner (gradient for brand, purple for influencer)
// 7. Dark footer with social links

function buildEmailHtml({
  preheader = '',
  headline,
  bodyHtml,
  ctaText,
  ctaUrl,
  variant = 'brand', // 'brand' or 'influencer'
}) {
  const footerBg = variant === 'brand'
    ? 'background: linear-gradient(135deg, #2EA5DD, #707BBB);'
    : `background: ${COLORS.kupPurple};`;

  const footerTagline = variant === 'brand'
    ? 'Get Better Marketing Results'
    : 'Partner With the Brands You Love';

  const ctaBlock = ctaText && ctaUrl ? `
    <tr>
      <td align="center" style="padding: 24px 0 32px;">
        <a href="${ctaUrl}" target="_blank" style="
          display: inline-block;
          padding: 14px 32px;
          background: ${COLORS.kupBlue};
          color: ${COLORS.white};
          text-decoration: none;
          border-radius: 8px;
          font-size: 16px;
          font-weight: 600;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        ">${ctaText}</a>
      </td>
    </tr>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${headline}</title>
  <!--[if !mso]><!-->
  <style>
    body { margin: 0; padding: 0; background: #F5F5F5; }
    .preheader { display: none !important; visibility: hidden; mso-hide: all; font-size: 1px; line-height: 1px; max-height: 0; max-width: 0; opacity: 0; overflow: hidden; }
  </style>
  <!--<![endif]-->
</head>
<body style="margin: 0; padding: 0; background: #F5F5F5; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;">

  <!-- Pre-header text (hidden, shows in email client preview) -->
  <span class="preheader">${preheader}</span>

  <!-- Main container -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background: #F5F5F5;">
    <tr>
      <td align="center" style="padding: 24px 16px;">
        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width: 600px; width: 100%; background: ${COLORS.white}; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">

          <!-- Blue pre-header bar -->
          <tr>
            <td style="background: ${COLORS.kupBlue}; padding: 12px 24px; text-align: center;">
              <span style="color: ${COLORS.white}; font-size: 13px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">${preheader || headline}</span>
            </td>
          </tr>

          <!-- Logo -->
          <tr>
            <td align="center" style="padding: 32px 24px 16px;">
              <img src="${process.env.APP_URL || 'https://keepuspostd.com'}/images/logo-dark.png" alt="KeepUsPostd" width="160" style="max-width: 160px; height: auto;" />
            </td>
          </tr>

          <!-- Headline -->
          <tr>
            <td align="center" style="padding: 8px 32px 16px;">
              <h1 style="margin: 0; color: ${COLORS.darkGray}; font-size: 24px; font-weight: 700; line-height: 1.3; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">${headline}</h1>
            </td>
          </tr>

          <!-- Divider -->
          <tr>
            <td align="center" style="padding: 0 32px;">
              <hr style="border: none; border-top: 1px solid ${COLORS.lightGray}; margin: 0;" />
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding: 24px 32px; color: ${COLORS.medGray}; font-size: 15px; line-height: 1.6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; text-align: center;">
              ${bodyHtml}
            </td>
          </tr>

          <!-- CTA Button -->
          ${ctaBlock}

          <!-- Footer Banner -->
          <tr>
            <td style="${footerBg} padding: 24px; text-align: center;">
              <p style="margin: 0 0 8px; color: ${COLORS.white}; font-size: 16px; font-weight: 600; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">${footerTagline}</p>
              <img src="${process.env.APP_URL || 'https://keepuspostd.com'}/images/logo-white.png" alt="KUP" width="80" style="max-width: 80px; height: auto;" />
            </td>
          </tr>

          <!-- Dark Footer -->
          <tr>
            <td style="background: ${COLORS.darkFooter}; padding: 24px; text-align: center;">
              <p style="margin: 0 0 12px; color: #AAAAAA; font-size: 14px; font-style: italic; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">Everyone has influence.</p>

              <!-- Social Icons (text links for max compatibility) -->
              <p style="margin: 0 0 16px;">
                <a href="https://facebook.com/keepuspostd" style="color: #AAAAAA; text-decoration: none; margin: 0 8px; font-size: 13px;">FB</a>
                <a href="https://instagram.com/keepuspostd" style="color: #AAAAAA; text-decoration: none; margin: 0 8px; font-size: 13px;">IG</a>
                <a href="https://twitter.com/Keepuspostd" style="color: #AAAAAA; text-decoration: none; margin: 0 8px; font-size: 13px;">X</a>
                <a href="https://tiktok.com/@keepuspostd" style="color: #AAAAAA; text-decoration: none; margin: 0 8px; font-size: 13px;">TikTok</a>
                <a href="https://linkedin.com/company/keepuspostd-corporation" style="color: #AAAAAA; text-decoration: none; margin: 0 8px; font-size: 13px;">LinkedIn</a>
              </p>

              <p style="margin: 0; color: #777777; font-size: 11px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">
                &copy; 2026 KeepUsPostd. All rights reserved.<br>
                <a href="${process.env.APP_URL || 'https://keepuspostd.com'}/email-preferences" style="color: #777777; text-decoration: underline;">Email Preferences</a> &nbsp;|&nbsp;
                <a href="${process.env.APP_URL || 'https://keepuspostd.com'}/unsubscribe" style="color: #777777; text-decoration: underline;">Unsubscribe</a>
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ── Send Email ──────────────────────────────────────────
// Main entry point. All routes call this.
// If SendGrid isn't configured, logs to console (dev mode).

async function sendEmail({
  to,
  subject,
  headline,
  bodyHtml,
  preheader = '',
  ctaText = null,
  ctaUrl = null,
  variant = 'brand', // 'brand' or 'influencer'
}) {
  const html = buildEmailHtml({ preheader, headline, bodyHtml, ctaText, ctaUrl, variant });

  // Dev mode — log instead of sending
  if (!SENDGRID_API_KEY) {
    console.log(`\n📧 [EMAIL - DEV MODE] Would send to: ${to}`);
    console.log(`   Subject: ${subject}`);
    console.log(`   Headline: ${headline}`);
    console.log(`   Variant: ${variant}`);
    console.log(`   CTA: ${ctaText || 'none'} → ${ctaUrl || 'none'}\n`);
    return { success: true, dev: true };
  }

  try {
    await sgMail.send({
      to,
      from: { email: FROM_EMAIL, name: FROM_NAME },
      subject,
      html,
    });
    console.log(`📧 Email sent to ${to}: ${subject}`);
    return { success: true };
  } catch (error) {
    console.error(`📧 Email failed to ${to}:`, error.response?.body?.errors || error.message);
    return { success: false, error: error.message };
  }
}

// ── Send Batch Emails ───────────────────────────────────
// For notifications that go to multiple recipients (e.g., admin alerts)

async function sendBatchEmails(messages) {
  if (!SENDGRID_API_KEY) {
    messages.forEach(msg => {
      console.log(`📧 [BATCH - DEV MODE] Would send to: ${msg.to} — ${msg.subject}`);
    });
    return { success: true, dev: true };
  }

  try {
    const formatted = messages.map(msg => ({
      to: msg.to,
      from: { email: FROM_EMAIL, name: FROM_NAME },
      subject: msg.subject,
      html: buildEmailHtml(msg),
    }));
    await sgMail.send(formatted);
    console.log(`📧 Batch sent: ${messages.length} emails`);
    return { success: true };
  } catch (error) {
    console.error('📧 Batch email failed:', error.message);
    return { success: false, error: error.message };
  }
}

module.exports = { sendEmail, sendBatchEmails, buildEmailHtml };
