import { describe, it, expect, beforeAll } from 'vitest';
import { createApp, type ServerOptions } from '../index.js';
import { ProviderRegistry, type ProviderAdapter, type Config } from '@untangle-ai/core';

// Create a mock provider for testing
function createMockProvider(): ProviderAdapter {
  const config = {
    id: 'test-provider',
    name: 'Test Provider',
    enabled: true,
    baseUrl: 'https://api.test.com',
    authHeader: 'Authorization',
    models: [
      { id: 'test-model-1', enabled: true, contextWindow: 4096, maxOutputTokens: 4096, capabilities: ['chat' as const] },
      { id: 'test-model-2', enabled: true, contextWindow: 4096, maxOutputTokens: 4096, capabilities: ['chat' as const] },
      { id: 'disabled-model', enabled: false, contextWindow: 4096, maxOutputTokens: 4096, capabilities: ['chat' as const] },
    ],
  };

  return {
    config,
    supportsModel(modelId: string) {
      return config.models.some(m => m.id === modelId);
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
  };
}

describe('Integration Tests', () => {
  let app: ReturnType<typeof createApp>;

  beforeAll(() => {
    const registry = new ProviderRegistry();
    registry.register(createMockProvider());

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
      getApiKey: () => 'test-key',
    };

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

      // Should have 2 enabled models (not the disabled one)
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
      expect(modelIds).toContain('test-model-1');
      expect(modelIds).toContain('test-model-2');
      expect(modelIds).not.toContain('disabled-model');
    });
  });

  describe('GET /v1/models/:modelId', () => {
    it('should return a specific model', async () => {
      const res = await app.request('/v1/models/test-model-1');
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body).toHaveProperty('id', 'test-model-1');
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
});
