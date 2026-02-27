import type { ProviderAdapter, ProviderConfig, ModelConfig, ProviderRegistry as IProviderRegistry } from '../types/provider.js';

export class ProviderRegistry implements IProviderRegistry {
  private adapters = new Map<string, ProviderAdapter>();

  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.config.id, adapter);
  }

  get(providerId: string): ProviderAdapter | undefined {
    return this.adapters.get(providerId);
  }

  /**
   * Enable or disable a provider
   */
  setProviderEnabled(providerId: string, enabled: boolean): boolean {
    const adapter = this.adapters.get(providerId);
    if (!adapter) return false;
    (adapter.config as { enabled: boolean }).enabled = enabled;
    return true;
  }

  /**
   * Update models for a provider (for dynamic model discovery)
   * Merges by id/alias and preserves existing models that are not in the update set.
   */
  updateModels(providerId: string, models: ModelConfig[]): boolean {
    const adapter = this.adapters.get(providerId);
    if (!adapter) {
      return false;
    }

    const existing = (adapter.config as { models: ModelConfig[] }).models;

    for (const incoming of models) {
      const match = existing.find((current) =>
        current.id === incoming.id
        || current.alias === incoming.id
        || (incoming.alias !== undefined
          && (current.id === incoming.alias || current.alias === incoming.alias))
      );

      if (match) {
        match.id = incoming.id;
        match.alias = incoming.alias;
        match.contextWindow = incoming.contextWindow;
        match.maxOutputTokens = incoming.maxOutputTokens;
        match.inputPricePer1M = incoming.inputPricePer1M;
        match.outputPricePer1M = incoming.outputPricePer1M;
        match.capabilities = incoming.capabilities;
        // Preserve match.enabled so refresh does not unexpectedly re-enable disabled models.
      } else {
        existing.push(incoming);
      }
    }

    return true;
  }

  /**
   * Add models to an existing provider
   */
  addModels(providerId: string, models: ModelConfig[]): boolean {
    const adapter = this.adapters.get(providerId);
    if (!adapter) return false;

    const existing = adapter.config.models;
    const existingIds = new Set(
      existing.flatMap((m) => (m.alias ? [m.id, m.alias] : [m.id]))
    );

    for (const model of models) {
      const candidateIds = model.alias ? [model.id, model.alias] : [model.id];
      if (!candidateIds.some((id) => existingIds.has(id))) {
        existing.push(model);
        for (const id of candidateIds) {
          existingIds.add(id);
        }
      }
    }

    return true;
  }

  /**
   * Enable/disable a model
   */
  setModelEnabled(providerId: string, modelId: string, enabled: boolean): boolean {
    const adapter = this.adapters.get(providerId);
    if (!adapter) return false;

    const model = adapter.config.models.find(m => m.id === modelId || m.alias === modelId);
    if (!model) return false;

    model.enabled = enabled;
    return true;
  }

  getForModel(modelId: string): ProviderAdapter | undefined {
    for (const adapter of this.adapters.values()) {
      if (adapter.config.enabled && adapter.supportsModel(modelId)) {
        return adapter;
      }
    }
    return undefined;
  }

  list(): ProviderConfig[] {
    return this.listAll().filter(config => config.enabled);
  }

  listAll(): ProviderConfig[] {
    return Array.from(this.adapters.values()).map(a => a.config);
  }

  listModels(options?: {
    includeDisabledProviders?: boolean;
    includeDisabledModels?: boolean;
  }): Array<{ model: ModelConfig; provider: ProviderConfig }> {
    const includeDisabledProviders = options?.includeDisabledProviders ?? false;
    const includeDisabledModels = options?.includeDisabledModels ?? false;
    const result: Array<{ model: ModelConfig; provider: ProviderConfig }> = [];
    for (const adapter of this.adapters.values()) {
      if (!includeDisabledProviders && !adapter.config.enabled) continue;
      for (const model of adapter.config.models) {
        if (!includeDisabledModels && !model.enabled) continue;
        result.push({ model, provider: adapter.config });
      }
    }
    return result;
  }
}

import { OpenAIAdapter } from './openai.js';
import { AnthropicAdapter } from './anthropic.js';
import { GoogleAdapter } from './google.js';
import { GroqAdapter } from './groq.js';
import { OpenRouterAdapter } from './openrouter.js';
import { CustomProviderAdapter, type CustomProviderDefinition } from '../templates/custom-provider.js';

export function registerDefaultProviders(registry: ProviderRegistry): ProviderRegistry {
  registry.register(new OpenAIAdapter());
  registry.register(new AnthropicAdapter());
  registry.register(new GoogleAdapter());
  registry.register(new GroqAdapter());
  registry.register(new OpenRouterAdapter());
  return registry;
}

export function createDefaultRegistry(
  customProviders: CustomProviderDefinition[] = []
): ProviderRegistry {
  const registry = registerDefaultProviders(new ProviderRegistry());
  for (const provider of customProviders) {
    registry.register(new CustomProviderAdapter(provider));
  }
  return registry;
}

export const defaultRegistry = createDefaultRegistry();
