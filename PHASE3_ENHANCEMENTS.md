# Phase 3 Enhancements Backlog

This file tracks follow-on enhancements identified while implementing Phase 3 baselines.

## Rollout Controls

1. Add streaming shadow mirroring with bounded buffers and cancellation safety.
2. Add per-lane metrics (`stable`, `canary`, `shadow`) for request count, error rate, and latency.
3. Add rollout stickiness options by virtual key and by explicit user identifier.
4. Add configurable canary auto-promotion/rollback guardrails based on SLO thresholds.

## Secrets and Security

1. Add managed secret backends (`aws-secrets-manager`, `gcp-secret-manager`, `azure-key-vault`) with short-lived caching.
2. Add encrypted-at-rest on-disk secret reference cache with rotation hooks.
3. Add admin auth audit trail endpoint and immutable log sink integration.
4. Add path-scoped admin auth policies so high-risk routes can use stricter auth controls.

## API-First Admin / IaC

1. Add signed spec support and optimistic concurrency with `etag`/generation fields.
2. Add reversible change bundles (`apply` + `rollback token`) for safer automation.
3. Add Terraform/Pulumi starter modules that call IaC endpoints for provider/model policy sync.
4. Add schema validation endpoint with JSON Schema output for CI preflight checks.
