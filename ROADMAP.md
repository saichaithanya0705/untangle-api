# Untangle-AI Feature Roadmap (Phase 1-4)

Last updated: February 25, 2026

This file defines strategy and scope.
For execution status, milestones, and sprint tracking, use [PLAN.md](./PLAN.md).

## Goal

Build `untangle-ai` from its current lightweight multi-provider gateway into:

1. A LiteLLM-level production gateway (Phase 1)
2. A hardened, reliability-first gateway with known failure classes closed (Phase 2)
3. A self-hosted platform with advanced operator features (Phase 3)
4. An enterprise-grade control plane (Phase 4)

---

## Current Baseline (What We Have Today)

`untangle-ai` already provides:

1. OpenAI-compatible `POST /v1/chat/completions`
2. Model listing endpoints (`GET /v1/models`, `GET /v1/models/:id`)
3. Multi-provider adapters (OpenAI, Anthropic, Google, Groq, OpenRouter)
4. Basic streaming passthrough and request/response transforms
5. API key management and basic provider toggling
6. Basic usage and pricing endpoints
7. Model discovery (API/OpenRouter/web/hardcoded fallback)

Key limitations today:

1. No true routing/fallback engine (single adapter resolution by model)
2. In-memory usage tracking, no persistent control plane data model
3. Minimal auth/tenant controls
4. Limited OpenAI-surface endpoint coverage
5. Basic observability and limited resiliency controls

---

## Phase 1: Reach LiteLLM-Level Capability

Target window: 8-12 weeks

### Objective

Match core LiteLLM proxy capabilities required for production adoption without copying LiteLLM internals.

### Workstream A: API Surface Parity

Deliver:

1. `POST /v1/embeddings`
2. `POST /v1/responses` (with streaming event compatibility)
3. `POST /v1/audio/transcriptions` and `POST /v1/audio/speech` (provider-gated)
4. `POST /v1/images/generations` (provider-gated)
5. Better request compatibility handling (OpenAI-style params normalization and strict validation modes)

### Workstream B: Router + Fallback Engine

Deliver:

1. Deployment groups per logical model alias (multiple backends per model)
2. Routing strategies:
   - Priority order
   - Weighted round-robin
   - Least-latency (EMA-based)
   - Simple shuffle
3. Retry policy with per-error-class behavior
4. Fallback policy honoring `Retry-After`
5. Cooldown and temporary ejection for unhealthy deployments
6. Circuit breaker controls (open/half-open/closed)
7. Stream-safe fallback policy modes:
   - pre-first-token fallback
   - continue-disabled for mid-stream failures
   - continue-with-policy-prompt as optional mode

### Workstream C: Control Plane Foundation

Deliver:

1. PostgreSQL-backed persistence for:
   - API keys (virtual keys)
   - usage events
   - spend ledger
   - tenants/teams
   - model/deployment configs
2. Redis-backed:
   - rate-limits
   - routing cache
   - short-term state
3. Key-scoped controls:
   - RPM/TPM limits
   - budget caps (daily/monthly)
   - model allow/deny lists

### Workstream D: Observability + Operations

Deliver:

1. Structured JSON logging with configurable levels
2. Prometheus metrics for request, latency, failures, fallback counts, rate-limit hits
3. OpenTelemetry tracing
4. Per-request correlation IDs and upstream provider spans
5. Debug endpoints for router decisions and health snapshots

### Workstream E: Provider Translation Layer v2

Deliver:

1. Centralized canonical schema for:
   - tool calls
   - structured output / JSON mode
   - multimodal content blocks
   - streaming chunk event contracts
2. Provider-specific conformance tests
3. Golden fixtures for request/response transforms

### Phase 1 Exit Criteria

1. Supports at least 10 common production providers/deployments through deployment-group routing
2. Sustains target load with predictable overhead (define baseline in CI load profile)
3. Passes compatibility suite for chat, tools, streaming, embeddings, responses
4. No P0/P1 defects in routing, auth, or billing controls across a 2-week soak

---

## Phase 2: Hardening + Known Failure Class Closure

Target window: 6-10 weeks (can overlap tail of Phase 1)

### Objective

Harden reliability and proactively close issue classes commonly reported in LiteLLM and similar gateways.

### Hardening Program

1. Reliability test matrix:
   - long-run soak tests
   - chaos tests (provider outages, partial slowdowns, Redis/DB blips)
   - stream interruption tests
2. Memory and CPU safety:
   - leak detection in CI (heap snapshots, long-lived stream tests)
   - queue bounding and timeout cleanup guarantees
3. Release safety:
   - canary rollouts
   - migration dry-run checks
   - rollback-safe schema changes
