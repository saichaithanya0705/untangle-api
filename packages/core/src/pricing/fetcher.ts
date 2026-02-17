/**
 * Dynamic pricing fetcher - retrieves model pricing from provider APIs and web sources
 */

export interface ModelPricing {
  modelId: string;
  providerId: string;
  inputPricePer1M: number;  // USD per 1M input tokens
  outputPricePer1M: number; // USD per 1M output tokens
  lastUpdated: string;
  source?: string; // Where the pricing came from
}

export interface PricingCache {
  prices: Map<string, ModelPricing>; // key: `${providerId}:${modelId}`
  lastFetched: string;
}

export class PricingFetcher {
  private cache: Map<string, ModelPricing> = new Map();
  private lastFetched: string = '';

  /**
   * Get pricing for a specific model
   */
  getPricing(providerId: string, modelId: string): ModelPricing | null {
    const key = `${providerId}:${modelId}`;
    return this.cache.get(key) || null;
  }

  /**
   * Get all cached pricing
   */
  getAllPricing(): ModelPricing[] {
    return Array.from(this.cache.values());
  }

  /**
   * Calculate cost for a request
   */
  calculateCost(
    providerId: string,
    modelId: string,
    inputTokens: number,
    outputTokens: number
  ): { inputCost: number; outputCost: number; totalCost: number } | null {
    const pricing = this.getPricing(providerId, modelId);
    if (!pricing) {
      // Try to find a close match (handle aliases)
      for (const [key, price] of this.cache) {
        if (key.includes(modelId) || price.modelId.includes(modelId)) {
          const inputCost = (inputTokens / 1_000_000) * price.inputPricePer1M;
          const outputCost = (outputTokens / 1_000_000) * price.outputPricePer1M;
          return { inputCost, outputCost, totalCost: inputCost + outputCost };
        }
      }
      return null;
    }

    const inputCost = (inputTokens / 1_000_000) * pricing.inputPricePer1M;
    const outputCost = (outputTokens / 1_000_000) * pricing.outputPricePer1M;

    return {
      inputCost,
      outputCost,
      totalCost: inputCost + outputCost,
    };
  }

  /**
   * Fetch pricing from OpenRouter API (has comprehensive pricing for many models)
   */
  async fetchFromOpenRouter(): Promise<ModelPricing[]> {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { 'User-Agent': 'untangle-ai/0.1.0' }
      });

      if (!response.ok) {
        console.error('OpenRouter API error:', response.status);
        return [];
      }

      const data = await response.json() as {
        data: Array<{
          id: string;
          pricing: { prompt: string; completion: string };
        }>;
      };

      const models: ModelPricing[] = [];

      for (const model of data.data) {
        // OpenRouter returns pricing per token, convert to per 1M
        const inputPricePer1M = parseFloat(model.pricing.prompt) * 1_000_000;
        const outputPricePer1M = parseFloat(model.pricing.completion) * 1_000_000;

        // Extract provider from model ID (e.g., "openai/gpt-4" -> "openai")
        const parts = model.id.split('/');
        const providerId = parts[0] || 'openrouter';
        const modelId = parts.slice(1).join('/') || model.id;

        const pricing: ModelPricing = {
          modelId,
          providerId,
          inputPricePer1M,
          outputPricePer1M,
          lastUpdated: new Date().toISOString(),
          source: 'openrouter',
        };

        models.push(pricing);
        this.cache.set(`${providerId}:${modelId}`, pricing);

        // Also cache with full openrouter ID for lookups
        this.cache.set(`openrouter:${model.id}`, {
          ...pricing,
          modelId: model.id,
          providerId: 'openrouter',
        });
      }

      console.log(`Fetched pricing for ${models.length} models from OpenRouter`);
      return models;
    } catch (error) {
      console.error('Failed to fetch OpenRouter pricing:', error);
      return [];
    }
  }

  /**
   * Fetch pricing by searching the web (using DuckDuckGo)
   */
  async searchPricingFromWeb(providerId: string, modelId: string): Promise<ModelPricing | null> {
    try {
      // Use DuckDuckGo instant answer API
      const query = encodeURIComponent(`${providerId} ${modelId} API pricing per token 2025`);
      const response = await fetch(`https://api.duckduckgo.com/?q=${query}&format=json&no_html=1`, {
        headers: { 'User-Agent': 'untangle-ai/0.1.0' }
      });

      if (!response.ok) {
        return null;
      }

      const data = await response.json() as {
        Abstract?: string;
        AbstractText?: string;
        RelatedTopics?: Array<{ Text?: string }>;
      };

      // Try to extract pricing from the abstract
      const text = data.AbstractText || data.Abstract || '';
      const pricing = this.extractPricingFromText(text, providerId, modelId);

      if (pricing) {
        this.cache.set(`${providerId}:${modelId}`, pricing);
        return pricing;
      }

      return null;
    } catch (error) {
      console.error('Web search pricing failed:', error);
      return null;
    }
  }

  /**
   * Extract pricing from text using regex patterns
   */
  private extractPricingFromText(text: string, providerId: string, modelId: string): ModelPricing | null {
    // Common patterns for pricing
    const patterns = [
      /\$?([\d.]+)\s*(?:per|\/)\s*(?:1M|million|1,000,000)\s*(?:input)?\s*tokens?/i,
      /input[:\s]*\$?([\d.]+)/i,
      /\$?([\d.]+)\s*\/\s*MTok/i,
    ];

    let inputPrice: number | null = null;
    let outputPrice: number | null = null;

    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const price = parseFloat(match[1]);
        if (!isNaN(price)) {
          if (text.toLowerCase().includes('input') || !inputPrice) {
            inputPrice = price;
          }
          if (text.toLowerCase().includes('output') || !outputPrice) {
            outputPrice = price;
          }
        }
      }
    }

    if (inputPrice !== null) {
      return {
        modelId,
        providerId,
        inputPricePer1M: inputPrice,
        outputPricePer1M: outputPrice ?? inputPrice * 2, // Estimate output as 2x input if not found
        lastUpdated: new Date().toISOString(),
        source: 'web-search',
      };
    }

    return null;
  }

  /**
   * Fetch pricing from provider's models API and enrich with pricing
   */
  async fetchFromProviderAPI(providerId: string, apiKey: string): Promise<ModelPricing[]> {
    const models: ModelPricing[] = [];

    try {
      let url = '';
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };

      switch (providerId) {
        case 'openai':
          url = 'https://api.openai.com/v1/models';
          headers['Authorization'] = `Bearer ${apiKey}`;
          break;
        case 'anthropic':
          // Anthropic doesn't have a models endpoint, use known models
          return this.getAnthropicPricing();
        case 'google':
          url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
          break;
        case 'groq':
          url = 'https://api.groq.com/openai/v1/models';
          headers['Authorization'] = `Bearer ${apiKey}`;
          break;
        default:
          return [];
      }

      const response = await fetch(url, { headers });
      if (!response.ok) {
        console.error(`${providerId} API error:`, response.status);
        return [];
      }

      const data = await response.json() as { data?: Array<{ id: string }> };
      const modelList = data.data || [];

      for (const model of modelList) {
        // Try to find pricing from OpenRouter cache first
        let pricing = this.getPricing(providerId, model.id);

        if (!pricing) {
          // Search web for pricing
          pricing = await this.searchPricingFromWeb(providerId, model.id);
        }

        if (pricing) {
          models.push(pricing);
        } else {
          // Add model with zero pricing (unknown)
          const unknownPricing: ModelPricing = {
            modelId: model.id,
            providerId,
            inputPricePer1M: 0,
            outputPricePer1M: 0,
            lastUpdated: new Date().toISOString(),
            source: 'unknown',
          };
          models.push(unknownPricing);
          this.cache.set(`${providerId}:${model.id}`, unknownPricing);
        }
      }

      return models;
    } catch (error) {
      console.error(`Failed to fetch ${providerId} models:`, error);
      return [];
    }
  }

  /**
   * Get Anthropic pricing (they don't have a models API)
   */
  private getAnthropicPricing(): ModelPricing[] {
    const models: ModelPricing[] = [
      { modelId: 'claude-opus-4-20250514', providerId: 'anthropic', inputPricePer1M: 15, outputPricePer1M: 75, lastUpdated: new Date().toISOString(), source: 'anthropic-docs' },
      { modelId: 'claude-sonnet-4-20250514', providerId: 'anthropic', inputPricePer1M: 3, outputPricePer1M: 15, lastUpdated: new Date().toISOString(), source: 'anthropic-docs' },
      { modelId: 'claude-3-5-sonnet-20241022', providerId: 'anthropic', inputPricePer1M: 3, outputPricePer1M: 15, lastUpdated: new Date().toISOString(), source: 'anthropic-docs' },
      { modelId: 'claude-3-5-haiku-20241022', providerId: 'anthropic', inputPricePer1M: 0.8, outputPricePer1M: 4, lastUpdated: new Date().toISOString(), source: 'anthropic-docs' },
      { modelId: 'claude-3-opus-20240229', providerId: 'anthropic', inputPricePer1M: 15, outputPricePer1M: 75, lastUpdated: new Date().toISOString(), source: 'anthropic-docs' },
    ];

    for (const pricing of models) {
      this.cache.set(`anthropic:${pricing.modelId}`, pricing);
    }

    return models;
  }

  /**
   * Refresh all pricing from available sources
   */
  async refreshAllPricing(): Promise<void> {
    // First fetch from OpenRouter (has most comprehensive pricing)
    await this.fetchFromOpenRouter();

    // Add Anthropic pricing
    this.getAnthropicPricing();

    this.lastFetched = new Date().toISOString();
    console.log(`Pricing cache updated with ${this.cache.size} models`);
  }

  /**
   * Update pricing for a specific model (manual override)
   */
  updatePricing(pricing: ModelPricing): void {
    const key = `${pricing.providerId}:${pricing.modelId}`;
    this.cache.set(key, pricing);
  }

  /**
   * Get cache status
   */
  getCacheStatus(): { size: number; lastFetched: string } {
    return {
      size: this.cache.size,
      lastFetched: this.lastFetched,
    };
  }
}

export const pricingFetcher = new PricingFetcher();
