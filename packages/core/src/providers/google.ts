import { BaseProviderAdapter } from './base.js';
import type { ProviderConfig, ModelConfig } from '../types/provider.js';
import type { OpenAIRequest, OpenAIResponse, OpenAIStreamChunk, OpenAIError } from '../types/openai.js';

const GOOGLE_MODELS: ModelConfig[] = [
  {
    id: 'gemini-2.0-flash',
    contextWindow: 1048576,
    maxOutputTokens: 8192,
    inputPricePer1M: 0.10,
    outputPricePer1M: 0.40,
    capabilities: ['chat', 'vision', 'tools'],
    enabled: true,
  },
  {
    id: 'gemini-1.5-pro',
    contextWindow: 2097152,
    maxOutputTokens: 8192,
    inputPricePer1M: 1.25,
    outputPricePer1M: 5.00,
    capabilities: ['chat', 'vision', 'tools'],
    enabled: true,
  },
  {
    id: 'gemini-1.5-flash',
    contextWindow: 1048576,
    maxOutputTokens: 8192,
    inputPricePer1M: 0.075,
    outputPricePer1M: 0.30,
    capabilities: ['chat', 'vision', 'tools'],
    enabled: true,
  },
];

interface GoogleContent {
  role: 'user' | 'model';
  parts: Array<{ text: string }>;
}

interface GoogleRequest {
  contents: GoogleContent[];
  systemInstruction?: { parts: Array<{ text: string }> };
  generationConfig?: {
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
  };
}

interface GoogleResponse {
  candidates: Array<{
    content: {
      parts: Array<{ text: string }>;
      role: string;
    };
    finishReason: string;
  }>;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

export class GoogleAdapter extends BaseProviderAdapter {
  readonly config: ProviderConfig = {
    id: 'google',
    name: 'Google AI',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    authHeader: 'x-goog-api-key',
    authScheme: undefined,
    models: GOOGLE_MODELS,
    enabled: true,
  };

  getEndpointUrl(
    endpoint: 'chat' | 'models',
    options?: { request?: OpenAIRequest; apiKey?: string }
  ): string {
    if (endpoint === 'chat') {
      const modelId = this.resolveModelId(options?.request);
      return `${this.config.baseUrl}/models/${modelId}:generateContent`;
    }
    return `${this.config.baseUrl}/models`;
  }

  getAuthHeaders(apiKey: string): Record<string, string> {
    return {
      'x-goog-api-key': apiKey,
    };
  }

  transformRequest(request: OpenAIRequest): GoogleRequest {
    // Extract system message
    const systemMessages = request.messages.filter(m => m.role === 'system');
    const systemInstruction = systemMessages.length > 0
      ? { parts: [{ text: systemMessages.map(m => m.content).join('\n') }] }
      : undefined;

    // Convert messages
    const contents: GoogleContent[] = request.messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content ?? '' }],
      }));

    return {
      contents,
      systemInstruction,
      generationConfig: {
        temperature: request.temperature,
        topP: request.top_p,
        maxOutputTokens: request.max_tokens,
        stopSequences: request.stop
          ? (Array.isArray(request.stop) ? request.stop : [request.stop])
          : undefined,
      },
    };
  }

  transformResponse(response: unknown, request?: OpenAIRequest): OpenAIResponse {
    const r = response as GoogleResponse;
    const candidate = r.candidates?.[0];
    const content = candidate?.content?.parts
      ?.map(p => p.text)
      ?.join('') ?? '';

    return {
      id: `google-${this.unixTimestamp()}`,
      object: 'chat.completion',
      created: this.unixTimestamp(),
      model: this.resolveModelId(request),
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content,
        },
        finish_reason: this.mapFinishReason(candidate?.finishReason),
      }],
      usage: r.usageMetadata ? {
        prompt_tokens: r.usageMetadata.promptTokenCount,
        completion_tokens: r.usageMetadata.candidatesTokenCount,
        total_tokens: r.usageMetadata.totalTokenCount,
      } : undefined,
    };
  }

  private mapFinishReason(reason?: string): 'stop' | 'length' | null {
    if (!reason) return null;
    if (reason === 'STOP') return 'stop';
    if (reason === 'MAX_TOKENS') return 'length';
    return 'stop';
  }

  transformStreamChunk(chunk: string, request?: OpenAIRequest): OpenAIStreamChunk | null {
    // Google streaming format
    try {
      const data = JSON.parse(chunk);
      const candidate = data.candidates?.[0];
      const text = candidate?.content?.parts?.[0]?.text;
      const model = this.resolveModelId(request);

      if (text) {
        return {
          id: `google-${this.unixTimestamp()}`,
          object: 'chat.completion.chunk',
          created: this.unixTimestamp(),
          model,
          choices: [{
            index: 0,
            delta: { content: text },
            finish_reason: null,
          }],
        };
      }

      if (candidate?.finishReason) {
        return {
          id: `google-${this.unixTimestamp()}`,
          object: 'chat.completion.chunk',
          created: this.unixTimestamp(),
          model,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: this.mapFinishReason(candidate.finishReason),
          }],
        };
      }

      return null;
    } catch {
      return null;
    }
  }

  private resolveModelId(request?: OpenAIRequest): string {
    const requested = request?.model ?? 'gemini-1.5-flash';
    return this.getModelConfig(requested)?.id ?? requested;
  }

  normalizeError(error: unknown): OpenAIError {
    if (typeof error === 'object' && error !== null && 'error' in error) {
      const e = error as { error: { message?: string; status?: string } };
      return {
        error: {
          message: e.error.message ?? 'Unknown Google AI error',
          type: e.error.status ?? 'api_error',
          code: null,
        },
      };
    }
    return super.normalizeError(error);
  }
}

export const googleAdapter = new GoogleAdapter();
