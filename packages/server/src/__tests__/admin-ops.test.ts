import { describe, expect, it } from 'vitest';
import { createApp, type ServerOptions } from '../index.js';
import { ProviderRegistry, SecurityConfigSchema, type ProviderAdapter } from '@untangle-ai/core';

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

function createServer(overrides?: {
  security?: {
    requireAdminAuthForApi?: boolean;
    adminApiKey?: string;
    adminHeader?: string;
    allowBearerToken?: boolean;
  };
}) {
  const registry = new ProviderRegistry();
  registry.register(createMockProvider('primary', ['primary-model']));
  registry.register(createMockProvider('secondary', ['secondary-model']));

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
          streamFallbackPolicy: undefined,
          deployments: [
            { provider: 'primary', model: 'primary-model', priority: 0, weight: 1, enabled: true, lane: 'stable' },
            { provider: 'secondary', model: 'secondary-model', priority: 1, weight: 1, enabled: true, lane: 'stable' },
          ],
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
      security: overrides?.security
        ? SecurityConfigSchema.parse({
            requireAdminAuthForApi: overrides.security.requireAdminAuthForApi ?? false,
            adminApiKey: overrides.security.adminApiKey,
            adminHeader: overrides.security.adminHeader ?? 'x-untangle-admin-key',
            allowBearerToken: overrides.security.allowBearerToken ?? true,
            requireDataPlaneAuth: false,
            requireContentLength: false,
            protectMetrics: false,
          })
        : SecurityConfigSchema.parse({
            requireDataPlaneAuth: false,
            requireContentLength: false,
            protectMetrics: false,
          }),
    },
    getApiKey: () => 'test-key',
  };
  return createApp(options);
}

describe('Admin security middleware', () => {
  it('denies admin-plane routes without token when enabled', async () => {
    const app = createServer({
      security: {
        requireAdminAuthForApi: true,
        adminApiKey: 'secret-token',
      },
    });

    const res = await app.request('/api/settings');
    expect(res.status).toBe(401);
    const body = await res.json() as { error: { code: string } };
    expect(body.error.code).toBe('admin_auth_required');
  });

  it('allows admin-plane routes with configured header token', async () => {
    const app = createServer({
      security: {
        requireAdminAuthForApi: true,
        adminApiKey: 'secret-token',
        adminHeader: 'x-untangle-admin-key',
      },
    });

    const res = await app.request('/api/settings', {
      headers: { 'x-untangle-admin-key': 'secret-token' },
    });
    expect(res.status).toBe(200);
  });

  it('allows admin-plane routes with bearer token when enabled', async () => {
    const app = createServer({
      security: {
        requireAdminAuthForApi: true,
        adminApiKey: 'secret-token',
        allowBearerToken: true,
      },
    });

    const res = await app.request('/api/settings', {
      headers: { authorization: 'Bearer secret-token' },
    });
    expect(res.status).toBe(200);
  });

  it('creates an admin session cookie and accepts it on later admin requests', async () => {
    const app = createServer({
      security: {
        requireAdminAuthForApi: true,
        adminApiKey: 'secret-token',
      },
    });

    const login = await app.request('/api/admin/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adminKey: 'secret-token' }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie');
    expect(cookie).toContain('untangle_admin_session=');

    const settings = await app.request('/api/settings', {
      headers: { cookie: String(cookie).split(';', 1)[0] ?? '' },
    });
    expect(settings.status).toBe(200);
  });

  it('rejects admin session creation with the wrong bootstrap key', async () => {
    const app = createServer({
      security: {
        requireAdminAuthForApi: true,
        adminApiKey: 'secret-token',
      },
    });

    const login = await app.request('/api/admin/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adminKey: 'wrong-token' }),
    });
    expect(login.status).toBe(401);
  });

  it('creates a shareable dashboard snapshot and records growth metrics', async () => {
    const app = createServer({
      security: {
        requireAdminAuthForApi: true,
        adminApiKey: 'secret-token',
      },
    });

    const login = await app.request('/api/admin/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adminKey: 'secret-token' }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie');

    const shareResponse = await app.request('/api/dashboard/share', {
      method: 'POST',
      headers: { cookie: String(cookie).split(';', 1)[0] ?? '' },
    });
    expect(shareResponse.status).toBe(200);
    const shareBody = await shareResponse.json() as { token: string; expiresAt: string };
    expect(shareBody.token.length).toBeGreaterThan(20);
    expect(new Date(shareBody.expiresAt).getTime()).toBeGreaterThan(Date.now());

    const publicResponse = await app.request(`/public/dashboard-share/${shareBody.token}`);
    expect(publicResponse.status).toBe(200);
    const publicBody = await publicResponse.json() as {
      snapshot: {
        summary: { totalProviders: number; totalModels: number };
        providers: Array<{ id: string }>;
      };
    };
    expect(publicBody.snapshot.summary.totalProviders).toBe(2);
    expect(publicBody.snapshot.summary.totalModels).toBe(2);
    expect(publicBody.snapshot.providers.map((provider) => provider.id)).toContain('primary');

    const metrics = await app.request('/metrics');
    const metricsBody = await metrics.text();
    expect(metricsBody).toContain('untangle_growth_events_total{event="share_generated"} 1');
    expect(metricsBody).toContain('untangle_growth_events_total{event="share_opened"} 1');
  });

  it('does not apply admin auth to data-plane routes', async () => {
    const app = createServer({
      security: {
        requireAdminAuthForApi: true,
        adminApiKey: 'secret-token',
      },
    });

    const res = await app.request('/v1/models');
    expect(res.status).toBe(200);
  });
});

