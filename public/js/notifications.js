/**
 * KUP Notification Center — Shared across all /app/ pages
 * Fetches in-app notifications from /api/notifications and renders them
 * in the bell icon popover. Auto-polls every 60s for new notifications.
 *
 * Requires: kupApi (from /js/api.js) to be loaded first.
 * Expects DOM elements: #notifBtn, #notifPopover, #notifList, #markAllRead, .notif-dot
 */
(function() {
  'use strict';

  var POLL_INTERVAL = 60000; // 60 seconds
  var pollTimer = null;

  function getTimeAgo(dateStr) {
    if (!dateStr) return '';
    var now = Date.now();
    var then = new Date(dateStr).getTime();
    var diff = Math.floor((now - then) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
    return new Date(dateStr).toLocaleDateString();
  }

  var TYPE_ICONS = {
    partnership: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><path d="M20 8v6"/><path d="M23 11h-6"/></svg>',
    content: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
    reward: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
    system: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  };

  function getIcon(type) {
    return TYPE_ICONS[type] || TYPE_ICONS.system;
  }

  function renderNotification(n) {
    var unreadClass = n.read ? '' : ' unread';
    return '<li class="notif-item' + unreadClass + '" data-id="' + n._id + '">' +
      '<div class="notif-icon">' + getIcon(n.type) + '</div>' +
      '<div class="notif-body">' +
        '<div class="notif-title">' + (n.title || '') + '</div>' +
        '<div class="notif-msg">' + (n.message || '') + '</div>' +
        '<div class="notif-time">' + getTimeAgo(n.createdAt) + '</div>' +
      '</div>' +
      (!n.read ? '<div class="notif-unread-dot"></div>' : '') +
    '</li>';
  }

  function renderList(notifications) {
    var list = document.getElementById('notifList');
    if (!list) return;

    if (!notifications || notifications.length === 0) {
      list.innerHTML = '<li class="notif-item" style="text-align:center;padding:24px 16px;color:#94a3b8;font-size:.82rem;">No notifications yet</li>';
      return;
    }

    list.innerHTML = notifications.map(renderNotification).join('');

    // Click to mark read + navigate
    list.querySelectorAll('.notif-item[data-id]').forEach(function(item) {
      item.addEventListener('click', function() {
        var id = this.getAttribute('data-id');
        if (this.classList.contains('unread')) {
          this.classList.remove('unread');
          var dot = this.querySelector('.notif-unread-dot');
          if (dot) dot.remove();
          kupApi.put('/api/notifications/' + id + '/read').catch(function() {});
          updateBadge(-1);
        }
      });
    });
  }

  function updateBadge(delta) {
    var dot = document.querySelector('.notif-dot');
    if (!dot) return;

    if (typeof delta === 'number') {
      var current = parseInt(dot.getAttribute('data-count') || '0');
      var newCount = Math.max(0, current + delta);
      dot.setAttribute('data-count', newCount);
      dot.style.display = newCount > 0 ? 'flex' : 'none';
      dot.textContent = newCount > 99 ? '99+' : newCount;
    }
  }

  function setBadge(count) {
    var dot = document.querySelector('.notif-dot');
    if (!dot) return;
    dot.setAttribute('data-count', count);
    dot.style.display = count > 0 ? 'flex' : 'none';
    dot.textContent = count > 99 ? '99+' : count;
  }

  async function loadNotifications() {
    if (typeof kupApi === 'undefined') return;
    try {
      var data = await kupApi.get('/api/notifications?limit=20');
      if (data && data.notifications) {
        renderList(data.notifications);
      }
    } catch (e) {
      // Silent fail — don't break the page
    }
  }

  async function loadUnreadCount() {
    if (typeof kupApi === 'undefined') return;
    try {
      var data = await kupApi.get('/api/notifications/unread-count');
      if (data && typeof data.unreadCount === 'number') {
        setBadge(data.unreadCount);
      }
    } catch (e) {
      // Silent fail
    }
  }

  function init() {
    // Load initial data
    loadUnreadCount();
    loadNotifications();

    // Poll for new notifications
    pollTimer = setInterval(function() {
      loadUnreadCount();
    }, POLL_INTERVAL);

    // Refresh notifications when popover opens
    var btn = document.getElementById('notifBtn');
    if (btn) {
      btn.addEventListener('click', function() {
        var pop = document.getElementById('notifPopover');
        if (pop && pop.classList.contains('show')) {
          loadNotifications();
        }
      });
    }

    // Mark all read
    var markAll = document.getElementById('markAllRead');
    if (markAll) {
      markAll.addEventListener('click', function() {
        kupApi.put('/api/notifications/read-all').then(function() {
          setBadge(0);
          document.querySelectorAll('.notif-item.unread').forEach(function(item) {
            item.classList.remove('unread');
            var dot = item.querySelector('.notif-unread-dot');
            if (dot) dot.remove();
          });
        }).catch(function() {});
      });
    }

    // Tab filtering (All / Unread)
    document.querySelectorAll('.notif-tab').forEach(function(tab) {
      tab.addEventListener('click', function() {
        var filter = this.getAttribute('data-tab');
        document.querySelectorAll('.notif-item').forEach(function(item) {
          if (filter === 'unread') {
            item.style.display = item.classList.contains('unread') ? 'flex' : 'none';
          } else {
            item.style.display = '';
          }
        });
      });
    });
  }

  // Wait for DOM + kupApi
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function() { setTimeout(init, 500); });
  } else {
    setTimeout(init, 500);
  }
})();
