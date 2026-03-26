/**
 * resume-banner.js
 * Auto-injects a "Resume Setup" banner on inner pages
 * when kup_profile_status is 'incomplete'.
 *
 * Include on any inner page AFTER the <header>.
 * Dismissible per session (sessionStorage).
 * Does NOT show on onboarding.html or add-brand.html.
 */
(function() {
  'use strict';

  try {
    var status = localStorage.getItem('kup_profile_status');
    var dismissed = sessionStorage.getItem('kup_banner_dismissed');

    // Only show for incomplete profiles, not yet dismissed this session
    if (status !== 'incomplete' || dismissed) return;

    // Don't inject on onboarding or add-brand pages
    var path = window.location.pathname;
    if (path.indexOf('onboarding') !== -1 || path.indexOf('add-brand') !== -1) return;

    // Build banner HTML
    var banner = document.createElement('div');
    banner.className = 'kup-resume-banner';
    banner.id = 'resumeBanner';
    banner.innerHTML =
      '<div class="resume-banner-inner">' +
        '<div class="resume-banner-left">' +
          '<span class="resume-banner-icon">&#128640;</span>' +
          '<div>' +
            '<strong class="resume-banner-title">Your brand is almost ready</strong>' +
            '<span class="resume-banner-desc">Pick up where you left off and start connecting with creators.</span>' +
          '</div>' +
        '</div>' +
        '<div class="resume-banner-actions">' +
          '<a href="../onboarding.html" class="resume-banner-btn">Resume Setup</a>' +
          '<button class="resume-banner-dismiss" id="dismissBanner" aria-label="Dismiss">&times;</button>' +
        '</div>' +
      '</div>';

    // Inject banner CSS (once)
    var style = document.createElement('style');
    style.textContent =
      '.kup-resume-banner{background:linear-gradient(135deg,#EBF7FD 0%,#F0EEFB 100%);border-bottom:1px solid rgba(46,165,221,.15)}' +
      '.resume-banner-inner{display:flex;align-items:center;justify-content:space-between;max-width:1400px;margin:0 auto;padding:14px 32px;gap:20px}' +
      '.resume-banner-left{display:flex;align-items:center;gap:14px}' +
      '.resume-banner-icon{font-size:1.4rem}' +
      '.resume-banner-title{font-size:.88rem;font-weight:700;color:#1a1a1a;display:block;line-height:1.3}' +
      '.resume-banner-desc{font-size:.78rem;color:#666;display:block;line-height:1.4}' +
      '.resume-banner-actions{display:flex;align-items:center;gap:12px;flex-shrink:0}' +
      '.resume-banner-btn{display:inline-block;padding:8px 24px;background:#2EA5DD;color:#fff;font-size:.82rem;font-weight:700;border-radius:6px;text-decoration:none;transition:background .2s;white-space:nowrap}' +
      '.resume-banner-btn:hover{background:#1e8fc4;color:#fff}' +
      '.resume-banner-dismiss{background:none;border:none;font-size:1.2rem;color:#999;cursor:pointer;padding:4px 8px;border-radius:4px;transition:background .15s}' +
      '.resume-banner-dismiss:hover{background:rgba(0,0,0,.05);color:#666}' +
      '@media(max-width:600px){' +
        '.resume-banner-inner{flex-direction:column;text-align:center;padding:16px 20px}' +
        '.resume-banner-left{flex-direction:column;gap:8px}' +
        '.resume-banner-actions{width:100%;justify-content:center}' +
        '.resume-banner-btn{width:100%;text-align:center;padding:12px}' +
      '}';
    document.head.appendChild(style);

    // Insert after the header (or brand-context bar if present)
    var header = document.querySelector('header.auth-header');
    if (header && header.nextElementSibling) {
      // Check if brand-context bar was injected after header
      var next = header.nextElementSibling;
      if (next.classList && next.classList.contains('kup-brand-context')) {
        next.parentNode.insertBefore(banner, next.nextSibling);
      } else {
        header.parentNode.insertBefore(banner, next);
      }
    } else if (header) {
      header.parentNode.insertBefore(banner, header.nextSibling);
    } else {
      // Fallback: prepend to body
      document.body.insertBefore(banner, document.body.firstChild);
    }

    // Dismiss handler
    var dismissBtn = document.getElementById('dismissBanner');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', function() {
        banner.style.display = 'none';
        try { sessionStorage.setItem('kup_banner_dismissed', '1'); } catch(e) {}
      });
    }

  } catch(e) {
    // Fail silently — banner is non-critical
  }
})();
