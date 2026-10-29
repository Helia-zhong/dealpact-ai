import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../server/index.js';
import { AgentEngine, getScenarios, inspectArtifact } from '../server/agentEngine.js';
import { PayPalClient, PayPalError, SIMULATED, LIVE, PAYPAL_BASE_URL } from '../server/paypalClient.js';
import { TelemetryStore } from '../server/telemetryStore.js';

const offlineEnv = { PAYPAL_ENV: 'sandbox' };
const liveEnv = { PAYPAL_ENV: 'sandbox', PAYPAL_CLIENT_ID: 'test-client', PAYPAL_CLIENT_SECRET: 'test-secret' };
const noNetwork = async () => { throw new Error('Tests must not contact external services.'); };
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'paypal-debug-id': 'TEST-DEBUG', ...headers } });

async function harness(t, options = {}) {
  const app = createApp({ env: offlineEnv, fetchImpl: noNetwork, ...options });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve()); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (endpoint, body, expected = 200) => {
    const response = await fetch(`${base}${endpoint}`, { signal: AbortSignal.timeout(5000), ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
    const data = await response.json();
    assert.equal(response.status, expected, `${endpoint}: ${JSON.stringify(data)}`);
    return data;
  };
  return { app, call, base };
}

test('server entrypoint starts without an env file and serves the workbench and APIs', { timeout: 15000 }, async (t) => {
  const project = fileURLToPath(new URL('../', import.meta.url));
  const missingEnv = path.join(tmpdir(), `dealpact-${randomUUID()}`, '.env');
  const child = spawn(process.execPath, [`--env-file-if-exists=${missingEnv}`, 'server/index.js'], {
    cwd: project, windowsHide: true,
    env: { ...process.env, NODE_OPTIONS: '', PORT: '0', HOST: '127.0.0.1', PAYPAL_ENV: 'sandbox',
      PAYPAL_CLIENT_ID: '', PAYPAL_CLIENT_SECRET: '', OPENAI_API_KEY: '', PAYPAL_SIMULATION: 'true' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  t.after(async () => { if (child.exitCode === null) child.kill(); await closed; });
  let output = '';
  child.stderr.on('data', (chunk) => { output += chunk.toString(); });
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Startup timed out: ${output}`)), 10000);
    const fail = (error) => { clearTimeout(timer); reject(error); };
    child.once('error', fail);
    child.once('exit', (code) => fail(new Error(`Server exited (${code}): ${output}`)));
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const match = output.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  const health = await (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(5000) })).json();
  assert.equal(health.status, 'ok');
  assert.equal(health.paypal.mode, SIMULATED);
  assert.equal(health.agents.mode, 'DETERMINISTIC');
  const page = await fetch(base, { signal: AbortSignal.timeout(5000) });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Judge Auto-Pilot/);
  const { scenarios } = await (await fetch(`${base}/api/scenarios`, { signal: AbortSignal.timeout(5000) })).json();
  assert.equal(scenarios.length, 4);
});

test('frontend, bundled grid, and local fonts are served without a CDN', async (t) => {
  const { base } = await harness(t);
  for (const [endpoint, expected] of [['/', 'text/html'], ['/styles.css', 'text/css'], ['/app.js', 'javascript'], ['/vendor/ag-grid-community.min.js', 'javascript'], ['/vendor/dm-sans/dm-sans-latin-400-normal.woff2', 'font/woff2'], ['/vendor/ibm-plex-mono/ibm-plex-mono-latin-400-normal.woff2', 'font/woff2']]) {
    const response = await fetch(`${base}${endpoint}`);
    assert.equal(response.status, 200, endpoint);
    assert.ok(response.headers.get('content-type').includes(expected), endpoint);
  }
  const html = await (await fetch(base)).text();
  assert.ok(html.includes('PayPal Escrow &amp; Reconciliation Ledger'));
});

test('health, all four presets, and missing-credential fallback are available without network', async (t) => {
  const { call } = await harness(t);
  const health = await call('/api/health');
  assert.equal(health.paypal.mode, SIMULATED);
  assert.equal(health.agents.names.length, 3);
  assert.equal(health.agents.mode, 'DETERMINISTIC');
  const { scenarios } = await call('/api/scenarios');
  assert.equal(scenarios.length, 4);
  assert.deepEqual(scenarios.map((item) => item.budget), [4500, 3200, 6000, 2400]);
  assert.deepEqual(scenarios.map((item) => item.milestones.length), [3, 2, 3, 2]);
  scenarios.forEach((scenario) => assert.equal(scenario.milestones.reduce((sum, milestone) => sum + milestone.amount, 0), scenario.budget));
  await call('/api/missing', undefined, 404);
});

test('hosted checkout return links use the Render URL and honor an explicit origin override', async (t) => {
  for (const appOrigin of [undefined, 'https://demo.example.com']) {
    const renderOrigin = 'https://dealpact-example.onrender.com';
    const { call } = await harness(t, { env: { ...offlineEnv, RENDER_EXTERNAL_URL: renderOrigin, APP_BASE_URL: appOrigin } });
    await call('/api/negotiate', { scenarioId: 'saas-checkout-migration' }, 201);
    const { entries } = await call('/api/telemetry?source=PAYPAL&limit=500');
    const order = entries.find((entry) => entry.endpoint === '/v2/checkout/orders');
    const checkout = order.request.body.payment_source.paypal.experience_context;
    assert.equal(checkout.return_url, (appOrigin || renderOrigin) + '/api/paypal/return');
    assert.equal(checkout.cancel_url, (appOrigin || renderOrigin) + '/api/paypal/cancel');
  }
});

test('all preset executions produce the required scores and payment outcomes', async (t) => {
  const { call } = await harness(t);
  const migration = await call('/api/scenarios/saas-checkout-migration/run', {}, 201);
  assert.deepEqual(migration.audits.map((item) => item.audit.score), [94, 94, 94]);
  migration.audits.forEach((item) => { assert.equal(item.payment.status, 'RELEASED'); assert.equal(item.payment.order.mode, SIMULATED); });
  const localization = await call('/api/scenarios/cross-border-localization/run', {}, 201);
  localization.audits.forEach((item) => { assert.equal(item.audit.score, 89); assert.equal(item.payment.status, 'RELEASED'); assert.equal(item.milestone.invoice.data.status, 'DRAFT'); });
  const security = await call('/api/scenarios/smart-contract-security/run', {}, 201);
  security.audits.forEach((item) => {
    assert.equal(item.audit.score, 41);
    assert.equal(item.audit.decision, 'BLOCK');
    assert.equal(item.payment.status, 'PAYOUT_BLOCKED');
    if (item.milestone.id === 'M1') assert.equal(item.milestone.order.data.status, 'CREATED');
    else assert.equal(item.milestone.order, null);
    assert.ok(item.audit.findings.some((finding) => finding.code === 'SQL_INJECTION'));
    assert.ok(item.audit.findings.some((finding) => finding.code === 'REGEX_DOS'));
    assert.match(item.audit.remediationDiff, /WHERE name = \?/);
  });
  const mobile = await call('/api/scenarios/mobile-ui-kit/run', {}, 201);
  assert.deepEqual(mobile.pact.milestones.map((item) => item.escrowStatus), ['RELEASED', 'HELD']);
  const { summary } = await call('/api/milestones');
  assert.equal(summary.releasedAmount, 9140);
  assert.equal(summary.heldAmount, 6960);
  assert.equal(summary.auditPassRate, 60);
  const { entries } = await call('/api/telemetry?source=PAYPAL&limit=500');
  assert.ok(entries.some((entry) => entry.endpoint === '/v2/invoicing/invoices'));
  assert.ok(entries.some((entry) => entry.endpoint.endsWith('/capture')));
  assert.ok(entries.every((entry) => entry.mode === SIMULATED));
});

test('preset order payloads keep real contract amounts and the live approval bridge reconciles after 422', async (t) => {
  const simulated = await harness(t);
  const { pact } = await simulated.call('/api/negotiate', { scenarioId: 'saas-checkout-migration' }, 201);
  assert.deepEqual(pact.milestones.map((milestone) => milestone.amount), [1800, 1575, 1125]);
  const order = await simulated.call('/api/paypal/orders', { pactId: pact.id, milestoneId: 'M1' }, 201);
  assert.equal(order.data.purchase_units[0].amount.value, '1800.00');
  assert.equal(pact.milestones[0].estimatedHours, 24);

  let captureAttempts = 0;
  let referenceId = null;
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/oauth2/token')) return json({ access_token: 'bridge-token', expires_in: 3600 });
    if (url.endsWith('/capture')) {
      captureAttempts++;
      return json({ name: 'UNPROCESSABLE_ENTITY', details: [{ issue: 'ORDER_NOT_APPROVED' }] }, 422);
    }
    if (url.endsWith('/checkout/orders')) {
      referenceId = JSON.parse(options.body).purchase_units[0].reference_id;
      return json({ id: 'REALORDER123456789', status: 'CREATED', purchase_units: [{ reference_id: referenceId, amount: { currency_code: 'USD', value: '1800.00' } }], links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=REALORDER123456789' }] }, 201);
    }
    return json({ id: 'REALORDER123456789', status: 'CREATED', purchase_units: [{ reference_id: referenceId, amount: { currency_code: 'USD', value: '1800.00' } }], links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=REALORDER123456789' }] });
  };
  const live = await harness(t, { env: liveEnv, fetchImpl });
  const negotiated = await live.call('/api/negotiate', { scenarioId: 'saas-checkout-migration' }, 201);
  const result = await live.call('/api/qa-audit', { pactId: negotiated.pact.id, milestoneId: 'M1', usePreset: true }, 200);
  assert.equal(captureAttempts, 1);
  assert.equal(result.payment.status, 'RELEASED_SIMULATED');
  assert.equal(result.milestone.escrowStatus, 'RELEASED_SIMULATED');
  assert.match(result.payment.settlement.id, /^SIM-BRIDGE-/);
  const trace = await live.call('/api/telemetry?source=PAYPAL&limit=500');
  assert.equal(trace.entries.filter((entry) => entry.endpoint.endsWith('/capture')).length, 1);
  assert.ok(trace.entries.some((entry) => entry.endpoint === '/v2/checkout/orders/REALORDER123456789' && entry.status === 200));
});

test('QA gates capture, stores ownership, and prevents duplicate or altered milestone payments', async (t) => {
  const { call } = await harness(t);
  const { pact, messages } = await call('/api/negotiate', { scenarioId: 'saas-checkout-migration' }, 201);
  assert.equal(messages.length, 4);
  const input = { pactId: pact.id, milestoneId: 'M1' };
  const [order, duplicate] = await Promise.all([call('/api/paypal/orders', input, 201), call('/api/paypal/orders', input, 201)]);
  assert.equal(order.data.id, duplicate.data.id);
  assert.equal(order.data.purchase_units[0].amount.value, '1800.00');
  assert.equal((await call(`/api/paypal/orders/${order.data.id}`)).data.status, 'CREATED');
  await call('/api/paypal/orders', { ...input, amount: '0.01' }, 400);
  await call(`/api/paypal/orders/${order.data.id}/capture`, { passed: true, qaScore: 100 }, 409);
  await call(`/api/paypal/orders/${order.data.id}/capture`, { milestoneId: 'M2' }, 409);
  const audited = await call('/api/qa-audit', { ...input, usePreset: true, autoCapture: false });
  assert.equal(audited.audit.decision, 'PASS');
  const results = await Promise.all([call(`/api/paypal/orders/${order.data.id}/capture`, {}), call(`/api/paypal/orders/${order.data.id}/capture`, {})]);
  assert.equal(results[0].status, 'RELEASED');
  assert.deepEqual(results[0], results[1]);
  await call('/api/qa-audit', { ...input, usePreset: true }, 409);
  const telemetry = await call('/api/telemetry?source=PAYPAL&limit=500');
  assert.equal(telemetry.entries.filter((entry) => entry.endpoint.endsWith('/capture')).length, 1);
  assert.equal(telemetry.entries.filter((entry) => entry.endpoint === '/v2/checkout/orders').length, 1);
});

test('official toolkit schemas back four structured tools used by negotiation and QA release', async (t) => {
  const { call, app } = await harness(t);
  const catalog = await call('/api/paypal/tools');
  const names = ['paypal_create_order', 'paypal_get_order', 'paypal_capture_order', 'paypal_create_draft_invoice'];
  assert.equal(catalog.provider, '@paypal/agent-toolkit');
  assert.deepEqual(catalog.functions.map((tool) => tool.function.name), names);
  for (const [index, tool] of catalog.functions.entries()) {
    assert.equal(tool.function.strict, true);
    assert.equal(tool.function.parameters.additionalProperties, false);
    assert.deepEqual(catalog.mcpTools[index].inputSchema, tool.function.parameters);
    assert.ok(!Object.hasOwn(tool.function.parameters.properties, 'amount'));
  }
  const { pact, paymentPreparation } = await call('/api/negotiate', { scenarioId: 'cross-border-localization' }, 201);
  assert.equal(paymentPreparation.status, 'ORDER_CREATED');
  assert.equal(paymentPreparation.orderId, pact.milestones[0].order.data.id);
  const args = { pactId: pact.id, milestoneId: 'M1', orderId: paymentPreparation.orderId };
  const toolResult = await app.locals.services.paypalTools.handleToolCall({
    id: 'call-lookup', type: 'function', function: { name: 'paypal_get_order', arguments: JSON.stringify(args) },
  });
  assert.equal(toolResult.role, 'tool');
  assert.equal(toolResult.tool_call_id, 'call-lookup');
  assert.equal(JSON.parse(toolResult.content).data.id, args.orderId);
  const accepted = await call('/api/qa-audit', { pactId: pact.id, milestoneId: 'M1', usePreset: true });
  assert.equal(accepted.payment.status, 'RELEASED');
  const trace = (await call('/api/telemetry?source=AGENT&limit=500')).entries.filter((entry) => entry.method === 'TOOL');
  for (const name of names) assert.ok(trace.some((entry) => entry.endpoint === `/agent-tools/${name}` && entry.status === 200), name);
  assert.ok(trace.some((entry) => entry.request.body.toolkitTool === 'pay_order'));
  assert.ok(trace.every((entry) => entry.mode === 'PAYPAL_AGENT_TOOLKIT'));
});

test('structured tools reject forged amounts, unknown tools, foreign orders, and failed QA before capture', async (t) => {
  const { call, app } = await harness(t);
  const { pact } = await call('/api/negotiate', { scenarioId: 'smart-contract-security' }, 201);
  const tools = app.locals.services.paypalTools;
  const selection = { pactId: pact.id, milestoneId: 'M1' };
  const captureArgs = { ...selection, orderId: pact.milestones[0].order.data.id };
  for (const input of [null, [], '{broken', { ...selection, amount: '0.01' }, { pactId: pact.id }, { ...selection, milestoneId: '../M1' }]) {
    await assert.rejects(tools.execute('paypal_create_order', input), (error) => [400, 404].includes(error.status));
  }
  await assert.rejects(tools.execute('toString', selection), (error) => error.status === 400);
  await assert.rejects(tools.execute('paypal_capture_order', { ...captureArgs, instantSettlement: true }), (error) => error.status === 409);
  await assert.rejects(tools.execute('paypal_get_order', { ...captureArgs, milestoneId: 'M2' }), (error) => error.status === 409);
  await call('/api/qa-audit', { ...selection, usePreset: true });
  await assert.rejects(tools.execute('paypal_capture_order', { ...captureArgs, instantSettlement: true }), (error) => error.status === 409);
  const trace = (await call('/api/telemetry?limit=500')).entries;
  assert.equal(trace.filter((entry) => entry.source === 'PAYPAL' && entry.endpoint.endsWith('/capture')).length, 0);
  assert.ok(trace.some((entry) => entry.endpoint === '/agent-tools/paypal_capture_order' && entry.status === 409));
});

test('negotiation retains a retryable pact when the payment tool receives a provider error', async (t) => {
  let rejectOrder = true;
  const { call } = await harness(t, { env: liveEnv, fetchImpl: async (url) => {
    if (url.endsWith('/oauth2/token')) return json({ access_token: 'TOOL_PRIVATE_TOKEN', expires_in: 3600 });
    if (rejectOrder) return json({ message: 'Sandbox order temporarily rejected.' }, 422);
    return json({ id: 'REALORDER123456789', status: 'CREATED' }, 201);
  } });
  const result = await call('/api/negotiate', { scenarioId: 'saas-checkout-migration' }, 201);
  assert.equal(result.paymentPreparation.status, 'PAYMENT_ERROR');
  assert.equal(result.pact.milestones[0].order, null);
  assert.equal((await call(`/api/pacts/${result.pact.id}`)).pact.status, 'AGREED');
  rejectOrder = false;
  const order = await call('/api/paypal/orders', { pactId: result.pact.id, milestoneId: 'M1' }, 201);
  assert.equal(order.data.id, 'REALORDER123456789');
});

test('failed resubmission revokes a previous passing QA decision', async (t) => {
  const { call } = await harness(t);
  const { pact } = await call('/api/negotiate', { scenarioId: 'saas-checkout-migration' }, 201);
  const input = { pactId: pact.id, milestoneId: 'M1' };
  const order = await call('/api/paypal/orders', input, 201);
  await call('/api/qa-audit', { ...input, usePreset: true, autoCapture: false });
  const audit = await call('/api/qa-audit', { ...input, deliverable: 'export const incomplete = true;', autoCapture: false });
  assert.equal(audit.audit.passed, false);
  await call(`/api/paypal/orders/${order.data.id}/capture`, {}, 409);
});

test('HTTP telemetry correlates order, invoice, QA rejection, and capture without exposing credentials', async (t) => {
  const { call } = await harness(t);
  const { pact } = await call('/api/negotiate', { scenarioId: 'cross-border-localization' }, 201);
  const selection = { pactId: pact.id, milestoneId: 'M1' };
  const order = await call('/api/paypal/orders', selection, 201);
  await call(`/api/paypal/orders/${order.data.id}`);
  await call('/api/qa-audit', { ...selection, deliverable: 'export const deliveryStatus = "incomplete";' });
  await call(`/api/paypal/orders/${order.data.id}/capture`, {}, 409);
  const blocked = await call('/api/telemetry?limit=500');
  assert.ok(blocked.entries.some((entry) => entry.source === 'AGENT' && entry.response.body.decision === 'HOLD'));
  assert.ok(blocked.entries.some((entry) => entry.source === 'APPLICATION' && entry.endpoint.endsWith('/capture') && entry.status === 409));
  assert.equal(blocked.entries.filter((entry) => entry.source === 'PAYPAL' && entry.endpoint.endsWith('/capture')).length, 0);

  const accepted = await call('/api/qa-audit', { ...selection, usePreset: true });
  assert.equal(accepted.payment.status, 'RELEASED');
  const trace = await call('/api/telemetry?source=PAYPAL&limit=500');
  const creation = trace.entries.find((entry) => entry.id === order.telemetryId);
  assert.equal(creation.method, 'POST');
  assert.equal(creation.endpoint, '/v2/checkout/orders');
  assert.equal(creation.status, 201);
  assert.equal(creation.request.body.purchase_units[0].amount.value, '1920.00');
  assert.equal(creation.response.body.id, order.data.id);
  assert.equal(creation.debugId, order.debugId);
  assert.match(creation.request.headers['PayPal-Request-Id'], /^o-/);
  assert.ok(creation.links.some((link) => link.rel === 'approve' && link.href.includes(order.data.id)));
  assert.ok(creation.links.some((link) => link.rel === 'capture' && link.method === 'POST'));
  const invoice = trace.entries.find((entry) => entry.endpoint === '/v2/invoicing/invoices');
  assert.equal(invoice.response.body.status, 'DRAFT');
  assert.equal(invoice.request.body.items[0].unit_amount.value, '1920.00');
  const capture = trace.entries.find((entry) => entry.endpoint === `/v2/checkout/orders/${order.data.id}/capture`);
  assert.equal(capture.status, 201);
  assert.deepEqual(capture.request.body, {});
  assert.match(capture.request.headers['PayPal-Request-Id'], /^c-/);
  assert.equal(capture.response.body.status, 'COMPLETED');
  assert.ok(capture.links.some((link) => link.href.includes('/v2/payments/captures/')));
  for (const entry of trace.entries) {
    assert.equal(entry.mode, SIMULATED);
    assert.ok(Number.isFinite(entry.latencyMs) && entry.latencyMs >= 0);
    assert.equal(entry.request.headers.Authorization, '[REDACTED]');
    assert.ok(!Number.isNaN(Date.parse(entry.timestamp)));
  }
  const incremental = await call(`/api/telemetry?after=${blocked.cursor}&source=PAYPAL&limit=500`);
  assert.ok(incremental.entries.length > 0);
  assert.ok(incremental.entries.every((entry) => entry.id > blocked.cursor && entry.source === 'PAYPAL'));
  assert.ok(!JSON.stringify(trace).includes('SIMULATED_ACCESS_TOKEN'));
});

test('every preset and default custom milestone supports fail, remediate, and capture without bypassing QA', async (t) => {
  const { call, app } = await harness(t);
  const inputs = [...getScenarios().map((scenario) => ({ scenarioId: scenario.id })), { scope: 'Build a validated input service.', budget: 1000 }];
  for (const input of inputs) {
    const { pact } = await call('/api/negotiate', input, 201);
    for (const milestone of pact.milestones) {
      const selection = { pactId: pact.id, milestoneId: milestone.id };
      const { passing, failing } = milestone.deliverableVariants;
      const order = await call('/api/paypal/orders', selection, 201);
      const failed = await call('/api/qa-audit', { ...selection, deliverable: failing });
      assert.equal(failed.audit.passed, false);
      assert.equal(failed.payment.status, 'PAYOUT_BLOCKED');
      assert.match(failed.audit.remediationDiff, /^- /m);
      assert.match(failed.audit.remediationDiff, /^\+ /m);
      await call(`/api/paypal/orders/${order.data.id}/capture`, {}, 409);
      const captures = () => app.locals.services.telemetry.list({ source: 'PAYPAL', limit: 500 }).filter((event) => event.endpoint === `/v2/checkout/orders/${order.data.id}/capture`);
      assert.equal(captures().length, 0, 'Failed QA must never contact the PayPal capture endpoint.');
      const accepted = await call('/api/qa-audit', { ...selection, deliverable: passing, autoCapture: false });
      assert.equal(accepted.audit.passed, true, `${pact.title} / ${milestone.id}`);
      assert.equal(accepted.audit.benchmarkFixture, false);
      assert.equal(accepted.audit.artifactHash, createHash('sha256').update(passing.trim()).digest('hex'));
      assert.equal(accepted.audit.scoreBreakdown.passedChecks, accepted.audit.checks.length);
      assert.equal(accepted.audit.scoreBreakdown.finalScore, accepted.audit.score);
      const captured = await call(`/api/paypal/orders/${order.data.id}/capture`, {});
      assert.equal(captured.status, 'RELEASED');
      assert.ok(captured.order.data.purchase_units[0].payments.captures[0].id);
      assert.equal(captures().length, 1);
      await call('/api/qa-audit', { ...selection, deliverable: failing }, 409);
    }
  }
});

test('custom text and missing requirements produce review prescriptions and cannot release payout', async (t) => {
  const { call } = await harness(t);
  const { pact } = await call('/api/negotiate', { scenarioId: 'mobile-ui-kit' }, 201);
  for (const deliverable of ['Design handover: responsive screens are still pending.', 'export const designTokens = { spacing: 8 };']) {
    const result = await call('/api/qa-audit', { pactId: pact.id, milestoneId: 'M2', deliverable });
    assert.equal(result.audit.decision, 'HOLD');
    assert.equal(result.payment.status, 'PAYOUT_BLOCKED');
    assert.equal(result.milestone.order, null);
    assert.match(result.audit.remediationDiff, /Implement and test: Implement responsive screen layouts/);
    assert.ok(result.audit.scoreBreakdown.passedChecks < result.audit.scoreBreakdown.totalChecks);
  }
});

test('custom negotiations reconcile cents and evaluate submitted code rather than preset labels', async (t) => {
  const { call } = await harness(t);
  const { pact } = await call('/api/negotiate', { scope: 'Build an input validation service.', budget: '1000.01', timelineDays: 10, client: 'Acme', vendor: 'Studio' }, 201);
  assert.equal(pact.milestones.reduce((sum, item) => sum + Math.round(item.amount * 100), 0), 100001);
  assert.equal(pact.milestones.length, 3);
  const deliverable = `import test from 'node:test'; import assert from 'node:assert/strict';
    export function validate(input) { if (typeof input !== 'string') throw new Error('Invalid input'); return input.trim(); }
    test('rejects numbers', () => { assert.throws(() => validate(1)); assert.equal(validate('ok'), 'ok'); });`;
  const result = await call('/api/qa-audit', { pactId: pact.id, milestoneId: 'M1', deliverable });
  assert.equal(result.audit.passed, true);
  assert.equal(result.audit.benchmarkFixture, false);
  assert.equal(result.payment.status, 'RELEASED');
  await call('/api/qa-audit', { pactId: pact.id, milestoneId: 'M2', usePreset: true }, 400);
  const invoice = await call('/api/paypal/invoices', { pactId: pact.id, milestoneId: 'M1', recipientEmail: 'client@example.com' }, 201);
  assert.equal(invoice.data.status, 'DRAFT');
  assert.match(invoice.data.id, /^INV2-/);
  const stored = await call(`/api/pacts/${pact.id}`);
  assert.equal(stored.pact.milestones[0].escrowStatus, 'RELEASED');
});

test('invalid inputs, invalid JSON, missing resources, and oversized requests return JSON errors', async (t) => {
  const { call, base } = await harness(t);
  for (const budget of [-1, 0, '1.234', '1e3', null, {}, true]) await call('/api/negotiate', { scope: 'Build checkout.', budget }, 400);
  await call('/api/negotiate', {}, 400);
  await call('/api/negotiate', { scenarioId: 'unknown' }, 404);
  await call('/api/negotiate', { scope: 'Build checkout.', budget: 100, acceptanceCriteria: [] }, 400);
  await call('/api/telemetry?limit=-1', undefined, 400);
  await call('/api/telemetry?after=1.5', undefined, 400);
  await call('/api/paypal/orders', { pactId: 'missing', milestoneId: 'M1' }, 404);
  await call('/api/paypal/orders/SIMUNKNOWN', undefined, 404);
  const { pact } = await call('/api/negotiate', { scenarioId: 'mobile-ui-kit' }, 201);
  await call('/api/qa-audit', { pactId: pact.id, milestoneId: 'M1', usePreset: 'false' }, 400);
  await call('/api/qa-audit', { pactId: pact.id, milestoneId: 'M1', usePreset: true, deliverable: 'anything' }, 400);
  await call('/api/qa-audit', { pactId: pact.id, milestoneId: 'M1', deliverable: '' }, 400);
  for (const [body, status] of [['{broken', 400], [JSON.stringify({ scope: 'x'.repeat(300000) }), 413]]) {
    const response = await fetch(`${base}/api/negotiate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(response.status, status);
    assert.ok((await response.json()).error.message);
  }
});

test('PayPal simulation has deterministic IDs, idempotency conflicts, and schema-shaped order and capture payloads', async () => {
  const client = new PayPalClient({ env: offlineEnv, fetchImpl: noNetwork });
  const input = { amount: '12.34', idempotencyKey: 'fixed-request' };
  const first = await client.createOrder(input);
  const another = await new PayPalClient({ env: offlineEnv, fetchImpl: noNetwork }).createOrder(input);
  assert.equal(first.data.id, another.data.id);
  assert.deepEqual(first.data, another.data);
  assert.equal(first.mode, SIMULATED);
  assert.equal(first.data.intent, 'CAPTURE');
  assert.ok(first.data.links.some((link) => link.rel === 'approve'));
  await assert.rejects(client.createOrder({ ...input, amount: '99.00' }), (error) => error.status === 409);
  const captured = await client.captureOrder(first.data.id);
  assert.equal(captured.data.status, 'COMPLETED');
  assert.equal(captured.data.purchase_units[0].payments.captures[0].amount.value, '12.34');
  assert.deepEqual(await client.captureOrder(first.data.id), captured);
  const entries = client.telemetry.list();
  assert.equal(entries[0].endpoint, '/v1/oauth2/token');
  assert.equal(entries[0].response.body.access_token, '[REDACTED]');
  assert.ok(entries.every((entry) => entry.request.headers.Authorization === '[REDACTED]'));
});

test('live transport caches OAuth, sends idempotency headers, captures, and follows minimal invoice responses', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/oauth2/token')) return json({ access_token: 'PRIVATE_TOKEN', expires_in: 3600 });
    if (url.endsWith('/capture')) return json({ id: 'REALORDER123456789', status: 'COMPLETED' }, 201);
    if (url.endsWith('/checkout/orders')) return json({ id: 'REALORDER123456789', status: 'CREATED', links: [] }, 201);
    if (url.endsWith('/invoicing/invoices')) return json({ href: `${PAYPAL_BASE_URL}/v2/invoicing/invoices/INV2-TEST-TEST-TEST-TEST`, rel: 'self', method: 'GET' }, 201);
    if (url.includes('/invoicing/invoices/')) return json({ id: 'INV2-TEST-TEST-TEST-TEST', status: 'DRAFT' });
    return json({ id: 'REALORDER123456789', status: 'APPROVED' });
  };
  const client = new PayPalClient({ env: liveEnv, fetchImpl });
  const created = await client.createOrder({ amount: 20, idempotencyKey: 'create-123' });
  assert.equal(created.mode, LIVE);
  await client.getOrder(created.data.id);
  await client.captureOrder(created.data.id, { idempotencyKey: 'capture-123' });
  const invoice = await client.createDraftInvoice({ amount: 20, recipientEmail: 'buyer@example.com', idempotencyKey: 'invoice-123' });
  assert.equal(invoice.data.status, 'DRAFT');
  assert.equal(calls.filter((call) => call.url.endsWith('/oauth2/token')).length, 1);
  assert.equal(calls[0].options.body, 'grant_type=client_credentials');
  assert.equal(calls[0].options.headers.Authorization, `Basic ${Buffer.from('test-client:test-secret').toString('base64')}`);
  assert.equal(calls.find((call) => call.url.endsWith('/checkout/orders')).options.headers['PayPal-Request-Id'], 'create-123');
  assert.equal(calls.find((call) => call.url.endsWith('/capture')).options.headers['PayPal-Request-Id'], 'capture-123');
  assert.equal(client.status.connection, 'CONNECTED');
  const telemetry = client.telemetry.list({ limit: 500 });
  assert.equal(telemetry.length, calls.length);
  assert.ok(telemetry.every((entry) => entry.debugId === 'TEST-DEBUG' && entry.latencyMs >= 0));
  assert.ok(!JSON.stringify(telemetry).includes('PRIVATE_TOKEN'));
  assert.ok(!JSON.stringify(telemetry).includes('test-secret'));
});

test('OAuth refresh retries unauthorized API requests with the same idempotency key', async () => {
  let tokens = 0;
  let orders = 0;
  const keys = [];
  const client = new PayPalClient({ env: liveEnv, fetchImpl: async (url, options) => {
    if (url.endsWith('/oauth2/token')) return json({ access_token: `token-${++tokens}`, expires_in: 3600 });
    keys.push(options.headers['PayPal-Request-Id']);
    if (++orders === 1) return json({ message: 'Expired token' }, 401);
    return json({ id: 'REALORDER123456789', status: 'CREATED' }, 201);
  } });
  await client.createOrder({ amount: 20, idempotencyKey: 'refresh-request' });
  assert.equal(tokens, 2);
  assert.deepEqual(keys, ['refresh-request', 'refresh-request']);
});

// APIMatic Context Plugin review: inspect every request, error payload, and timeout separately.
test('provider error status, JSON details, and debug ID survive the HTTP error boundary', async (t) => {
  const requests = [];
  const providerError = { name: 'UNPROCESSABLE_ENTITY', message: 'The order amount is invalid.', details: [{ issue: 'AMOUNT_MISMATCH' }] };
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    if (url.endsWith('/oauth2/token')) return json({ access_token: 'PRIVATE_ERROR_TEST_TOKEN', expires_in: 3600 });
    return json(providerError, 422);
  };
  const client = new PayPalClient({ env: liveEnv, fetchImpl });
  await assert.rejects(client.createOrder({ amount: 20, idempotencyKey: 'provider-error' }), (error) => {
    assert.ok(error instanceof PayPalError);
    assert.equal(error.status, 422);
    assert.equal(error.debugId, 'TEST-DEBUG');
    assert.deepEqual(error.body, providerError);
    return true;
  });
  assert.deepEqual(requests.map((request) => new URL(request.url).pathname), ['/v1/oauth2/token', '/v2/checkout/orders']);
  assert.equal(requests[1].options.method, 'POST');
  assert.equal(JSON.parse(requests[1].options.body).purchase_units[0].amount.value, '20.00');

  const { call } = await harness(t, { paypalClient: client });
  const { pact } = await call('/api/negotiate', { scenarioId: 'saas-checkout-migration' }, 201);
  const failed = await call('/api/paypal/orders', { pactId: pact.id, milestoneId: 'M1' }, 422);
  assert.equal(failed.error.code, 'PAYPAL_ERROR');
  assert.equal(failed.error.debugId, 'TEST-DEBUG');
  assert.deepEqual(failed.error.details, providerError);
  assert.equal((await call(`/api/pacts/${pact.id}`)).pact.milestones[0].order, null);
  assert.ok(client.telemetry.list().every((entry) => entry.mode === LIVE));
  assert.ok(!JSON.stringify(client.telemetry.list()).includes('PRIVATE_ERROR_TEST_TOKEN'));
});

