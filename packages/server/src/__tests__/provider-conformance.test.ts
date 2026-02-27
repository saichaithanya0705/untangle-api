import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  OpenAIAdapter,
  AnthropicAdapter,
  GoogleAdapter,
  GroqAdapter,
  OpenRouterAdapter,
  type OpenAIRequest,
} from '@untangle-ai/core';

function loadFixture<T>(filename: string): T {
  const fileUrl = new URL(`../__fixtures__/provider-conformance/${filename}`, import.meta.url);
  return JSON.parse(readFileSync(fileUrl, 'utf-8')) as T;
}

function withoutUndefined<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('Provider Translation Conformance (Phase 1 expanded)', () => {
  it('OpenAI adapter preserves golden passthrough request/response payloads', () => {
    const adapter = new OpenAIAdapter();
    const fixture = loadFixture<{
      request: OpenAIRequest;
      response: Record<string, unknown>;
    }>('openai-passthrough.json');

    expect(adapter.transformRequest(fixture.request)).toEqual(fixture.request);
    expect(adapter.transformResponse(fixture.response)).toEqual(fixture.response);
  });

  it('Anthropic adapter maps OpenAI tools/tool_choice request using golden fixture', () => {
    const adapter = new AnthropicAdapter();
    const fixture = loadFixture<{
      request: OpenAIRequest;
      expected: Record<string, unknown>;
    }>('anthropic-tools-request.json');

    const transformed = withoutUndefined(adapter.transformRequest(fixture.request));
    expect(transformed).toEqual(fixture.expected);
  });

  it('Anthropic adapter maps tool_use response blocks into OpenAI tool_calls', () => {
    const adapter = new AnthropicAdapter();
    const fixture = loadFixture<{
      request: OpenAIRequest;
      response: Record<string, unknown>;
      expected: Record<string, unknown>;
    }>('anthropic-tool-response.json');

    const transformed = adapter.transformResponse(fixture.response, fixture.request);
    expect(transformed).toMatchObject(fixture.expected);
  });

  it('Google adapter maps structured output + tools request fixture', () => {
    const adapter = new GoogleAdapter();
    const fixture = loadFixture<{
      request: OpenAIRequest;
      expected: Record<string, unknown>;
    }>('google-structured-tools-request.json');

    const transformed = withoutUndefined(adapter.transformRequest(fixture.request));
    expect(transformed).toEqual(fixture.expected);
  });

  it('Google stream chunks follow expected event sequence contract', () => {
    const adapter = new GoogleAdapter();
    const fixture = loadFixture<{
      request: OpenAIRequest;
      events: Record<string, unknown>[];
      expected: Array<{ deltaContent: string | null; finishReason: string | null }>;
    }>('google-stream-sequence.json');

    const chunks = fixture.events.map((event) =>
      adapter.transformStreamChunk(JSON.stringify(event), fixture.request)
    );

    expect(chunks).toHaveLength(fixture.expected.length);
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const expected = fixture.expected[i];
      expect(chunk?.choices[0]?.delta?.content ?? null).toBe(expected.deltaContent);
      expect(chunk?.choices[0]?.finish_reason ?? null).toBe(expected.finishReason);
    }
  });

  it('Anthropic stream chunks follow expected event sequence contract', () => {
    const adapter = new AnthropicAdapter();
    const fixture = loadFixture<{
      request: OpenAIRequest;
      events: Record<string, unknown>[];
      expected: Array<{ deltaContent: string | null; finishReason: string | null }>;
    }>('anthropic-stream-sequence.json');

    const chunks = fixture.events.map((event) =>
      adapter.transformStreamChunk(JSON.stringify(event), fixture.request)
    );

    expect(chunks).toHaveLength(fixture.expected.length);
    for (let i = 0; i < chunks.length; i += 1) {
      const chunk = chunks[i];
      const expected = fixture.expected[i];
      expect(chunk?.choices[0]?.delta?.content ?? null).toBe(expected.deltaContent);
      expect(chunk?.choices[0]?.finish_reason ?? null).toBe(expected.finishReason);
    }
  });

  it('OpenRouter adapter injects provider-specific auth headers', () => {
    const adapter = new OpenRouterAdapter();
    const headers = adapter.getAuthHeaders('test-key');
    expect(headers).toMatchObject({
      Authorization: 'Bearer test-key',
      'HTTP-Referer': 'https://untangle-ai.dev',
      'X-Title': 'untangle-ai',
    });
  });

  it('Groq and OpenRouter adapters preserve nested tool args request parity', () => {
    const groq = new GroqAdapter();
    const openrouter = new OpenRouterAdapter();
    const fixture = loadFixture<{
      request: OpenAIRequest;
      expected: Record<string, unknown>;
    }>('groq-openrouter-nested-tools-request.json');

    expect(withoutUndefined(groq.transformRequest(fixture.request))).toEqual(fixture.expected);
    expect(withoutUndefined(openrouter.transformRequest(fixture.request))).toEqual(fixture.expected);
  });

  it('Groq and OpenRouter adapters preserve mixed content + tool-call response payloads', () => {
    const groq = new GroqAdapter();
    const openrouter = new OpenRouterAdapter();
    const fixture = loadFixture<{
      response: Record<string, unknown>;
      expected: Record<string, unknown>;
    }>('groq-openrouter-mixed-content-response.json');

    expect(withoutUndefined(groq.transformResponse(fixture.response))).toEqual(fixture.expected);
    expect(withoutUndefined(openrouter.transformResponse(fixture.response))).toEqual(fixture.expected);
  });

  it('Groq and OpenRouter stream chunks preserve partial tool-call deltas', () => {
    const groq = new GroqAdapter();
    const openrouter = new OpenRouterAdapter();
    const fixture = loadFixture<{
      events: Record<string, unknown>[];
      expected: Array<{ partialArguments: string | null; finishReason: string | null }>;
    }>('groq-openrouter-partial-tool-stream.json');

    const groqChunks = fixture.events.map((event) => groq.transformStreamChunk(JSON.stringify(event)));
    const openrouterChunks = fixture.events.map((event) => openrouter.transformStreamChunk(JSON.stringify(event)));

    expect(groqChunks).toHaveLength(fixture.expected.length);
    expect(openrouterChunks).toHaveLength(fixture.expected.length);

    for (let i = 0; i < fixture.expected.length; i += 1) {
      const expected = fixture.expected[i];
      const groqChunk = groqChunks[i];
      const openrouterChunk = openrouterChunks[i];

      const groqArgs = groqChunk?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments ?? null;
      const openrouterArgs = openrouterChunk?.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments ?? null;
      const groqFinish = groqChunk?.choices?.[0]?.finish_reason ?? null;
      const openrouterFinish = openrouterChunk?.choices?.[0]?.finish_reason ?? null;

      expect(groqArgs).toBe(expected.partialArguments);
      expect(openrouterArgs).toBe(expected.partialArguments);
      expect(groqFinish).toBe(expected.finishReason);
      expect(openrouterFinish).toBe(expected.finishReason);
    }
  });
});
