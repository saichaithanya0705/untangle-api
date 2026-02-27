import { describe, expect, it } from 'vitest';
import { createApp, type ServerOptions } from '../index.js';
import { ProviderRegistry, type ProviderAdapter, type Config } from '@untangle-ai/core';

function createMockProvider(id: string): ProviderAdapter {
  const config = {
    id,
    name: `Provider ${id}`,
    enabled: true,
    baseUrl: 'https://api.test.com/v1',
    authHeader: 'Authorization',
    authScheme: 'Bearer',
    models: [
      { id: `${id}-model-1`, enabled: true, contextWindow: 4096, maxOutputTokens: 4096, capabilities: ['chat' as const] },
    ],
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
      return { error: { message: String(error), type: 'api_error', code: null } };
    },
    getEndpointUrl(endpoint) {
      return endpoint === 'chat' ? `${config.baseUrl}/chat/completions` : `${config.baseUrl}/models`;
    },
    getAuthHeaders(apiKey) {
      return { Authorization: `Bearer ${apiKey}` };
    },
    buildAuthenticatedUrl(endpoint) {
      return endpoint === 'chat' ? `${config.baseUrl}/chat/completions` : `${config.baseUrl}/models`;
    },
  };
}

function createStrictApp() {
  const registry = new ProviderRegistry();
  registry.register(createMockProvider('strict-provider'));

  const config: Config = {
    server: { port: 3000, host: 'localhost' },
    providers: {},
    routing: {
      groups: [],
      defaultStrategy: 'priority',
      defaultCooldownMs: 0,
      defaultRetryPolicy: { maxAttempts: 3, retryableStatusCodes: [408, 409, 429, 500, 502, 503, 504] },
      defaultCircuitBreaker: { failureThreshold: 3, resetTimeoutMs: 30000 },
      defaultStreamFallbackPolicy: undefined,
    },
    controlPlane: {
      enabled: false,
      virtualKeyHeader: 'x-untangle-key',
      postgres: { enabled: false, schema: 'public' },
      redis: { enabled: false, keyPrefix: 'untangle' },
    },
    api: {
      compatibility: {
        strictValidation: true,
        normalizeLegacyParams: true,
      },
    },
  };

  const options: ServerOptions = {
    registry,
    config,
    getApiKey: () => 'test-key',
  };

  return createApp(options);
}

describe('Management route strict compatibility', () => {
  it('rejects unknown fields for /api/models/:providerId/:modelId/toggle', async () => {
    const app = createStrictApp();
    const res = await app.request('/api/models/strict-provider/strict-provider-model-1/toggle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, unknown: true }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('unknown_fields');
  });

  it('rejects unknown fields for /api/models/:providerId/toggle', async () => {
    const app = createStrictApp();
    const res = await app.request('/api/models/strict-provider/toggle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        modelId: 'strict-provider-model-1',
        enabled: true,
        unknown: true,
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('unknown_fields');
  });

  it('rejects unknown fields for /api/models/:providerId/add', async () => {
    const app = createStrictApp();
    const res = await app.request('/api/models/strict-provider/add', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        models: [{
          id: 'strict-provider-model-2',
          name: 'Strict provider model 2',
          provider: 'strict-provider',
          contextWindow: 4096,
          maxOutputTokens: 2048,
          capabilities: ['chat'],
        }],
        unknown: true,
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('unknown_fields');
  });

  it('rejects unknown fields for /api/providers/:providerId/toggle', async () => {
    const app = createStrictApp();
    const res = await app.request('/api/providers/strict-provider/toggle', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: true, unknown: true }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { code: string };
    expect(body.code).toBe('unknown_fields');
  });
});
