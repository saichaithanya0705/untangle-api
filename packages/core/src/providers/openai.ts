import { BaseProviderAdapter } from './base.js';
import type { ProviderConfig, ModelConfig } from '../types/provider.js';
import type { OpenAIRequest, OpenAIResponse, OpenAIStreamChunk, OpenAIError } from '../types/openai.js';

const OPENAI_MODELS: ModelConfig[] = [
  {
    id: 'gpt-4o',
    contextWindow: 128000,
    maxOutputTokens: 16384,
    inputPricePer1M: 2.5,
    outputPricePer1M: 10,
    capabilities: ['chat', 'vision', 'tools', 'json_mode'],
    enabled: true,
  },
  {
    id: 'gpt-4o-mini',
    contextWindow: 128000,
    maxOutputTokens: 16384,
    inputPricePer1M: 0.15,
    outputPricePer1M: 0.6,
    capabilities: ['chat', 'vision', 'tools', 'json_mode'],
    enabled: true,
  },
  {
    id: 'gpt-4-turbo',
    contextWindow: 128000,
    maxOutputTokens: 4096,
    inputPricePer1M: 10,
    outputPricePer1M: 30,
    capabilities: ['chat', 'vision', 'tools', 'json_mode'],
    enabled: true,
  },
  {
    id: 'gpt-4',
    contextWindow: 8192,
    maxOutputTokens: 8192,
    inputPricePer1M: 30,
    outputPricePer1M: 60,
    capabilities: ['chat', 'tools'],
    enabled: true,
  },
  {
    id: 'gpt-3.5-turbo',
    contextWindow: 16385,
    maxOutputTokens: 4096,
    inputPricePer1M: 0.5,
    outputPricePer1M: 1.5,
    capabilities: ['chat', 'tools', 'json_mode'],
    enabled: true,
  },
  {
    id: 'o1',
    contextWindow: 200000,
    maxOutputTokens: 100000,
    inputPricePer1M: 15,
    outputPricePer1M: 60,
    capabilities: ['chat'],
    enabled: true,
  },
  {
    id: 'o1-mini',
    contextWindow: 128000,
    maxOutputTokens: 65536,
    inputPricePer1M: 3,
    outputPricePer1M: 12,
    capabilities: ['chat'],
    enabled: true,
  },
];

export class OpenAIAdapter extends BaseProviderAdapter {
  readonly config: ProviderConfig = {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    authHeader: 'Authorization',
    authScheme: 'Bearer',
    models: OPENAI_MODELS,
    enabled: true,
  };

  // OpenAI -> OpenAI: passthrough
  transformRequest(request: OpenAIRequest): OpenAIRequest {
    return request;
  }

  // OpenAI -> OpenAI: passthrough
  transformResponse(response: unknown): OpenAIResponse {
    return response as OpenAIResponse;
  }

  // OpenAI -> OpenAI: passthrough
  transformStreamChunk(chunk: string): OpenAIStreamChunk | null {
    if (chunk === '[DONE]') {
      return null;
    }
    try {
      return JSON.parse(chunk) as OpenAIStreamChunk;
    } catch {
      return null;
    }
  }

  normalizeError(error: unknown): OpenAIError {
    // If it's already an OpenAI error format, return as-is
    if (typeof error === 'object' && error !== null && 'error' in error) {
      const e = error as { error: { message?: string; type?: string; code?: string | null } };
      return {
        error: {
          message: e.error.message ?? 'Unknown error',
          type: e.error.type ?? 'api_error',
          code: e.error.code ?? null,
        },
      };
    }
    return super.normalizeError(error);
  }
}

export const openaiAdapter = new OpenAIAdapter();
