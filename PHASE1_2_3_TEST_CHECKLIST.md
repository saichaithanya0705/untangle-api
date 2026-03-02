# Phase 1-2-3 End-to-End Test Checklist

Last updated: March 1, 2026  
Project: `untangle-ai`

## 1) Purpose

Use this checklist to validate all implemented capabilities from:

1. Phase 1 (LiteLLM-level core capability)
2. Phase 2 (hardening and reliability)
3. Phase 3 (advanced self-hosted controls)

This checklist mixes:

1. Automated validation commands
2. Manual API checks
3. Manual UI checks

Every item includes expected behavior so testers can verify not just response codes but feature correctness.

## 2) Preconditions

- Node 18+ and `pnpm` installed.
- Dependencies installed: `pnpm install`
- Build artifacts available: `pnpm build`
- Test config file exists (`untangle.yaml`) and includes at least one working provider key.
- For fallback/routing tests, configure at least two deployments in a routing group.
- For admin/security tests, know the configured admin key if `security.adminApiKey` is enabled.

Recommended startup command (UI enabled by default):

```bash
pnpm --filter untangle-ai start -- --host 127.0.0.1 --port 4010
```

## 3) Evidence Format

For each test item, record:

1. `PASS` or `FAIL`
2. Command/request used
3. Key response/status/output
4. Notes for any mismatch

---

## 4) Global Startup and Smoke

- [ ] G-1 Server starts without crash.
Expected: process stays running, startup banner printed, listening on configured host/port.

- [ ] G-2 Health endpoint works: `GET /health`.
Expected: `200`, body contains `{"status":"ok"}`.

- [ ] G-3 Metrics endpoint works: `GET /metrics`.
Expected: `200`, Prometheus text with `untangle_http_requests_total`.

- [ ] G-4 UI loads by default (disable with `--no-ui`).
Expected: dashboard UI opens at `/` and major pages render (providers/models/keys/usage/settings).

---

## 5) Phase 1 Validation

### 5.1 API Endpoint Parity

- [ ] P1-API-1 `POST /v1/chat/completions` non-stream.
Expected: OpenAI-compatible JSON with `choices`, `model`, `usage`.

- [ ] P1-API-2 `POST /v1/chat/completions` stream.
Expected: SSE format, ordered chunks, terminal `[DONE]` on successful stream completion.

- [ ] P1-API-3 `POST /v1/responses` non-stream.
Expected: response envelope (`object: response`), `output_text`, `usage` when available.

- [ ] P1-API-4 `POST /v1/responses` stream.
Expected: response event sequence correctness (`response.created`, deltas, done/completed or error).

- [ ] P1-API-5 `POST /v1/embeddings`.
Expected: embeddings payload returned in OpenAI-compatible shape.

- [ ] P1-API-6 Media routes.
Endpoints:
1. `POST /v1/audio/transcriptions`
2. `POST /v1/audio/speech`
3. `POST /v1/images/generations`
Expected: successful provider-gated responses or clear `unsupported_provider`/validation errors.

- [ ] P1-API-7 Models routes.
Endpoints:
1. `GET /v1/models`
2. `GET /v1/models/:modelId`
Expected: enabled models only in list; specific model lookup behaves correctly.

### 5.2 Router, Strategy, Fallback, Circuit

- [ ] P1-ROUTER-1 Routing strategies (`priority`, `weighted`, `shuffle`, `least-latency`) behave as configured.
Expected:
1. `priority`: lower priority index preferred.
2. `weighted`: weighted ordering over multiple calls.
3. `shuffle`: non-deterministic ordering across calls.
4. `least-latency`: lower EMA latency preferred after observations.

- [ ] P1-ROUTER-2 Retry/fallback on retryable failures.
Expected: next eligible deployment is attempted when status is retryable (for example `503`).

- [ ] P1-ROUTER-3 `Retry-After` is respected.
Expected: failed deployment enters cooldown and immediate subsequent request avoids it.

- [ ] P1-ROUTER-4 Circuit breaker behavior.
Expected: deployment becomes unavailable after failure threshold and only re-enters half-open/open reset behavior after timeout.

- [ ] P1-ROUTER-5 Router debug endpoints.
Endpoints:
1. `GET /api/router/health`
2. `GET /api/router/decisions/:modelAlias`
Expected: reflects deployment eligibility/runtime state accurately.

### 5.3 Control Plane Foundation

