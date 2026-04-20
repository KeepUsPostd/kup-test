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

  function hydrate(user) {
    if (!user) return;
    var display = user.displayName || '';
    var email = user.email || '';
    var nameShort = shortName(display);
    var inits = initials(display, email);

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
  }

  auth.onAuthStateChanged(function(user) {
    if (!user) return;
    hydrate(user);
  });
})();
