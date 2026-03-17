import { BaseProviderAdapter } from './base.js';
import type { ProviderConfig, ModelConfig } from '../types/provider.js';
import type {
  OpenAIRequest,
  OpenAIResponse,
  OpenAIStreamChunk,
  OpenAIError,
  OpenAIUsage,
} from '../types/openai.js';
import { extractAccountIdFromToken, resolveCodexOriginator } from './chatgpt-auth.js';

const CHATGPT_MODELS: ModelConfig[] = [
  {
    id: 'gpt-5.3-codex',
    contextWindow: 128000,
    maxOutputTokens: 16384,
    capabilities: ['chat', 'tools'],
    enabled: true,
  },
  {
    id: 'gpt-5.2-codex',
    contextWindow: 128000,
    maxOutputTokens: 16384,
    capabilities: ['chat', 'tools'],
    enabled: true,
  },
  {
    id: 'gpt-5.1-codex-max',
    contextWindow: 128000,
    maxOutputTokens: 16384,
    capabilities: ['chat', 'tools'],
    enabled: true,
  },
  {
    id: 'gpt-5.2',
    contextWindow: 128000,
    maxOutputTokens: 16384,
    capabilities: ['chat', 'tools'],
    enabled: true,
  },
  {
    id: 'gpt-5.1-codex-mini',
    contextWindow: 128000,
    maxOutputTokens: 16384,
    capabilities: ['chat', 'tools'],
    enabled: true,
  },
];

type ReasoningEffort = 'low' | 'medium' | 'high';

type ChatGPTRequest = Omit<OpenAIRequest, 'messages' | 'max_tokens'> & {
  input: OpenAIRequest['messages'];
  max_output_tokens?: number;
  reasoning_effort?: ReasoningEffort;
};

export class ChatGPTAdapter extends BaseProviderAdapter {
  readonly config: ProviderConfig = {
    id: 'chatgpt',
    name: 'ChatGPT (Codex)',
    baseUrl: 'https://chatgpt.com/backend-api',
    authHeader: 'Authorization',
    authScheme: 'Bearer',
    models: CHATGPT_MODELS,
    enabled: true,
  };

  getEndpointUrl(
    endpoint: 'chat' | 'models',
    _options?: { request?: OpenAIRequest; apiKey?: string }
  ): string {
    if (endpoint === 'chat') {
      return `${this.config.baseUrl}/codex/responses`;
    }
    return `${this.config.baseUrl}/models`;
  }

  getAuthHeaders(apiKey: string): Record<string, string> {
    const headers = super.getAuthHeaders(apiKey);
    const accountId = extractAccountIdFromToken(apiKey);
    if (accountId) {
      headers['ChatGPT-Account-Id'] = accountId;
    }
    const originator = resolveCodexOriginator();
    if (originator) {
      headers.originator = originator;
    }
    return headers;
  }

  transformRequest(request: OpenAIRequest): ChatGPTRequest {
    const { messages, max_tokens, ...rest } = request as OpenAIRequest & Record<string, unknown>;
    const normalized: ChatGPTRequest = {
      ...(rest as Omit<OpenAIRequest, 'messages' | 'max_tokens'>),
      input: messages,
    };
    if (typeof max_tokens === 'number') {
      normalized.max_output_tokens = max_tokens;
    }
    if (!normalized.reasoning_effort) {
      normalized.reasoning_effort = 'high';
    }
    return normalized;
  }

