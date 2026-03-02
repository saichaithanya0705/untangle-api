import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type ServerOptions } from '../index.js';
import { DeploymentRouter, ProviderRegistry, type ProviderAdapter, type Config } from '@untangle-ai/core';
import { buildChatContinuationRequest } from '../routes/chat.js';
import { createStreamingResponse, extractSseDataEntries } from './helpers/stream-harness.js';

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
      if (chunk === '__NETWORK_ERROR__') {
        throw new TypeError('network stream interrupted');
      }
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

function createRoutingApp(config: any, overrides?: { cache?: Config['cache'] }) {
  const registry = new ProviderRegistry();
  registry.register(createMockProvider('primary', ['primary-model']));
  registry.register(createMockProvider('secondary', ['secondary-model']));

  const runtimeKeys = new Map<string, string>([
    ['primary', 'primary-key'],
    ['secondary', 'secondary-key'],
  ]);

  const appOptions: ServerOptions = {
    registry,
    config: {
      server: { port: 3000, host: 'localhost' },
      providers: {},
      routing: config,
      cache: overrides?.cache,
      controlPlane: {
        enabled: false,
        virtualKeyHeader: 'x-untangle-key',
        postgres: { enabled: false, schema: 'public' },
        redis: { enabled: false, keyPrefix: 'untangle' },
      },
    },
    getApiKey: (providerId) => runtimeKeys.get(providerId),
  };

  return createApp(appOptions);
}

