# Hardening Runbook

This runbook covers the release-critical validation path for Untangle API. It is intentionally scoped to checks that should stay green before publishing the CLI package or tagging a release.

## Required commands

```bash
pnpm install
pnpm test
pnpm run validate:phase1
pnpm run validate:phase2
pnpm run pack:cli:dry-run
```

## What the validation gates cover

- `pnpm test`: workspace test suite through Turbo.
- `pnpm run validate:phase1`: full workspace build plus the server test suite.
- `pnpm run validate:phase2`: phase 1 gate, hardening tests, control-plane migration validation, rollback-plan generation, and CLI packaging dry-run.
- `pnpm run phase2:release-safety`: focused smoke, chaos, soak, rollback, and pack checks.

## Release artifacts

- `artifacts/release/rollback-plan.json`
- `artifacts/packages/untangle-api-<version>.tgz` from `pnpm run pack:cli`

Neither artifact should be committed.

## Operational checklist before publication

- Confirm admin auth is documented accurately and disabled only for localhost development.
- Confirm `/metrics` protection matches the config you plan to ship or document.
- Confirm provider examples do not contain real credentials.
- Confirm the CLI tarball contains only `dist/`, `ui-dist/`, `README.md`, `LICENSE`, and `package.json`.
- Confirm generated assets such as `packages/cli/ui-dist/` are rebuilt during pack and not checked into git.

## Longer-running checks

Use these when you want higher confidence than the default release gate:

```bash
pnpm run phase2:chaos
pnpm run phase2:soak
```
