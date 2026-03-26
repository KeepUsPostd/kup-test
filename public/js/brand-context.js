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

  var DEFAULT_BRANDS = [
    { id: 'kup', name: 'KeepUsPostd', abbreviation: 'KP', color: '#2EA5DD', plan: 'growth', isAnchor: true, state: 'active' },
    { id: 'wmp', name: 'Wild Mercy Pictures', abbreviation: 'WMP', color: '#ED8444', plan: 'growth', isAnchor: false, state: 'active' }
  ];


  // ================================================================
  //  STATE MANAGEMENT
  // ================================================================

  function getAllBrands() {
    try {
      var stored = localStorage.getItem(BRANDS_KEY);
      if (stored) return JSON.parse(stored);
    } catch(e) {}
    localStorage.setItem(BRANDS_KEY, JSON.stringify(DEFAULT_BRANDS));
    return DEFAULT_BRANDS;
  }

  function getActiveBrand() {
    try {
      var stored = localStorage.getItem(STORAGE_KEY);
      if (stored) return JSON.parse(stored);
    } catch(e) {}
    var brands = getAllBrands();
    var anchor = brands[0];
    setActiveBrand(anchor);
    return anchor;
  }

  function setActiveBrand(brand) {
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
            '<span class="kup-bcb-plan">' + (activeBrand.plan || 'Growth') + '</span>' +
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

    // Update profile trigger brand text
    var brandEl = document.querySelector('.profile-info .brand');
    if (brandEl) {
      brandEl.textContent = activeBrand.name;
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

  function syncBrandElements() {
    var ab = getActiveBrand();
    var abbr = ab.abbreviation || 'KP';
    var name = ab.name || 'KeepUsPostd';
    var color = ab.color || '#2EA5DD';

    // --- Sidebar brand identity (logo + name) ---
    // Covers: brand-home, brand-reward-settings, market-code,
    //         purchase-points-setup, google-business, brand-profile
    var identityBlock = document.querySelector('.brand-identity');
    if (identityBlock) {
      var logoEl = identityBlock.querySelector('.logo, .logo-circle');
      if (logoEl) { logoEl.textContent = abbr; logoEl.style.background = color; }
      var nameEl = identityBlock.querySelector('.brand-name');
      if (nameEl) nameEl.textContent = name;
      var handleEl = identityBlock.querySelector('.brand-handle');
      if (handleEl) handleEl.textContent = '@' + name.toLowerCase().replace(/\s+/g, '');
    }

    // --- App profile preview card (brand-home, brand-profile) ---
    var appLogo = document.querySelector('.app-profile-logo');
    if (appLogo) { appLogo.textContent = abbr; appLogo.style.background = color; }
    var appNameH4 = document.querySelector('.app-profile-name h4');
    if (appNameH4) appNameH4.textContent = name;
    // brand-profile has an id="previewName" variant
    var previewName = document.getElementById('previewName');
    if (previewName) previewName.textContent = name;

    // --- Google Business preview card ---
    var gbpLogo = document.querySelector('.google-preview-logo');
    if (gbpLogo) { gbpLogo.textContent = abbr; gbpLogo.style.background = color; }
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
    if (ipBrandLogo) { ipBrandLogo.textContent = abbr; ipBrandLogo.style.background = color; }
    var ipBrandName = document.getElementById('ipBrandName');
    if (ipBrandName) ipBrandName.textContent = name;
  }


  // ================================================================
  //  SYNC BRANDS WITH API — Bridge localStorage IDs to MongoDB ObjectIds
  //  After Firebase auth confirms, fetch real brands from the API and
  //  enrich the local brand list with mongoId (the real MongoDB _id).
  //  All pages can then use getActiveBrand().mongoId for API calls.
  // ================================================================

  function syncBrandsWithApi() {
    // Only run if kupApi and Firebase auth are available
    if (typeof kupApi === 'undefined' || typeof auth === 'undefined') return;

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
          } else {
            // Brand exists in API but not locally — add it
            stored.push({
              id: apiBrand._id.substring(0, 6),  // Short local id from ObjectId
              name: apiBrand.name,
              abbreviation: apiBrand.name.split(' ').map(function(w) { return w[0]; }).join('').toUpperCase().substring(0, 3),
              color: '#2EA5DD',
              plan: apiBrand.planTier || 'starter',
              isAnchor: false,
              state: apiBrand.status || 'active',
              mongoId: apiBrand._id
            });
            changed = true;
          }
        });

        if (changed) {
          localStorage.setItem(BRANDS_KEY, JSON.stringify(stored));

          // Also update the active brand if it got a mongoId
          var active = getActiveBrand();
          var updatedActive = null;
          for (var i = 0; i < stored.length; i++) {
            if (stored[i].id === active.id) {
              updatedActive = stored[i];
              break;
            }
          }
          if (updatedActive) setActiveBrand(updatedActive);

          console.log('🔄 Brand context synced with API (' + data.brands.length + ' brands)');
        }
      }).catch(function(err) {
        console.warn('Brand sync skipped:', err.message || err);
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
    syncBrandsWithApi: syncBrandsWithApi
  };

})();