describe('DeploymentRouter', () => {
  it('prefers lower EMA latency when using least-latency strategy', () => {
    const registry = new ProviderRegistry();
    registry.register(createMockProvider('primary', ['primary-model']));
    registry.register(createMockProvider('secondary', ['secondary-model']));

    const router = new DeploymentRouter({
      groups: [{
        alias: 'prod',
        strategy: 'least-latency',
        deployments: [
          { provider: 'primary', model: 'primary-model', priority: 0 },
          { provider: 'secondary', model: 'secondary-model', priority: 1 },
        ],
      }],
    });

    const firstSelection = router.selectDeployments('prod', registry);
    expect(firstSelection.deployments.map((deployment) => deployment.providerId)).toEqual(['primary', 'secondary']);

    router.recordSuccess(firstSelection.deployments[0], 240);
    router.recordSuccess(firstSelection.deployments[1], 35);

    const secondSelection = router.selectDeployments('prod', registry);
    expect(secondSelection.deployments[0]?.providerId).toBe('secondary');
  });

  it('opens and later half-opens a circuit after repeated failures', () => {
    let now = 0;

    const registry = new ProviderRegistry();
    registry.register(createMockProvider('primary', ['primary-model']));

    const router = new DeploymentRouter({
      groups: [{
        alias: 'prod',
        deployments: [{ provider: 'primary', model: 'primary-model' }],
        circuitBreaker: {
          failureThreshold: 1,
          resetTimeoutMs: 500,
        },
      }],
    }, {
      now: () => now,
    });

    const first = router.selectDeployments('prod', registry);
    expect(first.deployments).toHaveLength(1);

    router.recordFailure(first.deployments[0]);

    const blocked = router.selectDeployments('prod', registry);
    expect(blocked.deployments).toHaveLength(0);

    now = 501;
    const recovered = router.selectDeployments('prod', registry);
    expect(recovered.deployments).toHaveLength(1);
  });

  it('propagates default and group stream fallback policy to resolved deployments', () => {
    const registry = new ProviderRegistry();
    registry.register(createMockProvider('primary', ['primary-model']));
    registry.register(createMockProvider('secondary', ['secondary-model']));

    const router = new DeploymentRouter({
      defaultStreamFallbackPolicy: {
        mode: 'continue-with-policy-prompt',
        policyPrompt: 'Continue with default prompt.',
      },
      groups: [
        {
          alias: 'inherits-default',
          deployments: [{ provider: 'primary', model: 'primary-model' }],
        },
        {
          alias: 'overrides-default',
          streamFallbackPolicy: {
            mode: 'continue-disabled',
            policyPrompt: 'Group override prompt.',
          },
          deployments: [{ provider: 'secondary', model: 'secondary-model' }],
        },
      ],
    });

    const inherited = router.selectDeployments('inherits-default', registry).deployments[0];
    expect(inherited?.streamFallbackPolicy.mode).toBe('continue-with-policy-prompt');
    expect(inherited?.streamFallbackPolicy.policyPrompt).toBe('Continue with default prompt.');

    const overridden = router.selectDeployments('overrides-default', registry).deployments[0];
    expect(overridden?.streamFallbackPolicy.mode).toBe('continue-disabled');
    expect(overridden?.streamFallbackPolicy.policyPrompt).toBe('Group override prompt.');
  });

  it('prefers same-region deployment when region routing is enabled', () => {
    const registry = new ProviderRegistry();
    registry.register(createMockProvider('primary', ['primary-model']));
    registry.register(createMockProvider('secondary', ['secondary-model']));

    const router = new DeploymentRouter({
      regionRouting: {
        enabled: true,
        homeRegion: 'us-east-1',
        failoverRegions: ['us-west-2'],
        allowCrossRegionFallback: true,
      },
      groups: [{
        alias: 'prod',
        strategy: 'priority',
        deployments: [
          { provider: 'primary', model: 'primary-model', priority: 0, region: 'us-east-1' },
          { provider: 'secondary', model: 'secondary-model', priority: 1, region: 'us-west-2' },
        ],
      }],
    });

    const selection = router.selectDeployments('prod', registry, { clientRegion: 'us-west-2' });
    expect(selection.deployments[0]?.providerId).toBe('secondary');
    expect(selection.deployments[0]?.region).toBe('us-west-2');
  });

  it('can restrict attempts to local region when cross-region fallback is disabled', () => {
    const registry = new ProviderRegistry();
    registry.register(createMockProvider('primary', ['primary-model']));
    registry.register(createMockProvider('secondary', ['secondary-model']));

    const router = new DeploymentRouter({
      regionRouting: {
        enabled: true,
        homeRegion: 'us-east-1',
        failoverRegions: ['us-west-2'],
        allowCrossRegionFallback: false,
      },
      groups: [{
        alias: 'prod',
        strategy: 'priority',
        deployments: [
          { provider: 'primary', model: 'primary-model', priority: 0, region: 'us-east-1' },
          { provider: 'secondary', model: 'secondary-model', priority: 1, region: 'us-west-2' },
        ],
      }],
    });

    const selection = router.selectDeployments('prod', registry, { clientRegion: 'us-east-1' });
    expect(selection.deployments).toHaveLength(1);
    expect(selection.deployments[0]?.providerId).toBe('primary');
    expect(selection.deployments[0]?.region).toBe('us-east-1');
  });

  it('auto-ejects unhealthy regions when failure ejection is enabled', () => {
    const registry = new ProviderRegistry();
    registry.register(createMockProvider('primary', ['primary-model']));
    registry.register(createMockProvider('secondary', ['secondary-model']));

    const router = new DeploymentRouter({
      regionRouting: {
        enabled: true,
        homeRegion: 'us-east-1',
        failoverRegions: ['us-west-2'],
        allowCrossRegionFallback: true,
        failureEjection: {
          enabled: true,
          failureThreshold: 1,
          cooldownMs: 60_000,
        },
      },
      groups: [{
        alias: 'prod',
        strategy: 'priority',
        deployments: [
          { provider: 'primary', model: 'primary-model', priority: 0, region: 'us-east-1' },
          { provider: 'secondary', model: 'secondary-model', priority: 1, region: 'us-west-2' },
        ],
      }],
    });

    const beforeFailure = router.selectDeployments('prod', registry, { clientRegion: 'us-east-1' });
    expect(beforeFailure.deployments[0]?.providerId).toBe('primary');

    router.recordFailure(beforeFailure.deployments[0]);

    const afterFailure = router.selectDeployments('prod', registry, { clientRegion: 'us-east-1' });
    expect(afterFailure.deployments[0]?.providerId).toBe('secondary');
  });

  it('routes fully to canary lane when canary rollout is at 100%', () => {
    const registry = new ProviderRegistry();
    registry.register(createMockProvider('primary', ['primary-model']));
    registry.register(createMockProvider('secondary', ['secondary-model']));

    const router = new DeploymentRouter({
      groups: [{
        alias: 'prod',
        strategy: 'priority',
        rollout: {
          mode: 'canary',
          canaryPercent: 100,
          includeStableFallback: false,
        },
        deployments: [
          { provider: 'primary', model: 'primary-model', priority: 0, lane: 'stable' },
          { provider: 'secondary', model: 'secondary-model', priority: 1, lane: 'canary' },
        ],
      }],
    });

    const selection = router.selectDeployments('prod', registry);
    expect(selection.deployments).toHaveLength(1);
    expect(selection.deployments[0]?.providerId).toBe('secondary');
    expect(selection.deployments[0]?.lane).toBe('canary');
  });

  it('keeps A/B rollout deterministic for the same rollout key', () => {
    const registry = new ProviderRegistry();
    registry.register(createMockProvider('primary', ['primary-model']));
    registry.register(createMockProvider('secondary', ['secondary-model']));

    const router = new DeploymentRouter({
      groups: [{
        alias: 'prod',
        strategy: 'priority',
        rollout: {
          mode: 'ab',
          canaryPercent: 50,
          includeStableFallback: false,
        },
        deployments: [
          { provider: 'primary', model: 'primary-model', priority: 0, lane: 'stable' },
          { provider: 'secondary', model: 'secondary-model', priority: 1, lane: 'canary' },
        ],
      }],
    });

    const alphaA = router.selectDeployments('prod', registry, { rolloutKey: 'alpha' });
    const alphaB = router.selectDeployments('prod', registry, { rolloutKey: 'alpha' });
    const beta = router.selectDeployments('prod', registry, { rolloutKey: 'beta' });

    expect(alphaA.deployments[0]?.providerId).toBe(alphaB.deployments[0]?.providerId);
    expect(alphaA.deployments[0]?.providerId).toBe('secondary');
    expect(beta.deployments[0]?.providerId).toBe('primary');
  });
});

