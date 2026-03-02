import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../index.js';
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

function parsePositiveNumber(rawValue: string | undefined, defaultValue: number): number {
  if (!rawValue) return defaultValue;
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) return defaultValue;
  return parsed;
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

describe('Phase 2 soak + memory guard', () => {
  it('holds latency/error/fallback and heap-growth budgets under sustained traffic', async () => {
    const iterations = Math.floor(parsePositiveNumber(process.env.UNTANGLE_SOAK_ITERATIONS, 600));
    const sampleEvery = Math.floor(parsePositiveNumber(process.env.UNTANGLE_SOAK_SAMPLE_EVERY, 50));
    const maxHeapGrowthMb = parsePositiveNumber(process.env.UNTANGLE_SOAK_MAX_HEAP_GROWTH_MB, 80);
    const maxP95LatencyMs = parsePositiveNumber(process.env.UNTANGLE_SOAK_MAX_P95_MS, 350);
    const maxErrorRate = parsePositiveNumber(process.env.UNTANGLE_SOAK_MAX_ERROR_RATE, 0.01);
    const minFallbackRate = parsePositiveNumber(process.env.UNTANGLE_SOAK_MIN_FALLBACK_RATE, 0.1);
    const maxFallbackRate = parsePositiveNumber(process.env.UNTANGLE_SOAK_MAX_FALLBACK_RATE, 0.5);

    const registry = new ProviderRegistry();
    registry.register(createMockProvider('primary', ['primary-model']));
    registry.register(createMockProvider('secondary', ['secondary-model']));
    const app = createApp({
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
              failureThreshold: 10000,
              resetTimeoutMs: 30000,
            },
            deployments: [
              { provider: 'primary', model: 'primary-model', priority: 0, enabled: true, weight: 1, lane: 'stable' },
              { provider: 'secondary', model: 'secondary-model', priority: 1, enabled: true, weight: 1, lane: 'stable' },
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
      },
      getApiKey: (providerId) => `${providerId}-key`,
    });

    let requestCount = 0;
    const fetchMock = vi.fn().mockImplementation((_url, init?: RequestInit) => {
      requestCount += 1;
      const body = JSON.parse(String(init?.body)) as { model?: string };
      const isPrimary = body.model === 'primary-model';
      if (isPrimary && requestCount % 5 === 0) {
        return Promise.resolve(new Response(JSON.stringify({
          error: { message: 'temporary outage', type: 'api_error', code: null },
        }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }));
      }

      const model = isPrimary ? 'primary-model' : 'secondary-model';
      return Promise.resolve(new Response(JSON.stringify({
        id: `chatcmpl-soak-${requestCount}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 3,
          total_tokens: 11,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const fallbackBeforeResponse = await app.request('/metrics');
    const fallbackBefore = await fallbackBeforeResponse.text();
    const fallbackBeforeMatch = fallbackBefore.match(/untangle_router_fallback_total\s+([0-9]+(?:\.[0-9]+)?)/);
    const baselineFallback = fallbackBeforeMatch ? Number(fallbackBeforeMatch[1]) : 0;

    const latencies: number[] = [];
    const memorySamples: number[] = [];
    let errors = 0;
    const maybeGc = (globalThis as { gc?: () => void }).gc;

    for (let index = 0; index < iterations; index += 1) {
      const started = performance.now();
      const response = await app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-prod',
          messages: [{ role: 'user', content: `soak-${index}` }],
        }),
      });
      latencies.push(performance.now() - started);
      if (response.status !== 200) {
        errors += 1;
      }

      if ((index + 1) % sampleEvery === 0 || index === iterations - 1) {
        if (typeof maybeGc === 'function') {
          maybeGc();
        }
        memorySamples.push(process.memoryUsage().heapUsed);
      }
    }

    const fallbackAfterResponse = await app.request('/metrics');
    const fallbackAfter = await fallbackAfterResponse.text();
    const fallbackAfterMatch = fallbackAfter.match(/untangle_router_fallback_total\s+([0-9]+(?:\.[0-9]+)?)/);
    const finalFallback = fallbackAfterMatch ? Number(fallbackAfterMatch[1]) : baselineFallback;
    const fallbackCount = Math.max(0, finalFallback - baselineFallback);

    const warmupIndex = Math.max(0, Math.floor(memorySamples.length * 0.2));
    const baselineHeap = memorySamples[warmupIndex] ?? memorySamples[0] ?? process.memoryUsage().heapUsed;
    const tailSamples = memorySamples.slice(Math.max(0, memorySamples.length - 3));
    const tailAverage = tailSamples.length > 0
      ? tailSamples.reduce((sum, value) => sum + value, 0) / tailSamples.length
      : baselineHeap;

    const heapGrowthMb = (tailAverage - baselineHeap) / (1024 * 1024);
    const p95Latency = percentile(latencies, 0.95);
    const errorRate = errors / Math.max(1, iterations);
    const fallbackRate = fallbackCount / Math.max(1, iterations);

    expect(p95Latency).toBeLessThanOrEqual(maxP95LatencyMs);
    expect(errorRate).toBeLessThanOrEqual(maxErrorRate);
    expect(fallbackRate).toBeGreaterThanOrEqual(minFallbackRate);
    expect(fallbackRate).toBeLessThanOrEqual(maxFallbackRate);
    expect(heapGrowthMb).toBeLessThanOrEqual(maxHeapGrowthMb);
  }, 180_000);
});
