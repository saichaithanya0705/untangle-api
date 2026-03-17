import { describe, expect, it, vi } from 'vitest';
import { createApp, type ServerOptions } from '../index.js';
import { ProviderRegistry, type ProviderAdapter } from '@untangle-ai/core';

interface LoadBudgets {
  p95LatencyMs: number;
  maxFallbackRate: number;
  maxErrorRate: number;
}

const LOAD_BUDGETS: LoadBudgets = {
  p95LatencyMs: 250,
  maxFallbackRate: 1.05,
  maxErrorRate: 0.01,
};

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

function createRoutingApp() {
  const registry = new ProviderRegistry();
  registry.register(createMockProvider('primary', ['primary-model']));
  registry.register(createMockProvider('secondary', ['secondary-model']));

  const runtimeKeys = new Map<string, string>([
    ['primary', 'primary-key'],
    ['secondary', 'secondary-key'],
  ]);

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
          retryPolicy: {
            maxAttempts: 2,
            retryableStatusCodes: [408, 409, 429, 500, 502, 503, 504],
          },
          circuitBreaker: {
            failureThreshold: 1000,
            resetTimeoutMs: 30_000,
          },
          deployments: [
            { provider: 'primary', model: 'primary-model', priority: 0, weight: 1, enabled: true, lane: 'stable' },
            { provider: 'secondary', model: 'secondary-model', priority: 1, weight: 1, enabled: true, lane: 'stable' },
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
          resetTimeoutMs: 30_000,
        },
        defaultStreamFallbackPolicy: undefined,
      },
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

function getFallbackCount(metricsBody: string): number {
  const match = metricsBody.match(/untangle_router_fallback_total\s+([0-9]+(?:\.[0-9]+)?)/);
  return match ? Number(match[1]) : 0;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

describe('Phase 1 load profile gates', () => {
  it('meets p95 latency, fallback-rate, and error-rate thresholds under retry/fallback load', async () => {
    const app = createRoutingApp();
    const fetchMock = vi.fn().mockImplementation((_url, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model?: string };
      if (body.model === 'primary-model') {
        return Promise.resolve(new Response(JSON.stringify({
          error: { message: 'temporary unavailable', type: 'api_error', code: null },
        }), {
          status: 503,
          headers: { 'content-type': 'application/json', 'retry-after': '1' },
        }));
      }

      return Promise.resolve(new Response(JSON.stringify({
        id: `chatcmpl-load-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'secondary-model',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 2,
          total_tokens: 10,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const beforeMetrics = await app.request('/metrics');
    const beforeBody = await beforeMetrics.text();
    const beforeFallback = getFallbackCount(beforeBody);

    const requestCount = 40;
    const latencies: number[] = [];
    let errorCount = 0;

    await Promise.all(Array.from({ length: requestCount }, async (_unused, index) => {
      const started = Date.now();
      const response = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-prod',
          messages: [{ role: 'user', content: `load-${index}` }],
        }),
      });
      latencies.push(Date.now() - started);
      if (response.status !== 200) {
        errorCount += 1;
      }
    }));

    const metrics = await app.request('/metrics');
    const metricsBody = await metrics.text();
    const afterFallback = getFallbackCount(metricsBody);
    const fallbackDelta = Math.max(0, afterFallback - beforeFallback);

    const p95LatencyMs = percentile(latencies, 0.95);
    const fallbackRate = fallbackDelta / requestCount;
    const errorRate = errorCount / requestCount;

    expect(p95LatencyMs).toBeLessThanOrEqual(LOAD_BUDGETS.p95LatencyMs);
    expect(errorRate).toBeLessThanOrEqual(LOAD_BUDGETS.maxErrorRate);
    expect(fallbackRate).toBeLessThanOrEqual(LOAD_BUDGETS.maxFallbackRate);
    expect(fallbackRate).toBeGreaterThan(0.9);
    expect(fetchMock).toHaveBeenCalledTimes(requestCount * 2);
  });
});
