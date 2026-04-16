// KUP API Helper — Fetch wrapper with Firebase auth token
// Automatically attaches the Bearer token to every API request.
// Usage: const brands = await kupApi.get('/api/brands');

const kupApi = {
  // Base URL — uses localhost in dev, same domain in production
  baseUrl: window.location.hostname === 'localhost'
    ? `http://localhost:${window.location.port || 3001}`
    : '',

  // Get the current auth token
  async getToken() {
    if (typeof getAuthToken === 'function') {
      return await getAuthToken();
    }
    return null;
  },

  // Build headers with auth token
  async getHeaders(extraHeaders = {}) {
    const token = await this.getToken();
    const headers = {
      'Content-Type': 'application/json',
      ...extraHeaders,
    };
    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }
    return headers;
  },

  // GET request
  async get(path) {
    const headers = await this.getHeaders();
    const response = await fetch(`${this.baseUrl}${path}`, { headers });
    if (response.status === 401) {
      // If Firebase still has a user, the token may just need refreshing — retry once
      if (typeof auth !== 'undefined' && auth.currentUser) {
        try {
          const freshToken = await auth.currentUser.getIdToken(true); // force refresh
          const retryHeaders = { ...headers, 'Authorization': `Bearer ${freshToken}` };
          const retry = await fetch(`${this.baseUrl}${path}`, { headers: retryHeaders });
          if (retry.ok) return await retry.json();
        } catch(e) {}
      }
      window.location.href = '/pages/login.html';
      return;
    }
    return await response.json();
  },

  // POST request
  async post(path, body = {}) {
    const headers = await this.getHeaders();
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
    if (response.status === 401) {
      if (typeof auth !== 'undefined' && auth.currentUser) {
        try {
          const freshToken = await auth.currentUser.getIdToken(true);
          const retry = await fetch(`${this.baseUrl}${path}`, { method: 'POST', headers: { ...headers, 'Authorization': `Bearer ${freshToken}` }, body: JSON.stringify(body) });
          if (retry.ok) return await retry.json();
        } catch(e) {}
      }
      window.location.href = '/pages/login.html';
      return;
    }
    return await response.json();
  },

  // PUT request
  async put(path, body = {}) {
    const headers = await this.getHeaders();
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(body),
    });
    if (response.status === 401) {
      if (typeof auth !== 'undefined' && auth.currentUser) {
        try {
          const freshToken = await auth.currentUser.getIdToken(true);
          const retry = await fetch(`${this.baseUrl}${path}`, { method: 'PUT', headers: { ...headers, 'Authorization': `Bearer ${freshToken}` }, body: JSON.stringify(body) });
          if (retry.ok) return await retry.json();
        } catch(e) {}
      }
      window.location.href = '/pages/login.html';
      return;
    }
    return await response.json();
  },

  // UPLOAD request — sends files via FormData (multipart)
  // Usage: const result = await kupApi.upload('/api/upload', fileInput.files, 'media');
  // Or single file: await kupApi.upload('/api/upload', [file], 'media');
  async upload(path, files, fieldName = 'media') {
    const token = await this.getToken();
    const formData = new FormData();
    for (let i = 0; i < files.length; i++) {
      formData.append(fieldName, files[i]);
    }
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    // Don't set Content-Type — browser sets it automatically with multipart boundary
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: formData,
    });
    if (response.status === 401) {
      window.location.href = '/pages/login.html';
      return;
    }
    return await response.json();
  },

  // DELETE request
  async delete(path) {
    const headers = await this.getHeaders();
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'DELETE',
      headers,
    });
    if (response.status === 401) {
      window.location.href = '/pages/login.html';
      return;
    }
    return await response.json();
  },

  // Generic request method (used by catalog + music pages)
  async request(method, path, options = {}) {
    switch (method.toUpperCase()) {
      case 'GET': return this.get(path);
      case 'POST': return this.post(path, options.body || {});
      case 'PUT': return this.put(path, options.body || {});
      case 'DELETE': return this.delete(path);
      default: return this.get(path);
    }
  },
  auth: {
    isAuthenticated() { return typeof auth !== 'undefined' && !!auth.currentUser; },
    async getToken() { if (typeof getAuthToken === 'function') return await getAuthToken(); return null; },
  },
};
const KUP_API = kupApi;

