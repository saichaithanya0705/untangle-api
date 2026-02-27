import { Hono } from 'hono';
import type {
  ProviderRegistry,
  OpenAIError,
  DeploymentRouter,
  ControlPlaneService,
  ApiCompatibilityConfig,
} from '@untangle-ai/core';
import { usageTracker } from '@untangle-ai/core';
import { observabilityMetrics } from '../observability/metrics.js';
import { tracedFetch } from '../observability/tracing.js';
import { enforceVirtualKeyGate, estimateTextTokens } from './virtual-key.js';
import { findUnknownFields, resolveApiCompatibility } from './compatibility.js';

interface MediaContext {
  registry: ProviderRegistry;
  getApiKey: (providerId: string) => Promise<string | undefined> | string | undefined;
  router: DeploymentRouter;
  controlPlane?: ControlPlaneService;
  virtualKeyHeader?: string;
  apiCompatibility?: ApiCompatibilityConfig;
}

interface AudioSpeechRequest {
  model: string;
  input: string;
  voice: string;
  response_format?: 'mp3' | 'opus' | 'aac' | 'flac' | 'wav' | 'pcm';
  speed?: number;
}

interface ImageGenerationRequest {
  model: string;
  prompt: string;
  n?: number;
  size?: string;
  quality?: string;
  style?: string;
  response_format?: 'url' | 'b64_json';
  user?: string;
}

const AUDIO_TRANSCRIPTION_ALLOWED_FIELDS = new Set<string>([
  'file',
  'model',
  'language',
  'prompt',
  'response_format',
  'temperature',
  'timestamp_granularities[]',
]);

const AUDIO_SPEECH_ALLOWED_FIELDS = new Set<string>([
  'model',
  'input',
  'voice',
  'response_format',
  'speed',
]);

const IMAGE_GENERATION_ALLOWED_FIELDS = new Set<string>([
  'model',
  'prompt',
  'n',
  'size',
  'quality',
  'style',
  'response_format',
  'user',
]);

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

async function readUpstreamError(response: Response): Promise<unknown> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  if (contentType.includes('application/json')) {
    return response.json().catch(() => ({ error: { message: response.statusText } }));
  }

  const text = await response.text().catch(() => response.statusText);
  return { error: { message: text || response.statusText } };
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

function supportsAudioProvider(providerId: string): boolean {
  return providerId !== 'anthropic' && providerId !== 'google';
}

function supportsImageProvider(providerId: string): boolean {
  return providerId !== 'anthropic' && providerId !== 'google';
}

function isValidSpeechRequest(body: unknown): body is AudioSpeechRequest {
  if (!body || typeof body !== 'object') return false;
  const maybe = body as Partial<AudioSpeechRequest>;
  return typeof maybe.model === 'string'
    && maybe.model.length > 0
    && typeof maybe.input === 'string'
    && maybe.input.length > 0
    && typeof maybe.voice === 'string'
    && maybe.voice.length > 0;
}

function isValidImageRequest(body: unknown): body is ImageGenerationRequest {
  if (!body || typeof body !== 'object') return false;
  const maybe = body as Partial<ImageGenerationRequest>;
  return typeof maybe.model === 'string'
    && maybe.model.length > 0
    && typeof maybe.prompt === 'string'
    && maybe.prompt.length > 0;
}

export function createMediaRoutes(ctx: MediaContext) {
  const app = new Hono();
  const deploymentRouter = ctx.router;
  const compatibility = resolveApiCompatibility(ctx.apiCompatibility);

  app.post('/v1/audio/transcriptions', async (c) => {
    const startTime = Date.now();
    let providerId = '';
    let modelId = '';
    const formData = await c.req.formData().catch(() => null);
    const model = typeof formData?.get('model') === 'string' ? String(formData.get('model')) : '';
    const file = formData?.get('file');

    if (!formData || model.length === 0 || !file) {
      return c.json<OpenAIError>({
        error: {
          message: 'Invalid multipart body. Expected at least model and file fields.',
          type: 'invalid_request_error',
          code: 'invalid_body',
        },
      }, 400);
    }

    if (compatibility.strictValidation) {
      const unknownFields = Array.from(formData.keys())
        .filter((key) => !AUDIO_TRANSCRIPTION_ALLOWED_FIELDS.has(key))
        .sort((a, b) => a.localeCompare(b));
      if (unknownFields.length > 0) {
        return c.json<OpenAIError>({
          error: {
            message: `Unknown multipart fields: ${unknownFields.join(', ')}`,
            type: 'invalid_request_error',
            code: 'unknown_fields',
          },
        }, 400);
      }
    }

    const virtualKeyGate = await enforceVirtualKeyGate(c, ctx, {
      modelId: model,
      inputTokens: 0,
    });
    if (virtualKeyGate.deniedResponse) {
      return virtualKeyGate.deniedResponse;
    }
    const usageMetadata = virtualKeyGate.virtualKeyId
      ? { virtualKeyId: virtualKeyGate.virtualKeyId }
      : undefined;

    const selection = deploymentRouter.selectDeployments(model, ctx.registry);
    if (selection.deployments.length === 0) {
      return c.json<OpenAIError>({
        error: { message: `Model not found: ${model}`, type: 'invalid_request_error', code: 'model_not_found' },
      }, 404);
    }

    let lastError: OpenAIError | null = null;
    let lastStatus = 500;
    let attempt = 0;

    for (const deployment of selection.deployments) {
      attempt += 1;
      providerId = deployment.providerId;
      modelId = deployment.modelId;

      if (!supportsAudioProvider(deployment.providerId)) {
        lastError = {
          error: {
            message: `Audio transcriptions are not supported by provider: ${deployment.providerId}`,
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

      const upstreamForm = new FormData();
      for (const [key, value] of formData.entries()) {
        if (key === 'model') {
          upstreamForm.append('model', deployment.modelId);
          continue;
        }
        upstreamForm.append(key, value);
      }

      const endpointUrl = `${deployment.adapter.config.baseUrl}/audio/transcriptions`;
      const headers = {
        ...deployment.adapter.getAuthHeaders(apiKey),
      };

      try {
        const response = await tracedFetch(c, endpointUrl, {
          method: 'POST',
          headers,
          body: upstreamForm,
        }, {
          providerId: deployment.providerId,
          modelId: deployment.modelId,
          endpoint: 'audio.transcriptions',
          attempt,
        });

        if (!response.ok) {
          const upstreamError = await readUpstreamError(response);
          const normalized = deployment.adapter.normalizeError(upstreamError);
          lastError = normalized;
          lastStatus = response.status;

          deploymentRouter.recordFailure(deployment, {
            retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
          });

          if (deploymentRouter.isRetryableStatus(deployment, response.status)) {
            observabilityMetrics.recordFallback();
            continue;
          }

          usageTracker.recordUsage(
            providerId,
            modelId,
            0,
            0,
            Date.now() - startTime,
            false,
            normalized.error.message,
            usageMetadata,
          );
          return c.json(normalized, toHttpErrorStatus(response.status));
        }

        deploymentRouter.recordSuccess(deployment, 0);
        usageTracker.recordUsage(
          providerId,
          modelId,
          0,
          0,
          Date.now() - startTime,
          true,
          undefined,
          usageMetadata,
        );
        const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
        if (contentType.includes('application/json')) {
          return c.json(await response.json());
        }

        const text = await response.text();
        return c.body(text, 200, {
          'Content-Type': response.headers.get('content-type') ?? 'text/plain; charset=utf-8',
        });
      } catch (err) {
        deploymentRouter.recordFailure(deployment);
        lastError = deployment.adapter.normalizeError(err);
        lastStatus = 502;

        if (deploymentRouter.isRetryableError(deployment, err)) {
          observabilityMetrics.recordFallback();
          continue;
        }

        usageTracker.recordUsage(
          providerId,
          modelId,
          0,
          0,
          Date.now() - startTime,
          false,
          String(err),
          usageMetadata,
        );
        return c.json(lastError, 500);
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
        0,
        0,
        Date.now() - startTime,
        false,
        finalError.error.message,
        usageMetadata,
      );
    }
    return c.json(finalError, toHttpErrorStatus(lastStatus));
  });

  app.post('/v1/audio/speech', async (c) => {
    const startTime = Date.now();
    let providerId = '';
    let modelId = '';
    const rawBody = await c.req.json().catch(() => null);
    const speechBody = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)
      ? rawBody as Record<string, unknown>
      : null;
    if (speechBody) {
      const unknownFields = findUnknownFields(speechBody, AUDIO_SPEECH_ALLOWED_FIELDS, compatibility);
      if (unknownFields.length > 0) {
        return c.json<OpenAIError>({
          error: {
            message: `Unknown request fields: ${unknownFields.join(', ')}`,
            type: 'invalid_request_error',
            code: 'unknown_fields',
          },
        }, 400);
      }
    }
    if (!isValidSpeechRequest(rawBody)) {
      return c.json<OpenAIError>({
        error: {
          message: 'Invalid request body. Expected { model: string, input: string, voice: string }',
          type: 'invalid_request_error',
          code: 'invalid_body',
        },
      }, 400);
    }

    const body: AudioSpeechRequest = rawBody;
    const estimatedInputTokens = estimateTextTokens(body.input);
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

    const selection = deploymentRouter.selectDeployments(body.model, ctx.registry);
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

      if (!supportsAudioProvider(deployment.providerId)) {
        lastError = {
          error: {
            message: `Audio speech is not supported by provider: ${deployment.providerId}`,
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

      const requestBody: AudioSpeechRequest = {
        ...body,
        model: deployment.modelId,
      };

      const endpointUrl = `${deployment.adapter.config.baseUrl}/audio/speech`;
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
          endpoint: 'audio.speech',
          attempt,
        });

        if (!response.ok) {
          const upstreamError = await readUpstreamError(response);
          const normalized = deployment.adapter.normalizeError(upstreamError);
          lastError = normalized;
          lastStatus = response.status;

          deploymentRouter.recordFailure(deployment, {
            retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
          });

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
        const audio = new Uint8Array(await response.arrayBuffer());
        return c.body(audio, 200, {
          'Content-Type': response.headers.get('content-type') ?? 'audio/mpeg',
        });
      } catch (err) {
        deploymentRouter.recordFailure(deployment);
        lastError = deployment.adapter.normalizeError(err);
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
        return c.json(lastError, 500);
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

  app.post('/v1/images/generations', async (c) => {
    const startTime = Date.now();
    let providerId = '';
    let modelId = '';
    const rawBody = await c.req.json().catch(() => null);
    const imageBody = rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)
      ? rawBody as Record<string, unknown>
      : null;
    if (imageBody) {
      const unknownFields = findUnknownFields(imageBody, IMAGE_GENERATION_ALLOWED_FIELDS, compatibility);
      if (unknownFields.length > 0) {
        return c.json<OpenAIError>({
          error: {
            message: `Unknown request fields: ${unknownFields.join(', ')}`,
            type: 'invalid_request_error',
            code: 'unknown_fields',
          },
        }, 400);
      }
    }
    if (!isValidImageRequest(rawBody)) {
      return c.json<OpenAIError>({
        error: {
          message: 'Invalid request body. Expected { model: string, prompt: string }',
          type: 'invalid_request_error',
          code: 'invalid_body',
        },
      }, 400);
    }

    const body: ImageGenerationRequest = rawBody;
    const estimatedInputTokens = estimateTextTokens(body.prompt);
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

    const selection = deploymentRouter.selectDeployments(body.model, ctx.registry);
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

      if (!supportsImageProvider(deployment.providerId)) {
        lastError = {
          error: {
            message: `Image generations are not supported by provider: ${deployment.providerId}`,
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

      const requestBody: ImageGenerationRequest = {
        ...body,
        model: deployment.modelId,
      };

      const endpointUrl = `${deployment.adapter.config.baseUrl}/images/generations`;
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
          endpoint: 'images.generations',
          attempt,
        });

        if (!response.ok) {
          const upstreamError = await readUpstreamError(response);
          const normalized = deployment.adapter.normalizeError(upstreamError);
          lastError = normalized;
          lastStatus = response.status;

          deploymentRouter.recordFailure(deployment, {
            retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after')),
          });

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
        return c.json(await response.json());
      } catch (err) {
        deploymentRouter.recordFailure(deployment);
        lastError = deployment.adapter.normalizeError(err);
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
        return c.json(lastError, 500);
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
