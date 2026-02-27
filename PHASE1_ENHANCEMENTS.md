# Phase 1 Enhancement Backlog

Date: February 26, 2026

Purpose: Capture post-Phase-1 improvements that are non-blocking for completion but valuable for Phase 2 hardening.

## Prioritized Items

| ID | Priority | Area | Enhancement | Why it matters | Suggested Track | Status |
|---|---|---|---|---|---|---|
| E1 | P1 | Streaming fallback | Add deterministic integration tests for `continue-with-policy-prompt` mid-stream continuation and validate event sequencing under real stream interruption shapes. | Current coverage validates stream-safe baseline, but continuation mode still needs stronger deterministic proof across adapters. | Phase 2 streaming correctness suite | done |
| E2 | P1 | Provider conformance | Expand fixture coverage for Groq/OpenRouter parity plus richer multimodal/tool edge cases (nested tool args, partial tool-call deltas, mixed content blocks). | Prevents schema drift and regressions as adapter behavior evolves. | Phase 2 compatibility hardening | done |
| E3 | P1 | Reliability | Add CI load profile and thresholds for routing/fallback overhead (p95 latency, fallback rate, error rate) with pass/fail gates. | Turns Phase 1 load simulations into repeatable release gating. | Phase 2 soak/chaos program | done |
| E4 | P2 | Control plane | Add persistent tests for PostgreSQL and Redis adapters in CI (containerized test matrix), including startup fallback scenarios. | Reduces risk of adapter-specific regressions outside in-memory test mode. | Phase 2 reliability matrix | done |
| E5 | P2 | Billing integrity | Add reconciliation checks between usage tracker totals and stored spend ledger aggregates. | Strengthens spend/accounting confidence before enterprise expansion. | Phase 2 accounting integrity | done |
| E6 | P2 | Route compatibility | Extend strict validation/normalization checks to any remaining management endpoints and document canonical field contracts in one reference file. | Keeps operator/API behavior predictable and easier to audit. | Phase 2 API hardening | done |
| E7 | P3 | Operability | Add SLO-oriented dashboards and alert rules (fallback surge, provider error bursts, limiter denials, trace sampling drift). | Improves operational response time and production readiness. | Phase 2/3 observability | done |
| E8 | P2 | Test infrastructure | Add a reusable stream test harness utility to eliminate duplicated SSE fixture construction and reduce assertion races across chat/responses streaming tests. | Reduces flaky assertions and keeps stream regression tests maintainable. | Phase 2 streaming correctness suite | done |

## Notes

1. These items are intentionally enhancement-focused and do not block the Phase 1 completion mark.
2. `E1`, `E2`, and `E3` are the highest-value carry-forward tasks for immediate Phase 2 kickoff.

## Execution Updates

- 2026-02-26: `E1` baseline completed in test suite with deterministic continuation coverage.
- Added continuation-request unit coverage for chat/responses helper builders.
- Added routing coverage to verify stream fallback policy propagation (default and group override).
- Added deterministic stream-interruption continuation tests for `continue-with-policy-prompt` mode, including event-order assertions.
- 2026-02-27: `E2` completed with fixture-driven Groq/OpenRouter parity and tool-stream edge-case conformance tests.
- 2026-02-27: `E3` completed with CI load-profile gating (`p95 latency`, `fallback rate`, `error rate`) and `validate:phase1` execution path.
- 2026-02-27: `E4` completed with persistent adapter coverage:
  - bootstrap fallback scenarios via `bootstrapControlPlane`
  - PostgreSQL/Redis adapter unit coverage
  - optional container-backed integration tests (via `UNTANGLE_TEST_POSTGRES_URL` / `UNTANGLE_TEST_REDIS_URL`)
- 2026-02-27: `E5` completed with billing reconciliation service logic + control-plane/usage reconciliation endpoints and tests.
- 2026-02-27: `E6` completed with strict unknown-field checks for remaining management mutation endpoints and canonical contracts reference (`API_FIELD_CONTRACTS.md`).
- 2026-02-27: `E7` completed with SLO metrics expansion (trace sampling drift) and operations artifacts:
  - `observability/prometheus/alerts-phase1-slo.yml`
  - `observability/grafana/phase1-slo-dashboard.json`
- 2026-02-27: `E8` completed with shared stream harness utility + refactored chat/responses streaming tests.
