import { describe, it, expect, beforeAll } from 'vitest';
import { createApp, type ServerOptions } from '../index.js';
import { ProviderRegistry, type ProviderAdapter, type Config } from '@untangle-ai/core';

// Create a mock provider for testing
function createMockProvider(id: string, enabled: boolean = true): ProviderAdapter {
  const config = {
    id,
    name: `Test Provider ${id}`,
    enabled,
    baseUrl: 'https://api.test.com',
    authHeader: 'Authorization',
    models: [
      { id: `${id}-model-1`, enabled: true, contextWindow: 4096, maxOutputTokens: 4096, capabilities: ['chat' as const] },
      { id: `${id}-model-2`, enabled: true, contextWindow: 4096, maxOutputTokens: 4096, capabilities: ['chat' as const] },
      { id: `${id}-disabled-model`, enabled: false, contextWindow: 4096, maxOutputTokens: 4096, capabilities: ['chat' as const] },
    ],
  };

  return {
    config,
    supportsModel(modelId: string) {
      return config.models.some(m => m.id === modelId && m.enabled);
    },
    getModelConfig(modelId: string) {
      return config.models.find(m => m.id === modelId);
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

describe('Integration Tests', () => {
  let app: ReturnType<typeof createApp>;
  const runtimeKeys = new Map<string, string>();

  beforeAll(() => {
    const registry = new ProviderRegistry();
    registry.register(createMockProvider('test-provider'));
    registry.register(createMockProvider('disabled-provider', false));

    const config: Config = {
      server: {
        port: 3000,
        host: 'localhost',
      },
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
    };

    const options: ServerOptions = {
      registry,
      config,
      getApiKey: (providerId) => runtimeKeys.get(providerId),
      setApiKey: (providerId, apiKey) => {
        runtimeKeys.set(providerId, apiKey);
      },
      removeApiKey: (providerId) => {
        runtimeKeys.delete(providerId);
      },
    };

    runtimeKeys.set('test-provider', 'test-key');
    app = createApp(options);
  });

  describe('GET /health', () => {
    it('should return ok status', async () => {
      const res = await app.request('/health');
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toEqual({ status: 'ok' });
    });

    it('should attach a request id header', async () => {
      const res = await app.request('/health');
      expect(res.status).toBe(200);
      expect(res.headers.get('x-request-id')).toBeTruthy();
    });

    it('should preserve caller-supplied request id header', async () => {
      const res = await app.request('/health', {
        headers: { 'x-request-id': 'req-test-123' },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('x-request-id')).toBe('req-test-123');
    });

    it('should include traceparent response header', async () => {
      const res = await app.request('/health');
      expect(res.status).toBe(200);
      const traceparent = res.headers.get('traceparent');
      expect(traceparent).toBeTruthy();
      expect(traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
    });

    it('should preserve incoming trace id in traceparent response', async () => {
      const incoming = '00-11111111111111111111111111111111-2222222222222222-01';
      const res = await app.request('/health', {
        headers: { traceparent: incoming },
      });
      expect(res.status).toBe(200);
      const outgoing = res.headers.get('traceparent');
      expect(outgoing).toBeTruthy();
      const outgoingTraceId = outgoing?.split('-')[1];
      expect(outgoingTraceId).toBe('11111111111111111111111111111111');
    });
  });

  describe('GET /metrics', () => {
    it('should return prometheus metrics payload', async () => {
      await app.request('/health');
      const res = await app.request('/metrics');
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('untangle_http_requests_total');
      expect(body).toContain('untangle_router_fallback_total');
      expect(body).toContain('untangle_provider_requests_total');
      expect(body).toContain('untangle_trace_requests_total');
      expect(body).toContain('untangle_trace_sampling_drift');
      expect(body).toContain('untangle_trace_sampling_rate_observed');
      expect(body).toContain('untangle_trace_sampling_rate_configured');
    });

    it('should track unsampled traces and expose trace sampling drift metrics', async () => {
      await app.request('/health', {
        headers: {
          traceparent: '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-00',
        },
      });

      const res = await app.request('/metrics');
      expect(res.status).toBe(200);
      const body = await res.text();

      const unsampledMatch = body.match(/untangle_trace_requests_total\{sampled="false"\}\s+([0-9]+)/);
      expect(Number(unsampledMatch?.[1] ?? '0')).toBeGreaterThan(0);

      const driftMatch = body.match(/untangle_trace_sampling_drift\s+([0-9]+(?:\.[0-9]+)?)/);
      expect(Number(driftMatch?.[1] ?? '0')).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Router debug endpoints', () => {
    it('should return router health snapshot', async () => {
      const res = await app.request('/api/router/health');
      expect(res.status).toBe(200);
      const body = await res.json() as {
        status: string;
        groups: unknown[];
        states: unknown[];
      };
      expect(body.status).toBe('ok');
      expect(Array.isArray(body.groups)).toBe(true);
      expect(Array.isArray(body.states)).toBe(true);
    });

    it('should return model decision snapshot for direct model', async () => {
      const res = await app.request('/api/router/decisions/test-provider-model-1');
      expect(res.status).toBe(200);
      const body = await res.json() as {
        modelAlias: string;
        deployments: Array<{ providerId: string; modelId: string }>;
      };
      expect(body.modelAlias).toBe('test-provider-model-1');
      expect(body.deployments[0]?.providerId).toBe('test-provider');
      expect(body.deployments[0]?.modelId).toBe('test-provider-model-1');
    });

    it('should support region ejection admin endpoints', async () => {
      const listBefore = await app.request('/api/router/regions');
      expect(listBefore.status).toBe(200);

      const eject = await app.request('/api/router/regions/us-east-1/eject', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'integration-drill' }),
      });
      expect(eject.status).toBe(200);

      const listAfterEject = await app.request('/api/router/regions');
      expect(listAfterEject.status).toBe(200);
      const ejectedBody = await listAfterEject.json() as {
        regions: Array<{ region: string; ejected: boolean; reason?: string }>;
      };
      const usEast = ejectedBody.regions.find((entry) => entry.region === 'us-east-1');
      expect(usEast?.ejected).toBe(true);
      expect(usEast?.reason).toBe('integration-drill');

      const restore = await app.request('/api/router/regions/us-east-1/restore', {
        method: 'POST',
      });
      expect(restore.status).toBe(200);

      const listAfterRestore = await app.request('/api/router/regions');
      const restoredBody = await listAfterRestore.json() as {
        regions: Array<{ region: string; ejected: boolean }>;
      };
      const restoredEntry = restoredBody.regions.find((entry) => entry.region === 'us-east-1');
      if (restoredEntry) {
        expect(restoredEntry.ejected).toBe(false);
      } else {
        expect(restoredEntry).toBeUndefined();
      }
    });
  });

  describe('GET /v1/models', () => {
    it('should return a list of models', async () => {
      const res = await app.request('/v1/models');
      expect(res.status).toBe(200);

      const body = await res.json() as { object: string; data: unknown[] };
      expect(body).toHaveProperty('object', 'list');
      expect(body).toHaveProperty('data');
      expect(Array.isArray(body.data)).toBe(true);
    });

    it('should return models with correct format', async () => {
      const res = await app.request('/v1/models');
      const body = await res.json() as { data: Array<{ id: string; object: string; created: number; owned_by: string }> };

      // Should have 2 enabled models from enabled provider (not the disabled one)
      expect(body.data.length).toBe(2);

      for (const model of body.data) {
        expect(model).toHaveProperty('id');
        expect(model).toHaveProperty('object', 'model');
        expect(model).toHaveProperty('created');
        expect(model).toHaveProperty('owned_by', 'test-provider');
        expect(typeof model.id).toBe('string');
        expect(typeof model.created).toBe('number');
      }
    });

    it('should not include disabled models', async () => {
      const res = await app.request('/v1/models');
      const body = await res.json() as { data: Array<{ id: string }> };

      const modelIds = body.data.map((m: { id: string }) => m.id);
      expect(modelIds).toContain('test-provider-model-1');
      expect(modelIds).toContain('test-provider-model-2');
      expect(modelIds).not.toContain('test-provider-disabled-model');
      expect(modelIds).not.toContain('disabled-provider-model-1');
    });
  });

  describe('GET /v1/models/:modelId', () => {
    it('should return a specific model', async () => {
      const res = await app.request('/v1/models/test-provider-model-1');
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toHaveProperty('id', 'test-provider-model-1');
      expect(body).toHaveProperty('object', 'model');
      expect(body).toHaveProperty('owned_by', 'test-provider');
    });

    it('should return 404 for non-existent model', async () => {
      const res = await app.request('/v1/models/non-existent');
      expect(res.status).toBe(404);

      const body = await res.json() as { error: { message: string } };
      expect(body).toHaveProperty('error');
      expect(body.error).toHaveProperty('message');
    });
  });

  describe('Provider and key management', () => {
    it('should include disabled providers for configuration UI', async () => {
      const res = await app.request('/api/providers/all');
      expect(res.status).toBe(200);

      const body = await res.json() as { providers: Array<{ id: string }> };
      const providerIds = body.providers.map(provider => provider.id);
      expect(providerIds).toContain('test-provider');
      expect(providerIds).toContain('disabled-provider');
    });

    it('should return key status for all registered providers', async () => {
      const res = await app.request('/api/keys');
      expect(res.status).toBe(200);

      const body = await res.json() as { providers: Array<{ id: string; envVar: string }> };
      const ids = body.providers.map(provider => provider.id);
      expect(ids).toContain('test-provider');
      expect(ids).toContain('disabled-provider');
      expect(body.providers.find(provider => provider.id === 'disabled-provider')?.envVar).toBe('DISABLED_PROVIDER_API_KEY');
    });

    it('should enable provider when key is added at runtime', async () => {
      const setRes = await app.request('/api/keys/disabled-provider', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: 'runtime-key' }),
      });
      expect(setRes.status).toBe(200);

      const providersRes = await app.request('/api/providers');
      const providersBody = await providersRes.json() as { providers: Array<{ id: string }> };
      expect(providersBody.providers.map(p => p.id)).toContain('disabled-provider');
    });

    it('should keep provider state unchanged when key is removed at runtime', async () => {
      const delRes = await app.request('/api/keys/disabled-provider', {
        method: 'DELETE',
      });
      expect(delRes.status).toBe(200);

      const providersRes = await app.request('/api/providers');
      const providersBody = await providersRes.json() as { providers: Array<{ id: string }> };
      expect(providersBody.providers.map(p => p.id)).toContain('disabled-provider');

      const keyStatusRes = await app.request('/api/keys/disabled-provider');
      expect(keyStatusRes.status).toBe(200);
      const keyStatus = await keyStatusRes.json() as { hasKey: boolean };
      expect(keyStatus.hasKey).toBe(false);
    });

    it('should persist provider enabled state with explicit toggle endpoint', async () => {
      const toggleOn = await app.request('/api/providers/disabled-provider/toggle', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      });
      expect(toggleOn.status).toBe(200);

      const modelsRes = await app.request('/v1/models');
      const modelsBody = await modelsRes.json() as { data: Array<{ owned_by: string }> };
      expect(modelsBody.data.some(model => model.owned_by === 'disabled-provider')).toBe(true);
    });

    it('should reject unknown key payload fields in strict mode', async () => {
      const registry = new ProviderRegistry();
      registry.register(createMockProvider('strict-provider'));
      const keys = new Map<string, string>();

      const strictApp = createApp({
        registry,
        config: {
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
        },
        getApiKey: (providerId) => keys.get(providerId),
        setApiKey: (providerId, apiKey) => {
          keys.set(providerId, apiKey);
        },
        removeApiKey: (providerId) => {
          keys.delete(providerId);
        },
      });

      const response = await strictApp.request('/api/keys/strict-provider', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: 'sk-test', unknown: true }),
      });

      expect(response.status).toBe(400);
      const body = await response.json() as { error: { code: string } };
      expect(body.error.code).toBe('unknown_fields');
    });

    it('should reject unknown pricing calculate payload fields in strict mode', async () => {
      const registry = new ProviderRegistry();
      registry.register(createMockProvider('strict-provider'));

      const strictApp = createApp({
        registry,
        config: {
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
        },
        getApiKey: () => 'test-key',
      });

      const response = await strictApp.request('/api/pricing/calculate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          provider: 'strict-provider',
          model: 'strict-provider-model-1',
          inputTokens: 10,
          outputTokens: 5,
          unknown: true,
        }),
      });

      expect(response.status).toBe(400);
      const body = await response.json() as { code: string };
      expect(body.code).toBe('unknown_fields');
    });
  });
});