test('OAuth and order requests each have an effective timeout and record the failed attempt before fallback', { timeout: 3000 }, async () => {
  for (const stalledPath of ['/v1/oauth2/token', '/v2/checkout/orders']) {
    const requests = [];
    const client = new PayPalClient({ env: liveEnv, timeoutMs: 15, fetchImpl: async (url, options) => {
      requests.push({ path: new URL(url).pathname, signal: options.signal });
      if (new URL(url).pathname !== stalledPath) return json({ access_token: 'TIMEOUT_TEST_TOKEN', expires_in: 3600 });
      return new Promise((resolve, reject) => {
        const guard = setTimeout(() => reject(new Error('The request failed to abort.')), 500);
        const abort = () => { clearTimeout(guard); reject(options.signal.reason); };
        if (options.signal?.aborted) abort();
        else options.signal?.addEventListener('abort', abort, { once: true });
      });
    } });
    const order = await client.createOrder({ amount: 20, idempotencyKey: 'timeout-test' });
    assert.equal(order.mode, SIMULATED);
    assert.ok(requests.every((request) => request.signal instanceof AbortSignal));
    assert.equal(requests.find((request) => request.path === stalledPath).signal.aborted, true);
    const failure = client.telemetry.list().find((entry) => entry.mode === LIVE && entry.endpoint === stalledPath);
    assert.equal(failure.status, 0);
    assert.equal(failure.response.body.name, 'SANDBOX_UNREACHABLE');
    assert.ok(failure.id < order.telemetryId);
    assert.equal(requests.length, stalledPath.endsWith('/token') ? 1 : 2);
  }
});

