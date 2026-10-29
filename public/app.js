'use strict';

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const usd = (value) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(Number(value) || 0);
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : ms));
const time = (value) => value ? new Date(value).toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
const isReleased = (row) => ['RELEASED', 'RELEASED_SIMULATED'].includes(row?.escrowStatus);
const state = {
  scenarios: [], selectedScenario: null, pact: null, milestoneId: 'M1', rows: [], health: null,
  ready: false, busy: false, customScope: false, agreementDirty: false, presetArtifact: true, filter: 'ALL',
  events: [], localEvents: [], cursor: 0, localSequence: 0, telemetrySource: 'ALL', focusedEvent: null,
  receipt: null, gridApi: null, gridLayout: null, polling: false, drafts: new Map(),
};
let toastTimer;
let searchTimer;

const scenarioLabels = {
  'saas-checkout-migration': ['Checkout migration', 'code', 'QA passes'],
  'cross-border-localization': ['AI localization', 'globe', 'Invoice + capture'],
  'smart-contract-security': ['Security audit', 'shield', 'Payout blocked'],
  'mobile-ui-kit': ['Mobile UI kit', 'phone', 'Partial release'],
};
const statuses = {
  HELD: ['Held', 'warning'], RELEASED: ['Released', 'success'], BLOCKED: ['Blocked', 'danger'],
  QA_PASSED: ['QA passed', 'info'], AWAITING_APPROVAL: ['Approval needed', 'warning'],
  CAPTURE_PENDING: ['Capture pending', 'warning'], PAYMENT_ERROR: ['Payment error', 'danger'],
  RELEASED_SIMULATED: ['Released · simulated', 'success'],
};
function badge(status) {
  const [label, color] = statuses[status] ?? [status ?? 'Draft', 'neutral'];
  return `<span class="status-badge ${color}"><span class="dot"></span>${escapeHtml(label)}</span>`;
}
function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}
function markup(html) {
  const element = document.createElement('div');
  element.innerHTML = html;
  return element;
}
function currentScenario() {
  return state.scenarios.find((scenario) => scenario.id === (state.pact ? state.pact.scenarioId : state.selectedScenario));
}
function currentMilestone() {
  return (state.pact ?? currentScenario())?.milestones.find((milestone) => milestone.id === state.milestoneId);
}
function selection() { return { pactId: state.pact?.id, milestoneId: state.milestoneId }; }
function draftKey(pactId = state.pact?.id ?? state.selectedScenario, milestoneId = state.milestoneId) { return `${pactId}:${milestoneId}`; }
function artifactDirty(row = currentMilestone()) {
  const draft = state.drafts.get(draftKey(row?.pactId ?? state.pact?.id ?? state.selectedScenario, row?.id));
  return Boolean(row?.audit && draft && draft.value.trim() !== draft.auditedValue);
}
function saveArtifact(source = 'custom') {
  const previous = state.drafts.get(draftKey());
  state.drafts.set(draftKey(), { value: $('#deliverable').value, filename: $('#filename').textContent, source, auditedValue: previous?.auditedValue ?? null });
  state.presetArtifact = source === 'preset';
  updateArtifactMeta();
}
function restoreArtifact() {
  let draft = state.drafts.get(draftKey());
  if (!draft) {
    const value = currentScenario()?.deliverables[state.milestoneId] ?? '';
    draft = { value, filename: 'deliverable.js', source: value ? 'preset' : 'custom', auditedValue: currentMilestone()?.audit?.benchmarkFixture ? value.trim() : null };
    state.drafts.set(draftKey(), draft);
  }
  $('#deliverable').value = draft.value;
  $('#filename').textContent = draft.filename;
  state.presetArtifact = draft.source === 'preset';
  updateArtifactMeta();
}
function notify(message, error = false) {
  clearTimeout(toastTimer);
  $('#toast').textContent = message;
  $('#toast').className = `toast${error ? ' error' : ''}`;
  $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, error ? 8000 : 4500);
}
function recordActivity(action, details = {}) {
  state.localEvents.push({ id: `ui-${++state.localSequence}`, timestamp: new Date().toISOString(), source: 'WORKBENCH', method: 'UI', endpoint: action, mode: 'LOCAL_ACTION', latencyMs: 0, response: { status: null, body: details }, request: { body: null }, links: [] });
  state.localEvents = state.localEvents.slice(-100);
  updateEventCounts();
  if ($('#inspector').open) renderTelemetry();
}
async function api(endpoint, body) {
  let response;
  try {
    response = await fetch(endpoint, { ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(60000) });
  } catch { throw new Error('The server could not be reached. Check the connection and retry.'); }
  const data = await response.json();
  if (!response.ok) throw new Error(data.error?.message ?? `Request failed (${response.status}).`);
  return data;
}

function updateConnection() {
  const info = state.health?.paypal;
  if (!info) return;
  const simulated = info.mode === 'SANDBOX_SIMULATED';
  const verified = info.connection === 'CONNECTED';
  $('#connection-status').className = `status-badge ${simulated ? 'warning' : 'success'}`;
  $('#connection-status').innerHTML = `<span class="status-dot"></span>${simulated ? 'SIMULATION FALLBACK' : verified ? 'LIVE PAYPAL SANDBOX' : 'SANDBOX CONFIGURED'}`;
  $('#connection-caption').textContent = simulated ? 'Deterministic demo · no real funds' : verified ? 'Connected to api-m.sandbox.paypal.com' : 'Connection verified on the first API call';
  $('#telemetry-mode').textContent = simulated ? 'SIMULATION' : 'SANDBOX';
}
function renderScenarios() {
  $('#scenario-pills').innerHTML = state.scenarios.map((scenario) => {
    const [label, symbol, outcome] = scenarioLabels[scenario.id];
    return `<button class="scenario-pill${state.selectedScenario === scenario.id ? ' selected' : ''}" data-scenario="${scenario.id}" aria-pressed="${state.selectedScenario === scenario.id}" title="${escapeHtml(scenario.title)}" ${state.busy ? 'disabled' : ''}><span class="scenario-icon">${icon(symbol)}</span><span class="scenario-text"><strong>${label}</strong><small><b>${usd(scenario.budget).replace('.00', '')}</b> · ${scenario.milestones.length} milestones<span class="scenario-outcome"> / ${outcome}</span></small></span></button>`;
  }).join('');
}
function selectScenario(id) {
  const scenario = state.scenarios.find((item) => item.id === id);
  if (!scenario) return;
  state.selectedScenario = id;
  state.pact = null;
  state.milestoneId = 'M1';
  state.customScope = false;
  state.agreementDirty = false;
  $('#scope').value = scenario.scope;
  $('#budget').value = scenario.budget;
  $('#timeline').value = scenario.timelineDays;
  $('#scope-kind').textContent = 'PRESET';
  $('#agent-status').innerHTML = '<span class="dot emerald"></span>Standing by';
  $('#conversation').innerHTML = `<div class="conversation-empty"><div class="orbit-mark">${icon('chat')}<span class="orbit-dot"></span></div><strong>Good work starts with a good agreement.</strong><p>Align scope, milestone budgets, and acceptance criteria<br>with your procurement, architect, and QA agents.</p><span class="empty-caption">BUYER <span>↔</span> VENDOR <span>→</span> QA AUDITOR</span></div>`;
  resetSteps();
  renderScenarios();
  renderPact();
  renderMilestone(true);
  updateControls();
}
function renderPact() {
  const pact = state.pact ?? currentScenario();
  if (!pact) return;
  $('#pact-status').textContent = state.pact ? `AGREED · ${pact.id.slice(0, 8)}` : 'Scenario preview';
  $('#pact-status').className = state.pact ? 'emerald-text' : 'muted';
  $('#pact-terms').textContent = state.pact ? '1% daily SLA penalty · 10% cap · QA-gated capture' : 'Acceptance first. Every milestone. Every payout.';
  $('#pact-milestones').style.gridTemplateColumns = `repeat(${pact.milestones.length}, minmax(0, 1fr))`;
  $('#pact-milestones').innerHTML = pact.milestones.map((milestone) => `<button class="pact-card ${milestone.id === state.milestoneId ? 'selected' : ''} ${milestone.escrowStatus?.toLowerCase() ?? ''}" data-milestone="${milestone.id}" aria-label="Select ${milestone.id}: ${escapeHtml(milestone.title)}" ${state.busy ? 'disabled' : ''}><div class="pact-card-top">${milestone.id}<small>DAY ${milestone.dueDays}</small></div><strong>${usd(milestone.amount).replace('.00', '')}</strong><span>${escapeHtml(milestone.title)}</span><div class="pact-card-bar"><i style="width:${Math.round(milestone.amount / pact.budget * 100)}%"></i></div></button>`).join('');
}
function loadPresetArtifact() {
  const artifact = currentScenario()?.deliverables[state.milestoneId];
  $('#deliverable').value = artifact ?? '';
  $('#filename').textContent = 'deliverable.js';
  saveArtifact(artifact ? 'preset' : 'custom');
  renderAudit(currentMilestone());
  renderPayment(currentMilestone());
}
function updateArtifactMeta() {
  const source = state.drafts.get(draftKey())?.source;
  $('#artifact-source').textContent = ({ preset: 'SCENARIO PRESET', passing: 'PASSING EXAMPLE', failing: 'FAILING EXAMPLE' })[source] ?? 'CUSTOM DELIVERABLE';
  $('#character-count').textContent = `${$('#deliverable').value.length.toLocaleString()} characters`;
  $$('[data-variant]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.variant === source)));
  const locked = isReleased(currentMilestone()) || currentMilestone()?.escrowStatus === 'CAPTURE_PENDING';
  $('#artifact-notice').textContent = locked ? 'This payment is finalized or pending. Start a new pact to audit another deliverable.' : artifactDirty() ? 'Deliverable changed. Run a new QA audit before capturing this payout.' : 'JavaScript is statically checked. Text-only evidence is held for manual review.';
  $('#artifact-notice').classList.toggle('amber-text', artifactDirty() && !locked);
}
function renderMilestone(loadArtifact = false) {
  const pact = state.pact ?? currentScenario();
  const milestone = currentMilestone();
  if (!pact || !milestone) return;
  $('#milestone-select').innerHTML = pact.milestones.map((item) => `<option value="${item.id}">${item.id} · ${escapeHtml(item.title)}</option>`).join('');
  $('#milestone-select').value = state.milestoneId;
  $('#milestone-amount').textContent = usd(milestone.amount);
  if (loadArtifact) restoreArtifact();
  else updateArtifactMeta();
  renderAudit(milestone);
  renderPayment(milestone);
  updateControls();
}
function renderAudit(milestone) {
  const audit = milestone.audit;
  const hold = $('#escrow-hold');
  const holding = Boolean(audit && !audit.passed);
  hold.hidden = !holding;
  if (holding && hold.dataset.auditId !== audit.id) {
    hold.dataset.auditId = audit.id;
    hold.innerHTML = `<span class="hold-icon">${icon('lock')}</span><div><strong>PayPal Escrow Hold Alert</strong><p>${usd(milestone.amount)} held · ${escapeHtml(milestone.id)} · Capture blocked</p><small>Resolve the findings below and run a new QA audit to release this gate.</small></div>`;
    hold.classList.remove('hold-enter');
    void hold.offsetWidth;
    hold.classList.add('hold-enter');
  }
  if (!audit) {
    $('#audit-result').innerHTML = `<div class="acceptance-header"><span class="eyebrow">ACCEPTANCE CRITERIA</span><span class="muted">Awaiting submission</span></div><ul class="check-list">${milestone.acceptanceCriteria.map((item) => `<li>${icon('shield')}<span>${escapeHtml(item.description)}</span></li>`).join('')}</ul>`;
    return;
  }
  const color = audit.passed ? 'var(--green)' : audit.decision === 'BLOCK' ? 'var(--red)' : 'var(--amber)';
  $('#audit-result').innerHTML = `<div class="audit-verdict"><div class="score-ring" style="--score-angle:${audit.score * 3.6}deg;--score-color:${color}"><strong>${audit.score}<small>/ 100</small></strong></div><div><h3 class="${audit.passed ? 'emerald-text' : audit.decision === 'BLOCK' ? 'crimson-text' : 'amber-text'}">${audit.passed ? 'Acceptance verified' : audit.decision === 'BLOCK' ? 'Security risk. Payout blocked.' : 'Incomplete delivery. Funds held.'}</h3><p>${escapeHtml(audit.summary)}</p></div></div><ul class="check-list">${audit.checks.map((check) => `<li class="${check.passed ? 'pass' : 'fail'}">${icon(check.passed ? 'check' : 'close')}<span>${escapeHtml(check.description)}</span></li>`).join('')}</ul>${audit.findings.length ? `<div class="audit-findings">${audit.findings.map((finding) => `<p class="finding"><strong>${escapeHtml(finding.code)}</strong>${finding.line ? ` · line ${finding.line}` : ''}<br>${escapeHtml(finding.message)}</p>`).join('')}</div>` : ''}${audit.remediationDiff ? `<details class="remediation" open><summary>Remediation diff prescription</summary><p>Review the suggested changes, then submit the corrected deliverable. This prescription is not an applied patch.</p><pre aria-label="Remediation diff">${audit.remediationDiff.split('\n').map((line) => `<span class="diff-line ${line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@') ? 'diff-context' : line.startsWith('+') ? 'diff-add' : line.startsWith('-') ? 'diff-remove' : ''}">${escapeHtml(line) || ' '}</span>`).join('')}</pre></details>` : ''}`;
}
function approvalUrl(order) {
  if (!order || order.simulated) return null;
  const href = order.data.links?.find((link) => ['approve', 'payer-action'].includes(link.rel))?.href;
  try {
    const url = new URL(href);
    return url.protocol === 'https:' && ['www.sandbox.paypal.com', 'sandbox.paypal.com'].includes(url.hostname) ? url.href : null;
  } catch { return null; }
}
function renderPayment(milestone) {
  const order = milestone.order;
  const paymentStatus = $('#payment-state');
  paymentStatus.textContent = order?.data.status ?? 'NO ORDER';
  paymentStatus.className = `status-badge ${milestone.escrowStatus === 'RELEASED' ? 'success' : order ? 'info' : 'neutral'}`;
  $('#payment-details').innerHTML = order ? `<div class="payment-info"><div><span>ORDER / ${order.simulated ? 'SIMULATED' : 'LIVE SANDBOX'}</span><button class="text-button" data-trace="${escapeHtml(order.data.id)}">${escapeHtml(order.data.id)} ${icon('external')}</button></div><div><span>${isReleased(milestone) ? 'SETTLED AMOUNT' : 'MILESTONE AMOUNT'}</span><strong>${usd(milestone.amount)}</strong></div>${milestone.invoice ? `<div><span>DRAFT INVOICE</span><button class="text-button" data-trace="${escapeHtml(milestone.invoice.data.id)}">${escapeHtml(milestone.invoice.data.id)}</button></div>` : ''}<div><span>QA GATE</span><span class="${milestone.audit?.passed ? 'emerald-text' : 'amber-text'}">${milestone.audit?.passed ? 'PASSED' : 'ACCEPTANCE REQUIRED'}</span></div></div>` : '<p class="muted">Create an order to connect this milestone to PayPal.</p>';
  if (milestone.settlement) {
    paymentStatus.textContent = 'COMPLETED · SIMULATED';
    paymentStatus.className = 'status-badge success';
    $('#payment-details').insertAdjacentHTML('beforeend', `<div class="settlement-bridge"><strong>Instant Sandbox Settlement Bridge</strong><p>Real order verified · settlement simulated. PayPal status: ${escapeHtml(order.data.status)}.</p><button class="text-button" data-trace="${escapeHtml(milestone.settlement.id)}">${escapeHtml(milestone.settlement.id)}</button><p>Approve below and capture again to replace this demo receipt with a PayPal capture.</p></div>`);
  }
  const approve = approvalUrl(order);
  $('#approve-order').hidden = !approve || milestone.escrowStatus === 'RELEASED';
  if (approve) $('#approve-order').href = approve;
  else $('#approve-order').removeAttribute('href');
}
function updateControls() {
  const milestone = currentMilestone();
  const editable = state.ready && !state.busy;
  const canAudit = Boolean(editable && !state.agreementDirty && state.pact && milestone && !isReleased(milestone) && milestone.escrowStatus !== 'CAPTURE_PENDING');
  for (const id of ['autopilot', 'negotiate', 'scope', 'budget', 'timeline', 'milestone-select']) $(`#${id}`).disabled = !editable;
  $('#deliverable').disabled = !editable || Boolean(state.pact && !canAudit);
  $('#upload').disabled = $('#deliverable').disabled;
  $('#load-preset').disabled = $('#deliverable').disabled || !currentScenario();
  $$('[data-variant]').forEach((button) => { button.disabled = $('#deliverable').disabled || !milestone?.deliverableVariants; });
  $('#run-audit').disabled = !canAudit || !$('#deliverable').value.trim();
  $('#run-audit').title = state.pact ? 'Audit this deliverable against the agreed acceptance criteria' : 'Negotiate a pact first';
  $('#create-order').disabled = !editable || state.agreementDirty || !state.pact || Boolean(milestone?.order);
  $('#capture-order').disabled = !editable || state.agreementDirty || artifactDirty() || !milestone?.order || !milestone?.audit?.passed || milestone.escrowStatus === 'RELEASED';
  $('#capture-order').title = artifactDirty() ? 'Deliverable changed. Run a new QA audit first.' : milestone?.audit?.passed ? 'Capture or reconcile the PayPal payment' : 'A passing QA audit is required';
  $('#export-certificate').disabled = !editable || !state.pact || !milestone?.audit;
  $('#inspect-payment').disabled = !milestone?.order;
  $('#auto-capture').disabled = state.busy;
  $('#instant-settlement').disabled = state.busy;
  $$('.scenario-pill, .pact-card').forEach((button) => { button.disabled = state.busy; });
  $('#autopilot').classList.toggle('busy-indicator', state.busy);
  state.gridApi?.refreshCells({ columns: ['actions', 'mobile'], force: true });
}
function setStep(index, status, detail) {
  const step = $(`[data-step="${index}"]`);
  step.className = status;
  if (detail) step.querySelector('small').textContent = detail;
}
function resetSteps() {
  ['Agree on a smart pact', 'PayPal Orders v2', 'AI acceptance checks', 'Capture after approval'].forEach((detail, index) => setStep(index, '', detail));
  $('#workflow-message').textContent = 'Ready when you are';
}
function syncSelectedProgress() {
  resetSteps();
  const milestone = currentMilestone();
  if (!state.pact || !milestone) return;
  setStep(0, 'done', `${state.pact.milestones.length} milestones agreed`);
  if (milestone.order) setStep(1, 'done', 'PayPal order linked');
  if (milestone.audit) setStep(2, milestone.audit.passed ? 'done' : 'warning', `${milestone.qaScore}/100 · ${milestone.audit.decision}`);
  if (isReleased(milestone)) setStep(3, 'done', milestone.settlement ? 'COMPLETED · simulated settlement' : 'COMPLETED · payout reconciled');
  else if (['BLOCKED', 'AWAITING_APPROVAL', 'CAPTURE_PENDING', 'PAYMENT_ERROR'].includes(milestone.escrowStatus) || (milestone.audit && !milestone.audit.passed)) {
    setStep(3, milestone.escrowStatus === 'PAYMENT_ERROR' ? 'error' : 'warning', statuses[milestone.escrowStatus]?.[0] ?? 'Payout held');
  }
  $('#workflow-message').textContent = `${milestone.id} · ${statuses[milestone.escrowStatus]?.[0] ?? 'Ready for delivery'}`;
}
async function refreshLedger() {
  const result = await api('/api/milestones');
  state.rows = result.milestones;
  const moneyHtml = (amount) => usd(amount).replace(/(\.\d{2})$/, '<span>$1</span>');
  $('#held-value').innerHTML = moneyHtml(result.summary.heldAmount);
  $('#released-value').innerHTML = moneyHtml(result.summary.releasedAmount);
  $('#released-caption').textContent = result.summary.simulatedReleasedAmount ? `${usd(result.summary.simulatedReleasedAmount)} simulated · ${usd(result.summary.liveReleasedAmount)} PayPal captures` : 'Reconciled through PayPal';
  $('#active-value').textContent = String(result.summary.activeMilestones).padStart(2, '0');
  const agreements = new Set(state.rows.map((row) => row.pactId)).size;
  $('#active-caption').textContent = agreements ? `Across ${agreements} smart ${agreements === 1 ? 'pact' : 'pacts'}` : 'No agreements started';
  const audits = state.rows.filter((row) => row.audit).length;
  $('#pass-value').innerHTML = `${audits ? result.summary.auditPassRate : '—'}<span>%</span>`;
  $('#pass-caption').textContent = audits ? `${state.rows.filter((row) => row.audit?.passed).length} of ${audits} milestones accepted` : 'Evidence before every payout';
  $('#pass-track').style.width = `${result.summary.auditPassRate}%`;
  $('#all-count').textContent = state.rows.length;
  $('#ledger-total').innerHTML = `Reconciled <strong>${usd(result.summary.releasedAmount)}</strong>${result.summary.simulatedReleasedAmount ? ` <span class="simulation-total">Includes ${usd(result.summary.simulatedReleasedAmount)} simulated</span>` : ''}`;
  state.gridApi?.setGridOption('rowData', state.rows);
  updateGridSummary();
  if (state.pact) {
    state.pact = (await api(`/api/pacts/${state.pact.id}`)).pact;
    renderPact();
    renderMilestone();
  }
}
async function perform(label, action) {
  if (state.busy) return;
  state.busy = true;
  updateControls();
  try { await action(); }
  catch (error) {
    recordActivity(`${label} failed`, { message: error.message });
    notify(error.message, true);
    $$('#workflow-steps li.active').forEach((step) => { step.className = 'error'; step.querySelector('small').textContent = 'Request failed · retry available'; });
    $('#workflow-message').textContent = `${label} needs attention`;
    $('#agent-status').innerHTML = '<span class="dot crimson"></span>Action failed';
  } finally {
    try {
      await refreshLedger();
      await pollTelemetry();
      state.health = await api('/api/health');
      updateConnection();
    } catch (error) { notify(error.message, true); }
    state.busy = false;
    updateControls();
  }
}
async function negotiate(forcePreset = false) {
  const scenario = state.scenarios.find((item) => item.id === state.selectedScenario);
  if (!forcePreset && (!$('#scope').value.trim() || !$('#budget').checkValidity() || !$('#timeline').checkValidity())) throw new Error('Enter a project scope, a valid budget, and a timeline from 3 to 365 days.');
  const payload = forcePreset || !state.customScope ? { scenarioId: scenario.id } : { scope: $('#scope').value, budget: $('#budget').value, timelineDays: Number($('#timeline').value) };
  $('#conversation').innerHTML = '<div class="typing">Agents are reviewing scope and delivery terms…</div>';
  $('#agent-status').innerHTML = '<span class="dot emerald"></span>Negotiating';
  setStep(0, 'active', 'Buyer ↔ Vendor ↔ Auditor');
  const result = await api('/api/negotiate', payload);
  state.pact = result.pact;
  $('#scope').value = result.pact.scope;
  $('#budget').value = result.pact.budget;
  $('#timeline').value = result.pact.timelineDays;
  state.agreementDirty = false;
  state.milestoneId = result.pact.milestones[0].id;
  if (!result.pact.scenarioId) saveArtifact('custom');
  $('#conversation').replaceChildren();
  for (const message of result.messages) {
    const article = node('article', `message ${message.role}`);
    article.innerHTML = `<span class="avatar ${message.role}">${message.role === 'buyer' ? 'B' : message.role === 'vendor' ? 'V' : 'Q'}</span><div class="message-body"><div class="message-meta"><strong>${escapeHtml(message.agent)}</strong><small>${String(message.sequence).padStart(2, '0')} / ${result.agentMode === 'OPENAI' ? 'AI' : 'RULES'}</small></div><p class="message-content">${escapeHtml(message.content)}</p></div>`;
    $('#conversation').append(article);
    $('#conversation').scrollTop = $('#conversation').scrollHeight;
    await sleep(240);
  }
  $('#agent-status').innerHTML = '<span class="dot emerald"></span>Agreement reached';
  renderPact();
  renderMilestone(Boolean(forcePreset || !state.customScope));
  setStep(0, 'done', `${result.pact.milestones.length} milestones agreed`);
  await refreshLedger();
  if (result.paymentPreparation?.status === 'PAYMENT_ERROR') notify(`Pact agreed. Order creation needs a retry: ${result.paymentPreparation.error}`, true);
  return result.pact;
}
async function makeOrder() {
  setStep(1, 'active', 'POST /v2/checkout/orders');
  const order = await api('/api/paypal/orders', selection());
  setStep(1, 'done', `${order.httpStatus} ${order.httpStatus === 201 ? 'Created' : 'OK'}${order.simulated ? ' · simulated' : ''}`);
  await refreshLedger();
  return order;
}
async function runAudit({ preset = state.presetArtifact, autoCapture = $('#auto-capture').checked } = {}) {
  setStep(2, 'active', `Auditing ${state.milestoneId}`);
  const result = await api('/api/qa-audit', { ...selection(), autoCapture, instantSettlement: $('#instant-settlement').checked, ...(preset ? { usePreset: true } : { deliverable: $('#deliverable').value }) });
  const draft = state.drafts.get(draftKey());
  if (draft) draft.auditedValue = (preset ? currentScenario().deliverables[state.milestoneId] : $('#deliverable').value).trim();
  setStep(2, result.audit.passed ? 'done' : 'warning', `${result.audit.score}/100 · ${result.audit.decision}`);
  if (autoCapture) showPaymentProgress(result.payment);
  await refreshLedger();
  return result;
}
function showPaymentProgress(payment) {
  if (isReleased({ escrowStatus: payment.status })) {
    setStep(3, 'done', payment.simulated ? 'COMPLETED · simulated settlement' : 'COMPLETED · payout reconciled');
    $('#workflow-message').textContent = payment.simulated ? 'Live order verified. Simulated settlement reconciled.' : 'Verified. Captured. Reconciled.';
  } else if (payment.status === 'PAYMENT_ERROR') {
    setStep(3, 'error', 'Payment error · retry required');
    $('#workflow-message').textContent = payment.error;
    notify(payment.error, true);
  } else {
    setStep(3, 'warning', payment.status === 'AWAITING_APPROVAL' ? 'Buyer approval required' : payment.status === 'CAPTURE_PENDING' ? 'Provider capture pending' : 'Payout safely held');
    $('#workflow-message').textContent = payment.status === 'AWAITING_APPROVAL' ? 'Approve in PayPal Sandbox, then capture.' : payment.status === 'CAPTURE_PENDING' ? 'Capture is pending. Reconcile before continuing.' : 'Acceptance gate protected this payout.';
  }
}
async function capturePayout() {
  const milestone = currentMilestone();
  if (!milestone?.order) throw new Error('Create a PayPal order first.');
  if (!milestone.audit?.passed || artifactDirty()) throw new Error('Capture blocked. Audit the current deliverable and resolve every failed check first.');
  setStep(3, 'active', 'Requesting PayPal capture');
  const result = await api(`/api/paypal/orders/${milestone.order.data.id}/capture`, { instantSettlement: $('#instant-settlement').checked });
  showPaymentProgress(result);
  await refreshLedger();
  return result;
}
async function autoPilot() {
  const scenarioId = state.selectedScenario ?? state.scenarios[0].id;
  selectScenario(scenarioId);
  $('#workflow-message').textContent = 'Auto-Pilot is negotiating your agreement…';
  await negotiate(true);
  for (const milestone of state.pact.milestones) {
    state.milestoneId = milestone.id;
    renderPact();
    renderMilestone(true);
    await makeOrder();
    await pollTelemetry();
    await sleep(220);
  }
  setStep(1, 'done', `${state.pact.milestones.length} PayPal orders created`);
  $('#workflow-message').textContent = 'Orders created. Checking every deliverable…';
  const auditResults = [];
  for (const milestone of state.pact.milestones) {
    state.milestoneId = milestone.id;
    renderPact();
    renderMilestone(true);
    auditResults.push(await runAudit({ preset: true, autoCapture: false }));
    await sleep(240);
  }
  const passed = auditResults.filter((result) => result.audit.passed).length;
  setStep(2, passed === auditResults.length ? 'done' : 'warning', `${passed}/${auditResults.length} milestones passed`);
  const firstPassing = state.pact.milestones.find((milestone) => milestone.audit?.passed);
  if (firstPassing) {
    const milestone = firstPassing;
    state.milestoneId = milestone.id;
    renderPact();
    renderMilestone(true);
    if (state.pact.requiresInvoice) await api('/api/paypal/invoices', selection());
    await capturePayout();
    await sleep(240);
  }
  await refreshLedger();
  const released = state.pact.milestones.filter(isReleased).length;
  const bridged = state.pact.milestones.filter((milestone) => milestone.settlement).length;
  const pending = state.pact.milestones.some((milestone) => ['AWAITING_APPROVAL', 'CAPTURE_PENDING'].includes(milestone.escrowStatus));
  const failed = state.pact.milestones.some((milestone) => milestone.escrowStatus === 'PAYMENT_ERROR');
  setStep(3, pending ? 'warning' : failed ? 'error' : released ? 'done' : 'warning', pending ? 'Waiting for buyer / provider' : `${released}/${state.pact.milestones.length} COMPLETED${bridged ? ' · simulated' : ''}`);
  $('#workflow-message').textContent = pending ? 'Approve in Sandbox, then capture the accepted milestones.' : failed ? 'Payment needs attention. Check the API trace.' : `${released} released · ${state.pact.milestones.length - released} held${bridged ? ` · ${bridged} simulated settlements after live order verification` : ''}`;
  state.milestoneId = state.pact.milestones.find((milestone) => !isReleased(milestone))?.id ?? 'M1';
  renderPact();
  renderMilestone(true);
  notify(pending ? 'QA passed. Buyer approval is required in PayPal Sandbox.' : `Auto-Pilot complete: ${released} released, ${state.pact.milestones.length - released} held.${bridged ? ' Settlement is simulated until PayPal buyer approval.' : ''}`);
}

function rowActions(row, mobile = false) {
  const group = node('div', 'row-actions');
  const actions = [
    ['order', 'wallet', 'Create PayPal Order', 'Order', Boolean(row.order)],
    ['audit', 'shield', 'Run QA Audit', 'Audit', isReleased(row) || row.escrowStatus === 'CAPTURE_PENDING'],
    ['capture', 'arrow', 'Capture Payout', 'Capture', !row.order || !row.audit?.passed || artifactDirty(row) || row.escrowStatus === 'RELEASED'],
    ['receipt', 'receipt', 'Receipt', 'Receipt', false],
  ];
  for (const [action, symbol, label, shortLabel, disabled] of actions) {
    const button = node('button');
    button.type = 'button'; button.title = label; button.setAttribute('aria-label', `${label} · ${row.id} · ${row.client}`);
    button.innerHTML = icon(symbol) + (mobile ? `<span>${shortLabel}</span>` : '');
    button.disabled = state.busy || disabled;
    button.addEventListener('click', (event) => { event.stopPropagation(); handleRowAction(action, row); });
    group.append(button);
  }
  return group;
}
function traceLink(value) {
  if (!value) return node('span', 'muted', '—');
  const button = node('button', 'grid-link', value);
  button.type = 'button'; button.title = `Inspect ${value}`;
  button.addEventListener('click', (event) => { event.stopPropagation(); openInspector(value); });
  return button;
}
function scoreRenderer(row) {
  if (row.qaScore === null || row.qaScore === undefined) return node('span', 'muted', 'Awaiting QA');
  const cell = node('div', 'score-cell');
  const color = row.audit?.passed ? 'var(--green)' : row.escrowStatus === 'BLOCKED' ? 'var(--red)' : 'var(--amber)';
  cell.innerHTML = `<span class="score-bar"><span style="width:${row.qaScore}%;background:${color}"></span></span><span style="color:${color}">${row.qaScore}</span>`;
  cell.setAttribute('aria-label', `QA score ${row.qaScore} out of 100`);
  return cell;
}
function mobileRenderer(params) {
  const row = params.data;
  if (params.node.rowPinned) return node('strong', 'grid-money', `VISIBLE TOTAL · ${usd(row.amount)}`);
  const card = node('article', 'mobile-ledger-card');
  card.innerHTML = `<header><span class="grid-id">${row.id} / ${row.pactId.slice(0, 6)}</span>${badge(row.escrowStatus)}<strong class="grid-money">${usd(row.amount)}</strong></header><h3>${escapeHtml(row.title)}</h3><p>${escapeHtml(row.client)} ↔ ${escapeHtml(row.vendor)}</p><div class="mobile-ledger-meta"><div class="mobile-payment"></div><div class="mobile-qa"></div></div><p>${escapeHtml(row.agentTool ?? 'No payment tool yet')} · ${time(row.updatedAt)}</p>`;
  card.querySelector('.mobile-payment').append(traceLink(row.order?.data.id), traceLink(row.invoice?.data.id), traceLink(row.order?.debugId));
  card.querySelector('.mobile-qa').append(scoreRenderer(row));
  card.append(rowActions(row, true));
  return card;
}
function columns(layout) {
  const wide = layout === 'wide';
  const medium = layout === 'medium';
  const defs = [
    { field: 'id', headerName: 'Milestone ID', flex: .6, minWidth: 56, cellRenderer: (p) => p.node.rowPinned ? 'TOTAL' : markup(`<div class="grid-double"><strong class="grid-id">${p.value}</strong><small>${p.data.pactId.slice(0, 6)}</small></div>`) },
    { colId: 'parties', headerName: 'Client & Vendor', flex: 1, minWidth: 100, hide: !wide && !medium, valueGetter: (p) => p.node.rowPinned ? '' : `${p.data.client} / ${p.data.vendor}`, cellRenderer: (p) => p.node.rowPinned ? '' : markup(`<div class="grid-double"><strong>${escapeHtml(p.data.client)}</strong><small>${escapeHtml(p.data.vendor)}</small></div>`) },
    { field: 'title', headerName: 'Deliverable Scope', flex: 1.6, minWidth: 130, cellClass: 'grid-scope' },
    { field: 'amount', headerName: 'Amount (USD)', flex: .8, minWidth: 80, valueFormatter: (p) => usd(p.value), cellClass: 'grid-money' },
    { colId: 'order', headerName: 'PayPal Order / Invoice', flex: 1.2, minWidth: 135, valueGetter: (p) => p.node.rowPinned ? '' : [p.data.order?.data.id, p.data.invoice?.data.id].filter(Boolean).join(' / '), cellRenderer: (p) => { const cell = node('div', 'grid-double'); if (!p.node.rowPinned) { cell.append(traceLink(p.data.order?.data.id)); if (p.data.invoice) cell.append(traceLink(p.data.invoice.data.id)); } return cell; } },
    { field: 'escrowStatus', headerName: 'Escrow Status', flex: 1, minWidth: 100, cellRenderer: (p) => p.node.rowPinned ? '' : markup(badge(p.value)) },
    { field: 'qaScore', headerName: 'AI QA Score', flex: .7, minWidth: 72, cellRenderer: (p) => p.node.rowPinned ? '' : scoreRenderer(p.data) },
    { field: 'agentTool', headerName: 'Agent Tool', flex: 1.1, minWidth: 126, cellClass: 'grid-tool', valueFormatter: (p) => p.node.rowPinned ? '' : p.value ?? '—' },
    { colId: 'debug', headerName: 'PayPal Debug ID', flex: 1, minWidth: 104, valueGetter: (p) => p.data.order?.debugId ?? '', cellRenderer: (p) => p.node.rowPinned ? '' : traceLink(p.value) },
    { field: 'updatedAt', headerName: 'Updated At', flex: .7, minWidth: 80, hide: !wide, valueFormatter: (p) => p.node.rowPinned ? '' : time(p.value), cellClass: 'grid-id' },
    { colId: 'actions', headerName: 'Quick Actions', flex: .9, minWidth: 104, sortable: false, resizable: false, cellRenderer: (p) => p.node.rowPinned ? '' : rowActions(p.data), getQuickFilterText: () => '' },
  ];
  if (layout === 'mobile') {
    defs.forEach((definition) => { definition.hide = true; });
    defs.push({ colId: 'mobile', headerName: 'Milestones & payment actions', flex: 1, minWidth: 0, sortable: false, resizable: false, cellRenderer: mobileRenderer, getQuickFilterText: () => '' });
  }
  return defs.map((definition) => ({ hide: false, ...definition }));
}
function filterRow(row) {
  if (state.filter === 'ALL') return true;
  if (state.filter === 'HELD') return !isReleased(row) && row.escrowStatus !== 'BLOCKED';
  if (state.filter === 'RELEASED') return isReleased(row);
  return row.escrowStatus === state.filter;
}
function updateGridSummary() {
  if (!state.gridApi) return;
  let count = 0;
  let cents = 0;
  state.gridApi.forEachNodeAfterFilter((row) => { if (row.data) { count++; cents += Math.round(row.data.amount * 100); } });
  state.gridApi.setGridOption('pinnedBottomRowData', [{ id: 'TOTAL', amount: cents / 100, title: `${count} visible milestones`, escrowStatus: '', qaScore: null }]);
  $('#ledger-count').textContent = `${count} of ${state.rows.length} milestones`;
}
function setupGrid() {
  if (!window.agGrid) throw new Error('AG Grid could not load. Run npm install, then restart the server.');
  const theme = agGrid.themeQuartz.withParams({
    backgroundColor: '#0f1521', foregroundColor: '#b8cbe4', borderColor: '#223149', headerBackgroundColor: '#101a29', headerTextColor: '#8099bb',
    rowHoverColor: '#152236', oddRowBackgroundColor: '#101925', accentColor: '#0070BA', selectedRowBackgroundColor: '#112b40',
    fontFamily: 'DM Sans, Segoe UI, sans-serif', fontSize: 11, cellHorizontalPadding: 12, headerHeight: 40, rowHeight: 66,
    wrapperBorder: false, wrapperBorderRadius: 0, browserColorScheme: 'dark',
  });
  state.gridApi = agGrid.createGrid($('#ledger-grid'), {
    theme, domLayout: 'autoHeight', columnDefs: columns('wide'), rowData: [], getRowId: (p) => p.data.pactId ? `${p.data.pactId}:${p.data.id}` : 'summary',
    defaultColDef: { sortable: true, unSortIcon: true, wrapHeaderText: true, autoHeaderHeight: true, resizable: false, suppressMovable: true, cellDataType: false, suppressHeaderMenuButton: true },
    includeHiddenColumnsInQuickFilter: true, animateRows: !matchMedia('(prefers-reduced-motion: reduce)').matches,
    isExternalFilterPresent: () => state.filter !== 'ALL', doesExternalFilterPass: (row) => filterRow(row.data),
    onFilterChanged: updateGridSummary,
    onSortChanged: () => recordActivity('Ledger columns sorted'),
    onRowClicked: (event) => { if (!event.node.rowPinned && !state.busy && !event.event.target.closest('button')) handleRowAction('select', event.data); },
    getRowHeight: (p) => p.node.rowPinned ? 38 : state.gridLayout === 'mobile' ? 228 : 66,
    overlayNoRowsTemplate: '<div class="grid-empty"><strong>Your next agreement starts above.</strong>Negotiate a pact or run Auto-Pilot to populate the ledger.</div>',
  });
  new ResizeObserver(([entry]) => {
    const width = entry.contentRect.width;
    const layout = width < 950 ? 'mobile' : width < 1100 ? 'compact' : width < 1280 ? 'medium' : 'wide';
    if (layout === state.gridLayout) return;
    state.gridLayout = layout;
    state.gridApi.setGridOption('columnDefs', columns(layout));
    state.gridApi.resetRowHeights();
    updateGridSummary();
  }).observe($('#ledger-grid'));
}
async function focusRow(row) {
  const switchedPact = state.pact?.id !== row.pactId;
  const sameMilestone = state.pact?.id === row.pactId && state.milestoneId === row.id;
  if (state.pact?.id !== row.pactId) state.pact = (await api(`/api/pacts/${row.pactId}`)).pact;
  state.selectedScenario = state.pact.scenarioId;
  state.milestoneId = row.id;
  state.customScope = !state.pact.scenarioId;
  state.agreementDirty = false;
  $('#scope').value = state.pact.scope;
  $('#budget').value = state.pact.budget;
  $('#timeline').value = state.pact.timelineDays;
  $('#scope-kind').textContent = state.customScope ? 'CUSTOM' : 'PRESET';
  if (switchedPact) {
    $('#conversation').innerHTML = `<div class="conversation-empty"><div class="orbit-mark">${icon('receipt')}</div><strong>Existing agreement loaded</strong><p>${escapeHtml(state.pact.client)} ↔ ${escapeHtml(state.pact.vendor)}</p><p>${usd(state.pact.budget)} across ${state.pact.milestones.length} agreed milestones.<br>Select a milestone to review its delivery and payment.</p><span class="empty-caption">PACT ${state.pact.id.slice(0, 8)}</span></div>`;
    $('#agent-status').innerHTML = '<span class="dot emerald"></span>Agreement loaded';
  }
  renderScenarios(); renderPact(); renderMilestone(!sameMilestone);
  syncSelectedProgress();
}
function handleRowAction(action, row) {
  if (action === 'receipt') return showReceipt(row);
  perform(`Milestone ${action}`, async () => {
    await focusRow(row);
    if (action === 'order') { await makeOrder(); notify('PayPal order created.'); }
    if (action === 'audit') {
      if (!$('#deliverable').value.trim()) {
        $('#deliverable').focus();
        notify('Paste or upload the custom deliverable, then run its QA audit.');
      } else await runAudit();
    }
    if (action === 'capture') await capturePayout();
    if (action === 'select') recordActivity('Milestone selected from ledger', { pactId: row.pactId, milestoneId: row.id });
    $('.audit-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function updateEventCounts() {
  const total = state.events.length + state.localEvents.length;
  $('#event-count').textContent = total;
  $('#dock-count').textContent = total;
}
async function pollTelemetry() {
  if (state.polling) return;
  state.polling = true;
  try {
    const result = await api(`/api/telemetry?after=${state.cursor}&limit=500`);
    if (result.cursor < state.cursor) { state.events = []; state.cursor = 0; return; }
    state.cursor = result.cursor;
    const known = new Set(state.events.map((entry) => entry.id));
    const added = result.entries.filter((entry) => !known.has(entry.id));
    state.events = [...state.events, ...added].slice(-500);
    updateEventCounts();
    if (added.length && $('#inspector').open) renderTelemetry();
  } finally { state.polling = false; }
}
function renderTelemetry() {
  const list = $('#telemetry-list');
  const open = new Set([...list.querySelectorAll('details[open]')].map((details) => details.dataset.eventId));
  if (state.focusedEvent) open.add(String(state.focusedEvent));
  const scrollTop = list.scrollTop;
  const events = [...state.events, ...state.localEvents].filter((entry) => state.telemetrySource === 'ALL' || entry.source === state.telemetrySource).sort((a, b) => b.timestamp.localeCompare(a.timestamp) || String(b.id).localeCompare(String(a.id)));
  list.replaceChildren();
  for (const entry of events) {
    const details = node('details', 'telemetry-entry');
    details.dataset.eventId = entry.id;
    details.open = open.has(String(entry.id));
    const summary = node('summary');
    const status = entry.response?.status ?? entry.status;
    const statusText = entry.source === 'WORKBENCH' ? 'LOCAL ACTION' : status === 0 ? 'NETWORK ERROR' : `${status ?? '—'} ${status === 201 ? 'Created' : status >= 200 && status < 300 ? 'OK' : 'Error'}`;
    summary.innerHTML = `<div class="event-top"><span class="http-method">${escapeHtml(entry.method)}</span><span class="event-time">${time(entry.timestamp)}</span><span class="http-status${status === 0 || status >= 400 ? ' error' : ''}">${statusText}</span></div><span class="event-path">${escapeHtml(entry.endpoint)}</span><div class="event-meta"><span class="event-mode${entry.mode === 'LIVE_PAYPAL_SANDBOX' ? ' live' : ''}">${escapeHtml(entry.mode ?? entry.source)}</span><span>${entry.latencyMs ?? 0} ms${entry.debugId ? ` · ${escapeHtml(entry.debugId)}` : ''}</span></div>`;
    details.append(summary);
    const body = node('div', 'event-body');
    body.append(node('h3', '', 'REQUEST'), node('pre', '', JSON.stringify(entry.request ?? {}, null, 2)), node('h3', '', 'RESPONSE'), node('pre', '', JSON.stringify(entry.response ?? {}, null, 2)));
    const links = node('div', 'event-links');
    for (const link of entry.links ?? []) {
      if (!['approve', 'payer-action'].includes(link.rel)) continue;
      const url = approvalUrl({ simulated: entry.mode === 'SANDBOX_SIMULATED', data: { links: [link] } });
      if (url) {
        const anchor = node('a', '', 'Open PayPal Sandbox approval ↗');
        anchor.href = url; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
        anchor.addEventListener('click', () => recordActivity('PayPal approval link opened', { url }));
        links.append(anchor);
      } else links.append(node('span', 'simulation-link', `SIMULATED APPROVAL LINK · ${link.href}`));
    }
    body.append(links); details.append(body); list.append(details);
  }
  if (!events.length) list.append(node('div', 'grid-empty', 'No matching activity yet. Run a workflow to inspect its requests and responses.'));
  $('#telemetry-summary').textContent = `${events.length} events · updates every 2.5 seconds`;
  list.scrollTop = scrollTop;
  if (state.focusedEvent) {
    const match = [...list.querySelectorAll('details')].find((item) => item.dataset.eventId === String(state.focusedEvent));
    match?.scrollIntoView({ block: 'nearest' });
    state.focusedEvent = null;
  }
}
async function openInspector(search) {
  try { await pollTelemetry(); } catch (error) { notify(error.message, true); }
  if (search) {
    const entry = [...state.events].reverse().find((item) => item.debugId === search || JSON.stringify(item.response?.body).includes(search) || item.endpoint.includes(search));
    state.focusedEvent = entry?.id ?? null;
    state.telemetrySource = entry?.source ?? 'PAYPAL';
    $('#telemetry-source').value = state.telemetrySource;
    if (!entry) notify('This trace has left the telemetry buffer. Current order details are in the receipt.');
  }
  if (!$('#inspector').open) $('#inspector').showModal();
  renderTelemetry();
}
function receiptData(row) {
  const captures = row.order?.data.purchase_units?.flatMap((unit) => unit.payments?.captures ?? []) ?? [];
  return {
    schemaVersion: 1, application: 'DealPact AI', exportedAt: new Date().toISOString(), environment: 'sandbox',
    mode: row.settlement ? 'SANDBOX_SIMULATED_BRIDGE' : row.order?.mode ?? 'NO_PAYMENT', pactId: row.pactId, milestoneId: row.id,
    client: row.client, vendor: row.vendor, deliverableScope: row.title, amount: row.amount, currency: 'USD',
    escrowStatus: row.escrowStatus, updatedAt: row.updatedAt ?? null,
    payment: { orderId: row.order?.data.id ?? null, captureIds: captures.map((capture) => capture.id), captures,
      invoiceId: row.invoice?.data.id ?? null, debugId: row.order?.debugId ?? null },
    audit: row.audit, order: row.order, invoice: row.invoice, settlement: row.settlement ?? null,
    notice: 'DealPact AI audit record. PayPal Sandbox only; no real funds move. Static checks are not a complete security certification. SHA-256 detects changes; this record is not digitally signed or issued by PayPal.',
  };
}
function receiptFields(receipt) {
  return [
    ['Milestone', `${receipt.milestoneId} · ${receipt.deliverableScope}`], ['Client / Vendor', `${receipt.client} / ${receipt.vendor}`],
    ['Pact ID', receipt.pactId], ['PayPal Order ID', receipt.payment.orderId ?? 'Not created'],
    ['PayPal Capture ID', receipt.payment.captureIds.join(', ') || 'Not captured by PayPal'],
    ...(receipt.settlement ? [['Simulated receipt ID', receipt.settlement.id], ['Settlement provenance', receipt.settlement.notice],
      ['Order verified at', receipt.settlement.createdAt], ['Verified order status', receipt.settlement.verification.providerStatus]] : []),
    ['Invoice ID', receipt.payment.invoiceId ?? 'Not created'], ['PayPal Debug ID', receipt.payment.debugId ?? 'No provider response'],
    ['QA decision', receipt.audit ? `${receipt.audit.decision} · ${receipt.audit.score}/100` : 'Not audited'],
    ['Audit timestamp', receipt.audit?.createdAt ?? 'Not audited'],
    ['Capture timestamp', receipt.payment.captures.map((capture) => capture.update_time ?? capture.create_time ?? 'Not provided').join(', ') || 'Not captured'],
    ['Record updated', receipt.updatedAt ?? 'Not updated'], ['Receipt exported', receipt.exportedAt],
  ];
}
function scoreExplanation(receipt) {
  const breakdown = receipt.audit?.scoreBreakdown;
  if (!breakdown) return 'No QA score breakdown available.';
  return `${breakdown.passedChecks}/${breakdown.totalChecks} checks passed · Check ratio ${breakdown.checkRatioScore}/100 · Security cap ${breakdown.securityCap}/100. ${breakdown.basis === 'PRESET_BENCHMARK' ? 'Final score uses the scenario benchmark.' : 'Final score is the check ratio limited by the security cap.'}`;
}
async function showReceipt(row) {
  try {
    const receipt = structuredClone(receiptData(row));
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(receipt)));
    receipt.integrity = { algorithm: 'SHA-256', value: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
      scope: 'UTF-8 JSON.stringify of this object with the integrity property removed, preserving property order.', signed: false };
    state.receipt = receipt;
    $('#receipt-content').innerHTML = `<article class="audit-certificate"><div class="certificate-masthead"><span>DEALPACT<span>AI</span></span><span>PAYMENT + QA RECORD / 01</span></div><h3>PayPal Escrow<br>Audit Certificate</h3><div class="certificate-mode">${escapeHtml(receipt.mode)} · NO REAL FUNDS</div><div class="receipt-hero"><strong>${usd(receipt.amount)}</strong>${badge(receipt.escrowStatus)}</div><dl class="receipt-fields">${receiptFields(receipt).map(([key, value]) => `<dt>${key}</dt><dd>${escapeHtml(value)}</dd>`).join('')}</dl><section class="certificate-qa"><h4>QA score breakdown</h4><p>${escapeHtml(scoreExplanation(receipt))}</p><ul>${(receipt.audit?.checks ?? []).map((check) => `<li><span class="${check.passed ? 'certificate-pass' : 'certificate-fail'}">${check.passed ? 'PASS' : 'FAIL'}</span><span>${escapeHtml(check.description)}</span></li>`).join('')}</ul></section><div class="certificate-hash"><span>ARTIFACT / SHA-256</span><code>${receipt.audit?.artifactHash ?? 'Not submitted'}</code><span>RECEIPT / SHA-256 · UNSIGNED CHECKSUM</span><code>${receipt.integrity.value}</code></div><p class="receipt-note">${escapeHtml(receipt.notice)}</p></article>`;
    if (!$('#receipt-dialog').open) $('#receipt-dialog').showModal();
    $('#receipt-dialog').scrollTop = 0;
    recordActivity('Audit certificate prepared', { pactId: receipt.pactId, milestoneId: receipt.milestoneId, checksum: receipt.integrity.value });
  } catch (error) { notify(`Receipt could not be prepared: ${error.message}`, true); }
}
async function exportReceiptPng() {
  const receipt = state.receipt;
  if (!receipt) return;
  const button = $('#download-png');
  button.disabled = true;
  try {
    await document.fonts.ready;
    const canvas = document.createElement('canvas');
    canvas.width = 1200;
    const ctx = canvas.getContext('2d');
    const draw = (measure = false) => {
      let y = 68;
      const text = (value, { size = 19, color = '#334155', bold = false, mono = false, x = 64, width = 1072, gap = 14 } = {}) => {
        ctx.font = `${bold ? '600' : '400'} ${size}px "${mono ? 'IBM Plex Mono' : 'DM Sans'}"`;
        ctx.fillStyle = color;
        ctx.textBaseline = 'top';
        const flush = (line) => {
          if (!measure) ctx.fillText(line, x, y);
          y += size * 1.5;
        };
        for (const paragraph of String(value).split('\n')) {
          let line = '';
          for (const word of paragraph.split(/\s+/)) {
            if (line && ctx.measureText(`${line} ${word}`).width > width) { flush(line); line = ''; }
            if (ctx.measureText(word).width > width) {
              for (const char of word) {
                if (line && ctx.measureText(line + char).width > width) { flush(line); line = ''; }
                line += char;
              }
            } else line += `${line ? ' ' : ''}${word}`;
          }
          flush(line);
        }
        y += gap;
      };
      const rule = () => { if (!measure) { ctx.fillStyle = '#dce4ec'; ctx.fillRect(64, y, 1072, 1); } y += 26; };
      text('DEALPACT AI', { mono: true, size: 19, bold: true, color: '#0070ba' });
      if (!measure) ctx.fillText('PAYMENT + QA RECORD / 01', 700, 68);
      y += 20;
      text('PayPal Escrow Audit Certificate', { size: 42, bold: true, color: '#111e30' });
      text(`${receipt.mode} · NO REAL FUNDS`, { mono: true, size: 18, color: '#925700', gap: 25 });
      text(`${usd(receipt.amount)}  /  ${receipt.escrowStatus}`, { size: 32, bold: true, color: isReleased(receipt) ? '#08734e' : '#ad2837', gap: 26 });
      rule();
      for (const [label, value] of receiptFields(receipt)) {
        const top = y;
        text(label.toUpperCase(), { mono: true, size: 14, color: '#62748b', width: 260 });
        const labelEnd = y;
        y = top;
        text(value, { size: 18, mono: /ID|timestamp|exported|updated/.test(label), x: 340, width: 796 });
        y = Math.max(y, labelEnd);
      }
      rule();
      text('QA SCORE BREAKDOWN', { mono: true, size: 18, bold: true, color: '#0070ba' });
      text(scoreExplanation(receipt), { size: 18 });
      for (const check of receipt.audit?.checks ?? []) text(`[${check.passed ? 'PASS' : 'FAIL'}]  ${check.description}`, { size: 18, color: check.passed ? '#08734e' : '#b42335' });
      rule();
      text('ARTIFACT / SHA-256', { mono: true, size: 14, color: '#62748b', gap: 3 });
      text(receipt.audit?.artifactHash ?? 'Not submitted', { mono: true, size: 18, gap: 20 });
      text('RECEIPT / SHA-256 · UNSIGNED CHECKSUM', { mono: true, size: 14, color: '#62748b', gap: 3 });
      text(receipt.integrity.value, { mono: true, size: 18, gap: 22 });
      text(receipt.notice, { size: 16, color: '#62748b', gap: 0 });
      return Math.ceil(y + 64);
    };
    canvas.height = draw(true);
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#0070ba'; ctx.fillRect(0, 0, canvas.width, 10);
    draw();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('PNG encoding failed.');
    download(receiptFilename('png', receipt), blob, 'image/png');
    recordActivity('PNG audit certificate exported', { milestoneId: receipt.milestoneId, checksum: receipt.integrity.value });
    notify('PNG certificate exported.');
  } catch (error) { notify(error.message, true); }
  finally { button.disabled = false; }
}
function receiptFilename(extension, receipt = state.receipt) { return `dealpact-${receipt.pactId.slice(0, 8)}-${receipt.milestoneId}-receipt.${extension}`; }
function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function visibleRows() {
  const rows = [];
  state.gridApi?.forEachNodeAfterFilterAndSort((entry) => { if (entry.data) rows.push(entry.data); });
  return rows;
}
function exportCsv() {
  const keys = ['id', 'parties', 'title', 'amount', 'order', 'escrowStatus', 'qaScore', 'agentTool', 'debug', 'updatedAt'];
  const csv = state.gridApi.getDataAsCsv({
    columnKeys: keys, skipPinnedBottom: true,
    processCellCallback: (params) => {
      const value = params.column.getColId() === 'amount' ? Number(params.value).toFixed(2) : String(params.value ?? '');
      return /^[\s]*[=+@-]/.test(value) ? `'${value}` : value;
    },
  });
  download('dealpact-ledger.csv', csv, 'text/csv;charset=utf-8');
  notify(`Exported ${visibleRows().length} visible milestones to CSV.`);
}

function bindEvents() {
  document.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (button && !button.disabled) recordActivity(button.getAttribute('aria-label') || button.title || button.textContent.trim(), { pactId: state.pact?.id ?? null, milestoneId: state.milestoneId });
  }, true);
  $('#scenario-pills').addEventListener('click', (event) => { const button = event.target.closest('[data-scenario]'); if (button && !state.busy) selectScenario(button.dataset.scenario); });
  $('#pact-milestones').addEventListener('click', (event) => { const button = event.target.closest('[data-milestone]'); if (!button || state.busy) return; state.milestoneId = button.dataset.milestone; renderPact(); renderMilestone(true); syncSelectedProgress(); });
  $('#milestone-select').addEventListener('change', (event) => { state.milestoneId = event.target.value; recordActivity('Milestone selected', selection()); renderPact(); renderMilestone(true); syncSelectedProgress(); });
  for (const id of ['scope', 'budget', 'timeline']) $(`#${id}`).addEventListener('input', () => {
    state.customScope = true; state.agreementDirty = Boolean(state.pact); $('#scope-kind').textContent = 'CUSTOM';
    if (state.agreementDirty) { $('#pact-status').textContent = 'Scope changed · renegotiate'; $('#pact-status').className = 'amber-text'; }
    updateControls();
  });
  $('#deliverable').addEventListener('input', () => { saveArtifact(); updateControls(); });
  $$('[data-variant]').forEach((button) => button.addEventListener('click', () => {
    $('#deliverable').value = currentMilestone().deliverableVariants[button.dataset.variant];
    $('#filename').textContent = 'deliverable.js';
    saveArtifact(button.dataset.variant);
    updateControls();
    notify('Example loaded. Run QA to evaluate it against this milestone.');
  }));
  $('#load-preset').addEventListener('click', () => { loadPresetArtifact(); updateControls(); notify('Preset deliverable loaded.'); });
  $('#upload').addEventListener('click', () => $('#file-upload').click());
  $('#file-upload').addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    try {
      if (file.size > 100000) throw new Error('Choose a text artifact smaller than 100 KB.');
      const content = await file.text();
      if (content.includes('\0')) throw new Error('Choose a plain text file containing code, text, or a diff.');
      $('#deliverable').value = content; $('#filename').textContent = file.name;
      saveArtifact(); updateControls(); recordActivity('Deliverable uploaded', { filename: file.name, bytes: file.size });
      notify('Deliverable loaded for review.');
    } catch (error) { notify(error.message, true); }
    finally { event.target.value = ''; }
  });
  $('#auto-capture').addEventListener('change', (event) => recordActivity('Automatic capture preference changed', { enabled: event.target.checked }));
  $('#negotiate').addEventListener('click', () => perform('Negotiation', async () => { resetSteps(); await negotiate(); $('#workflow-message').textContent = state.pact.milestones[0].order ? 'Smart pact agreed. First milestone order created.' : 'Smart pact agreed. Retry order creation in the payment console.'; notify('Smart pact agreed. Your milestones are in the ledger.'); }));
  $('#create-order').addEventListener('click', () => perform('Order creation', async () => { const order = await makeOrder(); notify(`PayPal order created · ${order.httpStatus} ${order.httpStatus === 201 ? 'Created' : 'OK'}${order.simulated ? ' · simulated' : ''}.`); }));
  $('#run-audit').addEventListener('click', () => perform('QA audit', async () => { const result = await runAudit(); notify(`QA ${result.audit.decision} · ${result.audit.score}/100`); }));
  $('#capture-order').addEventListener('click', () => perform('Capture', capturePayout));
  $('#autopilot').addEventListener('click', () => perform('Auto-Pilot', autoPilot));
  $('#approve-order').addEventListener('click', () => recordActivity('PayPal Sandbox approval opened', { orderId: currentMilestone()?.order?.data.id }));
  $('#payment-details').addEventListener('click', (event) => { const button = event.target.closest('[data-trace]'); if (button) openInspector(button.dataset.trace); });
  $('#inspect-payment').addEventListener('click', () => openInspector(currentMilestone()?.order?.data.id));
  $('#open-inspector').addEventListener('click', () => openInspector());
  $('#telemetry-dock').addEventListener('click', () => openInspector());
  $('#close-inspector').addEventListener('click', () => $('#inspector').close());
  $('#inspector').addEventListener('cancel', () => recordActivity('API inspector dismissed'));
  $('#telemetry-source').addEventListener('change', (event) => { state.telemetrySource = event.target.value; renderTelemetry(); recordActivity('Telemetry source filtered', { source: state.telemetrySource }); });
  $('#refresh-telemetry').addEventListener('click', async () => { try { await pollTelemetry(); renderTelemetry(); notify('API activity refreshed.'); } catch (error) { notify(error.message, true); } });
  $('#status-filters').addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter]'); if (!button) return;
    state.filter = button.dataset.filter;
    $$('#status-filters button').forEach((item) => { item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', String(item === button)); });
    state.gridApi.onFilterChanged();
  });
  $('#ledger-search').addEventListener('input', (event) => { state.gridApi.setGridOption('quickFilterText', event.target.value); clearTimeout(searchTimer); searchTimer = setTimeout(() => recordActivity('Ledger searched', { query: event.target.value }), 500); });
  $('#export-csv').addEventListener('click', exportCsv);
  $('#export-json').addEventListener('click', () => { const rows = visibleRows().map(receiptData); download('dealpact-audit.json', JSON.stringify({ exportedAt: new Date().toISOString(), milestones: rows }, null, 2), 'application/json'); notify(`Exported ${rows.length} milestone audit records.`); });
  $('#export-certificate').addEventListener('click', () => showReceipt({ ...currentMilestone(), pactId: state.pact.id, client: state.pact.client, vendor: state.pact.vendor }));
  $('#close-receipt').addEventListener('click', () => $('#receipt-dialog').close());
  $('#receipt-dialog').addEventListener('cancel', () => recordActivity('Receipt dismissed'));
  $('#copy-receipt').addEventListener('click', async () => { try { await navigator.clipboard.writeText(JSON.stringify(state.receipt, null, 2)); notify('Receipt JSON copied.'); } catch { notify('Clipboard access is unavailable. Use JSON Receipt.', true); } });
  $('#download-receipt').addEventListener('click', () => download(receiptFilename('json'), JSON.stringify(state.receipt, null, 2), 'application/json'));
  $('#download-png').addEventListener('click', exportReceiptPng);
  $('#print-receipt').addEventListener('click', () => window.print());
}

async function initialize() {
  try {
    setupGrid();
    bindEvents();
    const [health, presets] = await Promise.all([api('/api/health'), api('/api/scenarios')]);
    state.health = health; state.scenarios = presets.scenarios; state.ready = true;
    updateConnection(); selectScenario(state.scenarios[0].id);
    await refreshLedger(); await pollTelemetry();
    recordActivity('Workbench ready', { scenarioCount: state.scenarios.length });
    setInterval(() => { if (!document.hidden) pollTelemetry().catch(() => {}); }, 2500);
  } catch (error) {
    $('#connection-status').textContent = 'CONNECTION ERROR';
    $('#connection-status').className = 'status-badge danger';
    $('#connection-caption').textContent = 'Restart the server, then reload this page';
    notify(error.message, true);
  }
}

initialize();
