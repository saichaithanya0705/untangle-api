import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type ServerOptions } from '../index.js';
import { ProviderRegistry, type ProviderAdapter, type Config } from '@untangle-ai/core';
import { buildResponsesContinuationRequest } from '../routes/responses.js';
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

function createResponsesApp(config: any, overrides?: { cache?: Config['cache'] }) {
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
        failureMode: 'fallback',
        virtualKeyHeader: 'x-untangle-key',
        postgres: { enabled: false, schema: 'public' },
        redis: { enabled: false, keyPrefix: 'untangle' },
      },
    },
    getApiKey: (providerId) => runtimeKeys.get(providerId),
  };

  return createApp(appOptions);
}

describe('Responses Route', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back to next deployment on retryable upstream errors', async () => {
    const app = createResponsesApp({
      groups: [{
        alias: 'responses-prod',
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
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'chatcmpl-success',
        object: 'chat.completion',
        created: 1234567890,
        model: 'secondary-model',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'response fallback content' },
          finish_reason: 'stop',
        }],
        usage: {
          prompt_tokens: 9,
          completion_tokens: 5,
          total_tokens: 14,
        },
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'responses-prod',
        input: 'hello',
      }),
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const body = await response.json() as {
      object: string;
      status: string;
      model: string;
      output_text: string;
      usage: { input_tokens: number };
    };
    expect(body.object).toBe('response');
    expect(body.status).toBe('completed');
    expect(body.model).toBe('secondary-model');
    expect(body.output_text).toBe('response fallback content');
    expect(body.usage.input_tokens).toBe(9);
  });

  it('returns cached non-stream responses envelopes when exact cache is enabled', async () => {
    const app = createResponsesApp({
      groups: [{
        alias: 'responses-prod',
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
          chat: false,
          responses: true,
        },
      },
    });

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id: 'chatcmpl-cache-responses',
      object: 'chat.completion',
      created: 1234567890,
      model: 'primary-model',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'response-cache-value' },
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
    vi.stubGlobal('fetch', fetchMock);

    const requestPayload = {
      model: 'responses-prod',
      input: 'cache this response',
    };

    const first = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestPayload),
    });
    expect(first.status).toBe(200);
    expect(first.headers.get('x-untangle-cache')).toBe('miss');

    const second = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(requestPayload),
    });
    expect(second.status).toBe(200);
    expect(second.headers.get('x-untangle-cache')).toBe('hit');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const secondBody = await second.json() as { output_text: string };
    expect(secondBody.output_text).toBe('response-cache-value');
  });

  it('mirrors successful non-stream responses requests to shadow deployments', async () => {
    const app = createResponsesApp({
      groups: [{
        alias: 'responses-prod',
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
      }],
    });

    const fetchMock = vi.fn().mockImplementation((_url, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body)) as { model: string };
      const content = payload.model === 'primary-model' ? 'primary envelope' : 'shadow envelope';
      return Promise.resolve(new Response(JSON.stringify({
        id: `chatcmpl-${payload.model}`,
        object: 'chat.completion',
        created: 1234567890,
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

    const response = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'responses-prod',
        input: 'mirror this',
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { model: string; output_text: string };
    expect(body.model).toBe('primary-model');
    expect(body.output_text).toBe('primary envelope');

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    const firstPayload = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body)) as { model: string };
    const secondPayload = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body)) as { model: string };
    expect(firstPayload.model).toBe('primary-model');
    expect(secondPayload.model).toBe('secondary-model');
  });

  it('returns 400 when input is missing', async () => {
    const app = createResponsesApp({
      groups: [{
        alias: 'responses-prod',
        strategy: 'priority',
        deployments: [
          { provider: 'primary', model: 'primary-model', priority: 0 },
        ],
      }],
    });

    const response = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'responses-prod',
      }),
    });

    expect(response.status).toBe(400);
    const body = await response.json() as { error: { code: string } };
    expect(body.error.code).toBe('invalid_body');
  });

  it('normalizes max_tokens and messages compatibility inputs', async () => {
    const app = createResponsesApp({
      groups: [{
        alias: 'responses-prod',
        strategy: 'priority',
        deployments: [
          { provider: 'primary', model: 'primary-model', priority: 0 },
        ],
      }],
    });

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      id: 'chatcmpl-success',
      object: 'chat.completion',
      created: 1234567890,
      model: 'primary-model',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: 'ok' },
        finish_reason: 'stop',
      }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 3,
        total_tokens: 13,
      },
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'responses-prod',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 50,
      }),
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const fetchInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const payload = JSON.parse(String(fetchInit?.body)) as Record<string, unknown>;
    expect(payload.max_tokens).toBe(50);
    expect(Array.isArray(payload.messages)).toBe(true);
  });

  it('does not continue mid-stream by default for interrupted upstream streams', async () => {
    const app = createResponsesApp({
      groups: [{
        alias: 'responses-prod',
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

    const response = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'responses-prod',
        input: 'hello',
        stream: true,
      }),
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = await response.text();
    const entries = extractSseDataEntries(body);
    expect(entries.some((entry) => entry.includes('"delta":"hello "'))).toBe(true);
    expect(entries.some((entry) => entry.includes('"type":"response.error"'))).toBe(true);
    expect(entries.some((entry) => entry.includes('"delta":"world"'))).toBe(false);
  });

  it('continues mid-stream with policy prompt and preserves response event sequencing when enabled', async () => {
    const policyPrompt = 'Continue exactly where the previous stream was interrupted.';
    const app = createResponsesApp({
      defaultStreamFallbackPolicy: {
        mode: 'continue-with-policy-prompt',
        policyPrompt,
      },
      groups: [{
        alias: 'responses-prod',
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

    const response = await app.request('/v1/responses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'responses-prod',
        input: 'hello',
        stream: true,
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const secondInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    const secondPayload = JSON.parse(String(secondInit.body)) as {
      model: string;
      stream: boolean;
      messages: Array<{ role: string; content: string }>;
    };
    expect(secondPayload.model).toBe('secondary-model');
    expect(secondPayload.stream).toBe(true);
    expect(secondPayload.messages.at(-2)).toEqual({ role: 'assistant', content: 'hello ' });
    expect(secondPayload.messages.at(-1)).toEqual({ role: 'user', content: policyPrompt });

    const entries = extractSseDataEntries(body);
    const createdCount = (body.match(/event: response\.created/g) ?? []).length;
    const helloIndex = entries.findIndex((entry) => entry.includes('"delta":"hello "'));
    const worldIndex = entries.findIndex((entry) => entry.includes('"delta":"world"'));
    const doneIndex = entries.findIndex((entry) => entry.includes('"type":"response.output_text.done"'));
    const completedIndex = entries.findIndex((entry) => entry.includes('"type":"response.completed"'));

    expect(createdCount).toBe(1);
    expect(helloIndex).toBeGreaterThan(-1);
    expect(worldIndex).toBeGreaterThan(helloIndex);
    expect(doneIndex).toBeGreaterThan(worldIndex);
    expect(completedIndex).toBeGreaterThan(doneIndex);
    expect(body).not.toContain('event: response.error');
  });

});

describe('buildResponsesContinuationRequest', () => {
  it('forces streaming and appends assistant partial output and policy prompt', () => {
    const continuation = buildResponsesContinuationRequest(
      {
        model: 'responses-prod',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      },
      'secondary-model',
      'partial assistant output',
      'Continue exactly where you stopped.',
    );

    expect(continuation.model).toBe('secondary-model');
    expect(continuation.stream).toBe(true);
    expect(continuation.messages).toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'partial assistant output' },
      { role: 'user', content: 'Continue exactly where you stopped.' },
    ]);
  });

  it('forces streaming and keeps messages unchanged when partial output is empty', () => {
    const continuation = buildResponsesContinuationRequest(
      {
        model: 'responses-prod',
        stream: false,
        messages: [{ role: 'user', content: 'hello' }],
      },
      'secondary-model',
      '   ',
      'Continue exactly where you stopped.',
    );

    expect(continuation.model).toBe('secondary-model');
    expect(continuation.stream).toBe(true);
    expect(continuation.messages).toEqual([{ role: 'user', content: 'hello' }]);
  });
});
