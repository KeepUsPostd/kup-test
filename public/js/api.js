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
};
