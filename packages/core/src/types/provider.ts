import type { OpenAIRequest, OpenAIResponse, OpenAIStreamChunk, OpenAIError } from './openai.js';

export type ModelCapability = 'chat' | 'vision' | 'tools' | 'json_mode';

export interface ModelConfig {
  id: string;
  alias?: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputPricePer1M?: number;
  outputPricePer1M?: number;
  capabilities: ModelCapability[];
  enabled: boolean;
}

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  authHeader: string;
  authScheme?: string;
  models: ModelConfig[];
  enabled: boolean;
}

export interface ProviderAdapter {
  readonly config: ProviderConfig;

  transformRequest(request: OpenAIRequest): unknown;
  transformResponse(response: unknown, request?: OpenAIRequest): OpenAIResponse;
  transformStreamChunk(chunk: string, request?: OpenAIRequest): OpenAIStreamChunk | null;
  normalizeError(error: unknown): OpenAIError;
  supportsModel(modelId: string): boolean;
  getModelConfig(modelId: string): ModelConfig | undefined;
  getEndpointUrl(
    endpoint: 'chat' | 'models',
    options?: { request?: OpenAIRequest; apiKey?: string }
  ): string;
  getAuthHeaders(apiKey: string): Record<string, string>;
  buildAuthenticatedUrl(endpoint: 'chat' | 'models', apiKey: string): string;
}

export interface ProviderRegistry {
  register(adapter: ProviderAdapter): void;
  get(providerId: string): ProviderAdapter | undefined;
  setProviderEnabled(providerId: string, enabled: boolean): boolean;
  updateModels(providerId: string, models: ModelConfig[]): boolean;
  addModels(providerId: string, models: ModelConfig[]): boolean;
  setModelEnabled(providerId: string, modelId: string, enabled: boolean): boolean;
  getForModel(modelId: string): ProviderAdapter | undefined;
  list(): ProviderConfig[];
  listAll(): ProviderConfig[];
  listModels(): Array<{ model: ModelConfig; provider: ProviderConfig }>;
}
