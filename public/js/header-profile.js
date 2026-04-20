/**
 * KUP HEADER PROFILE HYDRATOR — Populates user name + avatar in page headers
 * Loaded on every inner /app/ page via <script src="/js/header-profile.js"></script>
 *
 * Replaces the previous pattern of hardcoded "Santana T." / "ST" placeholders.
 *
 * Populates (when present on page):
 *   - #headerName         -> user's display name (e.g., "Santana T.")
 *   - #headerAvatar       -> user's initials (e.g., "ST")
 *   - #headerProfileAvatar -> user's initials (alternative id used on some pages)
 *   - .profile-avatar (when text is empty) -> user's initials
 *
 * Depends on: firebase-auth-compat + firebase-client.js (both already loaded).
 */

(function() {
  'use strict';

  if (typeof auth === 'undefined' || !auth || !auth.onAuthStateChanged) return;

  function shortName(fullName) {
    if (!fullName) return '';
    var parts = String(fullName).trim().split(/\s+/);
    if (parts.length === 1) return parts[0];
    return parts[0] + ' ' + parts[parts.length - 1].charAt(0).toUpperCase() + '.';
  }

  function initials(fullName, fallbackEmail) {
    if (fullName) {
      var parts = String(fullName).trim().split(/\s+/);
      if (parts.length >= 2) {
        return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
      }
      return parts[0].charAt(0).toUpperCase();
    }
    if (fallbackEmail) return String(fallbackEmail).charAt(0).toUpperCase();
    return '';
  }

  function readStoredUser() {
    try {
      var raw = localStorage.getItem('kupUser');
      if (raw && raw !== 'undefined' && raw !== 'null') return JSON.parse(raw) || {};
    } catch(e) {}
    return {};
  }

  function displayNameFromAny(firebaseUser) {
    // Priority: Firebase displayName → backend first+last → email prefix
    if (firebaseUser && firebaseUser.displayName) return firebaseUser.displayName;
    var stored = readStoredUser();
    if (stored.firstName || stored.lastName) {
      return ((stored.firstName || '') + ' ' + (stored.lastName || '')).trim();
    }
    if (stored.legalFirstName || stored.legalLastName) {
      return ((stored.legalFirstName || '') + ' ' + (stored.legalLastName || '')).trim();
    }
    var email = (firebaseUser && firebaseUser.email) || stored.email || '';
    if (email) {
      var prefix = email.split('@')[0];
      // Prettify: "santana.t" → "Santana T", "santana_t" → "Santana T"
      return prefix
        .split(/[._-]+/)
        .map(function(p) { return p.charAt(0).toUpperCase() + p.slice(1); })
        .join(' ');
    }
    return '';
  }

  function readActiveBrand() {
    try {
      var raw = localStorage.getItem('kup_active_brand');
      if (raw && raw !== 'undefined' && raw !== 'null') return JSON.parse(raw) || null;
    } catch(e) {}
    return null;
  }

  function hydrate(user) {
    if (!user) return;
    var display = displayNameFromAny(user);
    var email = user.email || '';
    var nameShort = shortName(display);
    var inits = initials(display, email);
    var activeBrand = readActiveBrand();
    var brandName = (activeBrand && activeBrand.name) || '';

    // Populate known id-based slots
    ['headerName'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el && !el.textContent.trim()) el.textContent = nameShort;
    });

    ['headerAvatar', 'headerProfileAvatar', 'profileAvatar'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el && !el.textContent.trim()) el.textContent = inits;
    });

    // Fallback: any .profile-avatar that is still empty (and has no id match above)
    var avatars = document.querySelectorAll('.profile-avatar');
    for (var i = 0; i < avatars.length; i++) {
      if (!avatars[i].textContent.trim()) avatars[i].textContent = inits;
    }

    // Class-based fallback for pages that don't use id-based slots.
    // Pattern: <div class="profile-info"><div class="name"></div><div class="brand"></div></div>
    var nameNodes = document.querySelectorAll('.profile-info > .name');
    for (var j = 0; j < nameNodes.length; j++) {
      if (!nameNodes[j].textContent.trim()) nameNodes[j].textContent = nameShort;
    }
    var brandNodes = document.querySelectorAll('.profile-info > .brand');
    for (var k = 0; k < brandNodes.length; k++) {
      if (!brandNodes[k].textContent.trim() && brandName) brandNodes[k].textContent = brandName;
    }
  }

  // If kupUser is missing or has no stored firstName/lastName, re-hydrate it
  // from /api/auth/me then re-render. Prevents the top-right from showing
  // the email-prefix fallback after a cache clear.
  async function ensureStoredUser(user) {
    try {
      var stored = readStoredUser();
      if (stored && (stored.firstName || stored.lastName)) return stored;
      if (typeof kupApi === 'undefined') return stored;
      var me = await kupApi.get('/api/auth/me');
      if (me && me.user) {
        localStorage.setItem('kupUser', JSON.stringify(me.user));
        return me.user;
      }
    } catch (e) {}
    return null;
  }

  auth.onAuthStateChanged(async function(user) {
    if (!user) return;
    hydrate(user);                 // First pass — use whatever we have synchronously
    var fresh = await ensureStoredUser(user);
    if (fresh) hydrate(user);      // Re-hydrate once the backend user is cached
  });
})();
