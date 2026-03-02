# Untangle-AI Execution Plan

Last updated: March 1, 2026

This file is the persistent implementation plan.  
The full strategic roadmap is in [ROADMAP.md](./ROADMAP.md).

How to use both files:

1. Use `ROADMAP.md` for what we are building and why.
2. Use `PLAN.md` for when we are building it and current status.

## Plan Objective

Ship the roadmap in controlled phases with measurable checkpoints, so progress is trackable and not lost.

## Phase Plan

### Phase 1: LiteLLM-Level Capability

Status: `done` (completed on February 26, 2026)

Milestones:

1. Add endpoint parity core (`/v1/embeddings`, `/v1/responses`, core audio/images routes) - `done` (parity endpoints + strict compatibility handling + route-level validation/tests completed on February 26, 2026)
2. Build deployment-group router (priority, weighted, shuffle, least-latency) - `done` (routing engine + debug endpoints + load/failure simulation coverage completed on February 26, 2026)
3. Implement retry/fallback policies with cooldown and circuit breaking - `done` (retryable status/error behavior, `Retry-After` honoring, cooldown/circuit behavior, and stream-safe fallback baseline completed on February 26, 2026)
4. Add PostgreSQL + Redis control-plane base (keys, limits, usage, spend) - `done` (control-plane service/store/limiter foundation + Postgres schema artifact + management routes + CLI adapter selection/fallback to Postgres/Redis completed on February 26, 2026)
5. Add observability baseline (JSON logs, metrics, tracing, request IDs) - `done` (request IDs, JSON logs, Prometheus baseline metrics, provider upstream metrics, virtual-key rate-limit metrics, configurable log/tracing settings, and W3C trace-context/provider-span baseline completed on February 26, 2026)
6. Build provider translation conformance tests (tools, streaming, structured output) - `done` (fixture-driven conformance suite expanded for request/response/streaming/tool mappings across adapters on February 26, 2026)

Exit criteria:

1. Stable routing/fallback under load and provider-failure simulations
2. Compatibility suite green for chat/tools/streaming/embeddings/responses
3. No open P0/P1 defects for auth, routing, or billing controls

### Phase 2: Hardening and Reliability

Status: `in progress` (implementation complete on February 27, 2026; operational exit criteria pending)

Milestones:

1. Long-run soak testing and memory leak detection in CI - `done` (added configurable soak/memory gate test + nightly CI soak workflow and validated in `validate:phase2` on February 27, 2026)
2. Chaos testing for provider, Redis, and DB degradation - `done` (added chaos resilience suite for provider outage cooldown, control-plane degradation handling, and bootstrap fallback; validated in `validate:phase2` on February 27, 2026)
3. Retry/fallback correctness suite (including `Retry-After` handling) - `done` (added immediate subsequent-request `Retry-After` cooldown assertion in chaos suite and retained existing routing regression coverage)
4. Streaming correctness suite for event sequencing and edge cases - `done` (existing stream harness + chat/responses continuation sequencing coverage retained and included in Phase 2 gate)
5. Token/cost reconciliation against provider billing exports - `done` (added provider-export reconciliation endpoint + validation tests + CSV reconciliation script; runtime compatibility fallback and full gate validation completed on February 27, 2026)
6. Release safety system (canary, migration checks, rollback automation) - `done` (added release safety test suite, migration dry-run checker, rollback plan generator, and CI hardening workflow; fixed artifact path regression and validated in `validate:phase2` on February 27, 2026)

Exit criteria:

1. 30-day soak run meets memory and stability budgets
2. No known P1 regressions in fallback, streaming, or accounting paths
3. Upgrade path validated across recent minor versions

### Phase 3: Self-Hosted Advanced Features

Status: `in progress` (started on March 1, 2026)

Milestones:

1. Multi-region active-active routing and failover controls - `in progress` (added region-aware deployment metadata, region routing policy surface, request-region hint routing, and regression coverage on March 1, 2026)
2. Advanced cache layers (semantic + exact) with per-policy controls - `in progress` (added exact-response cache baseline with per-route policy controls for chat/responses on March 1, 2026)
3. Traffic shaping (quotas, bursts, adaptive throttling) - `in progress` (added data-plane token-bucket shaping with adaptive RPS controls, throttle metrics, and regression coverage on March 1, 2026)
4. Rollout controls (canary, A/B, shadow traffic) - `done` (added rollout lanes/modes, deterministic rollout-key selection, and non-stream shadow mirroring for chat/responses on March 1, 2026)
5. Secrets manager integrations and stronger security posture - `in progress` (added provider secret-reference resolution (`env:`/`file:`) and admin-plane auth middleware baseline on March 1, 2026)
6. API-first admin operations and infra-as-code integration path - `in progress` (added admin IaC export/plan/apply endpoints for provider/model/region state management on March 1, 2026)

Exit criteria:

1. Multi-region failover drills pass without data-plane downtime
2. Measurable cost and latency improvements from caching and routing

### Phase 4: Enterprise Platform

Status: `not started`

Milestones:

1. Enterprise identity (SAML/OIDC SSO, SCIM, granular RBAC/ABAC)
2. Policy engine (model/tool/data access policy-as-code)
3. Compliance controls (immutable audit, retention/legal hold workflows)
4. FinOps suite (chargeback, forecasting, anomaly detection)
5. DR and SLA framework (tested backups, restore, RTO/RPO playbooks)
6. Plugin/extensibility SDK for enterprise integrations

Exit criteria:

1. Enterprise identity and policy controls validated in multi-tenant setups
2. DR game-days and compliance audit workflows pass stakeholder review

## Immediate Next Steps (Execution Order)

Status: `phase 1 completed`

1. Implement router/fallback core - `done`
2. Add control-plane persistence (PostgreSQL/Redis) - `done`
3. Ship observability baseline - `done`
4. Expand API endpoint parity - `done`
5. Start hardening track in parallel - `next` (Phase 2 kickoff)

## Execution Log

### February 26, 2026

1. Started Phase 1 Workstream B.
2. Added deployment-group routing foundation with strategies: priority, weighted, shuffle, and least-latency.
3. Added retry/fallback baseline in chat route with retryable status handling, `Retry-After` cooldown support, and circuit open/half-open behavior.
4. Added focused tests for routing strategy, circuit behavior, and chat fallback semantics.
5. Added `/v1/embeddings` endpoint baseline with deployment-group fallback behavior and validation tests.
6. Added `/v1/responses` endpoint baseline (non-streaming envelope + streaming events) with fallback and validation tests.
7. Added observability baseline slice: request IDs, structured JSON request logs, fallback counter, and `/metrics` endpoint.
8. Added core media parity routes (`audio transcriptions`, `audio speech`, `image generations`) with provider gating and fallback tests.
9. Added provider translation conformance baseline tests in the test harness for request/response/stream transformations.
10. Added router debug endpoints (`/api/router/health`, `/api/router/decisions/:modelAlias`) and unified shared router state across routes.
11. Added control-plane foundation: virtual key management, in-memory limits/spend/usage store, PostgreSQL schema artifact, usage ingest hooks, and `/api/control-plane/*` endpoints.
12. Wired CLI startup to instantiate PostgreSQL and Redis control-plane adapters when configured, including safe fallback to in-memory implementations and automatic PostgreSQL schema bootstrap.
13. Enforced control-plane virtual-key checks in data-plane routes (`chat`, `responses`, `embeddings`, `audio`, `images`) using configured virtual-key headers and key-scoped limit decisions.
14. Extended usage tracking metadata to carry virtual-key identity into control-plane usage persistence for key-scoped analytics and spend attribution.
15. Added data-plane control-plane tests for invalid key rejection, model allow-list denial, and RPM limit enforcement; full validation green (`core build`, `server build`, `server test`).
16. Added tracing baseline with `traceparent` request/response propagation, provider upstream span logging, and trace-context forwarding to upstream calls in chat/responses/embeddings/media routes.
17. Added tracing-focused tests for response `traceparent` behavior and upstream trace-context propagation; validation remains green (`core build`, `server build`, `server test`, `cli build`).
18. Completed richer observability controls with configurable logging/tracing settings (`level`, `sampleRate`, `logSpans`, provider metric labels) and upstream provider request/error metrics.
19. Added Phase 1 compatibility hardening: strict unknown-field validation mode and legacy parameter normalization (`max_completion_tokens`, `max_tokens`, `messages`/`prompt` compatibility) for chat/responses/embeddings routes.
20. Added compatibility and observability regression tests (provider metric emission, strict validation rejection, and compatibility normalization) with full validation green (`core build`, `server build`, `server test`, `cli build`).
21. Expanded provider translation conformance with fixture-driven coverage for Anthropic tool mapping/tool-use response translation and Google structured output/tool/stream contracts.
22. Extended strict compatibility validation to media + admin/control-plane routes (`audio`, `images`, `keys`, `control-plane limit checks`, `pricing calculate`) and added regression tests.
23. Added burst provider-failure routing simulation to validate fallback stability under concurrent load.
24. Added configurable stream fallback policy surface (`continue-disabled` and optional `continue-with-policy-prompt`) and router retryable stream-interruption error handling updates.
25. Revalidated Phase 1 with green build/test matrix (`core build`, `server build`, `server test`, `cli build`), and moved Phase 1 status to `done`.

