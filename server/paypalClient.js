import { createHash, randomUUID } from 'node:crypto';
import { TelemetryStore } from './telemetryStore.js';

export const PAYPAL_BASE_URL = 'https://api-m.sandbox.paypal.com';
export const SIMULATED = 'SANDBOX_SIMULATED';
export const LIVE = 'LIVE_PAYPAL_SANDBOX';
const SIMULATED_TIME = '2026-01-01T00:00:00Z';
const digest = (value) => createHash('sha256').update(value).digest('hex').toUpperCase();

export class PayPalError extends Error {
  constructor(message, { status = 502, body = null, debugId = null, fallbackEligible = false } = {}) {
    super(message);
    this.name = 'PayPalError';
    Object.assign(this, { status, body, debugId, fallbackEligible });
  }
}

export function money(value) {
  if (!['string', 'number'].includes(typeof value) || !/^\d+(\.\d{1,2})?$/.test(String(value))) {
    throw new PayPalError('Amount must be a positive USD value with at most two decimal places.', { status: 400 });
  }
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000) {
    throw new PayPalError('Amount must be between USD 0.01 and USD 1,000,000.', { status: 400 });
  }
  return amount.toFixed(2);
}

function requestId(value = randomUUID()) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,38}$/.test(value)) {
    throw new PayPalError('PayPal-Request-Id must contain 1–38 letters, numbers, underscores, or hyphens.', { status: 400 });
  }
  return value;
}

function orderId(value) {
  if (typeof value !== 'string' || !/^[A-Z0-9]{5,32}$/.test(value)) {
    throw new PayPalError('Invalid PayPal order ID.', { status: 400 });
  }
  return value;
}

export class PayPalClient {
  constructor({ env = process.env, telemetry = new TelemetryStore(), fetchImpl = globalThis.fetch, timeoutMs = 10000 } = {}) {
    if (env.PAYPAL_ENV && env.PAYPAL_ENV !== 'sandbox') throw new Error('Only PAYPAL_ENV=sandbox is supported.');
    this.telemetry = telemetry;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.clientId = env.PAYPAL_CLIENT_ID?.trim();
    this.clientSecret = env.PAYPAL_CLIENT_SECRET?.trim();
    this.fallbackReason = env.PAYPAL_SIMULATION === 'true' ? 'SIMULATION_REQUESTED'
      : (!this.clientId || !this.clientSecret ? 'CREDENTIALS_NOT_CONFIGURED' : null);
    this.verified = false;
    this.token = null;
    this.tokenPromise = null;
    this.simulatedToken = null;
    this.orders = new Map();
    this.idempotency = new Map();
  }

  get status() {
    return {
      environment: 'sandbox', baseUrl: PAYPAL_BASE_URL,
      mode: this.fallbackReason ? SIMULATED : LIVE,
      connection: this.fallbackReason ? 'SIMULATION_FALLBACK' : (this.verified ? 'CONNECTED' : 'NOT_VERIFIED'),
      fallbackReason: this.fallbackReason,
    };
  }

  async exchange(method, endpoint, headers, body) {
    const started = performance.now();
    let status = 0;
    let responseHeaders = {};
    let responseBody;
    let malformed = false;
    try {
      const response = await this.fetch(`${PAYPAL_BASE_URL}${endpoint}`, {
        method, headers, signal: AbortSignal.timeout(this.timeoutMs),
        ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      });
      status = response.status;
      responseHeaders = Object.fromEntries(response.headers.entries());
      const raw = await response.text();
      try { responseBody = raw ? JSON.parse(raw) : {}; }
      catch { responseBody = { message: raw }; malformed = true; }
    } catch {
      responseBody = { name: 'SANDBOX_UNREACHABLE', message: 'PayPal Sandbox could not be reached before the request deadline.' };
      status = 0;
    }
    const debugId = responseHeaders['paypal-debug-id'] ?? null;
    const entry = this.telemetry.record({
      method, endpoint, url: `${PAYPAL_BASE_URL}${endpoint}`, mode: LIVE,
      request: { headers, body: body ?? null },
      response: { status, headers: responseHeaders, body: responseBody }, latencyMs: performance.now() - started,
    });
    if (status < 200 || status >= 300 || malformed) {
      throw new PayPalError(responseBody?.message ?? 'PayPal rejected the request.', {
        status: status >= 400 && status < 500 ? status : 502, body: responseBody, debugId,
        fallbackEligible: status === 0 || status >= 500,
      });
    }
    this.verified = true;
    return { data: responseBody, mode: LIVE, simulated: false, httpStatus: status, debugId, telemetryId: entry.id };
  }

  async getAccessToken() {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    if (!this.tokenPromise) {
      this.tokenPromise = (async () => {
        const result = await this.exchange('POST', '/v1/oauth2/token', {
          Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json',
        }, 'grant_type=client_credentials');
        if (!result.data.access_token || !(result.data.expires_in > 0)) throw new PayPalError('PayPal returned an invalid OAuth response.');
        this.token = { value: result.data.access_token, expiresAt: Date.now() + Math.max(1, result.data.expires_in - 30) * 1000 };
        return this.token.value;
      })().finally(() => { this.tokenPromise = null; });
    }
    return this.tokenPromise;
  }

  simulate(method, endpoint, headers, body, build) {
    if (!this.simulatedToken) {
      this.simulatedToken = 'SIMULATED_ACCESS_TOKEN';
      this.telemetry.record({
        method: 'POST', endpoint: '/v1/oauth2/token', mode: SIMULATED, fallbackReason: this.fallbackReason,
        request: { headers: { Authorization: 'Basic simulated', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials' },
        response: { status: 200, headers: { 'paypal-debug-id': 'SIM-OAUTH' }, body: {
          scope: 'https://uri.paypal.com/services/payments/payment', access_token: this.simulatedToken,
          token_type: 'Bearer', app_id: 'APP-SIMULATED', expires_in: 32400,
        } },
      });
    }
    const started = performance.now();
    const debugId = `SIM-${digest(`${method}:${endpoint}:${headers['PayPal-Request-Id'] ?? ''}`).slice(0, 13)}`;
    let data;
    let failure;
    try { data = build(); } catch (error) { failure = error; }
    const status = failure ? failure.status : (method === 'POST' ? 201 : 200);
    const entry = this.telemetry.record({
      method, endpoint, url: `${PAYPAL_BASE_URL}${endpoint}`, mode: SIMULATED, fallbackReason: this.fallbackReason,
      request: { headers: { ...headers, Authorization: `Bearer ${this.simulatedToken}` }, body: body ?? null },
      response: { status, headers: { 'paypal-debug-id': debugId }, body: failure?.body ?? data ?? { message: failure?.message } },
      latencyMs: performance.now() - started,
    });
    if (failure) throw failure;
    return { data: structuredClone(data), mode: SIMULATED, simulated: true, httpStatus: status, debugId, telemetryId: entry.id, fallbackReason: this.fallbackReason };
  }

  async request(method, endpoint, { body, key, simulate, forceSimulation = false, allowFallback = false } = {}) {
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json', Prefer: 'return=representation' };
    if (key) headers['PayPal-Request-Id'] = requestId(key);
    if (forceSimulation || (allowFallback && this.fallbackReason)) return this.simulate(method, endpoint, headers, body, simulate);
    if (!this.clientId || !this.clientSecret) throw new PayPalError('Live order details require Sandbox credentials.');
    try {
      let token;
      try { token = await this.getAccessToken(); }
      catch (error) {
        if (error instanceof PayPalError && [400, 401].includes(error.status)) error.fallbackEligible = true;
        throw error;
      }
      try {
        return await this.exchange(method, endpoint, { ...headers, Authorization: `Bearer ${token}` }, body);
      } catch (error) {
        if (error.status !== 401) throw error;
        this.token = null;
        token = await this.getAccessToken();
        return await this.exchange(method, endpoint, { ...headers, Authorization: `Bearer ${token}` }, body);
      }
    } catch (error) {
      if (!allowFallback || !error.fallbackEligible) throw error;
      this.fallbackReason = [400, 401].includes(error.status) ? 'INVALID_CREDENTIALS' : 'SANDBOX_UNREACHABLE';
      return this.simulate(method, endpoint, headers, body, simulate);
    }
  }

  async once(operation, key, body, action) {
    const cacheKey = `${operation}:${key}`;
    const fingerprint = JSON.stringify(body);
    const cached = this.idempotency.get(cacheKey);
    if (cached) {
      if (cached.fingerprint !== fingerprint) throw new PayPalError('Idempotency key was already used with a different payload.', { status: 409 });
      return structuredClone(await cached.promise);
    }
    const promise = action();
    this.idempotency.set(cacheKey, { fingerprint, promise });
    try { return structuredClone(await promise); }
    catch (error) { this.idempotency.delete(cacheKey); throw error; }
  }

  createOrder({ amount, currency = 'USD', description = 'DealPact milestone', referenceId = 'milestone', returnUrl, cancelUrl, idempotencyKey } = {}) {
    if (currency !== 'USD') throw new PayPalError('This demo supports USD only.', { status: 400 });
    const key = requestId(idempotencyKey);
    const body = {
      intent: 'CAPTURE', purchase_units: [{ reference_id: referenceId, description: description.slice(0, 127), amount: { currency_code: currency, value: money(amount) } }],
    };
    if (returnUrl && cancelUrl) body.payment_source = { paypal: { experience_context: {
      brand_name: 'DealPact AI', shipping_preference: 'NO_SHIPPING', user_action: 'PAY_NOW', return_url: returnUrl, cancel_url: cancelUrl,
    } } };
    return this.once('createOrder', key, body, () => this.request('POST', '/v2/checkout/orders', {
      body, key, allowFallback: true,
      simulate: () => {
        const id = `SIM${digest(`${key}:${JSON.stringify(body)}`).slice(0, 14)}`;
        const order = {
          id, intent: 'CAPTURE', status: 'CREATED', purchase_units: structuredClone(body.purchase_units), create_time: SIMULATED_TIME,
          links: [
            { href: `${PAYPAL_BASE_URL}/v2/checkout/orders/${id}`, rel: 'self', method: 'GET' },
            { href: `https://www.sandbox.paypal.com/checkoutnow?token=${id}`, rel: 'approve', method: 'GET' },
            { href: `${PAYPAL_BASE_URL}/v2/checkout/orders/${id}/capture`, rel: 'capture', method: 'POST' },
          ],
        };
        this.orders.set(id, order);
        return order;
      },
    }));
  }

  getOrder(id) {
    orderId(id);
    return this.request('GET', `/v2/checkout/orders/${id}`, {
      forceSimulation: this.orders.has(id) || id.startsWith('SIM'),
      simulate: () => {
        const order = this.orders.get(id);
        if (!order) throw new PayPalError('Simulated order was not found.', { status: 404, body: { name: 'RESOURCE_NOT_FOUND' } });
        return order;
      },
    });
  }

  captureOrder(id, { idempotencyKey } = {}) {
    orderId(id);
    const key = requestId(idempotencyKey ?? `capture-${id}`);
    return this.once(`captureOrder:${id}`, key, {}, () => this.request('POST', `/v2/checkout/orders/${id}/capture`, {
      body: {}, key, forceSimulation: this.orders.has(id) || id.startsWith('SIM'),
      simulate: () => {
        const order = this.orders.get(id);
        if (!order) throw new PayPalError('Simulated order was not found.', { status: 404, body: { name: 'RESOURCE_NOT_FOUND' } });
        if (order.status === 'COMPLETED') return order;
        order.status = 'COMPLETED';
        order.update_time = '2026-01-01T00:00:01Z';
        const captureId = `SIM${digest(`capture:${id}`).slice(0, 14)}`;
        order.purchase_units[0].payments = { captures: [{
          id: captureId, status: 'COMPLETED', amount: structuredClone(order.purchase_units[0].amount), final_capture: true,
          create_time: order.update_time, update_time: order.update_time,
          links: [{ href: `${PAYPAL_BASE_URL}/v2/payments/captures/${captureId}`, rel: 'self', method: 'GET' }],
        }] };
        order.links = order.links.filter((link) => link.rel === 'self');
        return order;
      },
    }));
  }

  createDraftInvoice({ amount, description = 'DealPact milestone', recipientEmail, referenceId = 'milestone', idempotencyKey } = {}) {
    if (typeof recipientEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipientEmail) || recipientEmail.length > 254) {
      throw new PayPalError('A valid recipientEmail is required for a draft invoice.', { status: 400 });
    }
    const key = requestId(idempotencyKey);
    const body = {
      detail: { currency_code: 'USD', reference: referenceId, payment_term: { term_type: 'DUE_ON_RECEIPT' } },
      invoicer: { name: { given_name: 'DealPact', surname: 'AI' } },
      primary_recipients: [{ billing_info: { email_address: recipientEmail } }],
      items: [{ name: description.slice(0, 200), quantity: '1', unit_amount: { currency_code: 'USD', value: money(amount) } }],
    };
    return this.once('createDraftInvoice', key, body, async () => {
      const result = await this.request('POST', '/v2/invoicing/invoices', {
        body, key, allowFallback: true,
        simulate: () => {
          const id = `INV2-${digest(`${key}:${JSON.stringify(body)}`).slice(0, 16).match(/.{4}/g).join('-')}`;
          return { ...structuredClone(body), id, status: 'DRAFT', amount: { currency_code: 'USD', value: money(amount) }, links: [
            { href: `${PAYPAL_BASE_URL}/v2/invoicing/invoices/${id}`, rel: 'self', method: 'GET' },
            { href: `${PAYPAL_BASE_URL}/v2/invoicing/invoices/${id}/send`, rel: 'send', method: 'POST' },
          ] };
        },
      });
      // Invoicing can return only a HATEOAS link despite Prefer: return=representation.
      if (!result.data.id) {
        const href = result.data.href ?? result.data.links?.find((link) => link.rel === 'self')?.href;
        const id = href?.match(/\/v2\/invoicing\/invoices\/(INV2-[A-Z0-9-]+)(?:\?|$)/)?.[1];
        if (!id) throw new PayPalError('PayPal returned an invoice response without an invoice ID.');
        return this.request('GET', `/v2/invoicing/invoices/${id}`);
      }
      return result;
    });
  }
}