// ── Universal Plan Upgrade Modal ──
// Automatically shown when any kupApi call returns { error: 'plan_required' }.
// Catches it at the response level so every page gets it for free.
(function() {
  // Wrap all kupApi methods to intercept plan_required responses
  ['get', 'post', 'put', 'delete', 'upload'].forEach(function(method) {
    var original = kupApi[method].bind(kupApi);
    kupApi[method] = async function() {
      var result = await original.apply(null, arguments);
      if (result && result.error === 'plan_required') {
        showPlanUpgradeModal(result);
        throw new Error(result.message || 'Upgrade required');
      }
      return result;
    };
  });

  function showPlanUpgradeModal(data) {
    // Remove existing modal if open
    var existing = document.getElementById('kupUpgradeModal');
    if (existing) existing.remove();

    var planName = (data.requiredPlan || 'growth').charAt(0).toUpperCase() + (data.requiredPlan || 'growth').slice(1);
    var currentPlan = (data.currentPlan || 'starter').charAt(0).toUpperCase() + (data.currentPlan || 'starter').slice(1);

    var overlay = document.createElement('div');
    overlay.id = 'kupUpgradeModal';
    overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.6);z-index:99999;display:flex;align-items:center;justify-content:center;padding:20px;animation:kupFadeIn .2s ease';

    overlay.innerHTML = '<div style="background:#fff;border-radius:20px;max-width:420px;width:100%;padding:32px;text-align:center;box-shadow:0 24px 48px rgba(0,0,0,0.15);position:relative">'
      + '<div style="width:64px;height:64px;border-radius:16px;background:linear-gradient(135deg,#2EA5DD,#707BBB);display:flex;align-items:center;justify-content:center;margin:0 auto 20px">'
      + '<svg width="28" height="28" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" viewBox="0 0 24 24"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>'
      + '</div>'
      + '<h2 style="font-family:Montserrat,sans-serif;font-size:22px;font-weight:800;color:#1a1a1a;margin:0 0 8px">Upgrade to ' + planName + '</h2>'
      + '<p style="font-family:Montserrat,sans-serif;font-size:14px;color:#666;margin:0 0 8px;line-height:1.5">' + (data.message || 'This feature requires a higher plan.') + '</p>'
      + '<p style="font-family:Montserrat,sans-serif;font-size:12px;color:#999;margin:0 0 24px">Current plan: <strong>' + currentPlan + '</strong></p>'
      + '<a href="pricing-payment.html" style="display:inline-block;padding:14px 32px;background:linear-gradient(135deg,#2EA5DD,#707BBB);color:#fff;font-family:Montserrat,sans-serif;font-size:15px;font-weight:700;border-radius:9999px;text-decoration:none;transition:transform .15s">View Plans & Upgrade</a>'
      + '<br><button onclick="this.closest(\'#kupUpgradeModal\').remove()" style="margin-top:16px;background:none;border:none;font-family:Montserrat,sans-serif;font-size:13px;color:#999;cursor:pointer;padding:8px">Maybe later</button>'
      + '</div>';

    overlay.addEventListener('click', function(e) {
      if (e.target === overlay) overlay.remove();
    });

    document.body.appendChild(overlay);
  }

  // Fade-in animation
  if (!document.getElementById('kupUpgradeStyles')) {
    var style = document.createElement('style');
    style.id = 'kupUpgradeStyles';
    style.textContent = '@keyframes kupFadeIn{from{opacity:0}to{opacity:1}}';
    document.head.appendChild(style);
  }
})();
