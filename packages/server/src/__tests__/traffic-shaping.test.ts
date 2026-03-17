import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type ServerOptions } from '../index.js';
import { ProviderRegistry, type ProviderAdapter } from '@untangle-ai/core';

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

function createTrafficShapingApp(config: {
  requestsPerSecond: number;
  burst: number;
  adaptive?: {
    enabled: boolean;
    minRps: number;
    maxRps: number;
    targetLatencyMs: number;
    errorRateThreshold: number;
    decreaseFactor: number;
    increaseStep: number;
    adjustIntervalMs: number;
  };
}) {
  const registry = new ProviderRegistry();
  registry.register(createMockProvider('primary', ['primary-model']));

  const options: ServerOptions = {
    registry,
    config: {
      server: { port: 3000, host: 'localhost' },
      providers: {},
      routing: {
        groups: [{
          alias: 'gpt-prod',
          strategy: 'priority',
          cooldownMs: 0,
          retryPolicy: { maxAttempts: 3, retryableStatusCodes: [408, 409, 429, 500, 502, 503, 504] },
          circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 30000 },
          deployments: [{ provider: 'primary', model: 'primary-model', priority: 0, enabled: true, weight: 1, lane: 'stable' }],
        }],
        defaultStrategy: 'priority',
        defaultCooldownMs: 0,
        defaultRetryPolicy: { maxAttempts: 3, retryableStatusCodes: [408, 409, 429, 500, 502, 503, 504] },
        defaultCircuitBreaker: { failureThreshold: 3, resetTimeoutMs: 30000 },
        defaultStreamFallbackPolicy: undefined,
      },
      controlPlane: {
        enabled: false,
        failureMode: 'fallback',
        virtualKeyHeader: 'x-untangle-key',
        postgres: { enabled: false, schema: 'public' },
        redis: { enabled: false, keyPrefix: 'untangle' },
      },
      trafficShaping: {
        enabled: true,
        requestsPerSecond: config.requestsPerSecond,
        burst: config.burst,
        adaptive: config.adaptive ?? {
          enabled: false,
          minRps: 1,
          maxRps: config.requestsPerSecond,
          targetLatencyMs: 750,
          errorRateThreshold: 0.05,
          decreaseFactor: 0.8,
          increaseStep: 1,
          adjustIntervalMs: 2000,
        },
      },
    },
    getApiKey: () => 'primary-key',
  };

  return createApp(options);
}

describe('Traffic shaping middleware', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throttles burst traffic with 429 and throttle code', async () => {
    const app = createTrafficShapingApp({
      requestsPerSecond: 1,
      burst: 1,
    });

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'chatcmpl-traffic-shaping',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'primary-model',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 3,
        completion_tokens: 1,
        total_tokens: 4,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const payload = {
      model: 'gpt-prod',
      messages: [{ role: 'user', content: 'hello' }],
    };

    const first = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(200);

    const second = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    expect(second.status).toBe(429);
    const secondBody = await second.json() as { error: { code: string } };
    expect(secondBody.error.code).toBe('traffic_shaping_throttled');
    expect(second.headers.get('x-untangle-traffic-shaping')).toBe('throttled');
  });

  it('adapts current rps downward when observed latency is above target', async () => {
    const app = createTrafficShapingApp({
      requestsPerSecond: 50,
      burst: 50,
      adaptive: {
        enabled: true,
        minRps: 5,
        maxRps: 50,
        targetLatencyMs: 1,
        errorRateThreshold: 0.5,
        decreaseFactor: 0.5,
        increaseStep: 1,
        adjustIntervalMs: 0,
      },
    });

    const fetchMock = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(JSON.stringify({
        id: 'chatcmpl-traffic-shaping-adaptive',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'primary-model',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: 3,
          completion_tokens: 1,
          total_tokens: 4,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    for (let index = 0; index < 5; index += 1) {
      const response = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-prod',
          messages: [{ role: 'user', content: `hello-${index}` }],
        }),
      });
      expect(response.status).toBe(200);
    }

    const metricsResponse = await app.request('/metrics');
    expect(metricsResponse.status).toBe(200);
    const metrics = await metricsResponse.text();
    const currentRpsMatch = metrics.match(/untangle_traffic_shaping_current_rps\s+([0-9]+(?:\.[0-9]+)?)/);
    const currentRps = Number(currentRpsMatch?.[1] ?? '0');
    expect(currentRps).toBeGreaterThan(0);
    expect(currentRps).toBeLessThan(50);
  });
});
