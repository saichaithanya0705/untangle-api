import { Hono } from 'hono';
import type {
  ProviderRegistry,
  OpenAIError,
  DeploymentRouter,
  ControlPlaneService,
  ApiCompatibilityConfig,
  RoutingConfig,
} from '@untangle-ai/core';
import { usageTracker } from '@untangle-ai/core';
import { observabilityMetrics } from '../observability/metrics.js';
import { tracedFetch } from '../observability/tracing.js';
import { enforceVirtualKeyGate, estimateTextTokens } from './virtual-key.js';
import { findUnknownFields, normalizeEmbeddingsBody } from './compatibility.js';
import { resolveDeploymentSelectionContext } from './region-routing.js';

interface EmbeddingsContext {
  registry: ProviderRegistry;
  getApiKey: (providerId: string) => Promise<string | undefined> | string | undefined;
  router: DeploymentRouter;
  controlPlane?: ControlPlaneService;
  virtualKeyHeader?: string;
  requireVirtualKey?: boolean;
  apiCompatibility?: ApiCompatibilityConfig;
  routingConfig?: RoutingConfig;
}

const EMBEDDINGS_ALLOWED_FIELDS = new Set<string>([
  'model',
  'input',
  'encoding_format',
  'dimensions',
  'user',
]);

interface OpenAIEmbeddingsRequest {
  model: string;
  input: string | string[];
  encoding_format?: 'float' | 'base64';
  dimensions?: number;
  user?: string;
}

function toHttpErrorStatus(status: number): 400 | 401 | 403 | 404 | 408 | 409 | 422 | 429 | 500 | 502 | 503 | 504 {
  switch (status) {
    case 400:
    case 401:
    case 403:
    case 404:
    case 408:
    case 409:
    case 422:
    case 429:
    case 500:
    case 502:
    case 503:
    case 504:
      return status;
    default:
      return status >= 400 && status < 500 ? 400 : 502;
  }
}

function parseRetryAfterMs(value: string | null, nowMs = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const asSeconds = Number(trimmed);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.floor(asSeconds * 1000);
  }

  const parsedAt = Date.parse(trimmed);
  if (!Number.isNaN(parsedAt)) {
    return Math.max(0, parsedAt - nowMs);
  }

  return undefined;
}

function isValidEmbeddingsRequest(body: unknown): body is OpenAIEmbeddingsRequest {
  if (!body || typeof body !== 'object') return false;
  const maybe = body as Partial<OpenAIEmbeddingsRequest>;
  if (typeof maybe.model !== 'string' || maybe.model.length === 0) return false;
  if (typeof maybe.input === 'string') return maybe.input.length > 0;
  if (Array.isArray(maybe.input)) return maybe.input.every((item) => typeof item === 'string');
  return false;
}

function estimateEmbeddingInputTokens(input: string | string[]): number {
  const text = Array.isArray(input) ? input.join('\n') : input;
  return estimateTextTokens(text);
}

function missingApiKeyError(providerId: string): OpenAIError {
  return {
    error: {
      message: `No API key configured for provider: ${providerId}`,
      type: 'authentication_error',
      code: 'missing_api_key',
    },
  };
}

async function readUpstreamError(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('application/json')) {
    return response.json().catch(() => ({ error: { message: response.statusText } }));
  }

  const text = await response.text().catch(() => response.statusText);
  return { error: { message: text || response.statusText } };
}

function supportsEmbeddingsProxy(providerId: string): boolean {
  return providerId !== 'anthropic' && providerId !== 'google';
}

function normalizeError(
  adapter: { normalizeError: (error: unknown) => OpenAIError },
  error: unknown
): OpenAIError {
  const normalized = adapter.normalizeError(error);
  if (normalized.error.code === undefined) {
    normalized.error.code = null;
  }
  return normalized;
}

