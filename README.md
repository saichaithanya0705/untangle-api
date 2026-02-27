# untangle-ai

`untangle-ai` is an OpenAI-compatible multi-provider API gateway with routing, fallback, control-plane limits/billing, observability, and an optional web UI.

It is designed to let you keep OpenAI-style client integrations while routing traffic across providers and models with operator controls.

## What You Get

- OpenAI-compatible data plane endpoints:
  - `POST /v1/chat/completions`
  - `POST /v1/responses`
  - `POST /v1/embeddings`
  - `POST /v1/audio/transcriptions`
  - `POST /v1/audio/speech`
  - `POST /v1/images/generations`
  - `GET /v1/models`, `GET /v1/models/:modelId`
- Multi-provider support:
  - OpenAI, Anthropic, Google, Groq, OpenRouter
  - Custom providers via request/response templates
- Deployment-group routing engine:
  - `priority`, `weighted`, `shuffle`, `least-latency`
  - retry/fallback with `Retry-After` support
  - cooldown + circuit breaker behavior
  - stream fallback policy controls
- Control-plane foundation (optional):
  - virtual keys
  - key-level limits (RPM/TPM/budgets/model allow-deny)
  - usage/spend/reconciliation endpoints
  - PostgreSQL/Redis adapters with safe in-memory fallback
- Observability:
  - structured request logs
  - Prometheus metrics at `GET /metrics`
  - W3C `traceparent` propagation and provider span logging
- Operator UI:
  - dashboard pages for providers, models, keys, usage, and settings (start with `--ui`)

## Architecture

Monorepo layout:

```text
packages/
  core/     shared types, provider adapters, routing, pricing, control-plane
  server/   Hono HTTP server and route handlers
  cli/      command-line entrypoint and commands
  ui/       React + Vite dashboard
```

Key docs in repo:

- [ROADMAP.md](./ROADMAP.md): long-term product direction
- [PLAN.md](./PLAN.md): phased execution and status
- [PHASE2_RUNBOOK.md](./PHASE2_RUNBOOK.md): hardening validation commands and soak tuning
- [API_FIELD_CONTRACTS.md](./API_FIELD_CONTRACTS.md): strict request/field contract notes

## Quick Start (Local)

### 1) Prerequisites

- Node.js `>=18`
- `pnpm` (workspace uses `pnpm@9`)

### 2) Install and Build

```bash
pnpm install
pnpm build
```

### 3) Initialize Config

```bash
pnpm --filter untangle-ai exec untangle-ai init
```

This creates `./untangle.yaml`. If no config is present, the server still starts with defaults.

### 4) Configure API Keys

You can provide provider keys by:

1. `untangle.yaml` (`providers.<id>.apiKey`)
2. CLI encrypted key store (`untangle-ai keys add <provider>`)
3. environment variables (for example `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`)

Example:

```bash
# macOS/Linux
export OPENAI_API_KEY=sk-...
export ANTHROPIC_API_KEY=sk-ant-...

# PowerShell
$env:OPENAI_API_KEY="sk-..."
$env:ANTHROPIC_API_KEY="sk-ant-..."
```

### 5) Start the Gateway

```bash
pnpm --filter untangle-ai start -- --host 127.0.0.1 --port 4010 --ui
```

Then open `http://127.0.0.1:4010`.

### 6) Smoke Test

```bash
curl http://127.0.0.1:4010/v1/models

curl http://127.0.0.1:4010/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"gpt-4o-mini\",\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}"
```

## CLI Commands

```bash
untangle-ai init
untangle-ai start [--port 3000] [--host localhost] [--config ./untangle.yaml] [--discover] [--ui]
untangle-ai keys add <provider>
untangle-ai keys list
untangle-ai keys remove <provider>
untangle-ai keys test <provider>
```

## API Surface

### Core Data Plane

| Method | Path | Notes |
|---|---|---|
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat, supports streaming |
| `POST` | `/v1/responses` | Responses API compatibility (stream + non-stream) |
| `POST` | `/v1/embeddings` | Embeddings proxy with routing/fallback |
| `POST` | `/v1/audio/transcriptions` | Provider-gated |
| `POST` | `/v1/audio/speech` | Provider-gated |
| `POST` | `/v1/images/generations` | Provider-gated |
| `GET` | `/v1/models` | List enabled models |
| `GET` | `/v1/models/:modelId` | Model details |

