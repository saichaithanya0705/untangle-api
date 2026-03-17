import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, type ServerOptions } from '../index.js';
import { ProviderRegistry, type ProviderAdapter, type Config } from '@untangle-ai/core';

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

function createMediaApp(config: any, strictValidation: boolean = false) {
  const registry = new ProviderRegistry();
  registry.register(createMockProvider('primary', [
    'primary-image-model',
    'primary-speech-model',
    'primary-transcription-model',
  ]));
  registry.register(createMockProvider('secondary', [
    'secondary-image-model',
    'secondary-speech-model',
    'secondary-transcription-model',
  ]));

  const runtimeKeys = new Map<string, string>([
    ['primary', 'primary-key'],
    ['secondary', 'secondary-key'],
  ]);

  const options: ServerOptions = {
    registry,
    config: {
      server: { port: 3000, host: 'localhost' },
      providers: {},
      routing: config,
      controlPlane: {
        enabled: false,
        failureMode: 'fallback',
        virtualKeyHeader: 'x-untangle-key',
        postgres: { enabled: false, schema: 'public' },
        redis: { enabled: false, keyPrefix: 'untangle' },
      },
      api: {
        compatibility: {
          strictValidation,
          normalizeLegacyParams: true,
        },
      },
    },
    getApiKey: (providerId) => runtimeKeys.get(providerId),
  };

  return createApp(options);
}

describe('Media Routes', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('falls back for /v1/images/generations on retryable status', async () => {
    const app = createMediaApp({
      groups: [{
        alias: 'image-prod',
        strategy: 'priority',
        deployments: [
          { provider: 'primary', model: 'primary-image-model', priority: 0 },
          { provider: 'secondary', model: 'secondary-image-model', priority: 1 },
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
        created: 1234567890,
        data: [{ url: 'https://example.com/fallback.png' }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await app.request('/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'image-prod',
        prompt: 'A lighthouse at sunset',
      }),
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const body = await response.json() as { data: Array<{ url: string }> };
    expect(body.data[0]?.url).toBe('https://example.com/fallback.png');
  });

  it('returns binary passthrough for /v1/audio/speech', async () => {
    const app = createMediaApp({
      groups: [{
        alias: 'speech-prod',
        strategy: 'priority',
        deployments: [
          { provider: 'primary', model: 'primary-speech-model', priority: 0 },
        ],
      }],
    });

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(
      Uint8Array.from([1, 2, 3, 4]),
      {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const response = await app.request('/v1/audio/speech', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'speech-prod',
        input: 'Hello world',
        voice: 'alloy',
      }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('audio/mpeg');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
  });

  it('accepts multipart and returns JSON for /v1/audio/transcriptions', async () => {
    const app = createMediaApp({
      groups: [{
        alias: 'transcribe-prod',
        strategy: 'priority',
        deployments: [
          { provider: 'primary', model: 'primary-transcription-model', priority: 0 },
        ],
      }],
    });

    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      text: 'transcribed text',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const form = new FormData();
    form.append('model', 'transcribe-prod');
    form.append('file', new File([new Uint8Array([1, 2, 3])], 'audio.wav', { type: 'audio/wav' }));

    const response = await app.request('/v1/audio/transcriptions', {
      method: 'POST',
      body: form,
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { text: string };
    expect(body.text).toBe('transcribed text');
  });

  it('rejects unknown media request fields when strict validation is enabled', async () => {
    const app = createMediaApp({
      groups: [{
        alias: 'image-prod',
        strategy: 'priority',
        deployments: [
          { provider: 'primary', model: 'primary-image-model', priority: 0 },
        ],
      }],
    }, true);

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await app.request('/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'image-prod',
        prompt: 'A lighthouse at sunset',
        unexpected_field: 'x',
      }),
    });

    expect(response.status).toBe(400);
    const body = await response.json() as { error: { code: string } };
    expect(body.error.code).toBe('unknown_fields');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
