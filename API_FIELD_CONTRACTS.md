# API Field Contracts (Canonical Reference)

Date: February 27, 2026

Purpose: Single source of truth for accepted request fields on write endpoints, with strict-validation behavior.

## Compatibility Rules

1. `api.compatibility.strictValidation=true`
   - Rejects unknown JSON body fields with `400` and `code: "unknown_fields"`.
2. `api.compatibility.normalizeLegacyParams=true`
   - Applies legacy field normalization for selected data-plane endpoints (listed below).

## Data Plane Contracts

### `POST /v1/chat/completions`

Allowed body fields:
`model`, `messages`, `stream`, `stream_options`, `temperature`, `top_p`, `max_tokens`, `max_completion_tokens`, `n`, `stop`, `presence_penalty`, `frequency_penalty`, `logit_bias`, `user`, `tools`, `tool_choice`, `response_format`, `seed`, `parallel_tool_calls`, `input`

Normalization:
1. `max_completion_tokens` -> `max_tokens` when `max_tokens` is missing.
2. `input` (string/string[]) -> `messages` when `messages` is missing.
3. `response_format: "json"` -> `{ "type": "json_object" }`.

### `POST /v1/responses`

Allowed body fields:
`model`, `input`, `messages`, `prompt`, `instructions`, `stream`, `temperature`, `top_p`, `max_output_tokens`, `max_tokens`, `tools`, `tool_choice`

Normalization:
1. `max_tokens` -> `max_output_tokens` when `max_output_tokens` is missing.
2. `messages` -> `input` when `input` is missing.
3. `prompt` (string) -> `input` when `input` is missing.

### `POST /v1/embeddings`

Allowed body fields:
`model`, `input`, `encoding_format`, `dimensions`, `user`

Normalization:
1. Numeric `input` values are converted to strings.

### `POST /v1/audio/transcriptions`

Allowed body fields:
`model`, `file`, `prompt`, `response_format`, `temperature`, `language`

### `POST /v1/audio/speech`

Allowed body fields:
`model`, `input`, `voice`, `response_format`, `speed`

### `POST /v1/images/generations`

Allowed body fields:
`model`, `prompt`, `n`, `size`, `quality`, `style`, `response_format`, `user`

## Control Plane and Management Contracts

### `POST /api/control-plane/keys`

Allowed body fields:
`name`, `key`, `limits`, `metadata`

### `POST /api/control-plane/limits/check`

Allowed body fields:
`key`, `modelId`, `inputTokens`

### `POST /api/control-plane/reconciliation/provider-export`

Allowed body fields:
`providerId`, `toleranceUsd`, `startDate`, `endDate`, `records`

Allowed per-record fields (`records[]`):
`providerId`, `modelId`, `costUsd`, `timestamp`, `requestCount`

### `POST /api/keys/:provider`

Allowed body fields:
`apiKey`

### `POST /api/pricing/calculate`

Allowed body fields:
`provider`, `model`, `inputTokens`, `outputTokens`

### `POST /api/models/:providerId/:modelId/toggle`

Allowed body fields:
`enabled`

### `POST /api/models/:providerId/toggle`

Allowed body fields:
`modelId`, `enabled`

### `POST /api/models/:providerId/add`

Allowed body fields:
`models`

### `POST /api/providers/:providerId/toggle`

Allowed body fields:
`enabled`

## Query Contracts

### `GET /api/control-plane/reconciliation`

Optional query params:
`toleranceUsd` (finite number)

### `GET /api/usage/reconciliation`

Optional query params:
`toleranceUsd` (finite number)
