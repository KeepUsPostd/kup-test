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

  // Auth helper (used by catalog + music pages)
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

// Alias for newer pages
const KUP_API = kupApi;
