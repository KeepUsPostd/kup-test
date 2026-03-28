// PayPal API Configuration — Sandbox & Production
// Rule G5: PayPal Business ONLY — no Stripe, no bank transfer
//
// Uses PayPal REST API v2 directly via Node fetch (no SDK dependency).
// Sandbox: api-m.sandbox.paypal.com
// Live:    api-m.paypal.com

const PAYPAL_BASE_URL = process.env.PAYPAL_MODE === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

// Cache the access token so we don't request a new one every call.
// PayPal tokens last ~9 hours; we refresh at 8 hours to be safe.
let _cachedToken = null;
let _tokenExpiresAt = 0;

/**
 * Get a PayPal OAuth2 access token (client credentials grant).
 * Caches the token and refreshes when expired.
 * @returns {Promise<string>} Bearer access token
 */
async function getAccessToken() {
  // Return cached token if still valid (with 60s buffer)
  if (_cachedToken && Date.now() < _tokenExpiresAt - 60000) {
    return _cachedToken;
  }

  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('PayPal credentials not configured. Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env');
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const response = await fetch(`${PAYPAL_BASE_URL}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`PayPal auth failed (${response.status}): ${err}`);
  }

  const data = await response.json();
  _cachedToken = data.access_token;
  // PayPal returns expires_in in seconds; convert to ms timestamp
  _tokenExpiresAt = Date.now() + (data.expires_in * 1000);

  console.log(`🔑 PayPal access token obtained (expires in ${Math.round(data.expires_in / 3600)}h)`);
  return _cachedToken;
}

/**
 * Make an authenticated request to the PayPal REST API.
 * @param {string} method - HTTP method (GET, POST, PATCH, etc.)
 * @param {string} path - API path (e.g., '/v2/checkout/orders')
 * @param {object} [body] - Request body (will be JSON-serialized)
 * @returns {Promise<object>} Parsed JSON response
 */
async function paypalRequest(method, path, body = null) {
  const token = await getAccessToken();

  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
  };

  if (body && method !== 'GET') {
    options.body = JSON.stringify(body);
  }

  const url = `${PAYPAL_BASE_URL}${path}`;
  const response = await fetch(url, options);

  // Some PayPal endpoints return 204 No Content
  if (response.status === 204) return null;

  const data = await response.json();

  if (!response.ok) {
    const error = new Error(`PayPal API error (${response.status}): ${data.message || JSON.stringify(data)}`);
    error.paypalResponse = data;
    error.statusCode = response.status;
    throw error;
  }

  return data;
}

// ── Subscription Helpers ─────────────────────────────────

/**
 * Create a PayPal product (one-time setup per plan tier).
 * Products are the parent of subscription plans.
 */
async function createProduct(name, description) {
  return paypalRequest('POST', '/v1/catalogs/products', {
    name,
    description,
    type: 'SERVICE',
    category: 'SOFTWARE',
  });
}

/**
 * Create a PayPal subscription plan under a product.
 * @param {string} productId - PayPal product ID
 * @param {string} name - Plan name (e.g., "KUP Growth Monthly")
 * @param {number} price - Price in USD
 * @param {string} interval - 'MONTH' or 'YEAR'
 */
async function createPlan(productId, name, price, interval) {
  return paypalRequest('POST', '/v1/billing/plans', {
    product_id: productId,
    name,
    billing_cycles: [
      {
        frequency: {
          interval_unit: interval,
          interval_count: 1,
        },
        tenure_type: 'REGULAR',
        sequence: 1,
        total_cycles: 0, // infinite
        pricing_scheme: {
          fixed_price: {
            value: price.toString(),
            currency_code: 'USD',
          },
        },
      },
    ],
    payment_preferences: {
      auto_bill_outstanding: true,
      payment_failure_threshold: 3,
    },
  });
}

/**
 * Create a subscription for a user (returns approval URL).
 * Brand owner clicks the approval URL → PayPal checkout → redirected back.
 * @param {string} planId - PayPal plan ID
 * @param {string} returnUrl - URL to redirect after approval
 * @param {string} cancelUrl - URL to redirect if user cancels
 * @param {string} [subscriberEmail] - Pre-fill subscriber email
 */
async function createSubscription(planId, returnUrl, cancelUrl, subscriberEmail) {
  const body = {
    plan_id: planId,
    application_context: {
      brand_name: 'KeepUsPostd',
      locale: 'en-US',
      shipping_preference: 'NO_SHIPPING',
      user_action: 'SUBSCRIBE_NOW',
      return_url: returnUrl,
      cancel_url: cancelUrl,
    },
  };

  if (subscriberEmail) {
    body.subscriber = {
      email_address: subscriberEmail,
    };
  }

  return paypalRequest('POST', '/v1/billing/subscriptions', body);
}

/**
 * Get subscription details from PayPal.
 */
async function getSubscription(subscriptionId) {
  return paypalRequest('GET', `/v1/billing/subscriptions/${subscriptionId}`);
}

/**
 * Cancel a PayPal subscription.
 */
async function cancelSubscription(subscriptionId, reason) {
  return paypalRequest('POST', `/v1/billing/subscriptions/${subscriptionId}/cancel`, {
    reason: reason || 'Customer requested cancellation',
  });
}

// ── Order Helpers (Brand → Influencer Payments) ──────────

/**
 * Create a PayPal order for a brand-to-influencer payment.
 * This is for one-off payments (CPA, bonus cash, PostdPay).
 * @param {number} amount - Total amount brand pays (gross)
 * @param {string} description - Payment description
 * @param {string} returnUrl - Redirect after approval
 * @param {string} cancelUrl - Redirect if cancelled
 */
async function createOrder(amount, description, returnUrl, cancelUrl) {
  return paypalRequest('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [
      {
        amount: {
          currency_code: 'USD',
          value: amount.toFixed(2),
        },
        description,
      },
    ],
    payment_source: {
      paypal: {
        experience_context: {
          brand_name: 'KeepUsPostd',
          locale: 'en-US',
          shipping_preference: 'NO_SHIPPING',
          user_action: 'PAY_NOW',
          return_url: returnUrl,
          cancel_url: cancelUrl,
        },
      },
    },
  });
}

/**
 * Capture a previously approved order (finalizes the payment).
 */
async function captureOrder(orderId) {
  return paypalRequest('POST', `/v2/checkout/orders/${orderId}/capture`);
}

/**
 * Get order details.
 */
async function getOrder(orderId) {
  return paypalRequest('GET', `/v2/checkout/orders/${orderId}`);
}

// ── Payout Helpers (KUP → Influencer for platform bonuses) ──

/**
 * Send a batch payout (KUP paying influencers directly).
 * Used only for platform bonuses, referral bonuses, etc.
 * Brand-to-influencer payments use Orders (above).
 * @param {Array<{email: string, amount: number, note: string}>} items
 * @param {string} batchId - Unique batch identifier
 */
async function createPayout(items, batchId) {
  return paypalRequest('POST', '/v1/payments/payouts', {
    sender_batch_header: {
      sender_batch_id: batchId,
      email_subject: 'You have a payment from KeepUsPostd',
      email_message: 'You received a payment for your content on KeepUsPostd!',
    },
    items: items.map((item, i) => ({
      recipient_type: 'EMAIL',
      amount: {
        value: item.amount.toFixed(2),
        currency: 'USD',
      },
      receiver: item.email,
      note: item.note || 'KeepUsPostd payment',
      sender_item_id: `${batchId}_${i}`,
    })),
  });
}

/**
 * Get payout batch status.
 */
async function getPayoutBatch(payoutBatchId) {
  return paypalRequest('GET', `/v1/payments/payouts/${payoutBatchId}`);
}

// ── Webhook Verification ─────────────────────────────────

/**
 * Verify a PayPal webhook signature.
 * @param {object} headers - Request headers from PayPal
 * @param {string} body - Raw request body string
 * @param {string} webhookId - Your webhook ID from PayPal dashboard
 */
async function verifyWebhook(headers, body, webhookId) {
  return paypalRequest('POST', '/v1/notifications/verify-webhook-signature', {
    auth_algo: headers['paypal-auth-algo'],
    cert_url: headers['paypal-cert-url'],
    transmission_id: headers['paypal-transmission-id'],
    transmission_sig: headers['paypal-transmission-sig'],
    transmission_time: headers['paypal-transmission-time'],
    webhook_id: webhookId,
    webhook_event: typeof body === 'string' ? JSON.parse(body) : body,
  });
}

module.exports = {
  PAYPAL_BASE_URL,
  getAccessToken,
  paypalRequest,

  // Subscriptions
  createProduct,
  createPlan,
  createSubscription,
  getSubscription,
  cancelSubscription,

  // Orders (brand → influencer payments)
  createOrder,
  captureOrder,
  getOrder,

  // Payouts (KUP → influencer platform bonuses)
  createPayout,
  getPayoutBatch,

  // Webhooks
  verifyWebhook,
};
