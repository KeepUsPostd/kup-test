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
 * Get transaction history for a PayPal subscription.
 * Returns up to 12 months of payment records.
 */
async function getSubscriptionTransactions(subscriptionId) {
  const endTime = new Date().toISOString();
  const startTime = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
  const qs = `?start_time=${encodeURIComponent(startTime)}&end_time=${encodeURIComponent(endTime)}`;
  return paypalRequest('GET', `/v1/billing/subscriptions/${subscriptionId}/transactions${qs}`);
}

/**
 * Cancel a PayPal subscription.
 */
async function cancelSubscription(subscriptionId, reason) {
  return paypalRequest('POST', `/v1/billing/subscriptions/${subscriptionId}/cancel`, {
    reason: reason || 'Customer requested cancellation',
  });
}

// ── PPCP Merchant Onboarding ──────────────────────────────

/**
 * Create a PayPal Partner Referral for PPCP merchant onboarding.
 * Influencers complete this to become PayPal merchants — enables
 * money routing directly to them (brand → influencer, no KUP holding).
 * @param {string} trackingId - Our unique internal ID for this onboarding session
 * @param {string} returnUrl  - Where PayPal redirects after onboarding (receives merchantIdInPayPal param)
 * @returns {Promise<{ actionUrl: string, referralId: string }>}
 */
async function createPartnerReferral(trackingId, returnUrl) {
  const partnerId = process.env.PAYPAL_PARTNER_ID;
  if (!partnerId) {
    throw new Error('PAYPAL_PARTNER_ID not configured. Add it to your .env file.');
  }

  const result = await paypalRequest('POST', '/v2/customer/partner-referrals', {
    tracking_id: trackingId,
    operations: [
      {
        operation: 'API_INTEGRATION',
        api_integration_preference: {
          rest_api_integration: {
            integration_method: 'PAYPAL',
            integration_type: 'THIRD_PARTY',
            third_party_details: {
              features: ['PAYMENT', 'REFUND', 'PARTNER_FEE', 'ACCESS_MERCHANT_INFORMATION'],
            },
          },
        },
      },
    ],
    products: ['EXPRESS_CHECKOUT'],
    legal_consents: [{ type: 'SHARE_DATA_CONSENT', granted: true }],
    partner_config_override: { return_url: returnUrl },
  });

  const actionLink = result.links && result.links.find(l => l.rel === 'action_url');
  return {
    actionUrl: actionLink ? actionLink.href : null,
    referralId: result.id || null,
  };
}

/**
 * Check merchant onboarding status from PayPal.
 * Call after MERCHANT.ONBOARDING.COMPLETED webhook fires (or on return URL).
 * @param {string} merchantId - The PayPal merchant ID returned after onboarding
 * @returns {Promise<object>} Merchant integration details (payments_receivable, primary_email_confirmed, etc.)
 */
async function getMerchantStatus(merchantId) {
  const partnerId = process.env.PAYPAL_PARTNER_ID;
  if (!partnerId) {
    throw new Error('PAYPAL_PARTNER_ID not configured.');
  }
  return paypalRequest('GET', `/v1/customer/partners/${partnerId}/merchant-integrations/${merchantId}`);
}

/**
 * Check merchant onboarding status by tracking ID.
 * Useful when PayPal doesn't fire the return URL redirect (common in sandbox).
 * @param {string} trackingId - Our internal tracking ID from createPartnerReferral
 * @returns {Promise<object|null>} Merchant integration details or null if not found
 */
async function getMerchantStatusByTrackingId(trackingId) {
  const partnerId = process.env.PAYPAL_PARTNER_ID;
  if (!partnerId) throw new Error('PAYPAL_PARTNER_ID not configured.');
  try {
    return await paypalRequest('GET', `/v1/customer/partners/${partnerId}/merchant-integrations?tracking_id=${trackingId}`);
  } catch (err) {
    // PayPal returns 404 if merchant hasn't completed onboarding yet
    if (err.status === 404 || err.statusCode === 404) return null;
    throw err;
  }
}

// ── Order Helpers (Brand → Influencer Payments) ──────────

/**
 * Create a PayPal order for a brand-to-influencer payment.
 * With PPCP (merchantId provided): money routes directly to influencer.
 * KUP collects platformFee automatically via PayPal's partner fee mechanism.
 * Without PPCP (no merchantId): money goes to KUP's account (legacy mode).
 *
 * @param {number} amount        - Total amount brand pays (gross, includes all fees)
 * @param {string} description   - Payment description shown in PayPal
 * @param {string} returnUrl     - Redirect after brand approves payment
 * @param {string} cancelUrl     - Redirect if brand cancels
 * @param {string} [merchantId]  - Influencer's PayPal merchant ID (PPCP direct routing)
 * @param {number} [platformFee] - KUP's partner fee to collect (default $0.50)
 * @param {string} [customId]    - Our transaction ID (stored in PayPal for webhook lookup)
 */
