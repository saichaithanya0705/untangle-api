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
   */
  updateModels(providerId: string, models: ModelConfig[]): void {
    const adapter = this.adapters.get(providerId);
    if (adapter) {
      // Update the config's models array
      (adapter.config as { models: ModelConfig[] }).models = models;
    }
  }

  /**
   * Add models to an existing provider
   */
  addModels(providerId: string, models: ModelConfig[]): void {
    const adapter = this.adapters.get(providerId);
    if (adapter) {
      const existing = adapter.config.models;
      const existingIds = new Set(existing.map(m => m.id));

      for (const model of models) {
        if (!existingIds.has(model.id)) {
          existing.push(model);
        }
      }
    }
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
    return Array.from(this.adapters.values())
      .filter(a => a.config.enabled)
      .map(a => a.config);
  }

  listModels(): Array<{ model: ModelConfig; provider: ProviderConfig }> {
    const result: Array<{ model: ModelConfig; provider: ProviderConfig }> = [];
    for (const adapter of this.adapters.values()) {
      if (!adapter.config.enabled) continue;
      for (const model of adapter.config.models) {
        if (model.enabled) {
          result.push({ model, provider: adapter.config });
        }
      }
    }
    return result;
  }
}

export const defaultRegistry = new ProviderRegistry();

import { openaiAdapter } from './openai.js';
import { anthropicAdapter } from './anthropic.js';
import { googleAdapter } from './google.js';
import { groqAdapter } from './groq.js';
import { openrouterAdapter } from './openrouter.js';

// Register default providers
defaultRegistry.register(openaiAdapter);
defaultRegistry.register(anthropicAdapter);
defaultRegistry.register(googleAdapter);
defaultRegistry.register(groqAdapter);
defaultRegistry.register(openrouterAdapter);
