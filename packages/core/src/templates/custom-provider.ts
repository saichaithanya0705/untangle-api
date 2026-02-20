import { BaseProviderAdapter } from '../providers/base.js';
import type { ProviderConfig, ModelConfig } from '../types/provider.js';
import type { OpenAIRequest, OpenAIResponse, OpenAIStreamChunk } from '../types/openai.js';
import { TemplateEngine } from './engine.js';

export interface CustomProviderDefinition {
  id: string;
  name: string;
  baseUrl: string;
  auth: {
    type: 'header' | 'query';
    header?: string;
    scheme?: string;
    queryParam?: string;
  };
  headers?: Record<string, string>;
  models: ModelConfig[];
  endpoints: {
    chat: {
      path: string;
      method: 'POST' | 'GET';
      requestTemplate: string;
      responseTemplate: string;
      streamParser?: 'sse' | 'json-lines';
    };
  };
}

export class CustomProviderAdapter extends BaseProviderAdapter {
  readonly config: ProviderConfig;
  private engine: TemplateEngine;
  private definition: CustomProviderDefinition;

  constructor(definition: CustomProviderDefinition) {
    super();
    this.definition = definition;
    this.engine = new TemplateEngine();

    // Compile templates
    this.engine.compile(`${definition.id}-request`, definition.endpoints.chat.requestTemplate);
    this.engine.compile(`${definition.id}-response`, definition.endpoints.chat.responseTemplate);

    this.config = {
      id: definition.id,
      name: definition.name,
      baseUrl: definition.baseUrl,
      authHeader: definition.auth.header ?? 'Authorization',
      authScheme: definition.auth.scheme,
      models: definition.models,
      enabled: true,
    };
  }

  getEndpointUrl(endpoint: 'chat' | 'models'): string {
    if (endpoint === 'chat') {
      return `${this.config.baseUrl}${this.definition.endpoints.chat.path}`;
    }
    return this.config.baseUrl;
  }

  buildAuthenticatedUrl(endpoint: 'chat' | 'models', apiKey: string): string {
    const baseUrl = this.getEndpointUrl(endpoint);
    const { auth } = this.definition;

    if (auth.type !== 'query') {
      return baseUrl;
    }

    const queryParam = auth.queryParam ?? 'api_key';
    const url = new URL(baseUrl);
    url.searchParams.set(queryParam, apiKey);
    return url.toString();
  }

  getAuthHeaders(apiKey: string): Record<string, string> {
    const { auth } = this.definition;
    const baseHeaders = this.definition.headers ?? {};

    if (auth.type === 'header') {
      const header = auth.header ?? 'Authorization';
      const value = auth.scheme ? `${auth.scheme} ${apiKey}` : apiKey;
      return {
        ...baseHeaders,
        [header]: value,
      };
    }

    // Query param auth uses URL-based auth and only static headers.
    return baseHeaders;
  }

  transformRequest(request: OpenAIRequest): unknown {
    return this.engine.transformToObject(
      `${this.definition.id}-request`,
      request
    );
  }

  transformResponse(response: unknown): OpenAIResponse {
    return this.engine.transformToObject(
      `${this.definition.id}-response`,
      { output: response }
    );
  }

  transformStreamChunk(chunk: string): OpenAIStreamChunk | null {
    // Basic streaming support - can be enhanced based on streamParser config
    try {
      const data = JSON.parse(chunk);
      return this.engine.transformToObject(
        `${this.definition.id}-response`,
        { output: data }
      ) as unknown as OpenAIStreamChunk;
    } catch {
      return null;
    }
  }
}

export function createCustomProvider(definition: CustomProviderDefinition): CustomProviderAdapter {
  return new CustomProviderAdapter(definition);
}
