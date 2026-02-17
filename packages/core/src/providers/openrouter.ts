import { BaseProviderAdapter } from './base.js';
import type { ProviderConfig, ModelConfig } from '../types/provider.js';
import type { OpenAIRequest, OpenAIResponse, OpenAIStreamChunk } from '../types/openai.js';

/**
 * OpenRouter adapter
 * OpenRouter is an aggregator that provides access to many models
 * It uses OpenAI-compatible API format
 */

const OPENROUTER_MODELS: ModelConfig[] = [
  // OpenRouter model IDs use 'provider/model' format
  // These are default models - the full list is populated dynamically from OpenRouter API
  {
    id: 'anthropic/claude-opus-4',
    alias: 'or-claude-opus-4',
    contextWindow: 200000,
    maxOutputTokens: 64000,
    inputPricePer1M: 15,
    outputPricePer1M: 75,
    capabilities: ['chat', 'vision', 'tools'],
    enabled: true,
  },
  {
    id: 'anthropic/claude-sonnet-4',
    alias: 'or-claude-sonnet-4',
    contextWindow: 200000,
    maxOutputTokens: 64000,
    inputPricePer1M: 3,
    outputPricePer1M: 15,
    capabilities: ['chat', 'vision', 'tools'],
    enabled: true,
  },
  {
    id: 'anthropic/claude-3.5-sonnet',
    alias: 'or-claude-3.5-sonnet',
    contextWindow: 200000,
    maxOutputTokens: 8192,
    inputPricePer1M: 3,
    outputPricePer1M: 15,
    capabilities: ['chat', 'vision', 'tools'],
    enabled: true,
  },
  {
    id: 'openai/gpt-4o',
    alias: 'or-gpt-4o',
    contextWindow: 128000,
    maxOutputTokens: 16384,
    inputPricePer1M: 2.5,
    outputPricePer1M: 10,
    capabilities: ['chat', 'vision', 'tools', 'json_mode'],
    enabled: true,
  },
  {
    id: 'google/gemini-2.0-flash-exp',
    alias: 'or-gemini-2.0-flash',
    contextWindow: 1000000,
    maxOutputTokens: 8192,
    inputPricePer1M: 0,
    outputPricePer1M: 0,
    capabilities: ['chat', 'vision', 'tools'],
    enabled: true,
  },
  {
    id: 'meta-llama/llama-3.3-70b-instruct',
    alias: 'or-llama-3.3-70b',
    contextWindow: 131072,
    maxOutputTokens: 8192,
    inputPricePer1M: 0.4,
    outputPricePer1M: 0.4,
    capabilities: ['chat', 'tools'],
    enabled: true,
  },
];

export class OpenRouterAdapter extends BaseProviderAdapter {
  readonly config: ProviderConfig = {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    authHeader: 'Authorization',
    authScheme: 'Bearer',
    models: OPENROUTER_MODELS,
    enabled: true,
  };

  getEndpointUrl(endpoint: 'chat' | 'models'): string {
    if (endpoint === 'chat') {
      return `${this.config.baseUrl}/chat/completions`;
    }
    return `${this.config.baseUrl}/models`;
  }

  getAuthHeaders(apiKey: string): Record<string, string> {
    return {
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://untangle-ai.dev',
      'X-Title': 'untangle-ai',
    };
  }

  transformRequest(request: OpenAIRequest): OpenAIRequest {
    // OpenRouter uses OpenAI-compatible format
    return request;
  }

  transformResponse(response: unknown): OpenAIResponse {
    // OpenRouter returns OpenAI-compatible format
    return response as OpenAIResponse;
  }

  transformStreamChunk(chunk: string): OpenAIStreamChunk | null {
    if (chunk === '[DONE]') return null;

    try {
      const data = JSON.parse(chunk);
      return data as OpenAIStreamChunk;
    } catch {
      return null;
    }
  }
}

export const openrouterAdapter = new OpenRouterAdapter();