4. Routing correctness:
   - verify no retry-cycle reset loops
   - strict `Retry-After` honoring
   - deterministic fallback ordering
5. Cost and token accounting integrity:
   - provider billing reconciliation job
   - explicit unknown-cost state (never silently zero-cost unless configured)

### Explicit Issue Classes to Prevent (Based on Industry Reports)

1. Fallback/retry loops and non-termination
2. Mid-stream fallback behavior causing malformed continuations
3. Missing/incorrect streaming event sequences
4. Tool-calling schema drift and raw JSON leakage
5. Version-to-version performance regressions
6. Memory growth under sustained throughput
7. Incorrect auth error mapping and poor operator diagnostics
8. Token/cost mismatch vs provider invoices
9. Logging settings not honoring configured verbosity
10. Distributed deployment URL/session/routing assumptions that break behind ingress

### Phase 2 Exit Criteria

1. 30-day soak with no memory growth beyond predefined threshold
2. Zero known open P1 defects in retry/fallback/streaming
3. Billing reconciliation error stays within defined tolerance
4. Upgrade test suite prevents regressions across last 3 minor versions

---

## Phase 3: Self-Hosted Power Features

Target window: 8-12 weeks

### Objective

Deliver features demanded by serious self-hosted teams running multi-cluster, high-volume workloads.

### Feature Set

1. Multi-region active-active routing with locality preference
2. Advanced cache layer:
   - semantic cache
   - exact cache
   - per-key/per-model cache policies
3. Traffic control:
   - quotas per team/model
   - burst controls
   - adaptive throttling
4. Rollout controls:
   - weighted canary between model versions
   - A/B experiments
   - shadow traffic
5. Enhanced observability:
   - trace sampling controls
   - latency heatmaps
   - provider SLO dashboards
6. Security posture:
   - mTLS upstream support
   - secrets manager integrations (Vault/KMS/cloud key vaults)
   - signed audit exports
7. Operational UX:
   - API-first admin
   - import/export configs
   - Terraform provider (or first-party module set)

### Phase 3 Exit Criteria

1. Multi-region failover drills succeed with no data-plane downtime
2. Cache hit-rate and cost savings targets reached in real workloads
3. Canary and rollback controls validated in production-like testbed

---

## Phase 4: Enterprise Platform

Target window: 10-16 weeks

### Objective

Provide enterprise-grade governance, compliance, and platform capabilities.

### Feature Set

1. Enterprise identity:
   - SSO (SAML/OIDC)
   - SCIM provisioning
   - fine-grained RBAC/ABAC
2. Governance and policy engine:
   - policy-as-code for model access, data boundaries, tool permissions
   - environment-level guardrails
3. Compliance and audit:
   - immutable audit log pipeline
   - retention/legal hold controls
   - compliance reporting packs
4. FinOps and chargeback:
   - org/team/project spend allocation
   - committed budget alerts and forecast models
   - anomaly detection
5. Enterprise reliability:
   - HA management plane
   - backup/restore and DR playbooks with tested RTO/RPO
   - SLA/SLO reporting
6. Enterprise extensibility:
   - plugin SDK for custom policies, provider adapters, and observability sinks
   - webhook/event bus integrations

### Phase 4 Exit Criteria

1. SSO/SCIM and policy engine used in multi-tenant production accounts
2. Audit and compliance workflows validated by security stakeholders
3. DR runbooks validated in scheduled game-days

---

## Cross-Phase Engineering Standards

Apply from Phase 1 onward:

1. Compatibility-first contracts:
   - strict schema tests
   - backward compatibility policy
2. Test strategy:
   - unit + integration + contract + soak + chaos
3. Performance gates:
   - CI perf budgets for p50/p95/p99 and CPU/memory
4. Security gates:
   - dependency scanning
   - secret scanning
   - threat model updates per major feature
5. Release discipline:
   - release trains
   - migration notes
   - rollback procedure per release

---

## Suggested Execution Order (First 90 Days)

1. Build router/fallback core (Phase 1 Workstream B)
2. Add PostgreSQL + Redis control-plane foundation (Phase 1 Workstream C)
3. Ship observability stack and request IDs (Phase 1 Workstream D)
4. Expand endpoint surface (embeddings and responses first) (Phase 1 Workstream A)
5. Start Phase 2 hardening in parallel with Phase 1 stabilization

---

## Build vs Borrow Position

Recommendation:

1. Do not fork and absorb LiteLLM code wholesale
2. Use LiteLLM behavior as compatibility reference targets
3. Keep `untangle-ai` architecture modular and typed (TypeScript-first)
4. Add a regression suite that includes issue-class repros observed in public gateways
