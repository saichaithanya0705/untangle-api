import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type ServerOptions } from '../index.js';
import { ProviderRegistry, type ProviderAdapter, type Config } from '@untangle-ai/core';

function createMockProvider(id: string, models: string[]): ProviderAdapter {
  const config = {
    id,
    name: `Provider ${id}`,
    enabled: true,
    baseUrl: `https://${id}.example.com/v1`,
    authHeader: 'Authorization',
    authScheme: 'Bearer',
    models: models.map((model) => ({
      id: model,
      enabled: true,
      contextWindow: 4096,
      maxOutputTokens: 4096,
      capabilities: ['chat' as const],
    })),
  };

  return {
    config,
    supportsModel(modelId: string) {
      return config.models.some((model) => model.id === modelId && model.enabled);
    },
    getModelConfig(modelId: string) {
      return config.models.find((model) => model.id === modelId);
    },
    transformRequest(request) {
      return request;
    },
    transformResponse(response) {
      return response as any;
    },
    transformStreamChunk(chunk: string) {
      return JSON.parse(chunk);
    },
    normalizeError(error) {
      if (typeof error === 'object' && error !== null && 'error' in error) {
        return error as { error: { message: string; type: string; code: string | null } };
      }
      return { error: { message: String(error), type: 'api_error', code: null } };
    },
    getEndpointUrl(endpoint) {
      return endpoint === 'chat'
        ? `${config.baseUrl}/chat/completions`
        : `${config.baseUrl}/models`;
    },
    getAuthHeaders(apiKey) {
      return { Authorization: `Bearer ${apiKey}` };
    },
    buildAuthenticatedUrl(endpoint) {
      return endpoint === 'chat'
        ? `${config.baseUrl}/chat/completions`
        : `${config.baseUrl}/models`;
    },
  };
}

function createEmbeddingsApp(config: any) {
  const registry = new ProviderRegistry();
  registry.register(createMockProvider('primary', ['primary-embedding-model']));
  registry.register(createMockProvider('secondary', ['secondary-embedding-model']));

  const runtimeKeys = new Map<string, string>([
    ['primary', 'primary-key'],
    ['secondary', 'secondary-key'],
  ]);

  const options: ServerOptions = {
    registry,
    config: {
      server: { port: 3000, host: 'localhost' },
      providers: {},
      routing: config,
      controlPlane: {
        enabled: false,
        failureMode: 'fallback',
        virtualKeyHeader: 'x-untangle-key',
        postgres: { enabled: false, schema: 'public' },
        redis: { enabled: false, keyPrefix: 'untangle' },
      },
    },
    getApiKey: (providerId) => runtimeKeys.get(providerId),
  };

  return createApp(options);
}

describe('Embeddings Route', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to next deployment on retryable status codes', async () => {
    const app = createEmbeddingsApp({
      groups: [{
        alias: 'embed-prod',
        strategy: 'priority',
        deployments: [
          { provider: 'primary', model: 'primary-embedding-model', priority: 0 },
          { provider: 'secondary', model: 'secondary-embedding-model', priority: 1 },
        ],
      }],
    });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'try later', type: 'api_error', code: null },
      }), {
        status: 503,
        headers: { 'content-type': 'application/json', 'retry-after': '1' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        object: 'list',
        data: [{
          object: 'embedding',
          embedding: [0.1, 0.2, 0.3],
          index: 0,
        }],
        model: 'secondary-embedding-model',
        usage: { prompt_tokens: 8, total_tokens: 8 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await app.request('/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'embed-prod',
        input: 'hello world',
      }),
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const body = await response.json() as { model: string; data: Array<{ embedding: number[] }> };
    expect(body.model).toBe('secondary-embedding-model');
    expect(body.data[0]?.embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it('returns 400 for invalid input body', async () => {
    const app = createEmbeddingsApp({
      groups: [{
        alias: 'embed-prod',
        strategy: 'priority',
        deployments: [
          { provider: 'primary', model: 'primary-embedding-model', priority: 0 },
        ],
      }],
    });

    const response = await app.request('/v1/embeddings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'embed-prod',
      }),
    });

    expect(response.status).toBe(400);
    const body = await response.json() as { error: { code: string } };
    expect(body.error.code).toBe('invalid_body');
  });
});
