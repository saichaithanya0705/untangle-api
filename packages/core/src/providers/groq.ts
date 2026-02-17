import { BaseProviderAdapter } from './base.js';
import type { ProviderConfig, ModelConfig } from '../types/provider.js';
import type { OpenAIRequest, OpenAIResponse, OpenAIStreamChunk, OpenAIError } from '../types/openai.js';

const GROQ_MODELS: ModelConfig[] = [
  {
    id: 'llama-3.3-70b-versatile',
    contextWindow: 128000,
    maxOutputTokens: 32768,
    capabilities: ['chat', 'tools'],
    enabled: true,
  },
  {
    id: 'llama-3.1-8b-instant',
    contextWindow: 128000,
    maxOutputTokens: 8192,
    capabilities: ['chat', 'tools'],
    enabled: true,
  },
  {
    id: 'llama-3.2-90b-vision-preview',
    contextWindow: 128000,
    maxOutputTokens: 8192,
    capabilities: ['chat', 'vision'],
    enabled: true,
  },
  {
    id: 'mixtral-8x7b-32768',
    contextWindow: 32768,
    maxOutputTokens: 32768,
    capabilities: ['chat'],
    enabled: true,
  },
  {
    id: 'gemma2-9b-it',
    contextWindow: 8192,
    maxOutputTokens: 8192,
    capabilities: ['chat'],
    enabled: true,
  },
];

export class GroqAdapter extends BaseProviderAdapter {
  readonly config: ProviderConfig = {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    authHeader: 'Authorization',
    authScheme: 'Bearer',
    models: GROQ_MODELS,
    enabled: true,
  };

  // OpenAI-compatible: passthrough
  transformRequest(request: OpenAIRequest): OpenAIRequest {
    return request;
  }

  // OpenAI-compatible: passthrough
  transformResponse(response: unknown): OpenAIResponse {
    return response as OpenAIResponse;
  }

  // OpenAI-compatible: passthrough
  transformStreamChunk(chunk: string): OpenAIStreamChunk | null {
    if (chunk === '[DONE]') return null;
    try {
      return JSON.parse(chunk) as OpenAIStreamChunk;
    } catch {
      return null;
    }
  }

  normalizeError(error: unknown): OpenAIError {
    // OpenAI-compatible error format
    if (typeof error === 'object' && error !== null && 'error' in error) {
      const e = error as { error: { message?: string; type?: string; code?: string | null } };
      return {
        error: {
          message: e.error.message ?? 'Unknown Groq error',
          type: e.error.type ?? 'api_error',
          code: e.error.code ?? null,
        },
      };
    }
    return super.normalizeError(error);
  }
}

export const groqAdapter = new GroqAdapter();
