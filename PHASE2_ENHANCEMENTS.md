# Phase 2 Enhancements Backlog

Date: February 27, 2026

## 1) Remove Node module-type warnings in release scripts

- Convert `scripts/check-control-plane-migration.js`, `scripts/generate-rollback-plan.js`, and `scripts/release-safety-check.js` to either:
  - `.mjs`, or
  - CommonJS (`require`) style `.js`.
- Update all npm/workflow references accordingly.
- Goal: zero `[MODULE_TYPELESS_PACKAGE_JSON]` warnings in CI logs.

## 2) Add upgrade-path compatibility matrix gate

- Add CI job to validate upgrade scenarios across recent minor versions.
- Minimum checks:
  - Migration artifact compatibility
  - Control-plane reconciliation endpoint behavior
  - Routing/fallback behavior parity
- Goal: explicit evidence for Phase 2 exit criterion "upgrade path validated across recent minor versions".

## 3) Persist long-run soak trend artifacts

- Publish nightly soak outputs to artifacts with:
  - p95 latency trend
  - heap growth trend
  - error/fallback rates over time
- Add threshold drift alerts when trend worsens but still stays under hard fail thresholds.
- Goal: produce durable evidence for the 30-day soak stability criterion.