- [ ] P1-CP-1 Virtual key create/list and key status routes work.
Expected: keys can be created/listed; invalid payloads rejected with clear error.

- [ ] P1-CP-2 Virtual key enforcement on data plane.
Expected:
1. Missing/invalid key rejected when required.
2. Valid key allows request.

- [ ] P1-CP-3 Limit checks (RPM/TPM/model allowlist/budget) enforce correctly.
Expected: exceeding policy returns denial with explicit reason.

- [ ] P1-CP-4 Usage/spend endpoints.
Expected: usage records and spend summaries update after requests.

- [ ] P1-CP-5 Control-plane schema endpoint.
Expected: `GET /api/control-plane/schema/postgres` returns SQL schema artifact.

### 5.4 Observability Baseline

- [ ] P1-OBS-1 Request IDs present.
Expected: `x-request-id` response header always present or preserved if provided by caller.

- [ ] P1-OBS-2 Trace context behavior.
Expected:
1. `traceparent` response header emitted.
2. incoming trace id preserved in outgoing trace tree.
3. provider upstream request carries trace context.

- [ ] P1-OBS-3 Provider upstream metrics.
Expected metrics include provider request/error counters and durations.

- [ ] P1-OBS-4 Configurable logging/tracing settings.
Expected changes in config reflect in runtime behavior (`level`, `sampleRate`, `logSpans`).

### 5.5 Compatibility and Translation

- [ ] P1-COMPAT-1 Legacy normalization.
Expected:
1. `max_completion_tokens` normalized to `max_tokens` in chat path.
2. responses compatibility (`messages`/`prompt`/`max_tokens`) normalized.

- [ ] P1-COMPAT-2 Strict validation mode.
Expected: unknown fields rejected with `unknown_fields` error when strict mode enabled.

- [ ] P1-COMPAT-3 Provider translation conformance suite.
Command: `pnpm --filter @untangle-ai/server test`
Expected: translation/conformance tests pass.

---

## 6) Phase 2 Validation

### 6.1 Hardening Gate

- [ ] P2-GATE-1 Phase 2 gate command.
Command:

```bash
pnpm run validate:phase2
```

Expected: all build/tests/scripts pass.

### 6.2 Soak and Memory Stability

- [ ] P2-SOAK-1 Soak test.
Command:

```bash
pnpm run phase2:soak
```

Expected: latency/error/fallback budgets and heap growth thresholds pass.

### 6.3 Chaos Resilience

- [ ] P2-CHAOS-1 Chaos suite.
Command:

```bash
pnpm run phase2:chaos
```

Expected:
1. provider outage handled with fallback
2. control-plane degradation returns explicit diagnostics
3. bootstrap fallback remains safe

### 6.4 Retry/Streaming Correctness

- [ ] P2-STREAM-1 Retry-stream correctness.
Command:

```bash
pnpm --filter @untangle-ai/server test:retry-stream
```

Expected: stream sequencing and fallback continuation tests pass.

### 6.5 Billing Reconciliation

- [ ] P2-BILL-1 Reconciliation endpoint.
Endpoint: `POST /api/control-plane/reconciliation/provider-export`
Expected: validates payload, returns reconciliation summary.

- [ ] P2-BILL-2 Reconciliation script.
Command (example):

```bash
node scripts/reconcile-provider-billing.js --server http://127.0.0.1:4010 --provider openai --csv <file.csv> --model-column model --cost-column cost_usd --timestamp-column timestamp --tolerance-usd 0.01
```

Expected: output summary matches endpoint behavior within tolerance.

### 6.6 Release Safety

- [ ] P2-REL-1 Release safety script.
Command:

```bash
pnpm run phase2:release-safety
```

Expected:
1. migration dry-run checker works
2. rollback plan generator works
3. release-safety checks pass

---

## 7) Phase 3 Validation

### 7.1 Multi-Region Routing and Failover

- [ ] P3-REGION-1 Region hint routing (`x-untangle-region` / `x-region`).
Expected: same-region deployment preferred when available.

- [ ] P3-REGION-2 Cross-region fallback control.
Expected: with fallback disabled, local region enforced if local deployment exists.

- [ ] P3-REGION-3 Region ejection admin APIs.
Endpoints:
1. `GET /api/router/regions`
2. `POST /api/router/regions/:region/eject`
3. `POST /api/router/regions/:region/restore`
Expected: state changes immediately reflected in routing decisions.