test('network errors and invalid credentials fall back, but business errors and live captures never do', async () => {
  for (const failure of [async () => { throw new Error('offline'); }, async () => json({ error: 'invalid_client' }, 401), async () => json({ message: 'Unavailable' }, 503)]) {
    const client = new PayPalClient({ env: liveEnv, fetchImpl: failure });
    const result = await client.createOrder({ amount: 20, idempotencyKey: 'fallback-request' });
    assert.equal(result.mode, SIMULATED);
    assert.equal(client.status.mode, SIMULATED);
    assert.equal(client.telemetry.list()[0].mode, LIVE);
    assert.ok(client.telemetry.list().some((entry) => entry.mode === SIMULATED));
  }
  const client = new PayPalClient({ env: liveEnv, fetchImpl: async (url) => url.endsWith('/oauth2/token') ? json({ access_token: 'token', expires_in: 3600 }) : json({ name: 'UNPROCESSABLE_ENTITY', message: 'Buyer approval is required.' }, 422) });
  await assert.rejects(client.createOrder({ amount: 20 }), (error) => error.status === 422);
  await assert.rejects(client.captureOrder('REALORDER123456789'), (error) => error.status === 422);
  client.fetch = async () => { throw new Error('offline'); };
  await assert.rejects(client.captureOrder('REALORDER123456789'), (error) => error.status === 502);
  assert.ok(client.telemetry.list().every((entry) => entry.mode === LIVE));
});