  transformResponse(response: unknown, request?: OpenAIRequest): OpenAIResponse {
    if (typeof response === 'object' && response !== null && 'choices' in response) {
      return response as OpenAIResponse;
    }

    const payload = response as Record<string, unknown> | null;
    if (!payload) {
      return response as OpenAIResponse;
    }

    const outputText = this.extractResponseText(payload);
    const usage = this.extractUsage(payload);
    const created = this.extractCreated(payload);
    const model = this.extractModel(payload, request);
    const id = typeof payload.id === 'string' ? payload.id : `chatcmpl_${Date.now()}`;

    return {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: outputText,
          },
          finish_reason: 'stop',
        },
      ],
      usage,
    };
  }

  transformStreamChunk(chunk: string, request?: OpenAIRequest): OpenAIStreamChunk | null {
    if (chunk === '[DONE]') return null;

    let parsed: any;
    try {
      parsed = JSON.parse(chunk);
    } catch {
      return null;
    }

    if (parsed?.error) {
      const message = parsed.error?.message || 'ChatGPT stream error';
      throw new Error(message);
    }

    if (parsed?.choices && Array.isArray(parsed.choices)) {
      return parsed as OpenAIStreamChunk;
    }

    const deltaText = this.extractDeltaText(parsed);
    if (!deltaText) return null;

    return this.buildDeltaChunk(deltaText, parsed, request);
  }

  normalizeError(error: unknown): OpenAIError {
    if (typeof error === 'object' && error !== null && 'error' in error) {
      const e = error as { error: { message?: string; type?: string; code?: string | null } };
      return {
        error: {
          message: e.error.message ?? 'ChatGPT error',
          type: e.error.type ?? 'api_error',
          code: e.error.code ?? null,
        },
      };
    }
    return super.normalizeError(error);
  }

  private extractDeltaText(payload: Record<string, unknown>): string | null {
    if (typeof payload.delta === 'string' && payload.type === 'response.output_text.delta') {
      return payload.delta;
    }
    if (typeof payload.text === 'string' && payload.type === 'response.output_text.done') {
      return payload.text;
    }
    if (typeof payload.output_text === 'string') {
      return payload.output_text;
    }
    return null;
  }

  private buildDeltaChunk(
    text: string,
    payload: Record<string, unknown>,
    request?: OpenAIRequest
  ): OpenAIStreamChunk {
    const model = typeof payload.model === 'string'
      ? payload.model
      : request?.model ?? this.config.models[0]?.id ?? 'gpt-5.3-codex';
    const id = typeof payload.id === 'string' ? payload.id : `chatcmpl_${Date.now()}`;

    return {
      id,
      object: 'chat.completion.chunk',
      created: this.unixTimestamp(),
      model,
      choices: [
        {
          index: 0,
          delta: { content: text },
          finish_reason: null,
        },
      ],
    };
  }

  private extractResponseText(payload: Record<string, unknown>): string {
    if (typeof payload.output_text === 'string') {
      return payload.output_text;
    }

    const output = payload.output;
    if (Array.isArray(output)) {
      const parts: string[] = [];
      for (const item of output) {
        if (!item || typeof item !== 'object') continue;
        const content = (item as { content?: unknown }).content;
        if (Array.isArray(content)) {
          for (const piece of content) {
            if (piece && typeof piece === 'object' && (piece as { type?: unknown }).type === 'output_text') {
              const text = (piece as { text?: unknown }).text;
              if (typeof text === 'string') {
                parts.push(text);
              }
            }
          }
        }
      }
      if (parts.length > 0) {
        return parts.join('');
      }
    }

    return '';
  }

  private extractUsage(payload: Record<string, unknown>): OpenAIUsage | undefined {
    const usage = payload.usage as Record<string, unknown> | undefined;
    if (!usage) return undefined;

    const prompt = usage.prompt_tokens ?? usage.input_tokens;
    const completion = usage.completion_tokens ?? usage.output_tokens;
    const total = usage.total_tokens ?? usage.total;

    if (typeof prompt !== 'number' || typeof completion !== 'number') {
      return undefined;
    }

    return {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: typeof total === 'number' ? total : prompt + completion,
    };
  }

  private extractCreated(payload: Record<string, unknown>): number {
    const created = payload.created ?? payload.created_at;
    if (typeof created === 'number') {
      return created;
    }
    return this.unixTimestamp();
  }

  private extractModel(payload: Record<string, unknown>, request?: OpenAIRequest): string {
    if (typeof payload.model === 'string') {
      return payload.model;
    }
    return request?.model ?? this.config.models[0]?.id ?? 'gpt-5.3-codex';
  }
}

export const chatgptAdapter = new ChatGPTAdapter();
