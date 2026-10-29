# AGENTS.md — DealPact AI (PayPal AI Hackathon 2026)

## Project Overview
DealPact AI is a full-stack Agentic Commerce web application built for the PayPal AI Hackathon 2026. It automates B2B/freelance contract negotiation, milestone billing, deliverable QA verification, and financial reconciliation using the PayPal Developer Platform (Sandbox REST APIs + PayPal Agent Toolkit) and AG Grid.

All UI text, code comments, commit messages, documentation, and preset scenarios MUST be written in professional English (strictly required by official hackathon rules).

## Tech Stack & Directory Structure
Use a clean, self-contained Node.js (Express/TypeScript or ES Modules) + modern Frontend architecture that runs with a single command (`npm run dev`):
- `server/`
  - `index.js` — Express API server serving both backend endpoints and static frontend assets.
  - `paypalClient.js` — Real PayPal Sandbox REST API client (`https://api-m.sandbox.paypal.com`) implementing:
    1. OAuth 2.0 token caching (`POST /v1/oauth2/token`)
    2. Order creation with idempotency header `PayPal-Request-Id` (`POST /v2/checkout/orders`)
    3. Order details & capture (`GET /v2/checkout/orders/:id`, `POST /v2/checkout/orders/:id/capture`)
    4. Draft invoice generation (`POST /v2/invoicing/invoices`)
    5. Graceful Sandbox Simulation Fallback: if `PAYPAL_CLIENT_ID` is not set or Sandbox is unreachable, return deterministic, schema-accurate PayPal v2 JSON payloads clearly badged as `SANDBOX_SIMULATED` while recording full request/response telemetry.
  - `agentEngine.js` — Multi-agent orchestration engine (supports OpenAI API when `OPENAI_API_KEY` is present, with a rich deterministic rule/AST heuristic engine fallback so judges never hit API key errors):
    1. **Buyer Procurement Agent** (optimizes budget, milestone splits, and SLA penalties)
    2. **Vendor Architect Agent** (defends engineering scope, hourly breakdown, and delivery timeline)
    3. **QA Escrow Auditor Agent** (inspects submitted code/PR diffs or deliverable artifacts against milestone acceptance criteria and triggers PayPal capture upon passing)
  - `telemetryStore.js` — Ring buffer storing every outbound PayPal API request and inbound JSON response (method, endpoint, HTTP status, latency ms, PayPal-Debug-Id, HATEOAS links) for the frontend Live API Inspector.
- `public/`
  - `index.html`, `styles.css`, `app.js` — Responsive 3-zone dark fintech workbench:
    - **Top Header**: Brand identity, Sandbox Connection Status pill (`LIVE PAYPAL SANDBOX` vs `SIMULATION FALLBACK`), KPI summary cards (Total Locked in Escrow, Released Payouts, Active Milestones, AI Audit Pass Rate), and **1-Click Judge Auto-Pilot Demo** button.
    - **Upper Workspace (Split View)**:
      - Left: **Scenario Selector (4 Presets)** + Scope Input & Multi-Agent Negotiation Arena (streaming chat between Buyer Agent & Vendor Agent culminating in a structured 3-Milestone Smart Pact).
      - Right: **AI Deliverable QA Auditor & PayPal Checkout/Capture Console** (allows uploading/pasting deliverable code or selecting preset deliverables, runs automated acceptance checks, and triggers real PayPal Sandbox Order Creation & Capture with clickable PayPal Sandbox approval links).
    - **Lower Workspace (Full-Width AG Grid Financial Reconciliation Terminal)**:
      - Powered by **AG Grid** (`ag-grid-community` via CDN/npm with custom dark fintech theme).
      - Columns: `Milestone ID`, `Client & Vendor`, `Deliverable Scope`, `Amount (USD)`, `PayPal Order / Invoice ID`, `Escrow Status` (custom badge renderer), `AI QA Score` (custom progress bar renderer), `PayPal Debug ID`, `Updated At`, and `Quick Actions` (Create Order, Verify Deliverable, Capture Funds, Export Audit Receipt).
      - Includes quick search filter, status filter pills, column sorting, pinned summary row (total USD reconciled), and CSV/JSON audit export.
    - **Collapsible Right Drawer**: **Live PayPal API Telemetry Inspector** displaying real HTTP requests/responses (`POST /v2/checkout/orders`, `201 Created`, HATEOAS `approve` & `capture` URLs).
- `test/`
  - `smoke.test.js` — Automated Node test script verifying all API routes, preset scenarios, PayPal client payload structure, and QA auditor logic.
- `LICENSE` — MIT License file at root (mandatory for Devpost repository validation).
- `README.md` — Comprehensive English documentation including Architecture Diagram, Tools Statement (PayPal Sandbox APIs, PayPal Agent Toolkit, OpenAI Codex, AG Grid, APIMatic Context Plugin), Setup Instructions, and Judge Testing Guide.

## Pre-Loaded B2B Preset Scenarios (Zero-Typing Judge Experience)
Always bundle 4 realistic presets selectable with one click:
1. **SaaS Stripe-to-PayPal Checkout Migration ($4,500 / 3 Milestones)** — Deliverable passes QA audit (Score: 94/100) -> triggers automatic PayPal Order Capture.
2. **Cross-Border E-Commerce AI Localization Microservice ($3,200 / 2 Milestones)** — Deliverable passes QA audit (Score: 89/100) -> generates PayPal Invoice & Order Capture.
3. **Smart Contract Security Audit & Penetration Report ($6,000 / 3 Milestones)** — Submitted deliverable contains unpatched SQLi/ReDoS vulnerabilities (Score: 41/100) -> QA Auditor **BLOCKS** PayPal payout and issues a remediation diff.
4. **Mobile App UI Kit & Design System ($2,400 / 2 Milestones)** — Partial milestone completion -> releases Milestone 1 via PayPal Sandbox and holds Milestone 2 in escrow.

## Coding & Verification Standards
1. Never leave placeholder buttons or dead links. Every button in the UI and inside AG Grid rows must trigger a real state update and log an entry in the Live PayPal API Telemetry Inspector.
2. After writing or modifying code, always run `node --check` on all JS files and run `npm test` to verify zero runtime or syntax errors.
3. Keep all secrets in `.env` (provide a clean `.env.example` with `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV=sandbox`, `OPENAI_API_KEY`).




