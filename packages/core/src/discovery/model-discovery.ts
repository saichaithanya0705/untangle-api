/**
 * Model Discovery - Fetches available models from provider APIs and pricing pages
 *
 * This module dynamically discovers models from:
 * 1. Provider APIs (OpenAI, Google, Groq)
 * 2. Provider pricing/documentation pages (Anthropic, etc.)
 * 3. OpenRouter API (aggregated data)
 */

import type { ModelConfig, ModelCapability } from '../types/provider.js';

export interface DiscoveredModel {
  id: string;
  name?: string;
  description?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  inputPricePer1M?: number;
  outputPricePer1M?: number;
  capabilities?: ModelCapability[];
  source: 'api' | 'web-search' | 'openrouter' | 'hardcoded';
}

export interface ModelDiscoveryResult {
  providerId: string;
  models: DiscoveredModel[];
  lastUpdated: string;
  source: string;
}

// Provider pricing page URLs for web scraping fallback
const PRICING_PAGES: Record<string, string> = {
  anthropic: 'https://www.anthropic.com/pricing',
  openai: 'https://openai.com/api/pricing',
  google: 'https://ai.google.dev/pricing',
  groq: 'https://groq.com/pricing',
};

export class ModelDiscovery {
  private cache = new Map<string, ModelDiscoveryResult>();
  private openRouterModels: DiscoveredModel[] = [];

  /**
   * Discover models for a provider using their API
   */
  async discoverFromAPI(
    providerId: string,
    apiKey: string,
    baseUrl?: string
  ): Promise<DiscoveredModel[]> {
    try {
      switch (providerId) {
        case 'openai':
          return await this.fetchOpenAIModels(apiKey, baseUrl);
        case 'google':
          return await this.fetchGoogleModels(apiKey);
        case 'groq':
          return await this.fetchGroqModels(apiKey);
        case 'anthropic':
          // Anthropic has a /v1/models API - use it with the API key
          return await this.discoverAnthropicModels(apiKey);
        case 'openrouter':
          // OpenRouter has a public API - use it directly
          return await this.fetchFromOpenRouter();
        default:
          return [];
      }
    } catch (error) {
      console.error(`Failed to discover ${providerId} models from API:`, error);
      return [];
    }
  }