describe('Admin IaC operations', () => {
  it('exports, plans, and applies declarative admin changes', async () => {
    const app = createServer();

    const exportBefore = await app.request('/api/admin/iac/export');
    expect(exportBefore.status).toBe(200);
    const beforeBody = await exportBefore.json() as {
      spec: {
        providers: Array<{ id: string; enabled: boolean; models: Array<{ id: string; enabled: boolean }> }>;
      };
    };
    const secondaryBefore = beforeBody.spec.providers.find((provider) => provider.id === 'secondary');
    expect(secondaryBefore?.enabled).toBe(true);

    const desiredSpec = {
      providers: [
        { id: 'secondary', enabled: false, models: [{ id: 'secondary-model', enabled: false }] },
      ],
      routing: {
        regions: [{ region: 'us-east-1', ejected: true, reason: 'iac-test' }],
      },
    };

    const planResponse = await app.request('/api/admin/iac/plan', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(desiredSpec),
    });
    expect(planResponse.status).toBe(200);
    const plan = await planResponse.json() as {
      plan: {
        providerChanges: unknown[];
        modelChanges: unknown[];
        regionChanges: unknown[];
      };
    };
    expect(plan.plan.providerChanges.length).toBe(1);
    expect(plan.plan.modelChanges.length).toBe(1);
    expect(plan.plan.regionChanges.length).toBe(1);

    const applyResponse = await app.request('/api/admin/iac/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(desiredSpec),
    });
    expect(applyResponse.status).toBe(200);
    const applied = await applyResponse.json() as {
      applied: boolean;
      state: {
        providers: Array<{ id: string; enabled: boolean; models: Array<{ id: string; enabled: boolean }> }>;
        routing: { regions: Array<{ region: string; ejected: boolean }> };
      };
    };
    expect(applied.applied).toBe(true);

    const secondaryAfter = applied.state.providers.find((provider) => provider.id === 'secondary');
    expect(secondaryAfter?.enabled).toBe(false);
    const secondaryModelAfter = secondaryAfter?.models.find((model) => model.id === 'secondary-model');
    expect(secondaryModelAfter?.enabled).toBe(false);
    const usEast = applied.state.routing.regions.find((region) => region.region === 'us-east-1');
    expect(usEast?.ejected).toBe(true);
  });
});
