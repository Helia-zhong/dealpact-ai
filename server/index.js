import express from 'express';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AgentEngine, AGENTS, InputError, getScenarios, getScenario, textInput } from './agentEngine.js';
import { PayPalClient, PayPalError, money } from './paypalClient.js';
import { TelemetryStore, redact } from './telemetryStore.js';
import { PayPalAgentTools, PAYPAL_TOOL_DEFINITIONS, PAYPAL_MCP_TOOLS } from './paypalAgentTools.js';

const directory = path.dirname(fileURLToPath(import.meta.url));

export function createApp({ env = process.env, fetchImpl = globalThis.fetch, telemetry = new TelemetryStore(), paypalClient, agentEngine } = {}) {
  const app = express();
  const paypal = paypalClient ?? new PayPalClient({ env, telemetry, fetchImpl });
  const engine = agentEngine ?? new AgentEngine({ env, telemetry, fetchImpl });
  const pacts = new Map();
  const orderOwners = new Map();
  const locks = new Map();
  const baseUrl = env.APP_BASE_URL || env.RENDER_EXTERNAL_URL || `http://localhost:${env.PORT || 3000}`;
  const publicDirectory = path.resolve(directory, '../public');
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (req.method === 'POST') {
      if (!req.is('application/json')) throw new InputError('Use Content-Type: application/json.', 415);
      if (!req.body || Array.isArray(req.body) || typeof req.body !== 'object') throw new InputError('Request body must be a JSON object.');
      const started = performance.now();
      res.on('finish', () => telemetry.record({
        source: 'APPLICATION', method: req.method, endpoint: req.originalUrl,
        latencyMs: performance.now() - started,
        response: { status: res.statusCode, body: { pactId: req.body.pactId ?? null, milestoneId: req.body.milestoneId ?? null } },
      }));
    }
    next();
  });

  function getPact(id) {
    textInput(id, 'pactId', 100);
    const pact = pacts.get(id);
    if (!pact) throw new InputError('Pact was not found.', 404);
    return pact;
  }

  function pair(pactId, milestoneId) {
    const pact = getPact(pactId);
    textInput(milestoneId, 'milestoneId', 100);
    const milestone = pact.milestones.find((item) => item.id === milestoneId);
    if (!milestone) throw new InputError('Milestone was not found in this pact.', 404);
    return { pact, milestone };
  }

  function withMilestone(pactId, milestoneId, action) {
    const selected = pair(pactId, milestoneId);
    const key = `${pactId}:${milestoneId}`;
    const previous = locks.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(() => action(selected)).finally(() => {
      if (locks.get(key) === current) locks.delete(key);
    });
    locks.set(key, current);
    return current;
  }

  function validateBoolean(input, name) {
    if (input[name] !== undefined && typeof input[name] !== 'boolean') throw new InputError(`${name} must be a boolean.`);
  }

  function validatePaymentInput(input, milestone) {
    if (input.amount !== undefined && money(input.amount) !== money(milestone.amount)) throw new InputError('Order amount must match the agreed milestone amount.');
    if (input.currency !== undefined && input.currency !== 'USD') throw new InputError('This demo supports USD only.');
  }

  async function createOrder(pact, milestone) {
    if (!milestone.order) {
      milestone.order = await paypal.createOrder({
        amount: milestone.amount, description: milestone.title, referenceId: `${pact.id}:${milestone.id}`,
        idempotencyKey: `o-${pact.id.slice(0, 28)}-${milestone.id}`,
        returnUrl: `${baseUrl}/api/paypal/return`, cancelUrl: `${baseUrl}/api/paypal/cancel`,
      });
      if (!milestone.order.data?.id) { milestone.order = null; throw new PayPalError('PayPal returned an order without an ID.'); }
      orderOwners.set(milestone.order.data.id, { pactId: pact.id, milestoneId: milestone.id });
    }
    milestone.updatedAt = new Date().toISOString();
    return milestone.order;
  }

  async function createInvoice(pact, milestone, recipientEmail = pact.recipientEmail) {
    if (milestone.invoice && milestone.invoiceRecipient !== recipientEmail) throw new InputError('This milestone already has a draft invoice for another recipient.', 409);
    if (!milestone.invoice) {
      milestone.invoice = await paypal.createDraftInvoice({
        amount: milestone.amount, description: milestone.title, recipientEmail, referenceId: `${pact.id}:${milestone.id}`,
        idempotencyKey: `i-${pact.id.slice(0, 28)}-${milestone.id}`,
      });
      milestone.invoiceRecipient = recipientEmail;
    }
    return milestone.invoice;
  }

  function applyCapture(milestone, result) {
    const units = result.data.purchase_units ?? [];
    const captures = units.flatMap((unit) => unit.payments?.captures ?? []);
    const capturedCents = captures.filter((capture) => capture.status === 'COMPLETED' && capture.amount?.currency_code === 'USD')
      .reduce((sum, capture) => sum + Math.round(Number(capture.amount.value) * 100), 0);
    const completed = result.data.status === 'COMPLETED' && captures.length > 0 && captures.every((capture) => capture.status === 'COMPLETED') && capturedCents === Math.round(milestone.amount * 100);
    milestone.order = result;
    milestone.settlement = null;
    milestone.escrowStatus = completed ? 'RELEASED' : 'CAPTURE_PENDING';
    milestone.updatedAt = new Date().toISOString();
    return { status: completed ? 'RELEASED' : 'CAPTURE_PENDING', order: result };
  }

  function awaitingApproval(pact, milestone, current, instantSettlement) {
    const approvalUrl = current.data.links?.find((link) => ['approve', 'payer-action'].includes(link.rel))?.href ?? null;
    milestone.order = current;
    if (!instantSettlement) {
      milestone.escrowStatus = milestone.settlement ? 'RELEASED_SIMULATED' : 'AWAITING_APPROVAL';
      return { status: 'AWAITING_APPROVAL', approvalUrl, order: current };
    }
    const units = current.data.purchase_units ?? [];
    const verifiedAmount = units.length > 0 && units.every((unit) => unit.amount?.currency_code === 'USD'
      && unit.reference_id === `${pact.id}:${milestone.id}`)
      && units.reduce((sum, unit) => sum + Math.round(Number(unit.amount.value) * 100), 0) === Math.round(milestone.amount * 100);
    if (current.simulated || current.httpStatus !== 200 || !current.debugId || !verifiedAmount) {
      throw new PayPalError('Sandbox settlement requires a verified live order with the agreed reference and amount.', { status: 409 });
    }
    if (!milestone.settlement) {
      const receipt = {
        type: 'INSTANT_SANDBOX_SETTLEMENT_BRIDGE', mode: 'SANDBOX_SIMULATED', simulated: true,
        status: 'COMPLETED', providerCapture: false, orderId: current.data.id,
        pactId: pact.id, milestoneId: milestone.id, amount: money(milestone.amount), currency: 'USD',
        auditId: milestone.audit.id, artifactHash: milestone.audit.artifactHash,
        verification: { method: 'GET', endpoint: `/v2/checkout/orders/${current.data.id}`, httpStatus: current.httpStatus,
          debugId: current.debugId, telemetryId: current.telemetryId, providerStatus: current.data.status },
        createdAt: new Date().toISOString(),
        notice: 'Simulated settlement issued by DealPact AI after live order verification. PayPal has not captured this payment.',
      };
      const checksum = createHash('sha256').update(JSON.stringify(receipt)).digest('hex');
      milestone.settlement = { ...receipt, id: `SIM-BRIDGE-${checksum.slice(0, 20).toUpperCase()}`, checksum };
      telemetry.record({ source: 'APPLICATION', method: 'POST', endpoint: '/api/sandbox/settlement-bridge',
        mode: 'SANDBOX_SIMULATED', request: { body: { pactId: pact.id, milestoneId: milestone.id, orderId: current.data.id } },
        response: { status: 201, body: milestone.settlement } });
    }
    milestone.escrowStatus = 'RELEASED_SIMULATED';
    milestone.updatedAt = new Date().toISOString();
    return { status: 'RELEASED_SIMULATED', simulated: true, settlement: milestone.settlement, approvalUrl, order: current };
  }

  async function capture(pact, milestone, { instantSettlement = true } = {}) {
    if (!milestone.audit?.passed) throw new InputError('Capture is blocked: this milestone needs a passing QA audit.', 409);
    if (milestone.escrowStatus === 'RELEASED') return { status: 'RELEASED', order: milestone.order };
    const order = await createOrder(pact, milestone);
    if (!order.simulated) {
      const current = await paypal.getOrder(order.data.id);
      if (current.data.id !== order.data.id) throw new PayPalError('PayPal returned a different order ID.', { status: 409 });
      if (current.data.status === 'COMPLETED') return applyCapture(milestone, current);
      if (['CREATED', 'PAYER_ACTION_REQUIRED'].includes(current.data.status)) {
        if (!instantSettlement) return awaitingApproval(pact, milestone, current, false);
        try {
          return applyCapture(milestone, await paypal.captureOrder(order.data.id, { idempotencyKey: `c-${pact.id.slice(0, 28)}-${milestone.id}` }));
        } catch (error) {
          const unapproved = error.status === 422 && error.body?.details?.some((detail) => detail.issue === 'ORDER_NOT_APPROVED');
          if (!unapproved) throw error;
          const verified = await paypal.getOrder(order.data.id);
          if (['CREATED', 'PAYER_ACTION_REQUIRED'].includes(verified.data.status)) return awaitingApproval(pact, milestone, verified, true);
          if (verified.data.status === 'APPROVED') return applyCapture(milestone, await paypal.captureOrder(order.data.id, { idempotencyKey: `c-${pact.id.slice(0, 28)}-${milestone.id}` }));
          throw error;
        }
      }
      if (current.data.status !== 'APPROVED') throw new PayPalError('This order is not eligible for capture or a simulated settlement.', { status: 409 });
    }
    try {
      return applyCapture(milestone, await paypal.captureOrder(order.data.id, { idempotencyKey: `c-${pact.id.slice(0, 28)}-${milestone.id}` }));
    } catch (error) {
      const unapproved = error.status === 422 && error.body?.details?.some((detail) => detail.issue === 'ORDER_NOT_APPROVED');
      if (!order.simulated && unapproved) {
        const current = await paypal.getOrder(order.data.id);
        if (current.data.id === order.data.id && ['CREATED', 'PAYER_ACTION_REQUIRED'].includes(current.data.status)) {
          return awaitingApproval(pact, milestone, current, instantSettlement);
        }
      }
      throw error;
    }
  }

  async function auditMilestone(pact, milestone, input) {
    validateBoolean(input, 'usePreset');
    validateBoolean(input, 'autoCapture');
    validateBoolean(input, 'instantSettlement');
    if (['RELEASED', 'RELEASED_SIMULATED', 'CAPTURE_PENDING'].includes(milestone.escrowStatus)) throw new InputError('Released milestones and pending captures cannot be audited again.', 409);
    const audit = await engine.audit(pact, milestone, input);
    milestone.audit = audit;
    milestone.qaScore = audit.score;
    milestone.escrowStatus = audit.passed ? 'QA_PASSED' : (audit.decision === 'BLOCK' ? 'BLOCKED' : 'HELD');
    milestone.updatedAt = new Date().toISOString();
    return { audit, payment: { status: audit.passed ? 'READY_FOR_CAPTURE' : 'PAYOUT_BLOCKED' }, milestone: structuredClone(milestone) };
  }

  async function runAudit(pactId, milestoneId, input) {
    const result = await withMilestone(pactId, milestoneId, ({ pact, milestone }) => auditMilestone(pact, milestone, input));
    if (result.audit.passed && input.autoCapture !== false) {
      const { pact, milestone } = pair(pactId, milestoneId);
      try {
        result.payment = await engine.releaseEscrow(pact, milestone, { instantSettlement: input.instantSettlement ?? true });
      } catch (error) {
        if (!(error instanceof PayPalError)) throw error;
        if (milestone.audit?.id === result.audit.id) milestone.escrowStatus = 'PAYMENT_ERROR';
        result.payment = { status: 'PAYMENT_ERROR', error: error.message, debugId: error.debugId, retryable: true };
      }
    }
    result.milestone = structuredClone(pair(pactId, milestoneId).milestone);
    return result;
  }

  const paypalTools = new PayPalAgentTools({ withMilestone, telemetry, handlers: {
    paypal_create_order: createOrder,
    paypal_get_order: (pact, milestone, args) => paypal.getOrder(args.orderId),
    paypal_capture_order: capture,
    paypal_create_draft_invoice: (pact, milestone, args) => createInvoice(pact, milestone, args.recipientEmail ?? pact.recipientEmail),
  } });
  engine.paypalTools = paypalTools;
  engine.onPactAgreed = (pact) => pacts.set(pact.id, pact);

  app.get('/api/health', (req, res) => res.json({
    status: 'ok', service: 'DealPact AI', paypal: paypal.status,
    agents: { names: Object.values(AGENTS), mode: engine.apiKey ? 'OPENAI_WITH_DETERMINISTIC_FALLBACK' : 'DETERMINISTIC' },
    storage: 'IN_MEMORY',
  }));
  app.get('/api/scenarios', (req, res) => res.json({ scenarios: getScenarios() }));
  app.get('/api/paypal/tools', (req, res) => res.json({ provider: '@paypal/agent-toolkit', functions: PAYPAL_TOOL_DEFINITIONS, mcpTools: PAYPAL_MCP_TOOLS }));
  app.post('/api/negotiate', async (req, res) => {
    const result = await engine.negotiate(req.body);
    pacts.set(result.pact.id, result.pact);
    res.status(201).json(result);
  });
  app.get('/api/pacts/:id', (req, res) => res.json({ pact: getPact(req.params.id) }));
  app.get('/api/milestones', (req, res) => {
    const milestones = [...pacts.values()].flatMap((pact) => pact.milestones.map((milestone) => ({ ...milestone, pactId: pact.id, client: pact.client, vendor: pact.vendor })));
    const total = (rows) => Number(rows.reduce((sum, item) => sum + item.amount, 0).toFixed(2));
    const audited = milestones.filter((item) => item.audit);
    const released = (item) => ['RELEASED', 'RELEASED_SIMULATED'].includes(item.escrowStatus);
    const simulated = (item) => item.escrowStatus === 'RELEASED_SIMULATED' || item.order?.simulated;
    res.json({ milestones, summary: {
      heldAmount: total(milestones.filter((item) => !released(item))),
      releasedAmount: total(milestones.filter(released)),
      liveReleasedAmount: total(milestones.filter((item) => released(item) && !simulated(item))),
      simulatedReleasedAmount: total(milestones.filter((item) => released(item) && simulated(item))),
      activeMilestones: milestones.filter((item) => !released(item)).length,
      auditPassRate: audited.length ? Math.round(audited.filter((item) => item.audit.passed).length / audited.length * 100) : 0,
      currency: 'USD',
    } });
  });
  app.post('/api/paypal/orders', async (req, res) => {
    validatePaymentInput(req.body, pair(req.body.pactId, req.body.milestoneId).milestone);
    const result = await engine.invokePayPalTool('paypal_create_order', { pactId: req.body.pactId, milestoneId: req.body.milestoneId });
    res.status(201).json(result);
  });
  app.get('/api/paypal/orders/:id', async (req, res) => {
    const owner = orderOwners.get(req.params.id);
    if (!owner) throw new InputError('Order is not associated with an active pact.', 404);
    res.json(await engine.invokePayPalTool('paypal_get_order', { ...owner, orderId: req.params.id }));
  });
  app.post('/api/paypal/orders/:id/capture', async (req, res) => {
    validateBoolean(req.body, 'instantSettlement');
    const owner = orderOwners.get(req.params.id);
    if (!owner) throw new InputError('Order is not associated with an active pact.', 404);
    if ((req.body.pactId && req.body.pactId !== owner.pactId) || (req.body.milestoneId && req.body.milestoneId !== owner.milestoneId)) throw new InputError('Order does not belong to the specified milestone.', 409);
    const result = await engine.invokePayPalTool('paypal_capture_order', { ...owner, orderId: req.params.id, instantSettlement: req.body.instantSettlement ?? true });
    res.status(['RELEASED', 'RELEASED_SIMULATED'].includes(result.status) ? 200 : 202).json(result);
  });
  app.post('/api/paypal/invoices', async (req, res) => {
    validatePaymentInput(req.body, pair(req.body.pactId, req.body.milestoneId).milestone);
    const result = await engine.invokePayPalTool('paypal_create_draft_invoice', { pactId: req.body.pactId, milestoneId: req.body.milestoneId, recipientEmail: req.body.recipientEmail ?? null });
    res.status(201).json(result);
  });
  app.post('/api/qa-audit', async (req, res) => {
    const result = await runAudit(req.body.pactId, req.body.milestoneId, req.body);
    res.json(result);
  });
  app.post('/api/scenarios/:id/run', async (req, res) => {
    getScenario(req.params.id);
    validateBoolean(req.body, 'autoCapture');
    validateBoolean(req.body, 'instantSettlement');
    const result = await engine.negotiate({ scenarioId: req.params.id });
    pacts.set(result.pact.id, result.pact);
    const audits = [];
    for (const milestone of result.pact.milestones) {
      audits.push(await runAudit(result.pact.id, milestone.id, { usePreset: true, autoCapture: req.body.autoCapture, instantSettlement: req.body.instantSettlement }));
    }
    res.status(201).json({ ...result, audits });
  });
  app.get('/api/paypal/return', async (req, res) => {
    const id = textInput(req.query.token, 'token', 32);
    if (!orderOwners.has(id)) throw new InputError('Order is not associated with an active pact.', 404);
    res.json({ message: 'Buyer approval returned. POST to the capture endpoint after a passing QA audit.', captureEndpoint: `/api/paypal/orders/${id}/capture`, order: await paypal.getOrder(id) });
  });
  app.get('/api/paypal/cancel', (req, res) => res.json({ status: 'APPROVAL_CANCELLED', message: 'The buyer cancelled approval. No capture was requested.' }));
  app.get('/api/telemetry', (req, res) => {
    const after = Number(req.query.after ?? 0);
    const limit = Number(req.query.limit ?? 100);
    if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > telemetry.capacity) throw new InputError(`after must be nonnegative; limit must be between 1 and ${telemetry.capacity}.`);
    if (req.query.source && !['PAYPAL', 'AGENT', 'APPLICATION'].includes(req.query.source)) throw new InputError('Unknown telemetry source.');
    res.json(telemetry.snapshot({ after, limit, source: req.query.source }));
  });
  app.use('/api', (req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'API endpoint was not found.' } }));
  app.get('/vendor/ag-grid-community.min.js', (req, res) => res.sendFile('ag-grid-community.min.js', { root: path.resolve(directory, '../node_modules/ag-grid-community/dist') }));
  app.use('/vendor/dm-sans', express.static(path.resolve(directory, '../node_modules/@fontsource/dm-sans/files')));
  app.use('/vendor/ibm-plex-mono', express.static(path.resolve(directory, '../node_modules/@fontsource/ibm-plex-mono/files')));
  app.use(express.static(publicDirectory));
  app.get('/', (req, res) => {
    if (existsSync(path.join(publicDirectory, 'index.html'))) return res.sendFile(path.join(publicDirectory, 'index.html'));
    res.json({ service: 'DealPact AI backend', health: '/api/health', scenarios: '/api/scenarios', telemetry: '/api/telemetry' });
  });
  app.use((req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Resource was not found.' } }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status >= 400 && error.status <= 599 ? error.status : 500;
    const message = error.type === 'entity.parse.failed' ? 'Request body contains invalid JSON.'
      : error.type === 'entity.too.large' ? 'Request body exceeds the 256 KB limit.'
        : status === 500 ? 'An internal server error occurred.' : error.message;
    res.status(status).json({ error: { code: error instanceof PayPalError ? 'PAYPAL_ERROR' : 'REQUEST_ERROR', message, debugId: error.debugId ?? null, details: redact(error.body ?? null) } });
  });
  app.locals.services = { paypal, engine, paypalTools, telemetry, pacts };
  return app;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const app = createApp();
  const server = app.listen(port, host, () => {
    console.log(`DealPact AI backend listening at http://${host}:${server.address().port}`);
    console.log(`PayPal mode: ${app.locals.services.paypal.status.mode}`);
  });
  server.on('error', (error) => { console.error(`Server failed to start: ${error.message}`); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}
