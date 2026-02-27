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
  parts: Array<{
    text?: string;
    functionCall?: {
      name: string;
      args?: Record<string, unknown>;
    };
  }>;
}

interface GoogleTool {
  functionDeclarations: Array<{
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  }>;
}

interface GoogleToolConfig {
  functionCallingConfig: {
    mode: 'AUTO' | 'NONE' | 'ANY';
    allowedFunctionNames?: string[];
  };
}

interface GoogleRequest {
  contents: GoogleContent[];
  systemInstruction?: { parts: Array<{ text: string }> };
  generationConfig?: {
    temperature?: number;
    topP?: number;
    maxOutputTokens?: number;
    stopSequences?: string[];
    responseMimeType?: string;
    responseSchema?: Record<string, unknown>;
  };
  tools?: GoogleTool[];
  toolConfig?: GoogleToolConfig;
}

interface GoogleResponse {
  candidates: Array<{
    content: {
      parts: Array<{
        text?: string;
        functionCall?: {
          name: string;
          args?: Record<string, unknown>;
        };
      }>;
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
    const extendedRequest = request as OpenAIRequest & {
      response_format?: string | {
        type?: string;
        json_schema?: {
          schema?: Record<string, unknown>;
        };
      };
    };

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

    const functionDeclarations = request.tools?.map((tool) => ({
      name: tool.function.name,
      description: tool.function.description,
      parameters: (tool.function.parameters as Record<string, unknown> | undefined) ?? {
        type: 'object',
        properties: {},
      },
    }));

    let toolConfig: GoogleToolConfig | undefined;
    if (request.tool_choice === 'auto') {
      toolConfig = { functionCallingConfig: { mode: 'AUTO' } };
    } else if (request.tool_choice === 'none') {
      toolConfig = { functionCallingConfig: { mode: 'NONE' } };
    } else if (typeof request.tool_choice === 'object' && request.tool_choice.type === 'function') {
      toolConfig = {
        functionCallingConfig: {
          mode: 'ANY',
          allowedFunctionNames: [request.tool_choice.function.name],
        },
      };
    }

    let responseMimeType: string | undefined;
    let responseSchema: Record<string, unknown> | undefined;
    const responseFormat = extendedRequest.response_format;
    if (typeof responseFormat === 'string') {
      if (responseFormat === 'json') {
        responseMimeType = 'application/json';
      }
    } else if (responseFormat?.type === 'json_object' || responseFormat?.type === 'json_schema') {
      responseMimeType = 'application/json';
      if (responseFormat.type === 'json_schema') {
        responseSchema = responseFormat.json_schema?.schema;
      }
    }

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
        responseMimeType,
        responseSchema,
      },
      tools: functionDeclarations && functionDeclarations.length > 0
        ? [{ functionDeclarations }]
        : undefined,
      toolConfig,
    };
  }

  transformResponse(response: unknown, request?: OpenAIRequest): OpenAIResponse {
    const r = response as GoogleResponse;
    const candidate = r.candidates?.[0];
    const content = candidate?.content?.parts
      ?.map((p) => p.text ?? '')
      ?.join('') ?? '';
    const toolCalls = (candidate?.content?.parts ?? [])
      .filter((part) => !!part.functionCall)
      .map((part, index) => ({
        id: `google-tool-${index}`,
        type: 'function' as const,
        function: {
          name: part.functionCall?.name ?? 'tool',
          arguments: JSON.stringify(part.functionCall?.args ?? {}),
        },
      }));

    return {
      id: `google-${this.unixTimestamp()}`,
      object: 'chat.completion',
      created: this.unixTimestamp(),
      model: this.resolveModelId(request),
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: content.length > 0 ? content : null,
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
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

  private mapFinishReason(reason?: string): 'stop' | 'length' | 'tool_calls' | null {
    if (!reason) return null;
    if (reason === 'STOP') return 'stop';
    if (reason === 'MAX_TOKENS') return 'length';
    if (reason.toUpperCase().includes('TOOL')) return 'tool_calls';
    return 'stop';
  }

  transformStreamChunk(chunk: string, request?: OpenAIRequest): OpenAIStreamChunk | null {
    // Google streaming format
    try {
      const data = JSON.parse(chunk);
      const candidate = data.candidates?.[0];
      const firstPart = candidate?.content?.parts?.[0];
      const text = firstPart?.text;
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

      if (firstPart?.functionCall) {
        return {
          id: `google-${this.unixTimestamp()}`,
          object: 'chat.completion.chunk',
          created: this.unixTimestamp(),
          model,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                id: `google-tool-${this.unixTimestamp()}`,
                type: 'function',
                function: {
                  name: firstPart.functionCall.name,
                  arguments: JSON.stringify(firstPart.functionCall.args ?? {}),
                },
              }],
            },
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