  /**
   * Fetch models from OpenAI API
   */
  private async fetchOpenAIModels(apiKey: string, baseUrl?: string): Promise<DiscoveredModel[]> {
    const url = `${baseUrl || 'https://api.openai.com/v1'}/models`;

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`OpenAI API error: ${response.status}`);
    }

    const data = await response.json() as {
      data: Array<{
        id: string;
        created: number;
        owned_by: string;
      }>;
    };

    // Filter to chat models only
    const chatModels = data.data.filter(m =>
      m.id.includes('gpt') ||
      m.id.includes('o1') ||
      m.id.includes('o3') ||
      m.id.includes('chatgpt')
    );

    // Enrich with pricing from OpenRouter or web search
    const models: DiscoveredModel[] = [];

    for (const model of chatModels) {
      const pricing = await this.getPricingForModel('openai', model.id);

      models.push({
        id: model.id,
        name: model.id,
        contextWindow: this.estimateContextWindow(model.id),
        maxOutputTokens: this.estimateMaxOutput(model.id),
        inputPricePer1M: pricing?.inputPricePer1M,
        outputPricePer1M: pricing?.outputPricePer1M,
        capabilities: this.inferCapabilities(model.id),
        source: 'api',
      });
    }

    return models;
  }

  /**
   * Fetch models from Google AI API
   */
  private async fetchGoogleModels(apiKey: string): Promise<DiscoveredModel[]> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;

    const response = await fetch(url);

    if (!response.ok) {
      throw new Error(`Google AI API error: ${response.status}`);
    }

    const data = await response.json() as {
      models: Array<{
        name: string;
        displayName: string;
        description: string;
        inputTokenLimit: number;
        outputTokenLimit: number;
        supportedGenerationMethods: string[];
      }>;
    };

    const models: DiscoveredModel[] = [];

    for (const model of data.models) {
      // Extract model ID from name (e.g., "models/gemini-1.5-flash" -> "gemini-1.5-flash")
      const modelId = model.name.replace('models/', '');

      // Only include generative models
      if (!model.supportedGenerationMethods?.includes('generateContent')) {
        continue;
      }

      const pricing = await this.getPricingForModel('google', modelId);

      models.push({
        id: modelId,
        name: model.displayName,
        description: model.description,
        contextWindow: model.inputTokenLimit,
        maxOutputTokens: model.outputTokenLimit,
        inputPricePer1M: pricing?.inputPricePer1M,
        outputPricePer1M: pricing?.outputPricePer1M,
        capabilities: this.inferCapabilities(modelId),
        source: 'api',
      });
    }

    return models;
  }

  /**
   * Fetch models from Groq API (OpenAI-compatible)
   */
  private async fetchGroqModels(apiKey: string): Promise<DiscoveredModel[]> {
    const url = 'https://api.groq.com/openai/v1/models';

    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Groq API error: ${response.status}`);
    }

    const data = await response.json() as {
      data: Array<{
        id: string;
        owned_by: string;
        context_window?: number;
      }>;
    };

    const models: DiscoveredModel[] = [];

    for (const model of data.data) {
      const pricing = await this.getPricingForModel('groq', model.id);

      models.push({
        id: model.id,
        name: model.id,
        contextWindow: model.context_window || 8192,
        maxOutputTokens: 8192,
        inputPricePer1M: pricing?.inputPricePer1M,
        outputPricePer1M: pricing?.outputPricePer1M,
        capabilities: this.inferCapabilities(model.id),
        source: 'api',
      });
    }

    return models;
  }

  /**
   * Discover Anthropic models from their API
   *
   * Anthropic now has a /v1/models endpoint that lists available models.
   */
  private async discoverAnthropicModels(apiKey?: string): Promise<DiscoveredModel[]> {
    // If we have an API key, try to fetch from Anthropic's models API
    if (apiKey) {
      try {
        const models = await this.fetchAnthropicModels(apiKey);
        if (models.length > 0) {
          return models;
        }
      } catch (error) {
        console.error('Failed to fetch Anthropic models from API:', error);
      }
    }

    // Fallback to known models with pricing
    return this.getKnownAnthropicModels();
  }

  /**
   * Fetch models from Anthropic's /v1/models API
   */
  private async fetchAnthropicModels(apiKey: string): Promise<DiscoveredModel[]> {
    const url = 'https://api.anthropic.com/v1/models';

    const response = await fetch(url, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      throw new Error(`Anthropic API error: ${response.status}`);
    }

    const data = await response.json() as {
      data: Array<{
        id: string;
        display_name: string;
        created_at: string;
        type: string;
      }>;
      has_more: boolean;
    };

    const models: DiscoveredModel[] = [];

    for (const model of data.data) {
      // Get pricing from OpenRouter cache or known pricing
      const pricing = this.getAnthropicModelPricing(model.id);

      models.push({
        id: model.id,
        name: model.display_name,
        contextWindow: this.estimateContextWindow(model.id),
        maxOutputTokens: this.estimateMaxOutput(model.id),
        inputPricePer1M: pricing?.inputPricePer1M,
        outputPricePer1M: pricing?.outputPricePer1M,
        capabilities: this.inferCapabilities(model.id),
        source: 'api',
      });
    }

    console.log(`Fetched ${models.length} models from Anthropic API`);
    return models;
  }

  /**
   * Get known pricing for Anthropic models
   */
  private getAnthropicModelPricing(modelId: string): { inputPricePer1M: number; outputPricePer1M: number } | null {
    const id = modelId.toLowerCase();

    // Claude 4 series
    if (id.includes('claude-opus-4') || id.includes('claude-4-opus')) {
      return { inputPricePer1M: 15, outputPricePer1M: 75 };
    }
    if (id.includes('claude-sonnet-4') || id.includes('claude-4-sonnet')) {
      return { inputPricePer1M: 3, outputPricePer1M: 15 };
    }

    // Claude 3.7 series
    if (id.includes('claude-3-7-sonnet') || id.includes('claude-3.7-sonnet')) {
      return { inputPricePer1M: 3, outputPricePer1M: 15 };
    }

    // Claude 3.5 series
    if (id.includes('claude-3-5-sonnet') || id.includes('claude-3.5-sonnet')) {
      return { inputPricePer1M: 3, outputPricePer1M: 15 };
    }
    if (id.includes('claude-3-5-haiku') || id.includes('claude-3.5-haiku')) {
      return { inputPricePer1M: 0.8, outputPricePer1M: 4 };
    }

    // Claude 3 series
    if (id.includes('claude-3-opus')) {
      return { inputPricePer1M: 15, outputPricePer1M: 75 };
    }
    if (id.includes('claude-3-sonnet')) {
      return { inputPricePer1M: 3, outputPricePer1M: 15 };
    }
    if (id.includes('claude-3-haiku')) {
      return { inputPricePer1M: 0.25, outputPricePer1M: 1.25 };
    }

    // Try OpenRouter cache
    const orModel = this.openRouterModels.find(m =>
      m.id.toLowerCase().includes(id) || id.includes(m.id.split('/').pop()?.toLowerCase() || '')
    );
    if (orModel?.inputPricePer1M !== undefined) {
      return {
        inputPricePer1M: orModel.inputPricePer1M,
        outputPricePer1M: orModel.outputPricePer1M || orModel.inputPricePer1M * 5,
      };
    }

    return null;
  }

  /**
   * Get known Anthropic models as fallback
   */
  private getKnownAnthropicModels(): DiscoveredModel[] {
    return [
      {
        id: 'claude-opus-4-20250514',
        name: 'Claude Opus 4',
        contextWindow: 200000,
        maxOutputTokens: 64000,
        inputPricePer1M: 15,
        outputPricePer1M: 75,
        capabilities: ['chat', 'vision', 'tools'],
        source: 'hardcoded',
      },
      {
        id: 'claude-sonnet-4-20250514',
        name: 'Claude Sonnet 4',
        contextWindow: 200000,
        maxOutputTokens: 64000,
        inputPricePer1M: 3,
        outputPricePer1M: 15,
        capabilities: ['chat', 'vision', 'tools'],
        source: 'hardcoded',
      },
      {
        id: 'claude-3-7-sonnet-20250219',
        name: 'Claude 3.7 Sonnet',
        contextWindow: 200000,
        maxOutputTokens: 128000,
        inputPricePer1M: 3,
        outputPricePer1M: 15,
        capabilities: ['chat', 'vision', 'tools'],
        source: 'hardcoded',
      },
      {
        id: 'claude-3-5-sonnet-20241022',
        name: 'Claude 3.5 Sonnet',
        contextWindow: 200000,
        maxOutputTokens: 8192,
        inputPricePer1M: 3,
        outputPricePer1M: 15,
        capabilities: ['chat', 'vision', 'tools'],
        source: 'hardcoded',
      },
      {
        id: 'claude-3-5-haiku-20241022',
        name: 'Claude 3.5 Haiku',
        contextWindow: 200000,
        maxOutputTokens: 8192,
        inputPricePer1M: 0.8,
        outputPricePer1M: 4,
        capabilities: ['chat', 'vision', 'tools'],
        source: 'hardcoded',
      },
      {
        id: 'claude-3-opus-20240229',
        name: 'Claude 3 Opus',
        contextWindow: 200000,
        maxOutputTokens: 4096,
        inputPricePer1M: 15,
        outputPricePer1M: 75,
        capabilities: ['chat', 'vision', 'tools'],
        source: 'hardcoded',
      },
    ];
  }

  /**
   * Fetch comprehensive model data from OpenRouter
   */
  async fetchFromOpenRouter(): Promise<DiscoveredModel[]> {
    try {
      const response = await fetch('https://openrouter.ai/api/v1/models', {
        headers: { 'User-Agent': 'untangle-ai/0.1.0' },
      });

      if (!response.ok) {
        console.error('OpenRouter API error:', response.status);
        return [];
      }

      const data = await response.json() as {
        data: Array<{
          id: string;
          name: string;
          description?: string;
          context_length: number;
          pricing: { prompt: string; completion: string };
          top_provider?: { max_completion_tokens?: number };
        }>;
      };

      const models: DiscoveredModel[] = [];

      for (const model of data.data) {
        const inputPrice = parseFloat(model.pricing.prompt) * 1_000_000;
        const outputPrice = parseFloat(model.pricing.completion) * 1_000_000;

        models.push({
          id: model.id,
          name: model.name,
          description: model.description,
          contextWindow: model.context_length,
          maxOutputTokens: model.top_provider?.max_completion_tokens || 4096,
          inputPricePer1M: inputPrice,
          outputPricePer1M: outputPrice,
          capabilities: this.inferCapabilities(model.id),
          source: 'openrouter',
        });
      }

      this.openRouterModels = models;
      console.log(`Loaded ${models.length} models from OpenRouter`);
      return models;
    } catch (error) {
      console.error('Failed to fetch from OpenRouter:', error);
      return [];
    }
  }

  /**
   * Intelligent web search discovery for any provider
   * Uses multiple search engines as fallback to ensure reliability
   */
  async discoverFromWebSearch(providerId: string): Promise<DiscoveredModel[]> {
    console.log(`Attempting web search discovery for ${providerId}...`);

    try {
      // Step 1: Search for the provider's models/pricing page using multiple search engines
      const searchResults = await this.searchProviderModelsPage(providerId);

      // Step 2: If no search results, use hardcoded models as fallback
      if (!searchResults || searchResults.length === 0) {
        console.log(`No search results found for ${providerId}, using hardcoded fallback`);
        return this.getHardcodedModels(providerId);
      }

      // Step 3: Try to extract model information from search results
      const models = await this.extractModelsFromSearchResults(providerId, searchResults);

      if (models.length > 0) {
        console.log(`Discovered ${models.length} models for ${providerId} via web search`);
        return models;
      }

      // Step 4: If extraction failed, use hardcoded models
      console.log(`Could not extract models from search results for ${providerId}, using hardcoded fallback`);
      return this.getHardcodedModels(providerId);
    } catch (error) {
      console.error(`Web search discovery failed for ${providerId}:`, error);
      // Always return hardcoded models as ultimate fallback
      return this.getHardcodedModels(providerId);
    }
  }

  /**
   * Search for provider's models/pricing page using multiple search engines
   * Tries: DuckDuckGo -> SearXNG public instances -> hardcoded knowledge
   */
  private async searchProviderModelsPage(providerId: string): Promise<Array<{ title: string; text: string; url: string }>> {
    const providerNames: Record<string, string> = {
      openai: 'OpenAI',
      anthropic: 'Anthropic Claude',
      google: 'Google Gemini',
      groq: 'Groq',
      mistral: 'Mistral AI',
      cohere: 'Cohere',
      perplexity: 'Perplexity AI',
      openrouter: 'OpenRouter',
    };

    const providerName = providerNames[providerId] || providerId;

    // Try multiple search engines in order
    let results: Array<{ title: string; text: string; url: string }> = [];

    // 1. Try DuckDuckGo Instant Answer API
    results = await this.searchWithDuckDuckGo(providerName, providerId);
    if (results.length > 0) return results;

    // 2. Try fetching directly from known pricing pages
    results = await this.fetchKnownPricingPage(providerId);
    if (results.length > 0) return results;

    // 3. Use hardcoded knowledge about models
    results = this.getHardcodedSearchResults(providerId, providerName);

    return results;
  }

  /**
   * Search using DuckDuckGo Instant Answer API
   */
  private async searchWithDuckDuckGo(providerName: string, providerId: string): Promise<Array<{ title: string; text: string; url: string }>> {
    const queries = [
      `${providerName} API models list pricing`,
      `${providerName} AI models pricing per million tokens`,
    ];

    const results: Array<{ title: string; text: string; url: string }> = [];

    for (const queryText of queries) {
      try {
        const query = encodeURIComponent(queryText);
        const response = await fetch(
          `https://api.duckduckgo.com/?q=${query}&format=json&no_html=1&no_redirect=1`,
          {
            headers: { 'User-Agent': 'untangle-ai/0.1.0' },
            signal: AbortSignal.timeout(5000), // 5 second timeout
          }
        );

        if (!response.ok) continue;

        const data = await response.json() as {
          AbstractText?: string;
          AbstractURL?: string;
          Heading?: string;
          RelatedTopics?: Array<{ Text?: string; FirstURL?: string }>;
          Results?: Array<{ Text?: string; FirstURL?: string }>;
        };

        if (data.AbstractText && data.AbstractURL) {
          results.push({
            title: data.Heading || providerName,
            text: data.AbstractText,
            url: data.AbstractURL,
          });
        }

        if (data.RelatedTopics) {
          for (const topic of data.RelatedTopics) {
            if (topic.Text && topic.FirstURL) {
              results.push({
                title: topic.Text.substring(0, 100),
                text: topic.Text,
                url: topic.FirstURL,
              });
            }
          }
        }

        if (data.Results) {
          for (const result of data.Results) {
            if (result.Text && result.FirstURL) {
              results.push({
                title: result.Text.substring(0, 100),
                text: result.Text,
                url: result.FirstURL,
              });
            }
          }
        }

        if (results.length > 0) break;
      } catch (error) {
        console.log(`DuckDuckGo search failed: ${queryText}`, error);
        continue;
      }
    }

    return results;
  }

  /**
   * Try to fetch directly from known pricing pages
   */
  private async fetchKnownPricingPage(providerId: string): Promise<Array<{ title: string; text: string; url: string }>> {
    const pricingUrls: Record<string, string[]> = {
      openai: [
        'https://openai.com/api/pricing',
        'https://platform.openai.com/docs/models',
      ],
      anthropic: [
        'https://www.anthropic.com/pricing',
        'https://docs.anthropic.com/en/docs/about-claude/models',
      ],
      google: [
        'https://ai.google.dev/pricing',
        'https://ai.google.dev/gemini-api/docs/models/gemini',
      ],
      groq: [
        'https://groq.com/pricing',
      ],
      mistral: [
        'https://mistral.ai/technology/#pricing',
      ],
    };

    const urls = pricingUrls[providerId];
    if (!urls) return [];

    const results: Array<{ title: string; text: string; url: string }> = [];

    for (const url of urls) {
      try {
        const response = await fetch(url, {
          headers: { 'User-Agent': 'untangle-ai/0.1.0' },
          signal: AbortSignal.timeout(10000), // 10 second timeout
        });

        if (!response.ok) continue;

        const text = await response.text();

        // Extract just the text content (strip HTML)
        const plainText = text
          .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
          .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();

        if (plainText.length > 100) {
          results.push({
            title: `${providerId} pricing page`,
            text: plainText.substring(0, 10000), // Limit to first 10k chars
            url,
          });
        }
      } catch (error) {
        console.log(`Failed to fetch ${url}:`, error);
        continue;
      }
    }

    return results;
  }

  /**
   * Get hardcoded search results based on known model information
   */
  private getHardcodedSearchResults(providerId: string, providerName: string): Array<{ title: string; text: string; url: string }> {
    const modelInfo: Record<string, string> = {
      openai: 'OpenAI models: GPT-4o ($2.50/$10 per 1M), GPT-4o-mini ($0.15/$0.60 per 1M), GPT-4-turbo ($10/$30 per 1M), o1 ($15/$60 per 1M), o1-mini ($3/$12 per 1M). Context windows: GPT-4o 128K, o1 200K.',
      anthropic: 'Anthropic Claude models: Claude Opus 4 ($15/$75 per 1M), Claude Sonnet 4 ($3/$15 per 1M), Claude 3.7 Sonnet ($3/$15 per 1M), Claude 3.5 Sonnet ($3/$15 per 1M), Claude 3.5 Haiku ($0.80/$4 per 1M), Claude 3 Opus ($15/$75 per 1M). All models have 200K context.',
      google: 'Google Gemini models: Gemini 2.0 Flash (free tier), Gemini 1.5 Pro ($1.25/$5 per 1M), Gemini 1.5 Flash ($0.075/$0.30 per 1M). Context: 1M-2M tokens.',
      groq: 'Groq models: Llama 3.3 70B ($0.59/$0.79 per 1M), Llama 3.1 8B ($0.05/$0.08 per 1M), Mixtral 8x7B ($0.24/$0.24 per 1M). Fast inference.',
      mistral: 'Mistral AI models: Mistral Large ($2/$6 per 1M), Mistral Medium ($2.70/$8.10 per 1M), Mistral Small ($0.20/$0.60 per 1M).',
      cohere: 'Cohere models: Command R+ ($2.50/$10 per 1M), Command R ($0.50/$1.50 per 1M), Command ($1/$2 per 1M).',
    };

    const text = modelInfo[providerId];
    if (!text) return [];

    return [{
      title: `${providerName} Models and Pricing`,
      text,
      url: `https://${this.getProviderDomain(providerId)}/pricing`,
    }];
  }

  /**
   * Get the domain for a provider
   */
  private getProviderDomain(providerId: string): string {
    const domains: Record<string, string> = {
      openai: 'openai.com',
      anthropic: 'anthropic.com',
      google: 'ai.google.dev',
      groq: 'groq.com',
      mistral: 'mistral.ai',
      cohere: 'cohere.com',
      perplexity: 'perplexity.ai',
    };
    return domains[providerId] || `${providerId}.com`;
  }

  /**
   * Extract model information from search results
   */
  private async extractModelsFromSearchResults(
    providerId: string,
    searchResults: Array<{ title: string; text: string; url: string }>
  ): Promise<DiscoveredModel[]> {
    const models: DiscoveredModel[] = [];
    const seenModelIds = new Set<string>();

    // Combine all search result text
    const combinedText = searchResults.map(r => r.text).join('\n');

    // Provider-specific model patterns
    const modelPatterns = this.getModelPatternsForProvider(providerId);

    for (const { pattern, idTemplate, nameTemplate } of modelPatterns) {
      const matches = combinedText.matchAll(pattern);

      for (const match of matches) {
        const modelId = idTemplate(match);
        if (!modelId || seenModelIds.has(modelId)) continue;

        seenModelIds.add(modelId);

        // Extract pricing if available in the match
        const pricing = this.extractPricingFromMatch(combinedText, modelId);

        models.push({
          id: modelId,
          name: nameTemplate(match),
          contextWindow: this.estimateContextWindow(modelId),
          maxOutputTokens: this.estimateMaxOutput(modelId),
          inputPricePer1M: pricing?.inputPricePer1M,
          outputPricePer1M: pricing?.outputPricePer1M,
          capabilities: this.inferCapabilities(modelId),
          source: 'web-search',
        });
      }
    }

    return models;
  }

  /**
   * Get model regex patterns for a specific provider
   */
  private getModelPatternsForProvider(providerId: string): Array<{
    pattern: RegExp;
    idTemplate: (match: RegExpMatchArray) => string;
    nameTemplate: (match: RegExpMatchArray) => string;
  }> {
    switch (providerId) {
      case 'openai':
        return [
          {
            pattern: /\b(gpt-4o(?:-mini)?(?:-\d{4}-\d{2}-\d{2})?)\b/gi,
            idTemplate: (m) => m[1].toLowerCase(),
            nameTemplate: (m) => m[1],
          },
          {
            pattern: /\b(gpt-4-turbo(?:-\d{4}-\d{2}-\d{2})?)\b/gi,
            idTemplate: (m) => m[1].toLowerCase(),
            nameTemplate: (m) => m[1],
          },
          {
            pattern: /\b(gpt-3\.5-turbo(?:-\d{4})?)\b/gi,
            idTemplate: (m) => m[1].toLowerCase(),
            nameTemplate: (m) => m[1],
          },
          {
            pattern: /\b(o1(?:-preview|-mini)?(?:-\d{4}-\d{2}-\d{2})?)\b/gi,
            idTemplate: (m) => m[1].toLowerCase(),
            nameTemplate: (m) => `OpenAI ${m[1]}`,
          },
          {
            pattern: /\b(o3(?:-mini)?(?:-\d{4}-\d{2}-\d{2})?)\b/gi,
            idTemplate: (m) => m[1].toLowerCase(),
            nameTemplate: (m) => `OpenAI ${m[1]}`,
          },
        ];

      case 'anthropic':
        return [
          {
            pattern: /\b(claude[- ]?(?:opus|sonnet|haiku)[- ]?4(?:[- ]\d{8})?)\b/gi,
            idTemplate: (m) => m[1].toLowerCase().replace(/\s+/g, '-'),
            nameTemplate: (m) => m[1],
          },
          {
            pattern: /\b(claude[- ]?3\.?7[- ]?sonnet(?:[- ]\d{8})?)\b/gi,
            idTemplate: (m) => m[1].toLowerCase().replace(/\s+/g, '-').replace('.', '-'),
            nameTemplate: (m) => m[1],
          },
          {
            pattern: /\b(claude[- ]?3\.?5[- ]?(?:sonnet|haiku)(?:[- ]\d{8})?)\b/gi,
            idTemplate: (m) => m[1].toLowerCase().replace(/\s+/g, '-').replace('.', '-'),
            nameTemplate: (m) => m[1],
          },
          {
            pattern: /\b(claude[- ]?3[- ]?(?:opus|sonnet|haiku)(?:[- ]\d{8})?)\b/gi,
            idTemplate: (m) => m[1].toLowerCase().replace(/\s+/g, '-'),
            nameTemplate: (m) => m[1],
          },
        ];

      case 'google':
        return [
          {
            pattern: /\b(gemini[- ]?2\.?0[- ]?(?:pro|flash)(?:-exp)?)\b/gi,
            idTemplate: (m) => m[1].toLowerCase().replace(/\s+/g, '-').replace('.', '-'),
            nameTemplate: (m) => m[1],
          },
          {
            pattern: /\b(gemini[- ]?1\.?5[- ]?(?:pro|flash)(?:-\d+)?)\b/gi,
            idTemplate: (m) => m[1].toLowerCase().replace(/\s+/g, '-').replace('.', '-'),
            nameTemplate: (m) => m[1],
          },
          {
            pattern: /\b(gemini[- ]?(?:pro|ultra|nano))\b/gi,
            idTemplate: (m) => m[1].toLowerCase().replace(/\s+/g, '-'),
            nameTemplate: (m) => m[1],
          },
        ];

      case 'groq':
        return [
          {
            pattern: /\b(llama[- ]?3\.?3?[- ]?\d+b(?:-instruct)?)\b/gi,
            idTemplate: (m) => m[1].toLowerCase().replace(/\s+/g, '-'),
            nameTemplate: (m) => m[1],
          },
          {
            pattern: /\b(mixtral[- ]?8x\d+b(?:-instruct)?)\b/gi,
            idTemplate: (m) => m[1].toLowerCase().replace(/\s+/g, '-'),
            nameTemplate: (m) => m[1],
          },
          {
            pattern: /\b(gemma[- ]?\d+b(?:-it)?)\b/gi,
            idTemplate: (m) => m[1].toLowerCase().replace(/\s+/g, '-'),
            nameTemplate: (m) => m[1],
          },
        ];

      default:
        return [
          // Generic pattern for unknown providers
          {
            pattern: /\b([a-z]+-\d+[a-z]*(?:-[a-z]+)*)\b/gi,
            idTemplate: (m) => m[1].toLowerCase(),
            nameTemplate: (m) => m[1],
          },
        ];
    }
  }

  /**
   * Extract pricing information from text near a model mention
   */
  private extractPricingFromMatch(
    text: string,
    modelId: string
  ): { inputPricePer1M: number; outputPricePer1M: number } | null {
    // Look for pricing near the model mention
    const modelIndex = text.toLowerCase().indexOf(modelId.toLowerCase());
    if (modelIndex === -1) return null;

    // Get surrounding context (500 chars before and after)
    const start = Math.max(0, modelIndex - 500);
    const end = Math.min(text.length, modelIndex + modelId.length + 500);
    const context = text.substring(start, end);

    // Common pricing patterns
    const patterns = [
      // "$X.XX / 1M tokens" or "$X.XX per million"
      /\$(\d+\.?\d*)\s*(?:\/|per)\s*(?:1M|million|MTok)/gi,
      // "input: $X.XX" and "output: $X.XX"
      /input[:\s]*\$?(\d+\.?\d*)/i,
      // "X.XX per 1M input tokens"
      /(\d+\.?\d*)\s*(?:\/|per)\s*(?:1M|million)\s*(?:input|prompt)/i,
    ];

    let inputPrice: number | undefined;
    let outputPrice: number | undefined;

    // Try to find input price
    const inputMatch = context.match(/input[:\s]*\$?(\d+\.?\d*)/i) ||
                       context.match(/(\d+\.?\d*)\s*(?:\/|per)\s*(?:1M|million)\s*(?:input|prompt)/i);
    if (inputMatch) {
      inputPrice = parseFloat(inputMatch[1]);
    }

    // Try to find output price
    const outputMatch = context.match(/output[:\s]*\$?(\d+\.?\d*)/i) ||
                        context.match(/(\d+\.?\d*)\s*(?:\/|per)\s*(?:1M|million)\s*(?:output|completion)/i);
    if (outputMatch) {
      outputPrice = parseFloat(outputMatch[1]);
    }

    // Fallback: general price pattern
    if (!inputPrice) {
      const generalMatch = context.match(/\$(\d+\.?\d*)\s*(?:\/|per)\s*(?:1M|million)/i);
      if (generalMatch) {
        inputPrice = parseFloat(generalMatch[1]);
        outputPrice = outputPrice || inputPrice * 3; // Estimate output as 3x input
      }
    }

    if (inputPrice !== undefined) {
      return {
        inputPricePer1M: inputPrice,
        outputPricePer1M: outputPrice || inputPrice * 3,
      };
    }

    return null;
  }

  /**
   * Enhanced discovery: try API first, then OpenRouter, then hardcoded
   * NOTE: Web search is NOT automatic - use refreshFromWebSearch() explicitly
   */
  async discoverWithFallback(providerId: string, apiKey?: string): Promise<DiscoveredModel[]> {
    // 1. Try native API if we have a key
    if (apiKey) {
      try {
        const models = await this.discoverFromAPI(providerId, apiKey);
        if (models.length > 0) {
          console.log(`Discovered ${models.length} models for ${providerId} from API`);
          return models;
        }
      } catch (error) {
        console.log(`API discovery failed for ${providerId}:`, error);
      }
    }

    // 2. Check if we have cached web search results
    const cached = this.cache.get(providerId);
    if (cached && cached.source === 'web-search' && cached.models.length > 0) {
      console.log(`Using ${cached.models.length} cached web search models for ${providerId}`);
      return cached.models;
    }

    // 3. Try OpenRouter data
    if (this.openRouterModels.length > 0) {
      const orModels = this.getOpenRouterModelsForProvider(providerId);
      if (orModels.length > 0) {
        console.log(`Using ${orModels.length} models for ${providerId} from OpenRouter cache`);
        // Convert to provider-native IDs
        return orModels.map(m => ({
          ...m,
          id: m.id.replace(`${providerId}/`, '').replace(/^[^/]+\//, ''),
          source: 'openrouter' as const,
        }));
      }
    }

    // 4. Fall back to hardcoded models for known providers (no auto web search)
    return this.getHardcodedModels(providerId);
  }

  /**
   * Refresh models for a provider using web search
   * This is triggered explicitly by the user (refresh button)
   * Results are cached until the next refresh
   */
  async refreshFromWebSearch(providerId: string): Promise<DiscoveredModel[]> {
    console.log(`Refreshing models for ${providerId} via web search...`);

    const models = await this.discoverFromWebSearch(providerId);

    if (models.length > 0) {
      // Cache the web search results
      this.setCached(providerId, models);
      console.log(`Cached ${models.length} models for ${providerId} from web search`);
      return models;
    }

    // If web search fails, try OpenRouter as fallback
    if (this.openRouterModels.length > 0) {
      const orModels = this.getOpenRouterModelsForProvider(providerId);
      if (orModels.length > 0) {
        const converted = orModels.map(m => ({
          ...m,
          id: m.id.replace(`${providerId}/`, '').replace(/^[^/]+\//, ''),
          source: 'web-search' as const, // Mark as web-search since user triggered refresh
        }));
        this.setCached(providerId, converted);
        return converted;
      }
    }

    return [];
  }

  /**
   * Get hardcoded fallback models for a provider
   */
  private getHardcodedModels(providerId: string): DiscoveredModel[] {
    switch (providerId) {
      case 'anthropic':
        return this.getKnownAnthropicModels();
      case 'openai':
        return this.getKnownOpenAIModels();
      case 'google':
        return this.getKnownGoogleModels();
      case 'groq':
        return this.getKnownGroqModels();
      default:
        return [];
    }
  }

  /**
   * Known OpenAI models as fallback
   */
  private getKnownOpenAIModels(): DiscoveredModel[] {
    return [
      { id: 'gpt-4o', name: 'GPT-4o', contextWindow: 128000, maxOutputTokens: 16384, inputPricePer1M: 2.5, outputPricePer1M: 10, capabilities: ['chat', 'vision', 'tools', 'json_mode'], source: 'hardcoded' },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', contextWindow: 128000, maxOutputTokens: 16384, inputPricePer1M: 0.15, outputPricePer1M: 0.6, capabilities: ['chat', 'vision', 'tools', 'json_mode'], source: 'hardcoded' },
      { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', contextWindow: 128000, maxOutputTokens: 4096, inputPricePer1M: 10, outputPricePer1M: 30, capabilities: ['chat', 'vision', 'tools', 'json_mode'], source: 'hardcoded' },
      { id: 'o1', name: 'OpenAI o1', contextWindow: 200000, maxOutputTokens: 100000, inputPricePer1M: 15, outputPricePer1M: 60, capabilities: ['chat'], source: 'hardcoded' },
      { id: 'o1-mini', name: 'OpenAI o1-mini', contextWindow: 128000, maxOutputTokens: 65536, inputPricePer1M: 3, outputPricePer1M: 12, capabilities: ['chat'], source: 'hardcoded' },
    ];
  }

  /**
   * Known Google models as fallback
   */
  private getKnownGoogleModels(): DiscoveredModel[] {
    return [
      { id: 'gemini-2.0-flash-exp', name: 'Gemini 2.0 Flash', contextWindow: 1048576, maxOutputTokens: 8192, inputPricePer1M: 0, outputPricePer1M: 0, capabilities: ['chat', 'vision', 'tools'], source: 'hardcoded' },
      { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', contextWindow: 2097152, maxOutputTokens: 8192, inputPricePer1M: 1.25, outputPricePer1M: 5, capabilities: ['chat', 'vision', 'tools'], source: 'hardcoded' },
      { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', contextWindow: 1048576, maxOutputTokens: 8192, inputPricePer1M: 0.075, outputPricePer1M: 0.3, capabilities: ['chat', 'vision', 'tools'], source: 'hardcoded' },
    ];
  }

  /**
   * Known Groq models as fallback
   */
  private getKnownGroqModels(): DiscoveredModel[] {
    return [
      { id: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B', contextWindow: 131072, maxOutputTokens: 8192, inputPricePer1M: 0.59, outputPricePer1M: 0.79, capabilities: ['chat', 'tools'], source: 'hardcoded' },
      { id: 'llama-3.1-8b-instant', name: 'Llama 3.1 8B', contextWindow: 131072, maxOutputTokens: 8192, inputPricePer1M: 0.05, outputPricePer1M: 0.08, capabilities: ['chat', 'tools'], source: 'hardcoded' },
      { id: 'mixtral-8x7b-32768', name: 'Mixtral 8x7B', contextWindow: 32768, maxOutputTokens: 8192, inputPricePer1M: 0.24, outputPricePer1M: 0.24, capabilities: ['chat', 'tools'], source: 'hardcoded' },
    ];
  }

  /**
   * Get pricing for a specific model (from OpenRouter cache or web search)
   */
  private async getPricingForModel(
    providerId: string,
    modelId: string
  ): Promise<{ inputPricePer1M: number; outputPricePer1M: number } | null> {
    // Check OpenRouter cache first
    const orModel = this.openRouterModels.find(m =>
      m.id.includes(modelId) || modelId.includes(m.id.split('/').pop() || '')
    );

    if (orModel?.inputPricePer1M !== undefined) {
      return {
        inputPricePer1M: orModel.inputPricePer1M,
        outputPricePer1M: orModel.outputPricePer1M || orModel.inputPricePer1M * 3,
      };
    }

    // Fallback to web search
    return await this.searchPricingFromWeb(providerId, modelId);
  }

  /**
   * Search for model pricing using DuckDuckGo
   */
  private async searchPricingFromWeb(
    providerId: string,
    modelId: string
  ): Promise<{ inputPricePer1M: number; outputPricePer1M: number } | null> {
    try {
      const query = encodeURIComponent(`${providerId} ${modelId} API pricing per million tokens`);
      const response = await fetch(
        `https://api.duckduckgo.com/?q=${query}&format=json&no_html=1`,
        { headers: { 'User-Agent': 'untangle-ai/0.1.0' } }
      );

      if (!response.ok) return null;

      const data = await response.json() as {
        AbstractText?: string;
        Abstract?: string;
      };

      const text = data.AbstractText || data.Abstract || '';

      // Extract pricing patterns
      const inputMatch = text.match(/input[:\s]*\$?(\d+\.?\d*)/i);
      const outputMatch = text.match(/output[:\s]*\$?(\d+\.?\d*)/i);
      const generalMatch = text.match(/\$(\d+\.?\d*)\s*(?:per|\/)\s*(?:1M|million)/i);

      if (inputMatch || generalMatch) {
        const inputPrice = parseFloat(inputMatch?.[1] || generalMatch?.[1] || '0');
        const outputPrice = parseFloat(outputMatch?.[1] || (inputPrice * 3).toString());

        return { inputPricePer1M: inputPrice, outputPricePer1M: outputPrice };
      }

      return null;
    } catch {
      return null;
    }
  }

  /**
   * Estimate context window for models without API data
   */
  private estimateContextWindow(modelId: string): number {
    const id = modelId.toLowerCase();

    if (id.includes('gpt-4o') || id.includes('gpt-4-turbo')) return 128000;
    if (id.includes('gpt-4')) return 8192;
    if (id.includes('gpt-3.5')) return 16385;
    if (id.includes('o1') || id.includes('o3')) return 200000;
    if (id.includes('gemini-2')) return 1048576;
    if (id.includes('gemini-1.5-pro')) return 2097152;
    if (id.includes('gemini-1.5-flash')) return 1048576;
    if (id.includes('claude')) return 200000;
    if (id.includes('llama')) return 128000;

    return 8192; // Default
  }

  /**
   * Estimate max output tokens for models without API data
   */
  private estimateMaxOutput(modelId: string): number {
    const id = modelId.toLowerCase();

    if (id.includes('gpt-4o')) return 16384;
    if (id.includes('gpt-4')) return 8192;
    if (id.includes('gpt-3.5')) return 4096;
    if (id.includes('o1')) return 100000;
    if (id.includes('gemini')) return 8192;
    if (id.includes('claude-opus-4') || id.includes('claude-sonnet-4')) return 64000;
    if (id.includes('claude')) return 8192;

    return 4096; // Default
  }

  /**
   * Infer capabilities from model ID
   */
  private inferCapabilities(modelId: string): ModelCapability[] {
    const id = modelId.toLowerCase();
    const caps: ModelCapability[] = ['chat'];

    // Vision capability
    if (
      id.includes('gpt-4o') ||
      id.includes('gpt-4-vision') ||
      id.includes('gemini') ||
      id.includes('claude')
    ) {
      caps.push('vision');
    }

    // Tool use capability
    if (
      id.includes('gpt-4') ||
      id.includes('gpt-3.5-turbo') ||
      id.includes('gemini') ||
      id.includes('claude')
    ) {
      caps.push('tools');
    }

    // JSON mode
    if (
      id.includes('gpt-4o') ||
      id.includes('gpt-4-turbo') ||
      id.includes('gpt-3.5-turbo')
    ) {
      caps.push('json_mode');
    }

    return caps;
  }

  /**
   * Convert discovered model to ModelConfig
   */
  toModelConfig(model: DiscoveredModel, enabled: boolean = false): ModelConfig {
    return {
      id: model.id,
      alias: model.name !== model.id ? model.name?.replace(/\s+/g, '-').toLowerCase() : undefined,
      contextWindow: model.contextWindow || 8192,
      maxOutputTokens: model.maxOutputTokens || 4096,
      inputPricePer1M: model.inputPricePer1M,
      outputPricePer1M: model.outputPricePer1M,
      capabilities: model.capabilities || ['chat'],
      enabled,
    };
  }

  /**
   * Get cached discovery result for a provider
   */
  getCached(providerId: string): ModelDiscoveryResult | undefined {
    return this.cache.get(providerId);
  }

  /**
   * Cache discovery result
   */
  setCached(providerId: string, models: DiscoveredModel[]): void {
    this.cache.set(providerId, {
      providerId,
      models,
      lastUpdated: new Date().toISOString(),
      source: models[0]?.source || 'unknown',
    });
  }

  /**
   * Get OpenRouter models (pre-fetched)
   */
  getOpenRouterModels(): DiscoveredModel[] {
    return this.openRouterModels;
  }

  /**
   * Filter OpenRouter models by provider
   */
  getOpenRouterModelsForProvider(providerId: string): DiscoveredModel[] {
    // If requesting openrouter itself, return all models
    if (providerId === 'openrouter') {
      return this.openRouterModels;
    }

    const providerMap: Record<string, string[]> = {
      openai: ['openai/', 'gpt-', 'o1-', 'o3-'],
      anthropic: ['anthropic/', 'claude'],
      google: ['google/', 'gemini'],
      groq: ['groq/', 'llama', 'mixtral'],
    };

    const patterns = providerMap[providerId] || [];
    if (patterns.length === 0) return [];

    return this.openRouterModels.filter(m =>
      patterns.some(p => m.id.toLowerCase().includes(p.toLowerCase()))
    );
  }
}

export const modelDiscovery = new ModelDiscovery();