async function createOrder(amount, description, returnUrl, cancelUrl, merchantId = null, platformFee = 0.50, customId = null) {
  const purchaseUnit = {
    amount: {
      currency_code: 'USD',
      value: amount.toFixed(2),
    },
    description,
  };

  // PPCP: route payment directly to influencer's PayPal merchant account.
  // KUP automatically receives platformFee as a partner fee — never touches the main payment.
  if (merchantId) {
    purchaseUnit.payee = { merchant_id: merchantId };
    purchaseUnit.payment_instruction = {
      disbursement_mode: 'INSTANT',
      platform_fees: [
        {
          amount: {
            currency_code: 'USD',
            value: platformFee.toFixed(2),
          },
        },
      ],
    };
  }

  // Store our transaction ID in custom_id so webhook handlers can find the record.
  if (customId) {
    purchaseUnit.custom_id = customId;
  }

  return paypalRequest('POST', '/v2/checkout/orders', {
    intent: 'CAPTURE',
    purchase_units: [purchaseUnit],
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

// ── Vault v3 — Save brand payment method for auto-capture ──────────────

/**
 * Create a Vault setup token. Brand visits the approve URL once to authorize
 * KUP to charge their PayPal for future content approval payments.
 * @param {string} returnUrl - Where PayPal redirects after brand approves
 * @param {string} cancelUrl - Where PayPal redirects if brand cancels
 * @returns {Promise<Object>} { id, approve_url, ... }
 */
async function createVaultSetupToken(returnUrl, cancelUrl) {
  return paypalRequest('POST', '/v3/vault/setup-tokens', {
    payment_source: {
      paypal: {
        usage_type: 'MERCHANT',
        experience_context: {
          return_url: returnUrl,
          cancel_url: cancelUrl,
          brand_name: 'KeepUsPostd',
          shipping_preference: 'NO_SHIPPING',
          landing_page: 'LOGIN',
          user_action: 'CONTINUE',
        },
      },
    },
  });
}

/**
 * Exchange a setup token for a permanent payment token after brand approves.
 * The payment_token can be used for future auto-captures without redirect.
 * @param {string} setupTokenId - The setup token ID from createVaultSetupToken
 * @returns {Promise<Object>} { id (payment_token), customer.id, ... }
 */
async function createVaultPaymentToken(setupTokenId) {
  return paypalRequest('POST', '/v3/vault/payment-tokens', {
    payment_source: {
      token: {
        id: setupTokenId,
        type: 'SETUP_TOKEN',
      },
    },
  });
}

/**
 * Create and immediately capture an order using a saved Vault payment token.
 * No brand redirect needed — payment is charged automatically.
 * @param {number} amount - Total amount brand pays (includes fees)
 * @param {string} description - Payment description
 * @param {string} vaultPaymentTokenId - Brand's saved payment token
 * @param {string} merchantId - Influencer's PPCP merchant ID
 * @param {number} platformFee - KUP platform fee ($0.50)
 * @param {string} customId - Transaction ID for webhook lookup
 * @returns {Promise<Object>} Order with capture result
 */
async function createOrderWithVault(amount, description, vaultPaymentTokenId, merchantId, platformFee = 0.50, customId = null) {
  const purchaseUnit = {
    amount: {
      currency_code: 'USD',
      value: amount.toFixed(2),
    },
    description,
  };

  // NOTE: PPCP payee + platform_fees cannot be combined with vault_id in a single order.
  // Vault orders charge the payer directly — KUP collects the full amount and pays out via Payouts API.
  if (customId) {
    purchaseUnit.custom_id = customId;
  }

  const orderPayload = {
    intent: 'CAPTURE',
    purchase_units: [purchaseUnit],
    payment_source: {
      paypal: {
        vault_id: vaultPaymentTokenId,
      },
    },
  };

  console.log(`💳 Vault order payload: ${JSON.stringify(orderPayload).substring(0, 300)}`);
  return paypalRequest('POST', '/v2/checkout/orders', orderPayload);
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
  getSubscriptionTransactions,
  cancelSubscription,

  // PPCP Merchant Onboarding
  createPartnerReferral,
  getMerchantStatus,
  getMerchantStatusByTrackingId,

  // Orders (brand → influencer payments, PPCP-enabled)
  createOrder,
  createOrderWithVault,
  captureOrder,
  getOrder,

  // Vault v3 (brand saved payment method)
  createVaultSetupToken,
  createVaultPaymentToken,

  // Payouts (KUP → influencer platform bonuses & cashouts)
  createPayout,
  getPayoutBatch,

  // Webhooks
  verifyWebhook,
};
