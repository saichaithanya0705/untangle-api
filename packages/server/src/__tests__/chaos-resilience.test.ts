import { describe, expect, it, vi } from 'vitest';
import { createApp, type ServerOptions } from '../index.js';
import {
  bootstrapControlPlane,
  ProviderRegistry,
  type Config,
  type ProviderAdapter,
} from '@untangle-ai/core';

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

function createBaseConfig(): Config {
  return {
    server: { port: 3000, host: 'localhost' },
    providers: {},
    routing: {
      groups: [{
        alias: 'gpt-prod',
        strategy: 'priority',
        cooldownMs: 0,
        retryPolicy: {
          maxAttempts: 2,
          retryableStatusCodes: [408, 409, 429, 500, 502, 503, 504],
        },
        circuitBreaker: {
          failureThreshold: 1000,
          resetTimeoutMs: 30000,
        },
        deployments: [
          { provider: 'primary', model: 'primary-model', priority: 0, enabled: true, weight: 1 },
          { provider: 'secondary', model: 'secondary-model', priority: 1, enabled: true, weight: 1 },
        ],
      }],
      defaultStrategy: 'priority',
      defaultCooldownMs: 0,
      defaultRetryPolicy: {
        maxAttempts: 3,
        retryableStatusCodes: [408, 409, 429, 500, 502, 503, 504],
      },
      defaultCircuitBreaker: {
        failureThreshold: 3,
        resetTimeoutMs: 30000,
      },
      defaultStreamFallbackPolicy: undefined,
    },
    controlPlane: {
      enabled: false,
      virtualKeyHeader: 'x-untangle-key',
      postgres: { enabled: false, schema: 'public' },
      redis: { enabled: false, keyPrefix: 'untangle' },
    },
  };
}

function createRoutingApp(options?: {
  controlPlane?: ServerOptions['controlPlane'];
  virtualKeyHeader?: string;
}) {
  const registry = new ProviderRegistry();
  registry.register(createMockProvider('primary', ['primary-model']));
  registry.register(createMockProvider('secondary', ['secondary-model']));

  const runtimeKeys = new Map<string, string>([
    ['primary', 'primary-key'],
    ['secondary', 'secondary-key'],
  ]);

  return createApp({
    registry,
    config: {
      ...createBaseConfig(),
      controlPlane: {
        ...createBaseConfig().controlPlane,
        enabled: !!options?.controlPlane,
        virtualKeyHeader: options?.virtualKeyHeader ?? 'x-untangle-key',
      },
    },
    controlPlane: options?.controlPlane,
    getApiKey: (providerId) => runtimeKeys.get(providerId),
  });
}

describe('Phase 2 chaos resilience', () => {
  it('honors Retry-After cooldown and avoids unhealthy deployment on immediate subsequent request', async () => {
    const app = createRoutingApp();
    const callModels: string[] = [];
    const retryAfterDate = new Date(Date.now() + 5000).toUTCString();

    const fetchMock = vi.fn().mockImplementation((_url, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model?: string };
      const model = body.model ?? 'unknown';
      callModels.push(model);
      if (model === 'primary-model') {
        return Promise.resolve(new Response(JSON.stringify({
          error: { message: 'primary outage', type: 'api_error', code: null },
        }), {
          status: 503,
          headers: { 'content-type': 'application/json', 'retry-after': retryAfterDate },
        }));
      }

      return Promise.resolve(new Response(JSON.stringify({
        id: 'chatcmpl-chaos',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'secondary-model',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-prod',
        messages: [{ role: 'user', content: 'one' }],
      }),
    });
    expect(first.status).toBe(200);

    const second = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-prod',
        messages: [{ role: 'user', content: 'two' }],
      }),
    });
    expect(second.status).toBe(200);

    const primaryCalls = callModels.filter((model) => model === 'primary-model').length;
    const secondaryCalls = callModels.filter((model) => model === 'secondary-model').length;

    // Request #1: primary fails then fallback to secondary (2 calls)
    // Request #2: primary remains on cooldown due Retry-After, so direct secondary (1 call)
    expect(primaryCalls).toBe(1);
    expect(secondaryCalls).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('returns 503 when virtual-key control plane dependencies are degraded', async () => {
    const controlPlane = {
      resolveVirtualKey: vi.fn().mockResolvedValue({
        key: {
          id: 'vk_test',
          name: 'Chaos key',
          keyHash: 'hash',
          createdAt: '2026-02-27T00:00:00.000Z',
          limits: {},
        },
      }),
      checkLimits: vi.fn().mockRejectedValue(new Error('redis unavailable')),
      recordUsageFromTracker: vi.fn(),
      clearUsageEvents: vi.fn(),
      getUsageSummary: vi.fn().mockResolvedValue({
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostUsd: 0,
      }),
      listUsageEvents: vi.fn().mockResolvedValue([]),
      getSpendSummary: vi.fn().mockResolvedValue({
        totalCostUsd: 0,
        todayCostUsd: 0,
        monthCostUsd: 0,
        byKeyUsd: {},
      }),
      getBillingReconciliation: vi.fn().mockResolvedValue({
        usageTotalCostUsd: 0,
        spendLedgerTotalCostUsd: 0,
        deltaUsd: 0,
        toleranceUsd: 0.0001,
        withinTolerance: true,
        byKey: [],
      }),
      listVirtualKeys: vi.fn().mockResolvedValue([]),
      createVirtualKey: vi.fn(),
      revokeVirtualKey: vi.fn(),
      reconcileProviderBillingExport: vi.fn(),
    } as any;

    const app = createRoutingApp({
      controlPlane,
      virtualKeyHeader: 'x-test-key',
    });

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-key': 'cp_chaos_key',
      },
      body: JSON.stringify({
        model: 'gpt-prod',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    expect(response.status).toBe(503);
    const body = await response.json() as { error: { code: string } };
    expect(body.error.code).toBe('control_plane_unavailable');
  });

  it('falls back to in-memory adapters when PostgreSQL and Redis bootstrap degrade', async () => {
    const bootstrap = await bootstrapControlPlane({
      enabled: true,
      postgres: {
        enabled: true,
        connectionString: 'postgres://localhost/test',
        schema: 'public',
      },
      redis: {
        enabled: true,
        connectionString: 'redis://localhost:6379/0',
        keyPrefix: 'untangle',
      },
    }, {
      createPostgresStore: vi.fn().mockRejectedValue(new Error('postgres degraded')),
      createRedisLimiter: vi.fn().mockRejectedValue(new Error('redis degraded')),
    });

    expect(bootstrap.service).toBeDefined();
    expect(bootstrap.storeType).toBe('in-memory');
    expect(bootstrap.limiterType).toBe('in-memory');
    expect(bootstrap.messages.some((message) => message.message.includes('postgres degraded'))).toBe(true);
    expect(bootstrap.messages.some((message) => message.message.includes('redis degraded'))).toBe(true);
  });
});
