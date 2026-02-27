# Phase 2 Hardening Runbook

Date: February 27, 2026

## Local Validation

1. Full Phase 2 gate:
   - `pnpm run validate:phase2`
2. Chaos-only:
   - `pnpm run phase2:chaos`
3. Soak-only:
   - `pnpm run phase2:soak`
4. Release safety:
   - `pnpm run phase2:release-safety`

## Soak Tuning (Environment Variables)

- `UNTANGLE_SOAK_ITERATIONS` (default `600`)
- `UNTANGLE_SOAK_SAMPLE_EVERY` (default `50`)
- `UNTANGLE_SOAK_MAX_HEAP_GROWTH_MB` (default `80`)
- `UNTANGLE_SOAK_MAX_P95_MS` (default `350`)
- `UNTANGLE_SOAK_MAX_ERROR_RATE` (default `0.01`)
- `UNTANGLE_SOAK_MIN_FALLBACK_RATE` (default `0.1`)
- `UNTANGLE_SOAK_MAX_FALLBACK_RATE` (default `0.5`)

Example:

```bash
UNTANGLE_SOAK_ITERATIONS=5000 \
UNTANGLE_SOAK_MAX_HEAP_GROWTH_MB=120 \
pnpm --filter @untangle-ai/server test:soak
```

## Provider Billing Export Reconciliation

Run against a live server with control-plane data:

```bash
node scripts/reconcile-provider-billing.js \
  --provider openai \
  --csv path/to/openai-billing-export.csv \
  --model-column model \
  --cost-column cost_usd \
  --timestamp-column timestamp \
  --tolerance-usd 0.01
```

The command exits:

- `0` when within tolerance
- `2` when reconciliation completes but exceeds tolerance
- `1` on validation/runtime errors
