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

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

interface AnthropicToolChoice {
  type: 'auto' | 'tool';
  name?: string;
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
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
}

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input?: unknown };

interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: AnthropicContentBlock[];
  model: string;
  stop_reason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null;
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
    const tools = request.tools?.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      input_schema: (tool.function.parameters as Record<string, unknown> | undefined) ?? {
        type: 'object',
        properties: {},
      },
    }));

    let toolChoice: AnthropicToolChoice | undefined;
    if (request.tool_choice === 'auto') {
      toolChoice = { type: 'auto' };
    } else if (typeof request.tool_choice === 'object' && request.tool_choice?.type === 'function') {
      toolChoice = {
        type: 'tool',
        name: request.tool_choice.function.name,
      };
    }

    return {
      model: modelId,
      max_tokens: request.max_tokens ?? 4096,
      messages,
      system,
      stream: request.stream,
      temperature: request.temperature,
      top_p: request.top_p,
      stop_sequences: request.stop ? (Array.isArray(request.stop) ? request.stop : [request.stop]) : undefined,
      tools,
      tool_choice: toolChoice,
    };
  }

  transformResponse(response: unknown, request?: OpenAIRequest): OpenAIResponse {
    const r = response as AnthropicResponse;
    const textContent = r.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('');
    const toolCalls = r.content
      .filter((block): block is { type: 'tool_use'; id: string; name: string; input?: unknown } => block.type === 'tool_use')
      .map((block) => ({
        id: block.id,
        type: 'function' as const,
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      }));

    const resolvedModel = this.getModelConfig(request?.model ?? '')?.id ?? request?.model ?? r.model;

    return {
      id: r.id,
      object: 'chat.completion',
      created: this.unixTimestamp(),
      model: resolvedModel,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: textContent.length > 0 ? textContent : null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
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

  private mapStopReason(reason: string | null): 'stop' | 'length' | 'tool_calls' | null {
    if (!reason) return null;
    if (reason === 'end_turn' || reason === 'stop_sequence') return 'stop';
    if (reason === 'max_tokens') return 'length';
    if (reason === 'tool_use') return 'tool_calls';
    return 'stop';
  }

  transformStreamChunk(chunk: string, request?: OpenAIRequest): OpenAIStreamChunk | null {
    if (chunk === '[DONE]') return null;

    try {
      const data = JSON.parse(chunk);
      const model = this.getModelConfig(request?.model ?? '')?.id ?? request?.model ?? '';

      // Handle different Anthropic event types
      if (data.type === 'content_block_delta' && data.delta?.type === 'text_delta') {
        return {
          id: data.index?.toString() ?? 'chunk',
          object: 'chat.completion.chunk',
          created: this.unixTimestamp(),
          model,
          choices: [{
            index: 0,
            delta: { content: data.delta.text },
            finish_reason: null,
          }],
        };
      }

      if (data.type === 'content_block_start' && data.content_block?.type === 'tool_use') {
        const argumentsPayload = JSON.stringify(data.content_block.input ?? {});
        return {
          id: data.content_block.id ?? 'tool',
          object: 'chat.completion.chunk',
          created: this.unixTimestamp(),
          model,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                id: data.content_block.id ?? 'tool',
                type: 'function',
                function: {
                  name: data.content_block.name ?? 'tool',
                  arguments: argumentsPayload,
                },
              }],
            },
            finish_reason: null,
          }],
        };
      }

      if (data.type === 'content_block_delta' && data.delta?.type === 'input_json_delta') {
        return {
          id: data.index?.toString() ?? 'tool',
          object: 'chat.completion.chunk',
          created: this.unixTimestamp(),
          model,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                id: `tool_${data.index ?? 0}`,
                type: 'function',
                function: {
                  name: '',
                  arguments: data.delta.partial_json ?? '',
                },
              }],
            },
            finish_reason: null,
          }],
        };
      }

      if (data.type === 'message_stop') {
        return {
          id: 'done',
          object: 'chat.completion.chunk',
          created: this.unixTimestamp(),
          model,
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
