import type {
  ProviderAdapter,
  ProviderConfig,
  ModelConfig
} from '../types/provider.js';
import type {
  OpenAIRequest,
  OpenAIResponse,
  OpenAIStreamChunk,
  OpenAIError
} from '../types/openai.js';

export abstract class BaseProviderAdapter implements ProviderAdapter {
  abstract readonly config: ProviderConfig;

  abstract transformRequest(request: OpenAIRequest): unknown;
  abstract transformResponse(response: unknown): OpenAIResponse;
  abstract transformStreamChunk(chunk: string): OpenAIStreamChunk | null;

  normalizeError(error: unknown): OpenAIError {
    if (error instanceof Error) {
      return {
        error: {
          message: error.message,
          type: 'api_error',
          code: null,
        },
      };
    }
    return {
      error: {
        message: String(error),
        type: 'unknown_error',
        code: null,
      },
    };
  }

  supportsModel(modelId: string): boolean {
    return this.config.models.some(
      m => m.enabled && (m.id === modelId || m.alias === modelId)
    );
  }

  getModelConfig(modelId: string): ModelConfig | undefined {
    return this.config.models.find(
      m => m.enabled && (m.id === modelId || m.alias === modelId)
    );
  }

  getEndpointUrl(endpoint: 'chat' | 'models'): string {
    const paths: Record<string, string> = {
      chat: '/chat/completions',
      models: '/models',
    };
    return `${this.config.baseUrl}${paths[endpoint] ?? ''}`;
  }

  getAuthHeaders(apiKey: string): Record<string, string> {
    const value = this.config.authScheme
      ? `${this.config.authScheme} ${apiKey}`
      : apiKey;
    return { [this.config.authHeader]: value };
  }

  buildAuthenticatedUrl(endpoint: 'chat' | 'models', _apiKey: string): string {
    return this.getEndpointUrl(endpoint);
  }
}
