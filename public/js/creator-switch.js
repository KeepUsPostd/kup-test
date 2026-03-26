// Creator Switch — Adds "Switch to Creator" option to brand dashboard
// When a brand user clicks this, they see the app download prompt.
// The creator app is where users browse OTHER brands, submit content,
// use music features, etc. — NOT for managing their own brand.
//
// Include this script on any brand-side /app/ page AFTER the DOM loads.

(function() {
  'use strict';

  // Wait for DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  function init() {
    // Find the profile dropdown
    var dropdown = document.getElementById('profileDropdown');
    if (!dropdown) return;

    // Don't add if already present
    if (dropdown.querySelector('.creator-switch-link')) return;

    // Insert "Switch to Creator" before the first divider
    var firstDivider = dropdown.querySelector('.divider');
    if (!firstDivider) return;

    var link = document.createElement('a');
    link.href = '#';
    link.className = 'creator-switch-link';
    link.style.cssText = 'display:flex;align-items:center;gap:8px;color:#ED8444;font-weight:600;';
    link.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg> Switch to Creator';
    link.addEventListener('click', function(e) {
      e.preventDefault();
      showCreatorModal();
    });

    var divider = document.createElement('div');
    divider.className = 'divider';

    firstDivider.insertAdjacentElement('beforebegin', divider);
    divider.insertAdjacentElement('beforebegin', link);
  }

  function showCreatorModal() {
    // Remove existing modal if any
    var existing = document.getElementById('creatorSwitchModal');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.id = 'creatorSwitchModal';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;z-index:3000;padding:24px;animation:fadeIn 0.2s ease;';

    overlay.innerHTML = '\
      <div style="background:#fff;border-radius:16px;width:90%;max-width:440px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.3);animation:slideUp 0.3s ease;position:relative;">\
        <div style="text-align:center;padding:32px 28px 0;">\
          <div style="width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#ED8444,#e06030);display:flex;align-items:center;justify-content:center;margin:0 auto 16px;">\
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>\
          </div>\
          <h3 style="font-family:Montserrat,sans-serif;font-size:1.2rem;font-weight:700;margin:0 0 8px;color:#1a1a1a;">Switch to Creator Mode</h3>\
          <p style="font-family:Montserrat,sans-serif;font-size:0.88rem;color:#666;margin:0 0 8px;line-height:1.5;">The KUP Creator app is where you discover other brands, submit content, use music tools, and earn rewards.</p>\
          <p style="font-family:Montserrat,sans-serif;font-size:0.78rem;color:#999;margin:0 0 24px;line-height:1.5;">Your brand dashboard stays here on the web. The creator experience lives in the mobile app.</p>\
        </div>\
        <div style="padding:0 28px 24px;display:flex;flex-direction:column;gap:10px;">\
          <button id="csAppStore" style="width:100%;padding:14px;border:none;border-radius:10px;background:#1a1a1a;color:#fff;font-family:Montserrat,sans-serif;font-weight:700;font-size:0.88rem;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:10px;transition:background 0.15s;">\
            <svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M18.71 19.5C17.88 20.74 17 21.95 15.66 21.97C14.32 22 13.89 21.18 12.37 21.18C10.84 21.18 10.37 21.95 9.1 22C7.79 22.05 6.8 20.68 5.96 19.47C4.25 16.56 2.93 11.3 4.7 7.72C5.57 5.94 7.36 4.86 9.28 4.84C10.56 4.81 11.78 5.72 12.57 5.72C13.36 5.72 14.85 4.62 16.4 4.8C17.07 4.83 18.9 5.08 20.11 6.78C20 6.86 17.63 8.23 17.65 11.11C17.68 14.55 20.63 15.67 20.66 15.68C20.63 15.76 20.18 17.33 18.71 19.5ZM13 3.5C13.73 2.67 14.94 2.04 15.94 2C16.07 3.17 15.6 4.35 14.9 5.19C14.21 6.04 13.07 6.7 11.95 6.61C11.8 5.46 12.36 4.26 13 3.5Z"/></svg>\
            Download on App Store\
          </button>\
          <button id="csGooglePlay" style="width:100%;padding:14px;border:none;border-radius:10px;background:#1a1a1a;color:#fff;font-family:Montserrat,sans-serif;font-weight:700;font-size:0.88rem;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:10px;transition:background 0.15s;">\
            <svg width="20" height="20" viewBox="0 0 24 24" fill="white"><path d="M3.609 1.814L13.792 12 3.61 22.186a2.372 2.372 0 01-.612-1.593V3.407c0-.605.222-1.16.612-1.593zm14.427 6.141l-2.884 2.884L3.61 22.186c.39.433.953.714 1.59.714.395 0 .788-.108 1.14-.333l13.28-7.47-1.584-1.584zm0 8.09l1.584-1.584 2.52-1.417c.856-.482.856-1.605 0-2.088l-2.52-1.417-1.584-1.584L13.792 12l4.244 4.045zM3.609 1.814c.39-.433.953-.714 1.59-.714.395 0 .788.108 1.14.333l13.28 7.47-1.584 1.584L3.609 1.814z"/></svg>\
            Get it on Google Play\
          </button>\
        </div>\
        <div style="background:#f8f9fa;padding:16px 28px;display:flex;align-items:center;gap:12px;">\
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#999" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>\
          <span style="font-family:Montserrat,sans-serif;font-size:0.78rem;color:#888;line-height:1.4;">Your creator account is already set up using the same email. Just download and sign in.</span>\
        </div>\
        <div style="border-top:1px solid #eee;padding:12px 28px;text-align:center;">\
          <a href="/app/submit-content.html" id="csWebFallback" style="font-family:Montserrat,sans-serif;font-size:0.75rem;color:#bbb;text-decoration:none;">Web version (testing only) →</a>\
        </div>\
        <button id="csClose" style="position:absolute;top:16px;right:16px;width:32px;height:32px;border:none;background:#f0f0f0;border-radius:50%;font-size:1.2rem;color:#666;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:all 0.15s;" aria-label="Close">&times;</button>\
      </div>';

    document.body.appendChild(overlay);

    // Close handlers
    overlay.querySelector('#csClose').addEventListener('click', function() { overlay.remove(); });
    overlay.addEventListener('click', function(e) { if (e.target === overlay) overlay.remove(); });
    document.addEventListener('keydown', function handler(e) {
      if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', handler); }
    });

    // App store buttons — placeholder for now (no real app yet)
    overlay.querySelector('#csAppStore').addEventListener('click', function() {
      alert('Coming soon! The KUP Creator app will be available on the App Store.');
    });
    overlay.querySelector('#csGooglePlay').addEventListener('click', function() {
      alert('Coming soon! The KUP Creator app will be available on Google Play.');
    });

    // Add animation keyframes if not present
    if (!document.getElementById('creatorSwitchStyles')) {
      var style = document.createElement('style');
      style.id = 'creatorSwitchStyles';
      style.textContent = '@keyframes fadeIn{from{opacity:0}to{opacity:1}}@keyframes slideUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}';
      document.head.appendChild(style);
    }
  }
})();
