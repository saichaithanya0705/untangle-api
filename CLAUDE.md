# untangle-ai

## Build
- `pnpm build` — turbo-based monorepo build (core → server/ui → cli)
- Always rebuild after changing core or server packages

## Architecture
- Monorepo: `packages/core`, `packages/server`, `packages/ui` (React+Vite), `packages/cli`
- Provider adapters: `packages/core/src/providers/` — each extends `BaseProviderAdapter`
- Registry: `packages/core/src/providers/registry.ts` — `list()` filters by `config.enabled`
- Model discovery: `packages/core/src/discovery/model-discovery.ts`
- Server routes: `packages/server/src/routes/`
- UI API client: `packages/ui/src/lib/api.ts`

## Providers
- API key env var pattern: `${PROVIDER_ID.toUpperCase()}_API_KEY` (e.g., `OPENROUTER_API_KEY`)
- Providers without API keys are disabled (`setProviderEnabled(id, false)`) and hidden from UI
- OpenRouter model IDs use `provider/model` format (e.g., `anthropic/claude-sonnet-4`), aliases use `or-` prefix
- Anthropic direct API IDs differ from OpenRouter (e.g., `claude-sonnet-4-20250514` vs `anthropic/claude-sonnet-4`)
- Anthropic has a `/v1/models` endpoint (requires `x-api-key` + `anthropic-version` headers)

## UI
- Pages that display provider/model data: Dashboard, Models, Providers, Keys
- Provider visibility changes must be verified across ALL these pages
- UI fetches providers from `/api/providers` (only returns enabled providers)
