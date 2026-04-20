/**
 * KUP BRAND CONTEXT — Shared Brand State + UI Injection
 * Loaded on every inner page via <script src="../../js/brand-context.js"></script>
 *
 * Responsibilities:
 * 1. localStorage brand state management (read/write active brand)
 * 2. Brand Context Bar injection (after <header>)
 * 3. Profile Dropdown Quick Switch injection (prepended into #profileDropdown)
 * 4. Multi-tab sync (storage event listener)
 * 5. Portable toast (reuses existing kupToast or creates own)
 */

var KUP_BRAND_CONTEXT = (function() {
  'use strict';

  // ================================================================
  //  CONFIG
  // ================================================================

  var STORAGE_KEY = 'kup_active_brand';
  var BRANDS_KEY = 'kup_brands_list';

  var DEFAULT_BRANDS = []; // No hardcoded fake brands — real brands loaded from API


  // ================================================================
  //  STATE MANAGEMENT
  // ================================================================

  var LEGACY_FAKE_IDS = ['kup', 'wmp']; // Prototype brands — purge from localStorage

  function getAllBrands() {
    try {
      var stored = localStorage.getItem(BRANDS_KEY);
      if (stored) {
        var parsed = JSON.parse(stored);
        if (parsed && parsed.length > 0) {
          // Strip out any legacy prototype brands that are still cached
          var clean = parsed.filter(function(b) { return LEGACY_FAKE_IDS.indexOf(b.id) === -1; });
          if (clean.length !== parsed.length) {
            localStorage.setItem(BRANDS_KEY, JSON.stringify(clean));
          }
          return clean;
        }
      }
    } catch(e) {}
    return [];
  }


  function getActiveBrand() {
    try {
      var stored = localStorage.getItem(STORAGE_KEY);
      // Purge stale bad values (literal "undefined"/"null" strings written
      // by older code paths before setActiveBrand was guarded).
      if (stored === 'undefined' || stored === 'null') {
        localStorage.removeItem(STORAGE_KEY);
        stored = null;
      }
      if (stored) {
        var active = JSON.parse(stored);
        // Purge legacy prototype brands
        if (active && LEGACY_FAKE_IDS.indexOf(active.id) !== -1) {
          localStorage.removeItem(STORAGE_KEY);
          return null;
        }
        // Enrich: if active brand is missing fields (abbreviation, color, etc),
        // look it up in the full brands list and merge
        if (!active.abbreviation || !active.color) {
          var brands = getAllBrands();
          var matchId = active.mongoId || active.id;
          for (var i = 0; i < brands.length; i++) {
            var b = brands[i];
            if (b.id === matchId || b.mongoId === matchId || b.name === active.name) {
              // Merge missing fields from the full brand entry
              if (!active.abbreviation && b.abbreviation) active.abbreviation = b.abbreviation;
              if (!active.color && b.color) active.color = b.color;
              if (!active.mongoId && b.mongoId) active.mongoId = b.mongoId;
              if (!active.logoUrl && b.logoUrl) active.logoUrl = b.logoUrl;
              if (b.plan) { active.plan = b.plan; active.trialActive = b.trialActive; active.trialDaysRemaining = b.trialDaysRemaining; }
              // Save the enriched version back
              setActiveBrand(active);
              break;
            }
          }
        }
        // Generate abbreviation from name if still missing
        if (!active.abbreviation && active.name) {
          var words = active.name.trim().split(/\s+/);
          active.abbreviation = words.length === 1
            ? words[0].charAt(0).toUpperCase()
            : words.map(function(w) { return w.charAt(0); }).join('').toUpperCase().substring(0, 3);
          setActiveBrand(active);
        }
        return active;
      }
    } catch(e) {}
    var brands = getAllBrands();
    var anchor = brands[0];
    // Don't write undefined/null to storage — return null so callers handle
    // the "no brands yet" case explicitly (e.g. brand-home redirects to
    // manage-brands instead of chasing a phantom active brand).
    if (!anchor) return null;
    setActiveBrand(anchor);
    return anchor;
  }

  function setActiveBrand(brand) {
    // Guard: never persist null/undefined — JSON.stringify(undefined) writes the
    // literal string "undefined" which then crashes JSON.parse on every read.
    if (!brand) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(brand));
  }

  function switchBrand(brandId) {
    var brands = getAllBrands();
    var target = null;
    for (var i = 0; i < brands.length; i++) {
      if (brands[i].id === brandId) { target = brands[i]; break; }
    }
    if (!target) return false;

    var current = getActiveBrand();
    if (current.id === target.id) return false;

    setActiveBrand(target);
    showToast('Switching to ' + target.name + '...', 'info');

    setTimeout(function() {
      window.location.reload();
    }, 600);

    return true;
  }


  // ================================================================
  //  PORTABLE TOAST
  // ================================================================

  function showToast(message, type) {
    if (typeof window.kupToast === 'function') {
      window.kupToast(message, type);
      return;
    }
    // Create minimal toast if page doesn't have one
    var container = document.getElementById('kupToastContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'kupToastContainer';
      container.style.cssText = 'position:fixed;top:20px;right:20px;z-index:9999;display:flex;flex-direction:column;gap:8px;';
      document.body.appendChild(container);
    }
    var toast = document.createElement('div');
    var colors = { success: '#16a34a', error: '#dc2626', info: '#2EA5DD', warning: '#f59e0b' };
    toast.style.cssText = 'background:white;border-left:4px solid ' + (colors[type] || colors.info) + ';padding:12px 20px;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,0.12);font-size:0.85rem;font-family:Montserrat,sans-serif;animation:kupToastIn 0.3s ease;max-width:360px;';
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(function() {
      toast.style.opacity = '0';
      toast.style.transform = 'translateX(20px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(function() { toast.remove(); }, 300);
    }, 3500);
  }


  // ================================================================
  //  CSS INJECTION
  // ================================================================

  function injectStyles() {
    var isDark = !!document.querySelector('.cm-header');
    var activeBrand = getActiveBrand();
    var brandColor = activeBrand.color || '#2EA5DD';

    var css = '' +
      /* Brand Context Bar */
      '.kup-bcb{background:' + (isDark ? '#1e2030' : '#f8f9fa') + ';border-bottom:1px solid ' + (isDark ? '#2a2d3e' : '#eee') + ';border-left:4px solid ' + brandColor + ';font-family:Montserrat,sans-serif;position:relative;z-index:99;}' +
      '.kup-bcb-inner{max-width:1400px;margin:0 auto;padding:0 32px;height:36px;display:flex;align-items:center;justify-content:space-between;}' +
      '.kup-bcb-left{display:flex;align-items:center;gap:10px;}' +
      '.kup-bcb-dot{width:10px;height:10px;border-radius:50%;flex-shrink:0;}' +
      '.kup-bcb-label{font-size:0.78rem;color:' + (isDark ? '#b0b3c0' : '#666') + ';}' +
      '.kup-bcb-label strong{color:' + (isDark ? '#fff' : '#1a1a1a') + ';font-weight:700;}' +
      '.kup-bcb-plan{font-size:0.68rem;font-weight:600;color:' + brandColor + ';background:' + brandColor + '14;padding:2px 10px;border-radius:20px;text-transform:capitalize;}' +
      '.kup-bcb-right{position:relative;}' +
      '.kup-bcb-switch{background:none;border:1px solid ' + (isDark ? '#3a3d50' : '#ddd') + ';border-radius:6px;padding:4px 14px;font-size:0.75rem;font-weight:600;color:' + (isDark ? '#b0b3c0' : '#555') + ';cursor:pointer;font-family:Montserrat,sans-serif;transition:all 0.15s ease;}' +
      '.kup-bcb-switch:hover{border-color:' + brandColor + ';color:' + brandColor + ';background:' + brandColor + '08;}' +
      '.kup-bcb-dropdown{position:absolute;top:calc(100% + 6px);right:0;background:' + (isDark ? '#252840' : 'white') + ';border:1px solid ' + (isDark ? '#3a3d50' : '#eee') + ';border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,' + (isDark ? '0.3' : '0.1') + ');min-width:260px;display:none;z-index:200;overflow:hidden;}' +
      '.kup-bcb-dropdown.show{display:block;}' +
      '.kup-bcb-dropdown-header{padding:10px 16px;font-size:0.72rem;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:0.5px;border-bottom:1px solid ' + (isDark ? '#3a3d50' : '#f0f0f0') + ';}' +
      '.kup-bcb-brand-item{display:flex;align-items:center;gap:10px;padding:10px 16px;cursor:pointer;transition:background 0.15s ease;font-size:0.82rem;}' +
      '.kup-bcb-brand-item:hover{background:' + (isDark ? '#2e3150' : '#f8f9fa') + ';}' +
      '.kup-bcb-brand-item.active{background:' + (isDark ? '#2e3150' : '#f0f8ff') + ';}' +
      '.kup-bcb-brand-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;}' +
      '.kup-bcb-brand-name{flex:1;font-weight:500;color:' + (isDark ? '#e0e2f0' : '#333') + ';}' +
      '.kup-bcb-anchor{font-size:0.7rem;color:#ED8444;margin-left:-4px;}' +
      '.kup-bcb-active-check{font-size:0.72rem;color:#16a34a;font-weight:600;}' +
      '.kup-bcb-switch-btn{background:' + (isDark ? '#3a3d50' : '#f0f0f0') + ';border:none;border-radius:4px;padding:3px 10px;font-size:0.72rem;font-weight:600;color:' + (isDark ? '#b0b3c0' : '#555') + ';cursor:pointer;font-family:Montserrat,sans-serif;transition:all 0.15s ease;}' +
      '.kup-bcb-switch-btn:hover{background:' + brandColor + ';color:white;}' +

      /* Profile Dropdown Quick Switch */
      '.kup-bs-section{padding:8px 0;border-bottom:1px solid ' + (isDark ? '#3a3d50' : '#eee') + ';}' +
      '.kup-bs-label{padding:4px 20px 6px;font-size:0.68rem;font-weight:600;color:#999;text-transform:uppercase;letter-spacing:0.5px;}' +
      '.kup-bs-item{display:flex;align-items:center;gap:8px;padding:8px 20px;font-size:0.82rem;transition:background 0.15s ease;}' +
      '.kup-bs-item:hover{background:#f8f9fa;}' +
      '.kup-bs-item-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;}' +
      '.kup-bs-item-name{flex:1;font-weight:500;color:#333;}' +
      '.kup-bs-item-anchor{font-size:0.65rem;color:#ED8444;}' +
      '.kup-bs-item-active{font-size:0.7rem;color:#16a34a;font-weight:600;}' +
      '.kup-bs-item-switch{background:#f0f0f0;border:none;border-radius:4px;padding:3px 10px;font-size:0.7rem;font-weight:600;color:#555;cursor:pointer;font-family:Montserrat,sans-serif;transition:all 0.15s ease;}' +
      '.kup-bs-item-switch:hover{background:#2EA5DD;color:white;}' +

      /* Multi-tab reload banner */
      '.kup-tab-banner{position:fixed;top:0;left:0;right:0;background:#FFF3CD;border-bottom:2px solid #f59e0b;padding:10px 20px;text-align:center;font-size:0.85rem;font-family:Montserrat,sans-serif;z-index:10000;color:#856404;}' +
      '.kup-tab-banner button{background:#f59e0b;color:white;border:none;border-radius:6px;padding:4px 16px;font-size:0.8rem;font-weight:600;cursor:pointer;margin-left:12px;font-family:Montserrat,sans-serif;}' +
      '.kup-tab-banner button:hover{background:#d97706;}' +

      /* Toast animation */
      '@keyframes kupToastIn{from{opacity:0;transform:translateX(20px);}to{opacity:1;transform:translateX(0);}}' +
    '';

    var style = document.createElement('style');
    style.id = 'kup-brand-context-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }


  // ================================================================
  //  BRAND CONTEXT BAR INJECTION
  // ================================================================

  function injectContextBar() {
    var header = document.querySelector('header');
    if (!header) return;

    // Don't double-inject
    if (document.querySelector('.kup-bcb')) return;

    var activeBrand = getActiveBrand();
    var allBrands = getAllBrands();

    var barHTML = '' +
      '<div class="kup-bcb">' +
        '<div class="kup-bcb-inner">' +
          '<div class="kup-bcb-left">' +
            '<span class="kup-bcb-dot" style="background:' + activeBrand.color + ';"></span>' +
            '<span class="kup-bcb-label">Operating as: <strong>' + activeBrand.name + '</strong></span>' +
            '<span class="kup-bcb-plan">' + (activeBrand.trialActive ? (activeBrand.plan || 'pro') + ' (Trial)' : (activeBrand.plan || 'Starter')) + '</span>' +
          '</div>' +
          '<div class="kup-bcb-right">' +
            '<button class="kup-bcb-switch" id="kupBcbSwitch">Switch Brand <span style="font-size:0.65rem;">&#9662;</span></button>' +
            '<div class="kup-bcb-dropdown" id="kupBcbDropdown">' +
              '<div class="kup-bcb-dropdown-header">Your Brands</div>' +
              buildBrandItems(allBrands, activeBrand) +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    header.insertAdjacentHTML('afterend', barHTML);

    // Toggle dropdown
    var switchBtn = document.getElementById('kupBcbSwitch');
    var dropdown = document.getElementById('kupBcbDropdown');
    if (switchBtn && dropdown) {
      switchBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        dropdown.classList.toggle('show');
      });
    }

    // Switch brand clicks
    document.querySelectorAll('.kup-bcb-switch-btn').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var brandId = this.getAttribute('data-brand-id');
        if (brandId) switchBrand(brandId);
      });
    });

    // Close dropdown on outside click
    document.addEventListener('click', function(e) {
      if (dropdown && !dropdown.contains(e.target) && e.target !== switchBtn) {
        dropdown.classList.remove('show');
      }
    });
  }

  function buildBrandItems(brands, activeBrand) {
    var html = '';
    for (var i = 0; i < brands.length; i++) {
      var b = brands[i];
      var isActive = b.id === activeBrand.id;
      html += '<div class="kup-bcb-brand-item' + (isActive ? ' active' : '') + '">' +
        '<span class="kup-bcb-brand-dot" style="background:' + b.color + ';"></span>' +
        (b.isAnchor ? '<span class="kup-bcb-anchor" title="Anchor Brand">&#9875;</span>' : '') +
        '<span class="kup-bcb-brand-name">' + b.name + '</span>' +
        (isActive
          ? '<span class="kup-bcb-active-check">&#10003; Active</span>'
          : '<button class="kup-bcb-switch-btn" data-brand-id="' + b.id + '">Switch</button>') +
      '</div>';
    }
    return html;
  }


  // ================================================================
  //  PROFILE DROPDOWN QUICK SWITCH INJECTION
  // ================================================================

  function injectProfileSwitch() {
    var dropdown = document.getElementById('profileDropdown');
    if (!dropdown) return;

    // Don't double-inject
    if (dropdown.querySelector('.kup-bs-section')) return;

    var activeBrand = getActiveBrand();
    var allBrands = getAllBrands();

    var switcherHTML = '<div class="kup-bs-section">' +
      '<div class="kup-bs-label">Brands</div>';

    for (var i = 0; i < allBrands.length; i++) {
      var b = allBrands[i];
      var isActive = b.id === activeBrand.id;
      switcherHTML += '<div class="kup-bs-item">' +
        '<span class="kup-bs-item-dot" style="background:' + b.color + ';"></span>' +
        (b.isAnchor ? '<span class="kup-bs-item-anchor" title="Anchor Brand">&#9875;</span>' : '') +
        '<span class="kup-bs-item-name">' + b.name + '</span>' +
        (isActive
          ? '<span class="kup-bs-item-active">&#10003; Active</span>'
          : '<button class="kup-bs-item-switch" data-brand-id="' + b.id + '">Switch</button>') +
      '</div>';
    }

    switcherHTML += '</div>';

    dropdown.insertAdjacentHTML('afterbegin', switcherHTML);

    // Wire up switch buttons in profile dropdown
    dropdown.querySelectorAll('.kup-bs-item-switch').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        e.preventDefault();
        var brandId = this.getAttribute('data-brand-id');
        if (brandId) switchBrand(brandId);
      });
    });
  }


  // ================================================================
  //  UPDATE HEADER BRAND NAME
  // ================================================================

  function updateHeaderBrandName() {
    var activeBrand = getActiveBrand();
    var abbr = activeBrand.abbreviation || 'KP';
    var color = activeBrand.color || '#2EA5DD';
    var logoUrl = activeBrand.logoUrl || null;

    // Update profile trigger brand text
    var brandEl = document.querySelector('.profile-info .brand');
    if (brandEl) {
      brandEl.textContent = activeBrand.name;
    }
    // Also update .profile-brand (used in some page variants)
    var profileBrandEl = document.querySelector('.profile-info .profile-brand');
    if (profileBrandEl) {
      profileBrandEl.textContent = activeBrand.name;
    }

    // Update the profile avatar circle in the header to show brand initials/logo
    var profileAvatar = document.querySelector('.profile-menu .profile-avatar');
    if (profileAvatar) {
      renderBrandLogo(profileAvatar, abbr, color, logoUrl);
    }
  }


  // ================================================================
  //  MULTI-TAB SYNC
  // ================================================================

  function initMultiTabSync() {
    window.addEventListener('storage', function(e) {
      if (e.key === STORAGE_KEY && e.newValue !== e.oldValue) {
        // Don't show banner if one already exists
        if (document.querySelector('.kup-tab-banner')) return;

        var banner = document.createElement('div');
        banner.className = 'kup-tab-banner';

        try {
          var newBrand = JSON.parse(e.newValue);
          banner.innerHTML = 'Brand context changed to <strong>' + newBrand.name + '</strong> in another tab.' +
            '<button onclick="location.reload()">Reload Now</button>';
        } catch(err) {
          banner.innerHTML = 'Brand context changed in another tab.' +
            '<button onclick="location.reload()">Reload Now</button>';
        }

        document.body.prepend(banner);
      }
    });
  }


  // ================================================================
  //  INIT — Run on DOMContentLoaded
  // ================================================================

  // ================================================================
  //  MOBILE NAV — AUTO-HIGHLIGHT ACTIVE PAGE
  // ================================================================

  function initMobileNav() {
    var navItems = document.querySelectorAll('.kup-mobile-nav-item');
    if (!navItems.length) return;

    var path = window.location.pathname;
    var currentPage = path.split('/').pop() || '';

    // Map each nav link to its page
    var navMap = {
      'activity.html': 0,
      'campaigns.html': 1,
      'campaign-detail.html': 1,
      'brand-campaign.html': 1,
      'content.html': 2,
      'content-manager.html': 2,
      'influencers.html': 3,
      'cash-rewards.html': 4,
      'cash-account.html': 4,
      'postd-pay.html': 4,
      'distribute-reward.html': 4
    };

    // Clear any existing active states
    navItems.forEach(function(item) { item.classList.remove('active'); });

    // Set active based on current page
    var activeIndex = navMap[currentPage];
    if (activeIndex !== undefined && navItems[activeIndex]) {
      navItems[activeIndex].classList.add('active');
    }
  }


  function fixHelpLinks() {
    var dropdown = document.getElementById('profileDropdown');
    if (!dropdown) return;
    dropdown.querySelectorAll('a').forEach(function(a) {
      var text = a.textContent.trim();
      if (text === 'Help Center' && a.getAttribute('href') === '#') {
        a.href = 'help-center.html';
      }
    });
  }

  // ================================================================
  //  SYNC ALL HARDCODED BRAND ELEMENTS ON PAGE
  //  Automatically updates sidebar logos, brand names, preview cards,
  //  help center chat, content IDs, etc. to reflect the active brand.
  // ================================================================

  // Helper: render a logo element — shows uploaded image if available, otherwise brand initials
  function renderBrandLogo(el, abbr, color, logoUrl) {
    if (!el) return;
    if (logoUrl) {
      el.innerHTML = '<img src="' + logoUrl + '" style="width:100%;height:100%;object-fit:cover;border-radius:inherit" alt="Brand Logo">';
      el.style.background = '#fff';
    } else {
      el.textContent = abbr;
      el.style.background = color;
    }
  }

  function syncBrandElements() {
    var ab = getActiveBrand();
    var abbr = ab.abbreviation || 'KP';
    var name = ab.name || 'KeepUsPostd';
    var color = ab.color || '#2EA5DD';
    var logoUrl = ab.logoUrl || null; // Set by API sync

    // --- Live-update the operating-as bar pill + brand name ---
    var planPill = document.querySelector('.kup-bcb-plan');
    if (planPill) {
      planPill.textContent = ab.trialActive
        ? (ab.plan || 'pro') + ' (Trial)'
        : (ab.plan || 'Starter');
    }
    var barNameEl = document.querySelector('.kup-bcb-label strong');
    if (barNameEl) barNameEl.textContent = name;

    // --- Sidebar brand identity (logo + name) ---
    // Covers: brand-home, brand-reward-settings, market-code,
    //         purchase-points-setup, google-business, brand-profile
    var identityBlock = document.querySelector('.brand-identity');
    if (identityBlock) {
      var logoEl = identityBlock.querySelector('.logo, .logo-circle');
      renderBrandLogo(logoEl, abbr, color, logoUrl);
      var nameEl = identityBlock.querySelector('.brand-name');
      if (nameEl) nameEl.textContent = name;
      var handleEl = identityBlock.querySelector('.brand-handle');
      if (handleEl) handleEl.textContent = '@' + name.toLowerCase().replace(/\s+/g, '');
    }

    // --- Phone mockup preview (brand-home, brand-profile) ---
    var phoneLogo = document.querySelector('.app-preview-logo');
    renderBrandLogo(phoneLogo, abbr, color, logoUrl);
    // Also handle legacy flat preview if still present
    var appLogo = document.querySelector('.app-profile-logo');
    renderBrandLogo(appLogo, abbr, color, logoUrl);
    var appNameH4 = document.querySelector('.app-profile-name h4');
    if (appNameH4) appNameH4.textContent = name;
    // Preview name (phone mockup or brand-profile)
    var previewName = document.getElementById('previewName');
    if (previewName) previewName.textContent = name;
    // Preview category, description, banner
    var previewCategory = document.getElementById('previewCategory');
    if (previewCategory && ab.category) previewCategory.textContent = ab.category;
    var previewDesc = document.getElementById('previewDesc');
    if (previewDesc && ab.description) previewDesc.textContent = ab.description;

    // --- Page title: replace KeepUsPostd with active brand name ---
    if (name !== 'KeepUsPostd') {
      var title = document.querySelector('title');
      if (title && title.textContent.indexOf('KeepUsPostd') !== -1) {
        title.textContent = title.textContent.replace('KeepUsPostd', name);
      }
    }

    // --- Campaign page header text ---
    var campaignHeader = document.querySelector('.content-header p strong, .campaign-header p strong');
    if (campaignHeader && campaignHeader.textContent === 'KeepUsPostd') {
      campaignHeader.textContent = name;
    }

    // --- Market code page brand elements ---
    var qrBrandName = document.querySelector('.qr-center-badge span');
    if (qrBrandName && qrBrandName.textContent === 'KeepUsPostd') qrBrandName.textContent = name;
    var scanText = document.querySelector('.scan-text');
    if (scanText && scanText.textContent.indexOf('KeepUsPostd') !== -1) {
      scanText.textContent = scanText.textContent.replace('KeepUsPostd', name);
    }

    // --- Google Business preview card ---
    var gbpLogo = document.querySelector('.google-preview-logo');
    renderBrandLogo(gbpLogo, abbr, color, logoUrl);
    var gbpName = document.querySelector('.google-preview-name');
    if (gbpName) gbpName.textContent = name;

    // --- Help center support chat ---
    var chatAvatar = document.querySelector('.hc-chat-avatar');
    if (chatAvatar) { chatAvatar.textContent = abbr; chatAvatar.style.background = color; }
    var chatName = document.querySelector('.hc-chat-name');
    if (chatName) chatName.textContent = name + ' Support';
    // Chat bot greeting
    var chatGreeting = document.querySelector('.hc-msg-bot .hc-msg-text');
    if (chatGreeting && chatGreeting.textContent.indexOf('KeepUsPostd') !== -1) {
      chatGreeting.textContent = chatGreeting.textContent.replace(/KeepUsPostd/g, name);
    }

    // --- Content Manager: brand ID prefix ---
    var kupIdEl = document.getElementById('dlKupId');
    if (kupIdEl) {
      var currentId = kupIdEl.textContent;
      // Replace the KP- prefix with the active brand abbreviation
      kupIdEl.textContent = currentId.replace(/^[A-Z]+-/, abbr + '-');
    }

    // --- Influencer profile modal brand badge (already has ids) ---
    // These are updated per-open in each page's JS, but also set defaults here
    var ipBrandLogo = document.getElementById('ipBrandLogo');
    renderBrandLogo(ipBrandLogo, abbr, color, logoUrl);
    var ipBrandName = document.getElementById('ipBrandName');
    if (ipBrandName) ipBrandName.textContent = name;
  }


  // ================================================================
  //  SYNC BRANDS WITH API — Bridge localStorage IDs to MongoDB ObjectIds
  //  After Firebase auth confirms, fetch real brands from the API and
  //  enrich the local brand list with mongoId (the real MongoDB _id).
  //  All pages can then use getActiveBrand().mongoId for API calls.
  // ================================================================

  var _syncRetries = 0;
  function syncBrandsWithApi() {
    // Only run if kupApi and Firebase auth are available
    // If not ready yet (brand-context loads before firebase/api scripts), retry up to 10 times
    if (typeof kupApi === 'undefined' || typeof auth === 'undefined') {
      if (_syncRetries < 10) {
        _syncRetries++;
        setTimeout(syncBrandsWithApi, 300 * _syncRetries);
      }
      return;
    }

    auth.onAuthStateChanged(function(user) {
      if (!user) return;

      kupApi.get('/api/brands').then(function(data) {
        if (!data || !data.brands || data.brands.length === 0) return;

        var stored = getAllBrands();
        var changed = false;

        data.brands.forEach(function(apiBrand) {
          // Try to match by name (case-insensitive)
          var match = null;
          for (var i = 0; i < stored.length; i++) {
            if (stored[i].name.toLowerCase() === apiBrand.name.toLowerCase()) {
              match = stored[i];
              break;
            }
          }

          if (match) {
            // Enrich with MongoDB _id
            if (match.mongoId !== apiBrand._id) {
              match.mongoId = apiBrand._id;
              changed = true;
            }
            // Sync logoUrl from API
            if (apiBrand.logoUrl && match.logoUrl !== apiBrand.logoUrl) {
              match.logoUrl = apiBrand.logoUrl;
              changed = true;
            }
            // Sync name-derived abbreviation if missing
            if (!match.abbreviation && apiBrand.name) {
              var words = apiBrand.name.trim().split(/\s+/);
              match.abbreviation = words.length === 1 ? words[0].charAt(0).toUpperCase() : words.map(function(w) { return w[0]; }).join('').toUpperCase().substring(0, 3);
              changed = true;
            }
            // Always sync plan + trial status from API (overrides any stale cached value)
            if (apiBrand.planTier) {
              match.plan = apiBrand.planTier;
              match.trialActive = !!apiBrand.trialActive;
              match.trialDaysRemaining = apiBrand.trialDaysRemaining || 0;
              changed = true;
            }
          } else {
            // Brand exists in API but not locally — add it
            stored.push({
              id: apiBrand._id.substring(0, 6),  // Short local id from ObjectId
              name: apiBrand.name,
              abbreviation: apiBrand.name.split(' ').map(function(w) { return w[0]; }).join('').toUpperCase().substring(0, 3),
              color: '#2EA5DD',
              plan: apiBrand.planTier || 'starter',
              trialActive: !!apiBrand.trialActive,
              trialDaysRemaining: apiBrand.trialDaysRemaining || 0,
              isAnchor: false,
              state: apiBrand.status || 'active',
              mongoId: apiBrand._id,
              logoUrl: apiBrand.logoUrl || null
            });
            changed = true;
          }
        });

        if (changed) {
          localStorage.setItem(BRANDS_KEY, JSON.stringify(stored));

          // Update the active brand — match by id, mongoId, or name (most robust).
          // Handle the null case: on fresh signup or after a cache clear, there
          // IS no previous active brand — default to the first entry so the
          // UI has something to render.
          var active = getActiveBrand();
          var updatedActive = null;
          if (!active) {
            updatedActive = stored[0] || null;
          } else {
            for (var i = 0; i < stored.length; i++) {
              var s = stored[i];
              if (
                s.id === active.id ||
                (active.mongoId && s.mongoId && s.mongoId === active.mongoId) ||
                (s.name && active.name && s.name.toLowerCase() === active.name.toLowerCase())
              ) {
                updatedActive = s;
                break;
              }
            }
            // Match failed AND we had an active that no longer exists in the
            // brands list — fall back to first entry instead of leaving null.
            if (!updatedActive) updatedActive = stored[0] || null;
          }
          if (updatedActive) setActiveBrand(updatedActive);

          // Re-render all brand elements now that we have logoUrl from API
          syncBrandElements();
          updateHeaderBrandName();

          console.log('🔄 Brand context synced with API (' + data.brands.length + ' brands)');
        }
      }).catch(function(err) {
        console.warn('Brand sync skipped:', err.message || err);
      });
    });
  }

  // ================================================================
  //  SYNC PLAN FROM BILLING — Directly fetch plan/trial status from
  //  /api/billing/subscription (the authoritative source of truth).
  //  Updates the active brand in localStorage and the operating-as
  //  pill in the DOM — independent of the brands list sync.
  // ================================================================
  var _planSyncRetries = 0;
  function syncPlanFromBilling() {
    if (typeof kupApi === 'undefined' || typeof auth === 'undefined') {
      if (_planSyncRetries < 10) {
        _planSyncRetries++;
        setTimeout(syncPlanFromBilling, 300 * _planSyncRetries);
      }
      return;
    }

    auth.onAuthStateChanged(function(user) {
      if (!user) return;

      kupApi.get('/api/billing/subscription').then(function(data) {
        if (!data) return;

        var planName  = data.plan || 'starter';
        var isTrialing = !!(data.trial && data.trial.active);
        var daysLeft   = isTrialing ? (data.trial.daysRemaining || 0) : 0;

        // Persist to active brand in localStorage
        var active = getActiveBrand();
        if (active) {
          active.plan               = planName;
          active.trialActive        = isTrialing;
          active.trialDaysRemaining = daysLeft;
          setActiveBrand(active);
        }

        // Live-update the pill immediately
        var planPill = document.querySelector('.kup-bcb-plan');
        if (planPill) {
          planPill.textContent = isTrialing
            ? planName + ' (Trial)'
            : planName.charAt(0).toUpperCase() + planName.slice(1);
        }

        console.log('💳 Plan synced from billing: ' + planName + (isTrialing ? ' (Trial, ' + daysLeft + 'd left)' : ''));
      }).catch(function(err) {
        console.warn('Plan sync skipped:', err.message || err);
      });
    });
  }


  function loadCreatorSwitch() {
    // Dynamically load creator-switch.js (adds "Switch to Creator" to profile dropdown)
    if (document.querySelector('script[src*="creator-switch"]')) return;
    var script = document.createElement('script');
    script.src = '/js/creator-switch.js';
    document.body.appendChild(script);
  }

  function init() {
    injectStyles();
    injectContextBar();
    injectProfileSwitch();
    fixHelpLinks();
    updateHeaderBrandName();
    syncBrandElements();
    initMultiTabSync();
    initMobileNav();
    syncBrandsWithApi();
    syncPlanFromBilling();   // Direct billing lookup — updates plan pill from source of truth
    loadCreatorSwitch();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }


  // ================================================================
  //  PUBLIC API
  // ================================================================

  return {
    getActiveBrand: getActiveBrand,
    getAllBrands: getAllBrands,
    switchBrand: switchBrand,
    setActiveBrand: setActiveBrand,
    syncBrandsWithApi: syncBrandsWithApi,
    syncPlanFromBilling: syncPlanFromBilling
  };

})();
