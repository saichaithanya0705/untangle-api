import { BaseProviderAdapter } from './base.js';
import type { ProviderConfig, ModelConfig } from '../types/provider.js';
import type { OpenAIRequest, OpenAIResponse, OpenAIStreamChunk, OpenAIError } from '../types/openai.js';

const ANTHROPIC_MODELS: ModelConfig[] = [
  {
    id: 'claude-opus-4-20250514',
    alias: 'claude-opus-4',
    contextWindow: 200000,
    maxOutputTokens: 64000,
    inputPricePer1M: 15,
    outputPricePer1M: 75,
    capabilities: ['chat', 'vision', 'tools'],
    enabled: true,
  },
  {
    id: 'claude-sonnet-4-20250514',
    alias: 'claude-sonnet-4',
    contextWindow: 200000,
    maxOutputTokens: 64000,
    inputPricePer1M: 3,
    outputPricePer1M: 15,
    capabilities: ['chat', 'vision', 'tools'],
    enabled: true,
  },
  {
    id: 'claude-3-7-sonnet-20250219',
    alias: 'claude-3.7-sonnet',
    contextWindow: 200000,
    maxOutputTokens: 128000,
    inputPricePer1M: 3,
    outputPricePer1M: 15,
    capabilities: ['chat', 'vision', 'tools'],
    enabled: true,
  },
  {
    id: 'claude-3-5-sonnet-20241022',
    alias: 'claude-3.5-sonnet',
    contextWindow: 200000,
    maxOutputTokens: 8192,
    inputPricePer1M: 3,
    outputPricePer1M: 15,
    capabilities: ['chat', 'vision', 'tools'],
    enabled: true,
  },
  {
    id: 'claude-3-5-haiku-20241022',
    alias: 'claude-3.5-haiku',
    contextWindow: 200000,
    maxOutputTokens: 8192,
    inputPricePer1M: 0.8,
    outputPricePer1M: 4,
    capabilities: ['chat', 'vision', 'tools'],
    enabled: true,
  },
  {
    id: 'claude-3-opus-20240229',
    alias: 'claude-3-opus',
    contextWindow: 200000,
    maxOutputTokens: 4096,
    inputPricePer1M: 15,
    outputPricePer1M: 75,
    capabilities: ['chat', 'vision', 'tools'],
    enabled: true,
  },
];

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | Array<{ type: 'text'; text: string }>;
}

interface AnthropicRequest {
  model: string;
  max_tokens: number;
  messages: AnthropicMessage[];
  system?: string;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
}

interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<{ type: 'text'; text: string }>;
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

export class AnthropicAdapter extends BaseProviderAdapter {
  readonly config: ProviderConfig = {
    id: 'anthropic',
    name: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    authHeader: 'x-api-key',
    authScheme: undefined,
    models: ANTHROPIC_MODELS,
    enabled: true,
  };

  getEndpointUrl(endpoint: 'chat' | 'models'): string {
    if (endpoint === 'chat') {
      return `${this.config.baseUrl}/messages`;
    }
    return `${this.config.baseUrl}/models`;
  }

  getAuthHeaders(apiKey: string): Record<string, string> {
    return {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    };
  }

  transformRequest(request: OpenAIRequest): AnthropicRequest {
    // Extract system message
    const systemMessages = request.messages.filter(m => m.role === 'system');
    const system = systemMessages.map(m => m.content).join('\n') || undefined;

    // Convert other messages
    const messages: AnthropicMessage[] = request.messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content ?? '',
      }));

    // Resolve model ID (handle aliases)
    const modelConfig = this.getModelConfig(request.model);
    const modelId = modelConfig?.id ?? request.model;

    return {
      model: modelId,
      max_tokens: request.max_tokens ?? 4096,
      messages,
      system,
      stream: request.stream,
      temperature: request.temperature,
      top_p: request.top_p,
      stop_sequences: request.stop ? (Array.isArray(request.stop) ? request.stop : [request.stop]) : undefined,
    };
  }

  transformResponse(response: unknown): OpenAIResponse {
    const r = response as AnthropicResponse;
    const content = r.content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('');

    return {
      id: r.id,
      object: 'chat.completion',
      created: Date.now(),
      model: r.model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content,
        },
        finish_reason: this.mapStopReason(r.stop_reason),
      }],
      usage: {
        prompt_tokens: r.usage.input_tokens,
        completion_tokens: r.usage.output_tokens,
        total_tokens: r.usage.input_tokens + r.usage.output_tokens,
      },
    };
  }

  private mapStopReason(reason: string | null): 'stop' | 'length' | null {
    if (!reason) return null;
    if (reason === 'end_turn' || reason === 'stop_sequence') return 'stop';
    if (reason === 'max_tokens') return 'length';
    return 'stop';
  }

  transformStreamChunk(chunk: string): OpenAIStreamChunk | null {
    if (chunk === '[DONE]') return null;

    try {
      const data = JSON.parse(chunk);

      // Handle different Anthropic event types
      if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') {
        return {
          id: data.index?.toString() ?? 'chunk',
          object: 'chat.completion.chunk',
          created: Date.now(),
          model: '',
          choices: [{
            index: 0,
            delta: { content: data.delta.text },
            finish_reason: null,
          }],
        };
      }

      if (data.type === 'message_stop') {
        return {
          id: 'done',
          object: 'chat.completion.chunk',
          created: Date.now(),
          model: '',
          choices: [{
            index: 0,
            delta: {},
            finish_reason: 'stop',
          }],
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  normalizeError(error: unknown): OpenAIError {
    if (typeof error === 'object' && error !== null && 'error' in error) {
      const e = error as { error: { message?: string; type?: string } };
      return {
        error: {
          message: e.error.message ?? 'Unknown Anthropic error',
          type: e.error.type ?? 'api_error',
          code: null,
        },
      };
    }
    return super.normalizeError(error);
  }
}

export const anthropicAdapter = new AnthropicAdapter();
