import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from '../index.js';
import {
  ControlPlaneService,
  InMemoryControlPlaneStore,
  InMemoryRateLimiter,
  ProviderRegistry,
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

describe('Phase 2 release safety checks', () => {
  it('passes canary smoke endpoints and migration artifact checks', async () => {
    const registry = new ProviderRegistry();
    registry.register(createMockProvider('canary', ['canary-model']));

    const controlPlane = new ControlPlaneService(
      new InMemoryControlPlaneStore(),
      new InMemoryRateLimiter(),
    );

    const app = createApp({
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
          enabled: true,
          failureMode: 'fallback',
          virtualKeyHeader: 'x-untangle-key',
          postgres: { enabled: false, schema: 'public' },
          redis: { enabled: false, keyPrefix: 'untangle' },
        },
      },
      controlPlane,
      getApiKey: () => 'canary-key',
    });

    const health = await app.request('/health');
    const metrics = await app.request('/metrics');
    const settings = await app.request('/api/settings');
    const schema = await app.request('/api/control-plane/schema/postgres');

    expect(health.status).toBe(200);
    expect(metrics.status).toBe(200);
    expect(settings.status).toBe(200);
    expect(schema.status).toBe(200);

    const schemaBody = await schema.text();
    expect(schemaBody).toContain('create table if not exists');
    expect(schemaBody).toContain('cp_virtual_keys');
    expect(schemaBody).toContain('cp_usage_events');
    expect(schemaBody).toContain('cp_spend_ledger');
    expect(schema.headers.get('x-migration-name')).toBe('control_plane_base');
  });

  it('generates rollback automation plan artifact', () => {
    const testDir = dirname(fileURLToPath(import.meta.url));
    const root = resolve(testDir, '../../../../');
    const outputRelativePath = 'packages/server/.tmp/rollback-plan.test.json';
    const outputAbsolutePath = resolve(root, outputRelativePath);

    if (existsSync(outputAbsolutePath)) {
      rmSync(outputAbsolutePath, { force: true });
    }

    execFileSync('node', ['scripts/generate-rollback-plan.js', '--output', outputRelativePath], {
      cwd: root,
      stdio: 'pipe',
    });

    expect(existsSync(outputAbsolutePath)).toBe(true);
    const payload = JSON.parse(readFileSync(outputAbsolutePath, 'utf-8')) as {
      generatedAt: string;
      commit: string;
      commands: string[];
      checkpoints: string[];
    };
    expect(payload.generatedAt).toBeTruthy();
    expect(payload.commit).toBeTruthy();
    expect(Array.isArray(payload.commands)).toBe(true);
    expect(payload.commands.length).toBeGreaterThan(0);
    expect(Array.isArray(payload.checkpoints)).toBe(true);
    expect(payload.checkpoints.length).toBeGreaterThan(0);
  });
});