### Operational + Admin Plane

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Liveness |
| `GET` | `/metrics` | Prometheus metrics |
| `GET` | `/api/settings` | Effective runtime settings |
| `GET` | `/api/router/health` | Router runtime health snapshot |
| `GET` | `/api/router/decisions/:modelAlias` | Deployment selection debug snapshot |
| `GET` | `/api/usage` | Usage summary (`period` query support) |
| `GET` | `/api/usage/reconciliation` | Usage vs spend-ledger reconciliation |
| `GET` | `/api/usage/records` | Recent usage events |
| `DELETE` | `/api/usage` | Clear in-memory usage tracker (and control-plane events if enabled) |
| `GET` | `/api/pricing` | Cached model pricing |
| `POST` | `/api/pricing/refresh` | Refresh pricing cache |
| `POST` | `/api/pricing/calculate` | Cost estimate for token counts |
| `GET/POST` | `/api/discover/*` | Provider/model discovery and toggles |
| `GET/POST` | `/api/control-plane/*` | Virtual keys, limits, spend, reconciliation, schema |

## Configuration Example

```yaml
server:
  port: 3000
  host: localhost

providers:
  openai:
    enabled: true
  anthropic:
    enabled: true
  google:
    enabled: true
  groq:
    enabled: true
  openrouter:
    enabled: true

routing:
  groups:
    - alias: gpt-prod
      strategy: priority
      cooldownMs: 5000
      retryPolicy:
        maxAttempts: 3
        retryableStatusCodes: [408, 409, 429, 500, 502, 503, 504]
      circuitBreaker:
        failureThreshold: 3
        resetTimeoutMs: 30000
      streamFallbackPolicy:
        mode: continue-disabled
      deployments:
        - provider: openai
          model: gpt-4o
          priority: 0
        - provider: openrouter
          model: openai/gpt-4o
          priority: 1

controlPlane:
  enabled: true
  virtualKeyHeader: x-untangle-key
  postgres:
    enabled: true
    connectionString: postgresql://postgres:postgres@localhost:5432/untangle
    schema: public
  redis:
    enabled: true
    connectionString: redis://localhost:6379
    keyPrefix: untangle

observability:
  logging:
    level: info
  tracing:
    enabled: true
    sampleRate: 1.0
    logSpans: true
  metrics:
    providerLabels: true

api:
  compatibility:
    strictValidation: false
    normalizeLegacyParams: true
```

## Virtual Keys and Limits

When control-plane is enabled, clients can send a virtual key header (default `x-untangle-key`) to enforce per-key policy.

Create a key:

```bash
curl -X POST http://127.0.0.1:4010/api/control-plane/keys \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"team-a\",\"key\":\"cp_team_a\",\"limits\":{\"rpm\":60,\"allowedModels\":[\"gpt-prod\"]}}"
```

Use the key in data-plane calls:

```bash
curl http://127.0.0.1:4010/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "x-untangle-key: cp_team_a" \
  -d "{\"model\":\"gpt-prod\",\"messages\":[{\"role\":\"user\",\"content\":\"hello\"}]}"
```

## Hardening and Validation

Baseline:

```bash
pnpm test
pnpm run validate:phase1
```

Hardening suite:

```bash
pnpm run validate:phase2
pnpm run phase2:release-safety
pnpm run phase2:chaos
pnpm run phase2:soak
```

Provider billing reconciliation helper:

```bash
node scripts/reconcile-provider-billing.js \
  --server http://127.0.0.1:4010 \
  --provider openai \
  --csv path/to/provider-export.csv \
  --model-column model \
  --cost-column cost_usd \
  --timestamp-column timestamp \
  --tolerance-usd 0.01
```

## Development

```bash
pnpm install
pnpm build
pnpm dev
pnpm test
```

Useful package-level commands:

```bash
pnpm --filter @untangle-ai/server test
pnpm --filter @untangle-ai/ui dev
pnpm --filter untangle-ai start -- --ui
```

## Troubleshooting

- `model_not_found`: model alias is not enabled in provider/routing config.
- `missing_api_key`: provider key is not configured (file, key store, or env var).
- `unsupported_provider`: endpoint is not supported by selected provider (for example some media/embeddings flows).
- `control_plane_required`: reconciliation endpoint called without control-plane enabled.
- `control_plane_unavailable`: temporary PostgreSQL/Redis/control-plane dependency issue.

## Roadmap and Status

- Strategic roadmap: [ROADMAP.md](./ROADMAP.md)
- Implementation tracking: [PLAN.md](./PLAN.md)

## License

MIT