### February 27, 2026

1. Started Phase 2 hardening implementation and moved Phase 2 status to `in progress`.
2. Added Phase 2 CI workflow (`.github/workflows/phase2-hardening.yml`) with PR/push validation and scheduled long-run soak execution.
3. Added configurable soak + memory guard coverage (`packages/server/src/__tests__/soak-memory.test.ts`) and wired package/root scripts for repeatable Phase 2 gates.
4. Added chaos resilience coverage (`packages/server/src/__tests__/chaos-resilience.test.ts`) for provider `Retry-After` cooldown behavior, control-plane degradation responses, and bootstrap fallback safety.
5. Hardened virtual-key enforcement degradation behavior (`packages/server/src/routes/virtual-key.ts`) to return explicit `503 control_plane_unavailable` diagnostics on control-plane dependency failures.
6. Added provider billing export reconciliation capability (`/api/control-plane/reconciliation/provider-export`) with strict payload validation and reconciliation regression tests.
7. Added provider billing CSV reconciliation automation (`scripts/reconcile-provider-billing.js`) for comparing provider export totals against control-plane usage data.
8. Added release safety automation artifacts: migration dry-run checker (`scripts/check-control-plane-migration.js`), rollback plan generator (`scripts/generate-rollback-plan.js`), and aggregate release-safety runner (`scripts/release-safety-check.js`).
9. Hardened provider-export reconciliation endpoint for mixed-build runtime compatibility by adding a safe fallback path when `reconcileProviderBillingExport` is unavailable at runtime.
10. Fixed Phase 2 validation regressions (`release-safety` test repo-root path and soak metrics typing/fallback stability) and revalidated full hardening gate (`pnpm run validate:phase2` green).

### March 1, 2026

1. Started Phase 3 implementation and moved Phase 3 status to `in progress`.
2. Added region-aware routing configuration surface (`routing.regionRouting`) and per-deployment region metadata for active-active selection controls.
3. Extended router selection/debug APIs to accept request context (client region and cross-region fallback behavior).
4. Wired request region hints (`x-untangle-region`, `x-region`) into chat/responses/embeddings/media route deployment selection.
5. Added regression coverage for same-region preference, local-only selection mode, and header-driven regional route selection.
6. Added explicit regional failover controls with router admin endpoints for region ejection/restore and region state inspection (`/api/router/regions/*`).
7. Added health-based regional ejection support (`routing.regionRouting.failureEjection`) with automatic temporary ejection after repeated regional failures.
8. Added regression coverage for manual ejection/restore behavior and auto regional ejection fallback behavior.
9. Added exact-response caching baseline (`cache.exact`) with TTL/max-entry policy controls and non-stream cache hit/miss behavior for `chat` and `responses` routes.
10. Added regression coverage for exact-cache hit/miss behavior in chat/responses route suites.
11. Added data-plane traffic-shaping middleware (`trafficShaping`) with burst controls and adaptive throttling adjustments based on observed latency/error pressure.
12. Added traffic-shaping observability metrics (`untangle_traffic_shaping_throttled_total`, `untangle_traffic_shaping_current_rps`) and regression tests for throttle and adaptive downscale behavior.
13. Completed rollout-controls baseline with deployment lanes (`stable`/`canary`/`shadow`), per-group rollout policy (`disabled`/`canary`/`ab`), deterministic rollout-key support, and shadow mirroring for non-stream chat/responses traffic.
14. Added security hardening baseline with configurable admin-plane authentication middleware for `/api/*` routes (`x-untangle-admin-key` and optional bearer token), plus admin-auth denial metrics.
15. Added API-first admin IaC endpoints (`/api/admin/iac/export`, `/api/admin/iac/plan`, `/api/admin/iac/apply`) for declarative provider/model state and regional ejection management workflows.
16. Added Phase 3 regression coverage for rollout determinism, shadow traffic mirroring, admin auth enforcement, and IaC export/plan/apply behavior; validation green (`core build`, `server build`, targeted Phase 3 test suite).

## Tracking

Update this file every sprint:

1. Set each phase status: `not started` | `in progress` | `blocked` | `done`
2. Add completion dates to milestones
3. Record blockers and decisions directly in this file
