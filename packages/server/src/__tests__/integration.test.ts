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

    it('should disable provider when key is removed at runtime', async () => {
      const delRes = await app.request('/api/keys/disabled-provider', {
        method: 'DELETE',
      });
      expect(delRes.status).toBe(200);

      const providersRes = await app.request('/api/providers');
      const providersBody = await providersRes.json() as { providers: Array<{ id: string }> };
      expect(providersBody.providers.map(p => p.id)).not.toContain('disabled-provider');
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
  });
});