export function createEmbeddingsRoutes(ctx: EmbeddingsContext) {
  const app = new Hono();
  const deploymentRouter = ctx.router;

  app.post('/v1/embeddings', async (c) => {
    const startTime = Date.now();
    let providerId = '';
    let modelId = '';
    const rawBody = await c.req.json().catch(() => null);
    const normalizedBody = normalizeEmbeddingsBody(rawBody, ctx.apiCompatibility);
    if (!normalizedBody) {
      return c.json<OpenAIError>({
        error: {
          message: 'Invalid request body. Expected { model: string, input: string | string[] }',
          type: 'invalid_request_error',
          code: 'invalid_body',
        },
      }, 400);
    }

    const unknownFields = findUnknownFields(normalizedBody, EMBEDDINGS_ALLOWED_FIELDS, ctx.apiCompatibility);
    if (unknownFields.length > 0) {
      return c.json<OpenAIError>({
        error: {
          message: `Unknown request fields: ${unknownFields.join(', ')}`,
          type: 'invalid_request_error',
          code: 'unknown_fields',
        },
      }, 400);
    }

    if (!isValidEmbeddingsRequest(normalizedBody)) {
      return c.json<OpenAIError>({
        error: {
          message: 'Invalid request body. Expected { model: string, input: string | string[] }',
          type: 'invalid_request_error',
          code: 'invalid_body',
        },
      }, 400);
    }

    const body: OpenAIEmbeddingsRequest = normalizedBody;
    const estimatedInputTokens = estimateEmbeddingInputTokens(body.input);
    const virtualKeyGate = await enforceVirtualKeyGate(c, ctx, {
      modelId: body.model,
      inputTokens: estimatedInputTokens,
    });
    if (virtualKeyGate.deniedResponse) {
      return virtualKeyGate.deniedResponse;
    }
    const usageMetadata = virtualKeyGate.virtualKeyId
      ? { virtualKeyId: virtualKeyGate.virtualKeyId }
      : undefined;
    const selectionContext = resolveDeploymentSelectionContext(c, ctx.routingConfig);
    const selection = deploymentRouter.selectDeployments(body.model, ctx.registry, selectionContext);
    if (selection.deployments.length === 0) {
      return c.json<OpenAIError>({
        error: { message: `Model not found: ${body.model}`, type: 'invalid_request_error', code: 'model_not_found' },
      }, 404);
    }

    let lastError: OpenAIError | null = null;
    let lastStatus = 500;
    let attempt = 0;

    for (const deployment of selection.deployments) {
      attempt += 1;
      providerId = deployment.providerId;
      modelId = deployment.modelId;

      if (!supportsEmbeddingsProxy(deployment.providerId)) {
        lastError = {
          error: {
            message: `Embeddings are not supported by provider: ${deployment.providerId}`,
            type: 'invalid_request_error',
            code: 'unsupported_provider',
          },
        };
        lastStatus = 400;
        observabilityMetrics.recordFallback();
        continue;
      }

      const apiKey = await ctx.getApiKey(deployment.providerId);
      if (!apiKey) {
        lastError = missingApiKeyError(deployment.providerId);
        lastStatus = 401;
        observabilityMetrics.recordFallback();
        continue;
      }

      const requestBody: OpenAIEmbeddingsRequest = {
        ...body,
        model: deployment.modelId,
      };

      const endpointUrl = `${deployment.adapter.config.baseUrl}/embeddings`;
      const headers = {
        'Content-Type': 'application/json',
        ...deployment.adapter.getAuthHeaders(apiKey),
      };

      try {
        const response = await tracedFetch(c, endpointUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
        }, {
          providerId: deployment.providerId,
          modelId: deployment.modelId,
          endpoint: 'embeddings',
          attempt,
        });

        if (!response.ok) {
          const upstreamError = await readUpstreamError(response);
          const normalized = normalizeError(deployment.adapter, upstreamError);

          deploymentRouter.recordFailure(deployment, {
            retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
          });

          lastError = normalized;
          lastStatus = response.status;

          if (deploymentRouter.isRetryableStatus(deployment, response.status)) {
            observabilityMetrics.recordFallback();
            continue;
          }

          usageTracker.recordUsage(
            providerId,
            modelId,
            estimatedInputTokens,
            0,
            Date.now() - startTime,
            false,
            normalized.error.message,
            usageMetadata,
          );
          return c.json(normalized, toHttpErrorStatus(response.status));
        }

        const payload = await response.json();
        deploymentRouter.recordSuccess(deployment, 0);
        usageTracker.recordUsage(
          providerId,
          modelId,
          estimatedInputTokens,
          0,
          Date.now() - startTime,
          true,
          undefined,
          usageMetadata,
        );
        return c.json(payload);
      } catch (err) {
        deploymentRouter.recordFailure(deployment);
        const normalized = normalizeError(deployment.adapter, err);
        lastError = normalized;
        lastStatus = 502;

        if (deploymentRouter.isRetryableError(deployment, err)) {
          observabilityMetrics.recordFallback();
          continue;
        }

        usageTracker.recordUsage(
          providerId,
          modelId,
          estimatedInputTokens,
          0,
          Date.now() - startTime,
          false,
          String(err),
          usageMetadata,
        );
        return c.json(normalized, 500);
      }
    }

    const finalError: OpenAIError = lastError ?? {
      error: {
        message: 'No healthy deployment available for the requested model.',
        type: 'service_unavailable',
        code: 'no_healthy_deployment',
      },
    };

    if (providerId && modelId) {
      usageTracker.recordUsage(
        providerId,
        modelId,
        estimatedInputTokens,
        0,
        Date.now() - startTime,
        false,
        finalError.error.message,
        usageMetadata,
      );
    }

    return c.json(finalError, toHttpErrorStatus(lastStatus));
  });

  return app;
}
