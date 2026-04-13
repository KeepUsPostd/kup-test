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

  // Redirect to login preserving current page as return URL
  _redirectToLogin() {
    const returnUrl = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = '/pages/login.html?redirect=' + returnUrl;
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
      this._redirectToLogin();
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
      this._redirectToLogin();
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
      this._redirectToLogin();
      return;
    }
    return await response.json();
  },

  // UPLOAD request — sends files via FormData (multipart)
  async upload(path, files, fieldName = 'media') {
    const token = await this.getToken();
    const formData = new FormData();
    for (let i = 0; i < files.length; i++) {
      formData.append(fieldName, files[i]);
    }
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers,
      body: formData,
    });
    if (response.status === 401) {
      this._redirectToLogin();
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
      this._redirectToLogin();
      return;
    }
    return await response.json();
  },

  // Generic request method (used by newer pages: brand-catalog, brand-music, etc.)
  async request(method, path, options = {}) {
    switch (method.toUpperCase()) {
      case 'GET': return this.get(path);
      case 'POST': return this.post(path, options.body || {});
      case 'PUT': return this.put(path, options.body || {});
      case 'DELETE': return this.delete(path);
      default: return this.get(path);
    }
  },

  // Auth helper (used by newer pages for token access)
  auth: {
    isAuthenticated() {
      return typeof auth !== 'undefined' && !!auth.currentUser;
    },
    async getToken() {
      if (typeof getAuthToken === 'function') return await getAuthToken();
      return null;
    },
  },
};

// Alias — newer pages use KUP_API
const KUP_API = kupApi;