test('live checkout waits for approval and does not release pending or incorrect captures', async (t) => {
  let approved = false;
  let captureState = 'PENDING';
  let captureAmount = '1800.00';
  let captures = 0;
  const fetchImpl = async (url) => {
    if (url.endsWith('/oauth2/token')) return json({ access_token: 'token', expires_in: 3600 });
    if (url.endsWith('/capture')) {
      captures++;
      return json({ id: 'REALORDER123456789', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAPTURE123', status: captureState, amount: { currency_code: 'USD', value: captureAmount } }] } }] }, 201);
    }
    return json({ id: 'REALORDER123456789', status: approved ? 'APPROVED' : 'CREATED', links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=REALORDER123456789' }] }, url.endsWith('/checkout/orders') ? 201 : 200);
  };
  const { call, app } = await harness(t, { env: liveEnv, fetchImpl });
  const { pact } = await call('/api/negotiate', { scenarioId: 'saas-checkout-migration' }, 201);
  const result = await call('/api/qa-audit', { pactId: pact.id, milestoneId: 'M1', usePreset: true, instantSettlement: false });
  assert.equal(result.payment.status, 'AWAITING_APPROVAL');
  assert.match(result.payment.approvalUrl, /sandbox.paypal.com/);
  assert.equal(captures, 0);
  approved = true;
  const pending = await call('/api/paypal/orders/REALORDER123456789/capture', {}, 202);
  assert.equal(pending.status, 'CAPTURE_PENDING');
  assert.equal(app.locals.services.pacts.get(pact.id).milestones[0].escrowStatus, 'CAPTURE_PENDING');
  await call('/api/qa-audit', { pactId: pact.id, milestoneId: 'M1', usePreset: true }, 409);
  captureState = 'COMPLETED'; captureAmount = '0.01';
  // Reconcile the provider's latest state without treating a wrong amount as a release.
  app.locals.services.paypal.fetch = async (url) => json({ id: 'REALORDER123456789', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAPTURE123', status: captureState, amount: { currency_code: 'USD', value: captureAmount } }] } }] });
  assert.equal((await call('/api/paypal/orders/REALORDER123456789/capture', {}, 202)).status, 'CAPTURE_PENDING');
  captureAmount = '1800.00';
  assert.equal((await call('/api/paypal/orders/REALORDER123456789/capture', {})).status, 'RELEASED');
  assert.equal(captures, 1);
});

test('OpenAI structured output enriches all agent roles and failures keep deterministic decisions', async () => {
  const calls = [];
  const engine = new AgentEngine({ env: { OPENAI_API_KEY: 'private-openai-key' }, telemetry: new TelemetryStore(), fetchImpl: async (url, options) => {
    const request = JSON.parse(options.body); calls.push(request);
    const advice = request.text.format.name && JSON.parse(request.input).task === 'negotiate'
      ? { buyer: 'Buyer budget analysis.', vendor: 'Vendor effort analysis.', auditor: 'Auditor acceptance requirements.' }
      : { summary: 'The security findings prevent payout.' };
    return json({ output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(advice) }] }] });
  } });
  const result = await engine.negotiate({ scenarioId: 'smart-contract-security' });
  assert.equal(result.agentMode, 'OPENAI');
  assert.equal(result.messages[0].content, 'Buyer budget analysis.');
  const audit = await engine.audit(result.pact, result.pact.milestones[0], { usePreset: true });
  assert.equal(audit.agentMode, 'OPENAI');
  assert.equal(audit.passed, false);
  assert.equal(audit.score, 41);
  assert.equal(calls[0].text.format.type, 'json_schema');
  assert.equal(calls[0].store, false);
  for (const failure of [noNetwork, async () => json({ error: 'invalid key' }, 401), async () => json({ output: [] })]) {
    engine.fetch = failure;
    const fallback = await engine.negotiate({ scenarioId: 'mobile-ui-kit' });
    assert.equal(fallback.agentMode, 'DETERMINISTIC');
    assert.equal(fallback.pact.budget, 2400);
  }
});

test('AST inspection does not execute code, count comments as evidence, or scan removed diff lines', () => {
  const criteria = [{ id: 'checkout', description: 'Implement checkout.', symbols: ['createOrder'] }];
  const commented = inspectArtifact('// createOrder test assert.equal\nexport const incomplete = true;', criteria);
  assert.equal(commented.passed, false);
  const invalid = inspectArtifact('export function broken(', criteria);
  assert.equal(invalid.passed, false);
  const patch = '--- a/code.js\n+++ b/code.js\n@@ -1 +1 @@\n-db.query("SELECT " + input);\n+export const safe = true;';
  assert.ok(!inspectArtifact(patch, criteria).findings.some((item) => item.code === 'SQL_INJECTION'));
  assert.equal(inspectArtifact('throw new Error("Never execute this artifact");', criteria).passed, false);
  const aliased = inspectArtifact('const sql = "SELECT * FROM users WHERE name = " + input; db.query(sql, []); new RegExp("^(a+)+$"); new Function(input);', criteria);
  assert.deepEqual(aliased.findings.map((finding) => finding.code), ['SQL_INJECTION', 'REGEX_DOS', 'DYNAMIC_EXECUTION']);
  assert.ok(!inspectArtifact('const sql = "SELECT * FROM users WHERE name = ?"; db.query(sql, [input]);', criteria).findings.some((finding) => finding.code === 'SQL_INJECTION'));
});

test('telemetry ring buffer redacts nested credentials, retains newest records, and isolates returned objects', () => {
  const store = new TelemetryStore(2);
  store.record({ response: { status: 200, body: { nested: { access_token: 'SECRET' } } } });
  store.record({ request: { headers: { Authorization: 'Bearer SECRET' } }, response: { status: 201, body: { links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow' }] } } });
  store.record({ source: 'AGENT', response: { status: 200, body: { client_secret: 'SECRET' } } });
  const snapshot = store.snapshot({ limit: 2 });
  assert.deepEqual(snapshot.entries.map((entry) => entry.id), [2, 3]);
  assert.equal(snapshot.cursor, 3);
  assert.equal(snapshot.entries[0].links[0].rel, 'approve');
  assert.ok(!JSON.stringify(snapshot).includes('SECRET'));
  snapshot.entries[0].response.status = 999;
  assert.equal(store.list()[0].response.status, 201);
  assert.equal(store.list({ after: 2 }).length, 1);
  assert.equal(store.list({ source: 'AGENT' }).length, 1);
});
