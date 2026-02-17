import { Command } from 'commander';
import { loadConfig, defaultRegistry, KeyStore, ProviderKeyManager, pricingFetcher, modelDiscovery } from '@untangle-ai/core';
import { startServer } from '@untangle-ai/server';
import { logger } from '../utils/logger.js';

export const startCommand = new Command('start')
  .description('Start the untangle-ai API gateway server')
  .option('-p, --port <port>', 'Port to listen on', '3000')
  .option('-H, --host <host>', 'Host to bind to', 'localhost')
  .option('-c, --config <path>', 'Path to config file')
  .option('--discover', 'Discover models from provider APIs on startup')
  .action(async (options) => {
    logger.banner();

    try {
      // Load config
      logger.info('Loading configuration...');
      const config = loadConfig(options.config);

      // Override with CLI options
      if (options.port) {
        config.server.port = parseInt(options.port, 10);
      }
      if (options.host) {
        config.server.host = options.host;
      }

      // Build API key getter from config, stored keys, and environment
      const keyStore = new KeyStore();
      let keyManager: ProviderKeyManager | null = null;

      try {
        await keyStore.initialize(process.env.UNTANGLE_MASTER_PASSWORD || 'untangle-ai-default');
        keyManager = new ProviderKeyManager(keyStore);
      } catch {
        // Encryption not available, continue without stored keys
      }

      const getApiKey = async (providerId: string): Promise<string | undefined> => {
        // 1. Check config first
        const providerConfig = config.providers[providerId];
        if (providerConfig?.apiKey) {
          return providerConfig.apiKey;
        }

        // 2. Check stored encrypted keys
        if (keyManager) {
          const storedKey = await keyManager.getKey(providerId);
          if (storedKey) return storedKey;
        }

        // 3. Fall back to environment variable
        const envKey = `${providerId.toUpperCase()}_API_KEY`;
        return process.env[envKey];
      };

      // Fetch dynamic models from provider APIs
      logger.info('Discovering models from configured providers...');

      // First fetch from OpenRouter (comprehensive pricing data for fallback)
      try {
        const orModels = await modelDiscovery.fetchFromOpenRouter();
        logger.dim(`  OpenRouter: Loaded ${orModels.length} models (pricing reference)`);
      } catch {
        logger.dim('  OpenRouter: Could not fetch (will use hardcoded data)');
      }

      // Only discover models for providers WITH API keys configured
      // Providers without keys are DISABLED and will NOT show in the UI
      const allProviders = defaultRegistry.list();
      const configuredProviders: string[] = [];

      for (const provider of allProviders) {
        const apiKey = await getApiKey(provider.id);
        if (apiKey) {
          // Provider has API key - enable it and discover models
          try {
            const discoveredModels = await modelDiscovery.discoverWithFallback(provider.id, apiKey);
            if (discoveredModels.length > 0) {
              const modelConfigs = discoveredModels.map(m => modelDiscovery.toModelConfig(m, true));
              (defaultRegistry as any).updateModels(provider.id, modelConfigs);
              const source = discoveredModels[0]?.source || 'unknown';
              logger.success(`  ${provider.name}: ${discoveredModels.length} models (source: ${source})`);
              configuredProviders.push(provider.name);
            }
          } catch (err) {
            logger.warn(`  ${provider.name}: Discovery failed, using defaults`);
            configuredProviders.push(provider.name);
          }
        } else {
          // No API key - DISABLE the provider completely
          (defaultRegistry as any).setProviderEnabled(provider.id, false);
        }
      }

      // Update pricing cache
      try {
        await pricingFetcher.refreshAllPricing();
        const status = pricingFetcher.getCacheStatus();
        logger.success(`  Pricing cache: ${status.size} models`);
      } catch {
        logger.warn('  Could not update pricing cache');
      }

      const setApiKey = keyManager
        ? async (providerId: string, apiKey: string): Promise<void> => {
            await keyManager.addKey(providerId, apiKey);
          }
        : undefined;

      const removeApiKey = keyManager
        ? async (providerId: string): Promise<void> => {
            keyManager.removeKey(providerId);
          }
        : undefined;

      // Log configured providers
      if (configuredProviders.length > 0) {
        logger.info(`Configured providers: ${configuredProviders.join(', ')}`);
      } else {
        logger.warn('No providers configured. Set API keys to enable providers.');
        logger.dim('  Example: OPENAI_API_KEY=sk-xxx or ANTHROPIC_API_KEY=sk-ant-xxx');
      }

      const models = defaultRegistry.listModels();
      logger.dim(`  ${models.length} models available`);

      // Start server
      startServer({
        registry: defaultRegistry,
        config,
        getApiKey,
        setApiKey,
        removeApiKey,
        enableUi: true,
      });

      logger.success(`Server running at http://${config.server.host}:${config.server.port}`);
      logger.dim('Press Ctrl+C to stop');

    } catch (err) {
      logger.error(`Failed to start: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });
