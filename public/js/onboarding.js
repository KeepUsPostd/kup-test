/**
 * KUP ONBOARDING — Checklist Widget + Contextual Tip Banners
 * Loaded on every inner page via <script src="../../js/onboarding.js"></script>
 *
 * Responsibilities:
 * 1. Floating checklist widget (bottom-left) with 5 onboarding steps
 * 2. Auto-completion of steps based on page visits
 * 3. Contextual tip banners (first visit to each major section)
 * 4. localStorage state management + multi-tab sync
 * 5. Dismiss/collapse controls with persistence
 */

var KUP_ONBOARDING = (function() {
  'use strict';

  // ================================================================
  //  CONFIG
  // ================================================================

  var STORAGE_KEY = 'kup_onboarding';

  var STEPS = [
    { id: 1, title: 'Complete your brand profile',   desc: 'Add your logo, description, and location',        page: 'brand-home.html',            link: 'brand-home.html' },
    { id: 2, title: 'Set up your first reward',      desc: 'Configure how influencers earn from your brand',   page: 'brand-reward-settings.html', link: 'brand-reward-settings.html' },
    { id: 3, title: 'Create a campaign',             desc: 'Launch your first influencer campaign',            page: 'campaigns.html',             link: 'campaigns.html' },
    { id: 4, title: 'Browse influencers',            desc: 'Discover creators that match your brand',          page: 'influencers.html',           link: 'influencers.html' },
    { id: 5, title: 'Explore your dashboard',        desc: 'Review your activity feed and analytics',          page: 'activity.html',              link: 'activity.html' }
  ];

  var TIPS = {
    'activity.html':              { id: 'tip-activity',  text: 'This is your command center. Track influencer activity, campaign performance, and pending approvals all in one place.' },
    'campaigns.html':             { id: 'tip-campaigns', text: 'Create campaigns to attract influencers. Set goals, content requirements, and reward structures.' },
    'influencers.html':           { id: 'tip-influencers', text: 'Browse and invite influencers that match your brand. Filter by niche, reach, and engagement.' },
    'content.html':               { id: 'tip-content',  text: 'Review and approve influencer submissions here. Download approved content for your marketing channels.' },
    'cash-rewards.html':          { id: 'tip-cash',     text: 'Manage your reward payouts and account balance. Fund your account to reward influencers automatically.' },
    'brand-home.html':            { id: 'tip-brand',    text: 'This is how your brand appears to influencers in the marketplace. Keep it updated to attract the right creators.' },
    'brand-reward-settings.html': { id: 'tip-rewards',  text: 'Configure your reward types here \u2014 cash, products, discounts, or points. Influencers see these when browsing your brand.' }
  };


  // ================================================================
  //  STATE MANAGEMENT
  // ================================================================

  function getDefaultState() {
    return {
      completed: [],
      dismissed: false,
      collapsed: false,
      tipsShown: []
    };
  }

  function getState() {
    try {
      var stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        var parsed = JSON.parse(stored);
        // Ensure all keys exist (merge with defaults)
        var defaults = getDefaultState();
        for (var key in defaults) {
          if (!(key in parsed)) parsed[key] = defaults[key];
        }
        return parsed;
      }
    } catch(e) {}
    return getDefaultState();
  }

  function saveState(state) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function completeStep(stepId) {
    var state = getState();
    if (state.completed.indexOf(stepId) === -1) {
      state.completed.push(stepId);
      saveState(state);
      updateWidgetUI(state);
      persistStepToServer(stepId - 1); // 0-indexed for backend
    }
  }

  function persistStepToServer(stepIndex) {
    try {
      if (typeof auth === 'undefined' || !auth.currentUser) return;
      auth.currentUser.getIdToken().then(function(token) {
        fetch('/api/auth/onboarding-step', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ step: stepIndex })
        }).catch(function() {});
      }).catch(function() {});
    } catch(e) {}
  }

  function hydrateFromServer() {
    // Pull completed steps from backend and merge into localStorage
    // Fixes restart bug when switching browsers or devices
    try {
      if (typeof auth === 'undefined') return;
      auth.onAuthStateChanged(function(user) {
        if (!user) return;
        user.getIdToken().then(function(token) {
          fetch('/api/auth/me', { headers: { 'Authorization': 'Bearer ' + token } })
            .then(function(r) { return r.json(); })
            .then(function(data) {
              var serverSteps = (data.user && data.user.onboardingSteps) ? data.user.onboardingSteps : [];
              if (!serverSteps.length) return;
              var state = getState();
              var changed = false;
              serverSteps.forEach(function(idx) {
                var stepId = idx + 1; // 0-indexed → 1-indexed
                if (state.completed.indexOf(stepId) === -1) {
                  state.completed.push(stepId);
                  changed = true;
                }
              });
              if (changed) { saveState(state); updateWidgetUI(state); }
            }).catch(function() {});
        }).catch(function() {});
      });
    } catch(e) {}
  }

  function dismissTip(tipId) {
    var state = getState();
    if (state.tipsShown.indexOf(tipId) === -1) {
      state.tipsShown.push(tipId);
      saveState(state);
    }
  }


  // ================================================================
  //  CSS INJECTION
  // ================================================================

  function injectStyles() {
    if (document.getElementById('kup-onboarding-styles')) return;

    var css = '' +
      /* ---- Checklist Pill (collapsed) ---- */
      '.kup-ob-pill{position:fixed;bottom:24px;left:24px;z-index:500;background:#fff;border-radius:12px;box-shadow:0 4px 24px rgba(0,0,0,0.12);padding:12px 18px;cursor:pointer;display:flex;align-items:center;gap:10px;font-family:Montserrat,sans-serif;transition:all 0.3s ease;border:1px solid #e8e8e8;max-width:240px;}' +
      '.kup-ob-pill:hover{box-shadow:0 6px 30px rgba(0,0,0,0.16);transform:translateY(-2px);}' +
      '.kup-ob-pill-icon{width:28px;height:28px;border-radius:50%;background:linear-gradient(135deg,#2EA5DD,#707BBB);display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px;flex-shrink:0;}' +
      '.kup-ob-pill-text{font-size:0.78rem;font-weight:600;color:#333;white-space:nowrap;}' +
      '.kup-ob-pill-progress{font-size:0.72rem;color:#888;font-weight:500;}' +

      /* ---- Checklist Panel (expanded) ---- */
      '.kup-ob-panel{position:fixed;bottom:24px;left:24px;z-index:500;background:#fff;border-radius:16px;box-shadow:0 8px 40px rgba(0,0,0,0.15);width:340px;max-height:480px;font-family:Montserrat,sans-serif;overflow:hidden;display:flex;flex-direction:column;border:1px solid #e8e8e8;animation:kupObSlideUp 0.3s ease;}' +

      /* Panel Header */
      '.kup-ob-header{background:linear-gradient(135deg,#2EA5DD 0%,#707BBB 100%);padding:18px 20px 14px;color:#fff;position:relative;}' +
      '.kup-ob-header-title{font-size:1rem;font-weight:700;margin:0 0 2px;}' +
      '.kup-ob-header-sub{font-size:0.75rem;opacity:0.85;font-weight:400;}' +
      '.kup-ob-close{position:absolute;top:12px;right:14px;background:rgba(255,255,255,0.2);border:none;border-radius:50%;width:26px;height:26px;display:flex;align-items:center;justify-content:center;cursor:pointer;color:#fff;font-size:14px;transition:background 0.15s;}' +
      '.kup-ob-close:hover{background:rgba(255,255,255,0.35);}' +

      /* Progress Bar */
      '.kup-ob-progress-wrap{padding:12px 20px 4px;}' +
      '.kup-ob-progress-bar{height:6px;background:#e8ecf0;border-radius:3px;overflow:hidden;}' +
      '.kup-ob-progress-fill{height:100%;background:linear-gradient(90deg,#2EA5DD,#707BBB);border-radius:3px;transition:width 0.5s ease;}' +
      '.kup-ob-progress-label{font-size:0.72rem;color:#888;margin-top:4px;font-weight:500;}' +

      /* Steps List */
      '.kup-ob-steps{flex:1;overflow-y:auto;padding:8px 0;}' +
      '.kup-ob-step{display:flex;align-items:flex-start;gap:12px;padding:10px 20px;transition:background 0.15s;}' +
      '.kup-ob-step:hover{background:#f8f9fa;}' +
      '.kup-ob-step-check{width:22px;height:22px;border-radius:50%;border:2px solid #d0d5dd;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;transition:all 0.3s ease;font-size:12px;color:transparent;}' +
      '.kup-ob-step.completed .kup-ob-step-check{background:#16a34a;border-color:#16a34a;color:#fff;}' +
      '.kup-ob-step-content{flex:1;min-width:0;}' +
      '.kup-ob-step-title{font-size:0.82rem;font-weight:600;color:#333;margin:0;line-height:1.3;}' +
      '.kup-ob-step-title a{color:#2EA5DD;text-decoration:none;}' +
      '.kup-ob-step-title a:hover{text-decoration:underline;}' +
      '.kup-ob-step.completed .kup-ob-step-title{color:#999;text-decoration:line-through;}' +
      '.kup-ob-step-desc{font-size:0.72rem;color:#888;margin:2px 0 0;line-height:1.35;}' +
      '.kup-ob-step.completed .kup-ob-step-desc{color:#bbb;}' +

      /* Footer */
      '.kup-ob-footer{padding:12px 20px;border-top:1px solid #f0f0f0;display:flex;align-items:center;justify-content:space-between;}' +
      '.kup-ob-footer a{font-size:0.72rem;color:#999;text-decoration:none;cursor:pointer;transition:color 0.15s;}' +
      '.kup-ob-footer a:hover{color:#666;}' +

      /* Completion State */
      '.kup-ob-complete{text-align:center;padding:32px 20px;}' +
      '.kup-ob-complete-icon{font-size:48px;margin-bottom:12px;}' +
      '.kup-ob-complete-title{font-size:1.05rem;font-weight:700;color:#333;margin:0 0 6px;}' +
      '.kup-ob-complete-text{font-size:0.8rem;color:#888;margin:0 0 16px;line-height:1.4;}' +
      '.kup-ob-complete-btn{background:linear-gradient(135deg,#2EA5DD,#707BBB);color:#fff;border:none;border-radius:8px;padding:8px 24px;font-size:0.82rem;font-weight:600;cursor:pointer;font-family:Montserrat,sans-serif;transition:opacity 0.15s;}' +
      '.kup-ob-complete-btn:hover{opacity:0.9;}' +

      /* ---- Tip Banners ---- */
      '.kup-ob-tip{background:rgba(46,165,221,0.06);border-left:4px solid #2EA5DD;border-radius:0 8px 8px 0;padding:14px 18px;margin-bottom:20px;display:flex;align-items:flex-start;gap:12px;font-family:Montserrat,sans-serif;animation:kupObFadeIn 0.4s ease;}' +
      '.kup-ob-tip-icon{font-size:18px;flex-shrink:0;margin-top:1px;}' +
      '.kup-ob-tip-content{flex:1;min-width:0;}' +
      '.kup-ob-tip-label{font-size:0.68rem;font-weight:700;color:#2EA5DD;text-transform:uppercase;letter-spacing:0.5px;margin:0 0 4px;}' +
      '.kup-ob-tip-text{font-size:0.82rem;color:#444;line-height:1.45;margin:0;}' +
      '.kup-ob-tip-dismiss{background:none;border:1px solid #2EA5DD;border-radius:6px;padding:4px 14px;font-size:0.72rem;font-weight:600;color:#2EA5DD;cursor:pointer;font-family:Montserrat,sans-serif;flex-shrink:0;align-self:center;transition:all 0.15s;}' +
      '.kup-ob-tip-dismiss:hover{background:#2EA5DD;color:#fff;}' +

      /* ---- Animations ---- */
      '@keyframes kupObSlideUp{from{opacity:0;transform:translateY(20px);}to{opacity:1;transform:translateY(0);}}' +
      '@keyframes kupObFadeIn{from{opacity:0;transform:translateY(-8px);}to{opacity:1;transform:translateY(0);}}' +

      /* ---- Mobile ---- */
      '@media(max-width:768px){' +
        '.kup-ob-pill{bottom:72px;left:12px;max-width:200px;}' +
        '.kup-ob-panel{bottom:72px;left:12px;right:12px;width:auto;max-width:none;}' +
        '.kup-ob-tip{margin-left:0;margin-right:0;}' +
      '}' +
    '';

    var style = document.createElement('style');
    style.id = 'kup-onboarding-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }


  // ================================================================
  //  CHECKLIST WIDGET
  // ================================================================

  function getCurrentPage() {
    var path = window.location.pathname;
    return path.split('/').pop() || '';
  }

  function buildPill(state) {
    var completedCount = state.completed.length;
    var total = STEPS.length;
    var pct = Math.round((completedCount / total) * 100);

    var el = document.createElement('div');
    el.className = 'kup-ob-pill';
    el.id = 'kupObPill';
    el.innerHTML = '' +
      '<span class="kup-ob-pill-icon">&#9776;</span>' +
      '<span>' +
        '<span class="kup-ob-pill-text">Get Started</span><br>' +
        '<span class="kup-ob-pill-progress">' + completedCount + '/' + total + ' \u2014 ' + pct + '% complete</span>' +
      '</span>';

    el.addEventListener('click', function() {
      var s = getState();
      s.collapsed = false;
      saveState(s);
      renderWidget();
    });

    return el;
  }

  function buildPanel(state) {
    var completedCount = state.completed.length;
    var total = STEPS.length;
    var pct = Math.round((completedCount / total) * 100);
    var allDone = completedCount === total;

    var el = document.createElement('div');
    el.className = 'kup-ob-panel';
    el.id = 'kupObPanel';

    if (allDone) {
      el.innerHTML = '' +
        '<div class="kup-ob-header">' +
          '<div class="kup-ob-header-title">All Done!</div>' +
          '<button class="kup-ob-close" id="kupObClose" title="Close">&times;</button>' +
        '</div>' +
        '<div class="kup-ob-complete">' +
          '<div class="kup-ob-complete-icon">&#127881;</div>' +
          '<h3 class="kup-ob-complete-title">You\'re all set!</h3>' +
          '<p class="kup-ob-complete-text">You\'ve completed the onboarding checklist. Your brand is ready to attract influencers and grow.</p>' +
          '<button class="kup-ob-complete-btn" id="kupObDismissForever">Close Checklist</button>' +
        '</div>';
    } else {
      var stepsHTML = '';
      for (var i = 0; i < STEPS.length; i++) {
        var step = STEPS[i];
        var isDone = state.completed.indexOf(step.id) !== -1;
        stepsHTML += '' +
          '<div class="kup-ob-step' + (isDone ? ' completed' : '') + '">' +
            '<div class="kup-ob-step-check">' + (isDone ? '&#10003;' : '') + '</div>' +
            '<div class="kup-ob-step-content">' +
              '<p class="kup-ob-step-title">' +
                (isDone ? step.title : '<a href="' + step.link + '">' + step.title + '</a>') +
              '</p>' +
              '<p class="kup-ob-step-desc">' + step.desc + '</p>' +
            '</div>' +
          '</div>';
      }

      el.innerHTML = '' +
        '<div class="kup-ob-header">' +
          '<div class="kup-ob-header-title">Welcome to KeepUsPostd!</div>' +
          '<div class="kup-ob-header-sub">Complete these steps to get started</div>' +
          '<button class="kup-ob-close" id="kupObClose" title="Collapse">&minus;</button>' +
        '</div>' +
        '<div class="kup-ob-progress-wrap">' +
          '<div class="kup-ob-progress-bar"><div class="kup-ob-progress-fill" style="width:' + pct + '%;"></div></div>' +
          '<div class="kup-ob-progress-label">' + completedCount + ' of ' + total + ' completed (' + pct + '%)</div>' +
        '</div>' +
        '<div class="kup-ob-steps">' + stepsHTML + '</div>' +
        '<div class="kup-ob-footer">' +
          '<a id="kupObSkip">Skip for now</a>' +
          '<a id="kupObDismiss">Dismiss forever</a>' +
        '</div>';
    }

    return el;
  }

  function renderWidget() {
    // Remove existing widget
    var existing = document.getElementById('kupObPill');
    if (existing) existing.remove();
    existing = document.getElementById('kupObPanel');
    if (existing) existing.remove();

    var state = getState();

    // Don't render if dismissed
    if (state.dismissed) return;

    var widget;
    if (state.collapsed) {
      widget = buildPill(state);
    } else {
      widget = buildPanel(state);
    }

    document.body.appendChild(widget);

    // Bind events
    var closeBtn = document.getElementById('kupObClose');
    if (closeBtn) {
      closeBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        var s = getState();
        s.collapsed = true;
        saveState(s);
        renderWidget();
      });
    }

    var skipBtn = document.getElementById('kupObSkip');
    if (skipBtn) {
      skipBtn.addEventListener('click', function(e) {
        e.preventDefault();
        var s = getState();
        s.collapsed = true;
        saveState(s);
        renderWidget();
      });
    }

    var dismissBtn = document.getElementById('kupObDismiss');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', function(e) {
        e.preventDefault();
        var s = getState();
        s.dismissed = true;
        saveState(s);
        renderWidget();
      });
    }

    var dismissForeverBtn = document.getElementById('kupObDismissForever');
    if (dismissForeverBtn) {
      dismissForeverBtn.addEventListener('click', function() {
        var s = getState();
        s.dismissed = true;
        saveState(s);
        renderWidget();
      });
    }
  }

  function updateWidgetUI(state) {
    // Re-render the widget with updated state
    renderWidget();
  }


  // ================================================================
  //  AUTO-COMPLETE ON PAGE VISIT
  // ================================================================

  function autoCompleteCurrentPage() {
    var currentPage = getCurrentPage();
    for (var i = 0; i < STEPS.length; i++) {
      if (STEPS[i].page === currentPage) {
        completeStep(STEPS[i].id);
        break;
      }
    }
  }


  // ================================================================
  //  CONTEXTUAL TIP BANNERS
  // ================================================================

  function showTipIfNeeded() {
    var currentPage = getCurrentPage();
    var tipConfig = TIPS[currentPage];
    if (!tipConfig) return;

    var state = getState();
    if (state.tipsShown.indexOf(tipConfig.id) !== -1) return;

    // Find the page content container to insert the tip
    // For brand sidebar pages, insert into the main content area (not the sidebar)
    var container = document.querySelector('.page-content') ||
                    document.querySelector('.brand-preview') ||
                    document.querySelector('.kup-inner-main') ||
                    document.querySelector('main');
    if (!container) return;

    var tip = document.createElement('div');
    tip.className = 'kup-ob-tip';
    tip.id = 'kupObTip-' + tipConfig.id;
    tip.innerHTML = '' +
      '<span class="kup-ob-tip-icon">&#128161;</span>' +
      '<div class="kup-ob-tip-content">' +
        '<p class="kup-ob-tip-label">Quick Tip</p>' +
        '<p class="kup-ob-tip-text">' + tipConfig.text + '</p>' +
      '</div>' +
      '<button class="kup-ob-tip-dismiss" data-tip-id="' + tipConfig.id + '">Got it</button>';

    // Insert as first child of the content area
    container.insertBefore(tip, container.firstChild);

    // Bind dismiss
    tip.querySelector('.kup-ob-tip-dismiss').addEventListener('click', function() {
      var id = this.getAttribute('data-tip-id');
      dismissTip(id);
      tip.style.opacity = '0';
      tip.style.transform = 'translateY(-8px)';
      tip.style.transition = 'all 0.3s ease';
      setTimeout(function() { tip.remove(); }, 300);
    });
  }


  // ================================================================
  //  MULTI-TAB SYNC
  // ================================================================

  function initMultiTabSync() {
    window.addEventListener('storage', function(e) {
      if (e.key === STORAGE_KEY && e.newValue !== e.oldValue) {
        renderWidget();
      }
    });
  }


  // ================================================================
  //  INIT
  // ================================================================

  function init() {
    var state = getState();

    // Inject styles
    injectStyles();

    // Hydrate completed steps from server (fixes restart on new browser/device)
    hydrateFromServer();

    // Auto-complete step if user is on a tracked page
    autoCompleteCurrentPage();

    // Show checklist widget (unless dismissed)
    if (!state.dismissed) {
      renderWidget();
    }

    // Show contextual tip banner if applicable
    showTipIfNeeded();

    // Multi-tab sync
    initMultiTabSync();
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
    getState: getState,
    completeStep: completeStep,
    reset: function() {
      localStorage.removeItem(STORAGE_KEY);
      renderWidget();
    }
  };

})();