describe('buildChatContinuationRequest', () => {
  it('appends assistant partial output and policy prompt when partial output exists', () => {
    const continuation = buildChatContinuationRequest(
      {
        model: 'gpt-prod',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      },
      'secondary-model',
      'partial assistant output',
      'Continue exactly where you stopped.',
    );

    expect(continuation.model).toBe('secondary-model');
    expect(continuation.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'partial assistant output' },
      { role: 'user', content: 'Continue exactly where you stopped.' },
    ]);
  });

  it('switches model without mutating messages when partial output is empty', () => {
    const continuation = buildChatContinuationRequest(
      {
        model: 'gpt-prod',
        messages: [{ role: 'user', content: 'hello' }],
      },
      'secondary-model',
      '   ',
      'Continue exactly where you stopped.',
    );

    expect(continuation.model).toBe('secondary-model');
    expect(continuation.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });
});

describe('Chat Routing Fallback', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to the next deployment for retryable upstream failures', async () => {
    const app = createRoutingApp({
      groups: [{
        alias: 'gpt-prod',
        strategy: 'priority',
        deployments: [
          { provider: 'primary', model: 'primary-model', priority: 0 },
          { provider: 'secondary', model: 'secondary-model', priority: 1 },
        ],
      }],
    });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: { message: 'temporary unavailable', type: 'api_error', code: null },
      }), {
        status: 503,
        headers: { 'content-type': 'application/json', 'retry-after': '1' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'chatcmpl-success',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'secondary-model',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'fallback response' },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 4,
          total_tokens: 14,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-prod',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const body = await response.json() as { model: string; choices: Array<{ message: { content: string } }> };
    expect(body.model).toBe('secondary-model');
    expect(body.choices[0]?.message?.content).toBe('fallback response');
  });

  it('returns cached non-stream chat responses when exact cache is enabled', async () => {
    const app = createRoutingApp({
      groups: [{
        alias: 'gpt-prod',
        strategy: 'priority',
        deployments: [
          { provider: 'primary', model: 'primary-model', priority: 0 },
        ],
      }],
    }, {
      cache: {
        exact: {
          enabled: true,
          ttlMs: 60_000,
          maxEntries: 100,
          chat: true,
          responses: false,
        },
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'chatcmpl-cache',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'primary-model',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'cached-value' },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 2,
        total_tokens: 7,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const requestPayload = {
      model: 'gpt-prod',
      messages: [{ role: 'user', content: 'cache me' }],
    };

    const first = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestPayload),
    });
    expect(first.status).toBe(200);
    expect(first.headers.get('x-untangle-cache')).toBe('miss');

    const second = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestPayload),
    });
    expect(second.status).toBe(200);
    expect(second.headers.get('x-untangle-cache')).toBe('hit');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const secondBody = await second.json() as { choices: Array<{ message: { content: string } }> };
    expect(secondBody.choices[0]?.message?.content).toBe('cached-value');
  });

  it('mirrors successful non-stream requests to configured shadow deployments', async () => {
    const app = createRoutingApp({
      groups: [ {
        alias: 'gpt-prod',
        strategy: 'priority',
        rollout: {
          mode: 'disabled',
          shadow: {
            enabled: true,
            samplePercent: 100,
            maxDeployments: 1,
          },
        },
        deployments: [
          { provider: 'primary', model: 'primary-model', priority: 0, lane: 'stable' },
          { provider: 'secondary', model: 'secondary-model', priority: 1, lane: 'shadow' },
        ],
      } ],
    });

    const fetchMock = vi.fn().mockImplementation((_url, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { model: string };
      const content = payload.model === 'primary-model' ? 'primary-response' : 'shadow-response';
      return Promise.resolve(new Response(JSON.stringify({
        id: `chatcmpl-${payload.model}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: payload.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content },
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

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-prod',
        messages: [{ role: 'user', content: 'hello shadow' }],
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { model: string; choices: Array<{ message: { content: string } }> };
    expect(body.model).toBe('primary-model');
    expect(body.choices[0]?.message?.content).toBe('primary-response');

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const firstPayload = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as { model: string };
    const secondPayload = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as { model: string };
    expect(firstPayload.model).toBe('primary-model');
    expect(secondPayload.model).toBe('secondary-model');
  });

  it('routes to same-region deployment when x-untangle-region is provided', async () => {
    const app = createRoutingApp({
      regionRouting: {
        enabled: true,
        homeRegion: 'us-east-1',
        defaultClientRegion: 'us-east-1',
        failoverRegions: ['us-west-2'],
        allowCrossRegionFallback: true,
      },
      groups: [{
        alias: 'gpt-prod',
        strategy: 'priority',
        deployments: [
          { provider: 'primary', model: 'primary-model', priority: 0, region: 'us-east-1' },
          { provider: 'secondary', model: 'secondary-model', priority: 1, region: 'us-west-2' },
        ],
      }],
    });

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'chatcmpl-region',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'secondary-model',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'west-region response' },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 4,
        completion_tokens: 3,
        total_tokens: 7,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-untangle-region': 'us-west-2',
      },
      body: JSON.stringify({
        model: 'gpt-prod',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const firstPayload = JSON.parse(String(firstInit.body)) as { model: string };
    expect(firstPayload.model).toBe('secondary-model');
  });

  it('uses rollout key headers for deterministic A/B routing decisions', async () => {
    const app = createRoutingApp({
      groups: [{
        alias: 'gpt-prod',
        strategy: 'priority',
        rollout: {
          mode: 'ab',
          canaryPercent: 50,
          includeStableFallback: false,
        },
        deployments: [
          { provider: 'primary', model: 'primary-model', priority: 0, lane: 'stable' },
          { provider: 'secondary', model: 'secondary-model', priority: 1, lane: 'canary' },
        ],
      }],
    });

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'chatcmpl-rollout',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'secondary-model',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'ab response' },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 4,
        completion_tokens: 3,
        total_tokens: 7,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-untangle-rollout-key': 'alpha',
      },
      body: JSON.stringify({
        model: 'gpt-prod',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    expect(response.status).toBe(200);
    const firstInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const firstPayload = JSON.parse(String(firstInit.body)) as { model: string };
    expect(firstPayload.model).toBe('secondary-model');
  });

  it('supports manual region ejection and restore through router admin endpoints', async () => {
    const app = createRoutingApp({
      regionRouting: {
        enabled: true,
        homeRegion: 'us-east-1',
        defaultClientRegion: 'us-east-1',
        failoverRegions: ['us-west-2'],
        allowCrossRegionFallback: true,
      },
      groups: [{
        alias: 'gpt-prod',
        strategy: 'priority',
        deployments: [
          { provider: 'primary', model: 'primary-model', priority: 0, region: 'us-east-1' },
          { provider: 'secondary', model: 'secondary-model', priority: 1, region: 'us-west-2' },
        ],
      }],
    });

    const fetchMock = vi.fn().mockImplementation((_url, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model?: string };
      const model = body.model ?? 'unknown-model';
      return Promise.resolve(new Response(JSON.stringify({
        id: 'chatcmpl-region-admin',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: `from-${model}` },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: 4,
          completion_tokens: 2,
          total_tokens: 6,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const eject = await app.request('/api/router/regions/us-east-1/eject', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'drill' }),
    });
    expect(eject.status).toBe(200);

    const first = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-untangle-region': 'us-east-1',
      },
      body: JSON.stringify({
        model: 'gpt-prod',
        messages: [{ role: 'user', content: 'first' }],
      }),
    });
    expect(first.status).toBe(200);
    const firstPayload = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as { model: string };
    expect(firstPayload.model).toBe('secondary-model');

    const restore = await app.request('/api/router/regions/us-east-1/restore', {
      method: 'POST',
    });
    expect(restore.status).toBe(200);

    const second = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-untangle-region': 'us-east-1',
      },
      body: JSON.stringify({
        model: 'gpt-prod',
        messages: [{ role: 'user', content: 'second' }],
      }),
    });
    expect(second.status).toBe(200);
    const secondPayload = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as { model: string };
    expect(secondPayload.model).toBe('primary-model');
  });

  it('does not continue mid-stream by default after an interrupted provider stream', async () => {
    const app = createRoutingApp({
      groups: [{
        alias: 'gpt-prod',
        strategy: 'priority',
        deployments: [
          { provider: 'primary', model: 'primary-model', priority: 0 },
          { provider: 'secondary', model: 'secondary-model', priority: 1 },
        ],
      }],
    });

    const primaryChunk = 'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":123,"model":"primary-model","choices":[{"index":0,"delta":{"content":"hello "},"finish_reason":null}]}\n\n';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createStreamingResponse([
        primaryChunk,
        'data: __NETWORK_ERROR__\n\n',
      ]))
      .mockResolvedValueOnce(createStreamingResponse([
        'data: {"id":"chatcmpl-2","object":"chat.completion.chunk","created":123,"model":"secondary-model","choices":[{"index":0,"delta":{"content":"world"},"finish_reason":null}]}\n\n',
        'data: [DONE]\n\n',
      ]));
    vi.stubGlobal('fetch', fetchMock);

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-prod',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = await response.text();
    const entries = extractSseDataEntries(body);
    expect(entries.some((entry) => entry.includes('"content":"hello "'))).toBe(true);
    expect(entries.some((entry) => entry.includes('"content":"world"'))).toBe(false);
    expect(entries.some((entry) => entry.includes('"error"'))).toBe(true);
  });

  it('continues mid-stream with policy prompt when continuation mode is enabled', async () => {
    const policyPrompt = 'Continue exactly where the previous stream was interrupted.';
    const app = createRoutingApp({
      defaultStreamFallbackPolicy: {
        mode: 'continue-with-policy-prompt',
        policyPrompt,
      },
      groups: [{
        alias: 'gpt-prod',
        strategy: 'priority',
        streamFallbackPolicy: {
          mode: 'continue-with-policy-prompt',
          policyPrompt,
        },
        deployments: [
          { provider: 'primary', model: 'primary-model', priority: 0 },
          { provider: 'secondary', model: 'secondary-model', priority: 1 },
        ],
      }],
    });

    const primaryChunk = 'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":123,"model":"primary-model","choices":[{"index":0,"delta":{"content":"hello "},"finish_reason":null}]}\n\n';
    const secondaryChunk = 'data: {"id":"chatcmpl-2","object":"chat.completion.chunk","created":123,"model":"secondary-model","choices":[{"index":0,"delta":{"content":"world"},"finish_reason":null}]}\n\n';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(createStreamingResponse([
        primaryChunk,
        'data: __NETWORK_ERROR__\n\n',
      ]))
      .mockResolvedValueOnce(createStreamingResponse([
        secondaryChunk,
        'data: [DONE]\n\n',
      ]));
    vi.stubGlobal('fetch', fetchMock);

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-prod',
        stream: true,
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const secondInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const secondPayload = JSON.parse(String(secondInit.body)) as {
      model: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(secondPayload.model).toBe('secondary-model');
    expect(secondPayload.messages.at(-2)).toEqual({ role: 'assistant', content: 'hello ' });
    expect(secondPayload.messages.at(-1)).toEqual({ role: 'user', content: policyPrompt });

    const entries = extractSseDataEntries(body);
    const helloIndex = entries.findIndex((entry) => entry.includes('"content":"hello "'));
    const worldIndex = entries.findIndex((entry) => entry.includes('"content":"world"'));
    const doneIndex = entries.lastIndexOf('[DONE]');
    expect(helloIndex).toBeGreaterThan(-1);
    expect(worldIndex).toBeGreaterThan(helloIndex);
    expect(doneIndex).toBeGreaterThan(worldIndex);
    expect(body).not.toContain('"error"');
  });

  it('remains stable under burst traffic when primary deployment is failing', async () => {
    const app = createRoutingApp({
      groups: [{
        alias: 'gpt-prod',
        strategy: 'priority',
        cooldownMs: 0,
        retryPolicy: {
          maxAttempts: 3,
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
    });

    const fetchMock = vi.fn().mockImplementation((_url, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { model?: string };
      if (body.model === 'primary-model') {
        return Promise.resolve(new Response(JSON.stringify({
          error: { message: 'primary temporarily unavailable', type: 'api_error', code: null },
        }), {
          status: 503,
          headers: { 'content-type': 'application/json', 'retry-after': '1' },
        }));
      }

      return Promise.resolve(new Response(JSON.stringify({
        id: `chatcmpl-success-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'secondary-model',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'secondary response' },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: 8,
          completion_tokens: 4,
          total_tokens: 12,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    });
    vi.stubGlobal('fetch', fetchMock);

    const requests = Array.from({ length: 25 }, (_, index) =>
      app.request('/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-prod',
          messages: [{ role: 'user', content: `hello-${index}` }],
        }),
      }));

    const responses = await Promise.all(requests);
    expect(responses.every((response) => response.status === 200)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(50);

    const metricsResponse = await app.request('/metrics');
    expect(metricsResponse.status).toBe(200);
    const metricsBody = await metricsResponse.text();
    expect(metricsBody).toContain('untangle_router_fallback_total');
  });

  it('does not retry on non-retryable status codes', async () => {
    const app = createRoutingApp({
      groups: [{
        alias: 'gpt-prod',
        strategy: 'priority',
        deployments: [
          { provider: 'primary', model: 'primary-model', priority: 0 },
          { provider: 'secondary', model: 'secondary-model', priority: 1 },
        ],
      }],
    });

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      error: { message: 'invalid request', type: 'invalid_request_error', code: 'bad_request' },
    }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-prod',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    expect(response.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('propagates trace context to upstream provider requests', async () => {
    const app = createRoutingApp({
      groups: [{
        alias: 'gpt-prod',
        strategy: 'priority',
        deployments: [
          { provider: 'primary', model: 'primary-model', priority: 0 },
        ],
      }],
    });

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'chatcmpl-success',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'primary-model',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 2,
        total_tokens: 7,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const incomingTraceparent = '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01';
    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        traceparent: incomingTraceparent,
      },
      body: JSON.stringify({
        model: 'gpt-prod',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const fetchInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = new Headers(fetchInit?.headers);
    const forwardedTraceparent = headers.get('traceparent');
    expect(forwardedTraceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
    expect(forwardedTraceparent?.split('-')[1]).toBe('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
  });

  it('records provider upstream metrics after chat request', async () => {
    const app = createRoutingApp({
      groups: [{
        alias: 'gpt-prod',
        strategy: 'priority',
        deployments: [
          { provider: 'primary', model: 'primary-model', priority: 0 },
        ],
      }],
    });

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'chatcmpl-success',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'primary-model',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 2,
        total_tokens: 7,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-prod',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    });
    expect(response.status).toBe(200);

    const metrics = await app.request('/metrics');
    expect(metrics.status).toBe(200);
    const body = await metrics.text();
    expect(body).toContain('untangle_provider_requests_total');
    expect(body).toContain('provider="primary"');
    expect(body).toContain('endpoint="chat.completions"');
  });

  it('normalizes max_completion_tokens to max_tokens for provider request', async () => {
    const app = createRoutingApp({
      groups: [{
        alias: 'gpt-prod',
        strategy: 'priority',
        deployments: [
          { provider: 'primary', model: 'primary-model', priority: 0 },
        ],
      }],
    });

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'chatcmpl-success',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'primary-model',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 5,
        completion_tokens: 2,
        total_tokens: 7,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-prod',
        messages: [{ role: 'user', content: 'hello' }],
        max_completion_tokens: 64,
      }),
    });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const fetchInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const payload = JSON.parse(String(fetchInit?.body)) as Record<string, unknown>;
    expect(payload.max_tokens).toBe(64);
    expect(payload.max_completion_tokens).toBeUndefined();
  });

  it('rejects unknown fields in strict compatibility mode', async () => {
    // Build a strict-mode app to verify unknown field rejection.
    const registry = new ProviderRegistry();
    registry.register(createMockProvider('primary', ['primary-model']));
    const strictApp = createApp({
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
            deployments: [{ provider: 'primary', model: 'primary-model', priority: 0, weight: 1, enabled: true, lane: 'stable' }],
          }],
          defaultStrategy: 'priority',
          defaultCooldownMs: 0,
          defaultRetryPolicy: { maxAttempts: 3, retryableStatusCodes: [408, 409, 429, 500, 502, 503, 504] },
          defaultCircuitBreaker: { failureThreshold: 3, resetTimeoutMs: 30000 },
          defaultStreamFallbackPolicy: undefined,
        },
        controlPlane: {
          enabled: false,
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
      },
      getApiKey: () => 'primary-key',
    });

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await strictApp.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'gpt-prod',
        messages: [{ role: 'user', content: 'hello' }],
        unexpected_field: 'x',
      }),
    });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: { code: string } };
    expect(body.error.code).toBe('unknown_fields');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('exposes router decision debug snapshot for a deployment group alias', async () => {
    const app = createRoutingApp({
      groups: [{
        alias: 'gpt-prod',
        strategy: 'priority',
        deployments: [
          { provider: 'primary', model: 'primary-model', priority: 0 },
          { provider: 'secondary', model: 'secondary-model', priority: 1 },
        ],
      }],
    });

    const response = await app.request('/api/router/decisions/gpt-prod');
    expect(response.status).toBe(200);
    const body = await response.json() as {
      modelAlias: string;
      strategy: string;
      deployments: Array<{ providerId: string; modelId: string; eligible: boolean }>;
    };
    expect(body.modelAlias).toBe('gpt-prod');
    expect(body.strategy).toBe('priority');
    expect(body.deployments.map((deployment) => deployment.providerId)).toEqual(['primary', 'secondary']);
    expect(body.deployments.every((deployment) => deployment.eligible)).toBe(true);
  });
});
