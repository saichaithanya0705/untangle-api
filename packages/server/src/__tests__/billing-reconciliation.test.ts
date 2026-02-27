import { describe, expect, it } from 'vitest';
import { createApp, type ServerOptions } from '../index.js';
import {
  ControlPlaneService,
  InMemoryControlPlaneStore,
  InMemoryRateLimiter,
  ProviderRegistry,
  type ProviderAdapter,
  type Config,
} from '@untangle-ai/core';

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

function createBaseConfig(controlPlaneEnabled: boolean): Config {
  return {
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
      enabled: controlPlaneEnabled,
      virtualKeyHeader: 'x-untangle-key',
      postgres: { enabled: false, schema: 'public' },
      redis: { enabled: false, keyPrefix: 'untangle' },
    },
  };
}

async function createControlPlaneWithUsage(): Promise<ControlPlaneService> {
  const controlPlane = new ControlPlaneService(new InMemoryControlPlaneStore(), new InMemoryRateLimiter());
  const key = await controlPlane.createVirtualKey({
    name: 'Billing test key',
    rawKey: 'cp_billing_test_123',
  });

  await controlPlane.recordUsageEvent({
    id: 'evt_1',
    timestamp: '2026-02-26T12:00:00.000Z',
    virtualKeyId: key.id,
    providerId: 'test-provider',
    modelId: 'test-provider-model',
    inputTokens: 20,
    outputTokens: 8,
    totalCost: 1.25,
    durationMs: 90,
    success: true,
  });
  await controlPlane.recordUsageEvent({
    id: 'evt_2',
    timestamp: '2026-02-26T12:01:00.000Z',
    virtualKeyId: key.id,
    providerId: 'test-provider',
    modelId: 'test-provider-model',
    inputTokens: 10,
    outputTokens: 5,
    totalCost: 0.75,
    durationMs: 80,
    success: true,
  });
  await controlPlane.recordUsageEvent({
    id: 'evt_3',
    timestamp: '2026-02-26T12:02:00.000Z',
    providerId: 'test-provider',
    modelId: 'test-provider-model',
    inputTokens: 15,
    outputTokens: 6,
    totalCost: 2,
    durationMs: 85,
    success: true,
  });

  return controlPlane;
}

describe('Billing reconciliation endpoints', () => {
  it('returns reconciliation summaries for control-plane and usage APIs', async () => {
    const registry = new ProviderRegistry();
    registry.register(createMockProvider('test-provider'));
    const controlPlane = await createControlPlaneWithUsage();

    const options: ServerOptions = {
      registry,
      config: createBaseConfig(true),
      getApiKey: () => 'test-key',
      controlPlane,
    };
    const app = createApp(options);

    const cpRes = await app.request('/api/control-plane/reconciliation');
    expect(cpRes.status).toBe(200);
    const cpBody = await cpRes.json() as {
      usageTotalCostUsd: number;
      spendLedgerTotalCostUsd: number;
      deltaUsd: number;
      withinTolerance: boolean;
      byKey: Array<{ usageCostUsd: number; spendLedgerCostUsd: number; deltaUsd: number }>;
    };
    expect(cpBody.usageTotalCostUsd).toBe(4);
    expect(cpBody.spendLedgerTotalCostUsd).toBe(4);
    expect(cpBody.deltaUsd).toBe(0);
    expect(cpBody.withinTolerance).toBe(true);
    expect(cpBody.byKey).toHaveLength(1);
    expect(cpBody.byKey[0]?.usageCostUsd).toBe(2);
    expect(cpBody.byKey[0]?.spendLedgerCostUsd).toBe(2);
    expect(cpBody.byKey[0]?.deltaUsd).toBe(0);

    const usageRes = await app.request('/api/usage/reconciliation');
    expect(usageRes.status).toBe(200);
    const usageBody = await usageRes.json() as { withinTolerance: boolean; deltaUsd: number };
    expect(usageBody.withinTolerance).toBe(true);
    expect(usageBody.deltaUsd).toBe(0);
  });

  it('validates reconciliation query params', async () => {
    const registry = new ProviderRegistry();
    registry.register(createMockProvider('test-provider'));
    const controlPlane = await createControlPlaneWithUsage();

    const app = createApp({
      registry,
      config: createBaseConfig(true),
      getApiKey: () => 'test-key',
      controlPlane,
    });

    const cpInvalid = await app.request('/api/control-plane/reconciliation?toleranceUsd=abc');
    expect(cpInvalid.status).toBe(400);
    const cpInvalidBody = await cpInvalid.json() as { error: { code: string } };
    expect(cpInvalidBody.error.code).toBe('invalid_query');

    const usageInvalid = await app.request('/api/usage/reconciliation?toleranceUsd=abc');
    expect(usageInvalid.status).toBe(400);
    const usageInvalidBody = await usageInvalid.json() as { code: string };
    expect(usageInvalidBody.code).toBe('invalid_query');
  });

  it('returns 501 for usage reconciliation when control-plane is unavailable', async () => {
    const registry = new ProviderRegistry();
    registry.register(createMockProvider('test-provider'));

    const app = createApp({
      registry,
      config: createBaseConfig(false),
      getApiKey: () => 'test-key',
    });

    const response = await app.request('/api/usage/reconciliation');
    expect(response.status).toBe(501);
    const body = await response.json() as { code: string };
    expect(body.code).toBe('control_plane_required');
  });

  it('reconciles provider billing export totals and per-model deltas', async () => {
    const registry = new ProviderRegistry();
    registry.register(createMockProvider('test-provider'));
    const controlPlane = await createControlPlaneWithUsage();

    const app = createApp({
      registry,
      config: createBaseConfig(true),
      getApiKey: () => 'test-key',
      controlPlane,
    });

    const response = await app.request('/api/control-plane/reconciliation/provider-export', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providerId: 'test-provider',
        toleranceUsd: 0.01,
        records: [
          { providerId: 'test-provider', modelId: 'test-provider-model', costUsd: 4.0 },
        ],
      }),
    });
    expect(response.status).toBe(200);

    const body = await response.json() as {
      providerId: string;
      usageTotalCostUsd: number;
      billingExportTotalCostUsd: number;
      deltaUsd: number;
      withinTolerance: boolean;
      byModel: Array<{ modelId: string; deltaUsd: number; withinTolerance: boolean }>;
    };
    expect(body.providerId).toBe('test-provider');
    expect(body.usageTotalCostUsd).toBe(4);
    expect(body.billingExportTotalCostUsd).toBe(4);
    expect(body.deltaUsd).toBe(0);
    expect(body.withinTolerance).toBe(true);
    expect(body.byModel).toHaveLength(1);
    expect(body.byModel[0]?.modelId).toBe('test-provider-model');
    expect(body.byModel[0]?.deltaUsd).toBe(0);
    expect(body.byModel[0]?.withinTolerance).toBe(true);
  });

  it('validates provider export reconciliation payload', async () => {
    const registry = new ProviderRegistry();
    registry.register(createMockProvider('test-provider'));
    const controlPlane = await createControlPlaneWithUsage();

    const app = createApp({
      registry,
      config: createBaseConfig(true),
      getApiKey: () => 'test-key',
      controlPlane,
    });

    const response = await app.request('/api/control-plane/reconciliation/provider-export', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providerId: 'test-provider',
        records: [
          { modelId: 'test-provider-model', costUsd: -1 },
        ],
      }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { code: string } };
    expect(body.error.code).toBe('invalid_body');
  });
});
