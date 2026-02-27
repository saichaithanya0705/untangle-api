import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
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
      { id: `${id}-model`, enabled: true, contextWindow: 4096, maxOutputTokens: 4096, capabilities: ['chat' as const] },
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

describe('Control Plane Routes', () => {
  let app: ReturnType<typeof createApp>;

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeAll(() => {
    const registry = new ProviderRegistry();
    registry.register(createMockProvider('test-provider'));

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
        enabled: true,
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

    app = createApp(options);
  });

  it('returns postgres schema artifact', async () => {
    const res = await app.request('/api/control-plane/schema/postgres');
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('cp_virtual_keys');
    expect(res.headers.get('x-migration-name')).toBeTruthy();
  });

  it('creates, lists, and revokes virtual keys', async () => {
    const createRes = await app.request('/api/control-plane/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'CI key',
        key: 'cp_test_key_123',
        limits: { rpm: 5 },
      }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json() as { id: string; name: string; limits: { rpm: number } };
    expect(created.name).toBe('CI key');
    expect(created.limits.rpm).toBe(5);

    const listRes = await app.request('/api/control-plane/keys');
    expect(listRes.status).toBe(200);
    const listed = await listRes.json() as { keys: Array<{ id: string; name: string }> };
    expect(listed.keys.some((key) => key.id === created.id)).toBe(true);

    const revokeRes = await app.request(`/api/control-plane/keys/${created.id}/revoke`, {
      method: 'POST',
    });
    expect(revokeRes.status).toBe(200);
    const revoked = await revokeRes.json() as { revoked: boolean };
    expect(revoked.revoked).toBe(true);
  });

  it('enforces in-memory rpm limits on limit checks', async () => {
    const createRes = await app.request('/api/control-plane/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Rate limited key',
        key: 'cp_rate_key_456',
        limits: { rpm: 1 },
      }),
    });
    expect(createRes.status).toBe(201);

    const first = await app.request('/api/control-plane/limits/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        key: 'cp_rate_key_456',
        modelId: 'test-provider-model',
        inputTokens: 5,
      }),
    });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { allowed: boolean };
    expect(firstBody.allowed).toBe(true);

    const second = await app.request('/api/control-plane/limits/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        key: 'cp_rate_key_456',
        modelId: 'test-provider-model',
        inputTokens: 5,
      }),
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json() as { allowed: boolean; reason?: string };
    expect(secondBody.allowed).toBe(false);
    expect(secondBody.reason).toBe('rpm_exceeded');
  });

  it('rejects data-plane requests with invalid virtual key', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-untangle-key': 'cp_invalid_key',
      },
      body: JSON.stringify({
        model: 'test-provider-model',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('invalid_virtual_key');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('enforces model allow-list in data-plane virtual key checks', async () => {
    const createRes = await app.request('/api/control-plane/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Allow-list key',
        key: 'cp_model_guard_123',
        limits: { allowedModels: ['different-model'] },
      }),
    });
    expect(createRes.status).toBe(201);

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-untangle-key': 'cp_model_guard_123',
      },
      body: JSON.stringify({
        model: 'test-provider-model',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    expect(res.status).toBe(403);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('model_denied');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('enforces data-plane rpm limits before upstream call', async () => {
    const createRes = await app.request('/api/control-plane/keys', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Data-plane rpm key',
        key: 'cp_data_plane_rate_123',
        limits: { rpm: 1 },
      }),
    });
    expect(createRes.status).toBe(201);

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'chatcmpl-test',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'test-provider-model',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const first = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-untangle-key': 'cp_data_plane_rate_123',
      },
      body: JSON.stringify({
        model: 'test-provider-model',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    expect(first.status).toBe(200);

    const second = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-untangle-key': 'cp_data_plane_rate_123',
      },
      body: JSON.stringify({
        model: 'test-provider-model',
        messages: [{ role: 'user', content: 'hello again' }],
      }),
    });
    expect(second.status).toBe(429);
    const secondBody = await second.json() as { error: { code: string } };
    expect(secondBody.error.code).toBe('rpm_exceeded');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects unknown fields for control-plane limit checks in strict mode', async () => {
    const response = await app.request('/api/control-plane/limits/check', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        key: 'cp_rate_key_456',
        unknown_field: true,
      }),
    });

    expect(response.status).toBe(400);
    const body = await response.json() as { error: { code: string } };
    expect(body.error.code).toBe('unknown_fields');
  });
});
