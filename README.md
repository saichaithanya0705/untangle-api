# Untangle API

Untangle API is an OpenAI-compatible multi-provider API gateway. It keeps the familiar `/v1/*` surface while adding provider routing, fallback controls, virtual keys, usage accounting, observability, and a bundled admin UI.

This repository is a pnpm monorepo. The public package prepared for npm publication is `untangle-api`; the internal workspace packages remain private under the `@untangle-ai/*` scope.

## What exists today

- OpenAI-compatible endpoints for chat, responses, embeddings, audio transcription, audio speech, image generation, and model discovery.
- Provider adapters for OpenAI, Anthropic, Google, Groq, OpenRouter, plus custom templated providers.
- Deployment-group routing with priority, weighted, shuffle, least-latency, retry, cooldown, circuit breaker, regional failover, canary, A/B, and shadow traffic controls.
- Control-plane features for virtual keys, key-level limits, spend and usage tracking, reconciliation, and declarative export/plan/apply operations.
- Prometheus metrics, structured request logs, and trace propagation.
- A React admin UI served from the same gateway binary.

## Repository layout

```text
packages/
  core/    internal runtime, config, provider adapters, routing, control-plane
  server/  Hono HTTP server and route handlers
  cli/     public CLI package and release artifact
  ui/      React + Vite admin UI
```

Supporting docs:

- [`docs/hardening-runbook.md`](./docs/hardening-runbook.md)
- [`docs/api-field-contracts.md`](./docs/api-field-contracts.md)
- [`docs/roadmap.md`](./docs/roadmap.md)
- [`examples/`](./examples)

## Quick start from source

Requirements:

- Node.js `>=18.18.0`
- `pnpm@9`

Install and build:

```bash
pnpm install
pnpm build
```

Create a localhost-only config:

```bash
pnpm --filter untangle-api exec untangle-api init
```

That writes `./untangle-api.yaml` with local-development defaults. The generated file intentionally disables admin auth, metrics protection, and data-plane auth so you can boot the gateway on loopback quickly. Do not expose that config on `0.0.0.0` or behind a public ingress.

Configure a provider key:

```bash
# macOS/Linux
export OPENAI_API_KEY=sk-...

# PowerShell
$env:OPENAI_API_KEY="sk-..."
```

Start the gateway:

```bash
pnpm --filter untangle-api start -- --host 127.0.0.1 --port 4010
```

Smoke test:

```bash
curl http://127.0.0.1:4010/v1/models

curl http://127.0.0.1:4010/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"gpt-4o-mini\",\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}"
```

## Security defaults and production use

- `untangle-api init` is for local development only.
- For production, use [`examples/config/untangle-api.yaml`](./examples/config/untangle-api.yaml) as the starting point.
- Before exposing the gateway outside localhost, enable `security.requireAdminAuthForApi`, `security.protectMetrics`, and `security.requireDataPlaneAuth`.
- Set `security.adminApiKeySecretRef` or `security.adminApiKey` explicitly.
- When `requireDataPlaneAuth=true`, clients must send a valid virtual key in `x-untangle-key` unless you change `security.dataPlaneHeader`.
- If you want persisted keys and limits, enable Postgres and Redis under `controlPlane`; otherwise the gateway falls back to in-memory behavior where configured.

## CLI commands

```bash
untangle-api init
untangle-api start [--port 3000] [--host localhost] [--config ./untangle-api.yaml] [--discover] [--no-ui]
untangle-api keys add <provider>
untangle-api keys list
untangle-api keys remove <provider>
untangle-api keys test <provider>
```

`untangle-api keys add` stores runtime credentials in the local encrypted key store under `~/.untangle-api/master.key`, with migration fallback from the legacy `~/.untangle-ai/master.key` path.

## Validation and release checks

Core validation:

```bash
pnpm test
pnpm run validate:phase1
pnpm run validate:phase2
```

Focused hardening commands:

```bash
pnpm run phase2:release-safety
pnpm run phase2:chaos
pnpm run phase2:soak
```

CLI packaging:

```bash
pnpm run pack:cli:dry-run
pnpm run pack:cli
```

`pnpm run pack:cli` writes the tarball to `artifacts/packages/` and rejects unexpected published files.

## Public package identity

- Repository: `saichaithanya0705/untangle-api`
- Product name: `Untangle API`
- npm package: `untangle-api`
- CLI binary: `untangle-api`

The package metadata and tarball flow are ready for publication, but this repository does not assume a release already exists on npm. Use `pnpm run pack:cli` to test the package locally.

The internal workspace packages are implementation details and are intentionally marked private.

## Troubleshooting

- `missing_api_key`: the selected provider has no configured credential.
- `model_not_found`: the requested model alias is not enabled in provider or routing config.
- `data_plane_auth_required`: data-plane auth is enabled and no virtual key was supplied.
- `invalid_virtual_key`: the supplied virtual key does not resolve or has been revoked.
- `control_plane_unavailable`: the configured control-plane dependency is unavailable.

## License

MIT