- [ ] P3-REGION-4 Health-based region failure ejection.
Expected: repeated failures trigger temporary auto-ejection and failover.

### 7.2 Exact Cache

- [ ] P3-CACHE-1 Chat exact cache.
Expected:
1. first non-stream request: `x-untangle-cache: miss`
2. repeat identical request: `x-untangle-cache: hit`

- [ ] P3-CACHE-2 Responses exact cache.
Expected same miss->hit behavior for non-stream responses.

- [ ] P3-CACHE-3 Cache policy toggles.
Expected: cache only active for enabled routes (`cache.exact.chat`, `cache.exact.responses`).

### 7.3 Traffic Shaping

- [ ] P3-TS-1 Burst throttling.
Expected: over-burst requests return `429` with code `traffic_shaping_throttled`.

- [ ] P3-TS-2 Adaptive throttle behavior.
Expected: under high latency/error pressure, effective RPS decreases.

- [ ] P3-TS-3 Traffic shaping metrics.
Expected:
1. `untangle_traffic_shaping_throttled_total`
2. `untangle_traffic_shaping_current_rps`

### 7.4 Rollout Controls

- [ ] P3-ROLL-1 Canary mode lane selection.
Expected: canary traffic percentage obeys `canaryPercent`.

- [ ] P3-ROLL-2 A/B deterministic selection.
Expected: same rollout key maps to same lane consistently.
Headers:
1. `x-untangle-rollout-key`
2. `x-untangle-ab-key`

- [ ] P3-ROLL-3 Shadow mirroring.
Expected: primary response returned to user while shadow deployment receives mirrored non-stream request in background.

- [ ] P3-ROLL-4 Rollout debug inspection.
Expected: `GET /api/router/decisions/:modelAlias?rolloutKey=...` reflects lane selection and shadow candidates.

### 7.5 Secrets and Security Baseline

- [ ] P3-SEC-1 Secret reference resolution via env.
Expected: `providers.<id>.apiKeySecretRef: env:VAR_NAME` resolves at startup.

- [ ] P3-SEC-2 Optional file secret references.
Expected: `file:` refs resolve only when `secrets.allowFileRefs=true`.

- [ ] P3-SEC-3 Admin API auth enforcement.
Expected: when enabled, `/api/*` requires valid admin token/header; data plane `/v1/*` remains unaffected.

- [ ] P3-SEC-4 Admin auth metrics.
Expected: denied admin requests increment `untangle_admin_auth_denied_total`.

### 7.6 Admin IaC Operations

- [ ] P3-IAC-1 Export.
Endpoint: `GET /api/admin/iac/export`
Expected: current provider/model/routing region state in declarative form.

- [ ] P3-IAC-2 Plan.
Endpoint: `POST /api/admin/iac/plan`
Expected: dry-run diff (provider/model/region changes) without applying state.

- [ ] P3-IAC-3 Apply.
Endpoint: `POST /api/admin/iac/apply`
Expected: applies declarative state and returns updated runtime state.

### 7.7 UI Manual Validation

- [ ] P3-UI-1 Providers page.
Expected: provider status, toggle behavior, and key state visible and accurate.

- [ ] P3-UI-2 Models page.
Expected: model enable/disable reflects backend state and updates correctly.

- [ ] P3-UI-3 Keys page.
Expected: key management actions (set/test/remove) are clear and produce expected outcomes.

- [ ] P3-UI-4 Usage page.
Expected: usage/spend metrics and trends update after traffic.

- [ ] P3-UI-5 Settings page.
Expected: displays runtime settings (`host`, `port`, observability state, UI enabled flag).

---

## 8) Final Exit Check

- [ ] E-1 `pnpm run validate:phase1` passes.
- [ ] E-2 `pnpm run validate:phase2` passes.
- [ ] E-3 Phase 3 targeted suite passes:

```bash
pnpm --filter @untangle-ai/server test src/__tests__/admin-ops.test.ts src/__tests__/chat-routing.test.ts src/__tests__/responses.test.ts src/__tests__/integration.test.ts src/__tests__/traffic-shaping.test.ts
```

- [ ] E-4 Manual API checks and UI checks completed with evidence.
- [ ] E-5 Any failures triaged with repro steps and severity.

---

## 9) Test Summary Template

Fill this at the end:

1. Build status:
2. Automated test status:
3. Manual API status:
4. UI status:
5. Total failed checks:
6. High-severity issues:
7. Medium/low issues:
8. Recommended next actions:
