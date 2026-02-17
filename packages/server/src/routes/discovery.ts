import { Hono } from 'hono';
import type { ProviderRegistry, ModelConfig } from '@untangle-ai/core';
import { modelDiscovery, type DiscoveredModel } from '@untangle-ai/core';

interface DiscoveryContext {
  registry: ProviderRegistry;
  getApiKey: (providerId: string) => Promise<string | undefined>;
}

export function createDiscoveryRoutes(ctx: DiscoveryContext) {
  const app = new Hono();

  /**
   * Discover models for a specific provider using intelligent fallback
   * Chain: API -> OpenRouter -> Web Search -> Hardcoded
   */
  app.get('/api/discover/:providerId', async (c) => {
    const providerId = c.req.param('providerId');
    const apiKey = await ctx.getApiKey(providerId);

    try {
      // Use intelligent fallback discovery (works even without API key)
      const models = await modelDiscovery.discoverWithFallback(providerId, apiKey);

      // Cache the result
      modelDiscovery.setCached(providerId, models);

      return c.json({
        providerId,
        models,
        count: models.length,
        source: models[0]?.source || 'unknown',
        hasApiKey: !!apiKey,
      });
    } catch (error) {
      return c.json({
        error: error instanceof Error ? error.message : 'Failed to discover models',
        models: [],
      }, 500);
    }
  });

  /**
   * Discover models using web search only (no API key required)
   */
  app.get('/api/discover/:providerId/web', async (c) => {
    const providerId = c.req.param('providerId');

    try {
      const models = await modelDiscovery.discoverFromWebSearch(providerId);

      return c.json({
        providerId,
        models,
        count: models.length,
        source: 'web-search',
      });
    } catch (error) {
      return c.json({
        error: error instanceof Error ? error.message : 'Web search discovery failed',
        models: [],
      }, 500);
    }
  });

  /**
   * Get cached discovery results for a provider
   */
  app.get('/api/discover/:providerId/cached', (c) => {
    const providerId = c.req.param('providerId');
    const cached = modelDiscovery.getCached(providerId);

    if (!cached) {
      return c.json({ models: [], cached: false });
    }

    return c.json({
      ...cached,
      cached: true,
    });
  });

  /**
   * Refresh models for a provider using web search
   * This is the endpoint for the UI's refresh button
   * Results are cached until the next refresh
   */
  app.post('/api/discover/:providerId/refresh', async (c) => {
    const providerId = c.req.param('providerId');
    const apiKey = await ctx.getApiKey(providerId);

    try {
      let models: DiscoveredModel[];
      let source: string;

      // If we have an API key, try API first
      if (apiKey) {
        try {
          models = await modelDiscovery.discoverFromAPI(providerId, apiKey);
          source = 'api';
        } catch {
          // Fall back to web search
          models = await modelDiscovery.refreshFromWebSearch(providerId);
          source = 'web-search';
        }
      } else {
        // No API key, use web search
        models = await modelDiscovery.refreshFromWebSearch(providerId);
        source = 'web-search';
      }

      if (models.length > 0) {
        // Update the registry with refreshed models
        const modelConfigs = models.map(m => modelDiscovery.toModelConfig(m, true));
        (ctx.registry as any).updateModels(providerId, modelConfigs);

        // Cache the result
        modelDiscovery.setCached(providerId, models);
      }

      return c.json({
        providerId,
        models,
        count: models.length,
        source,
        refreshedAt: new Date().toISOString(),
      });
    } catch (error) {
      return c.json({
        error: error instanceof Error ? error.message : 'Refresh failed',
        models: [],
      }, 500);
    }
  });

  /**
   * Fetch all models from OpenRouter (comprehensive pricing data)
   */
  app.post('/api/discover/openrouter/refresh', async (c) => {
    try {
      const models = await modelDiscovery.fetchFromOpenRouter();

      return c.json({
        count: models.length,
        providers: [...new Set(models.map(m => m.id.split('/')[0]))].length,
        lastUpdated: new Date().toISOString(),
      });
    } catch (error) {
      return c.json({
        error: error instanceof Error ? error.message : 'Failed to fetch from OpenRouter',
      }, 500);
    }
  });

  /**
   * Get OpenRouter models filtered by provider
   */
  app.get('/api/discover/openrouter/:providerId', (c) => {
    const providerId = c.req.param('providerId');
    const models = modelDiscovery.getOpenRouterModelsForProvider(providerId);

    return c.json({
      providerId,
      models,
      count: models.length,
      source: 'openrouter',
    });
  });

  /**
   * Discover all available models across all providers using intelligent fallback
   */
  app.get('/api/discover/all', async (c) => {
    const providers = ctx.registry.list();
    const results: Record<string, { models: DiscoveredModel[]; source: string }> = {};

    // First fetch from OpenRouter for pricing reference
    try {
      await modelDiscovery.fetchFromOpenRouter();
    } catch {
      // Continue without OpenRouter data
    }

    // Use intelligent fallback for each provider
    for (const provider of providers) {
      const apiKey = await ctx.getApiKey(provider.id);

      try {
        const models = await modelDiscovery.discoverWithFallback(provider.id, apiKey);
        results[provider.id] = {
          models,
          source: models[0]?.source || 'unknown',
        };
      } catch {
        results[provider.id] = { models: [], source: 'error' };
      }
    }

    return c.json({
      providers: Object.keys(results).length,
      totalModels: Object.values(results).reduce((sum, r) => sum + r.models.length, 0),
      results,
    });
  });

  /**
   * Enable/disable a model in the registry
   */
  app.post('/api/models/:providerId/:modelId/toggle', async (c) => {
    const providerId = c.req.param('providerId');
    const modelId = c.req.param('modelId');
    const body = await c.req.json() as { enabled: boolean };

    const success = (ctx.registry as any).setModelEnabled(providerId, modelId, body.enabled);

    if (!success) {
      return c.json({ error: 'Model or provider not found' }, 404);
    }

    return c.json({
      providerId,
      modelId,
      enabled: body.enabled,
    });
  });

  /**
   * Add discovered models to a provider
   */
  app.post('/api/models/:providerId/add', async (c) => {
    const providerId = c.req.param('providerId');
    const body = await c.req.json() as { models: DiscoveredModel[] };

    // Convert discovered models to ModelConfig
    const modelConfigs: ModelConfig[] = body.models.map(m =>
      modelDiscovery.toModelConfig(m, false)
    );

    (ctx.registry as any).addModels(providerId, modelConfigs);

    return c.json({
      providerId,
      added: modelConfigs.length,
    });
  });

  /**
   * Get full model list with all details (for UI)
   * Only returns models from providers with API keys configured
   */
  app.get('/api/models/full', (c) => {
    const models = ctx.registry.listModels();

    return c.json({
      models: models.map(({ model, provider }) => ({
        id: model.id,
        alias: model.alias,
        providerId: provider.id,
        providerName: provider.name,
        contextWindow: model.contextWindow,
        maxOutputTokens: model.maxOutputTokens,
        inputPricePer1M: model.inputPricePer1M,
        outputPricePer1M: model.outputPricePer1M,
        capabilities: model.capabilities,
        enabled: model.enabled,
      })),
    });
  });

  /**
   * Get list of configured providers (those with API keys)
   * Only enabled providers are returned - providers without API keys are hidden
   */
  app.get('/api/providers', (c) => {
    // registry.list() already filters to only enabled providers
    const providers = ctx.registry.list();

    return c.json({
      providers: providers.map(provider => {
        const cached = modelDiscovery.getCached(provider.id);
        return {
          id: provider.id,
          name: provider.name,
          enabled: provider.enabled,
          modelCount: provider.models.filter(m => m.enabled).length,
          lastRefreshed: cached?.lastUpdated || null,
          source: cached?.source || 'api',
        };
      }),
      count: providers.length,
    });
  });

  /**
   * Get all providers including unconfigured ones (for settings page)
   */
  app.get('/api/providers/all', async (c) => {
    const allProviders = ctx.registry.list();
    const providers = [];

    for (const provider of allProviders) {
      const apiKey = await ctx.getApiKey(provider.id);
      const cached = modelDiscovery.getCached(provider.id);
      providers.push({
        id: provider.id,
        name: provider.name,
        enabled: provider.enabled,
        configured: !!apiKey,
        modelCount: provider.models.filter(m => m.enabled).length,
        lastRefreshed: cached?.lastUpdated || null,
        source: cached?.source || (apiKey ? 'api' : 'none'),
      });
    }

    return c.json({
      providers,
      configured: providers.filter(p => p.configured).length,
      total: providers.length,
    });
  });

  return app;
}
