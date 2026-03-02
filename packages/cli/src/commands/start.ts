import { Command } from 'commander';
import { setDefaultResultOrder } from 'node:dns';
import {
  createDefaultRegistry,
  type Config,
  type CustomProviderConfig,
  type CustomProviderDefinition,
  type ModelCapability,
  type ModelConfig,
  type ProviderRegistry,
  KeyStore,
  ProviderKeyManager,
  loadConfig,
  getChatGPTAuthSession,
  modelDiscovery,
  pricingFetcher,
  usageTracker,
  bootstrapControlPlane,
} from '@untangle-ai/core';
import { startServer } from '@untangle-ai/server';
import { logger } from '../utils/logger.js';
import { resolveMasterPassword } from '../utils/master-password.js';
import { resolveSecretReference } from '../utils/secrets.js';

const ENV_VAR_OVERRIDES: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  chatgpt: 'UNTANGLE_CODEX_AUTH_TOKEN',
};

const KNOWN_CAPABILITIES: ModelCapability[] = ['chat', 'vision', 'tools', 'json_mode'];

function toEnvVar(providerId: string): string {
  return ENV_VAR_OVERRIDES[providerId]
    ?? `${providerId.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}_API_KEY`;
}

function sanitizeCapabilities(capabilities?: string[]): ModelCapability[] {
  if (!capabilities || capabilities.length === 0) return ['chat'];
  const valid = capabilities.filter((cap): cap is ModelCapability =>
    KNOWN_CAPABILITIES.includes(cap as ModelCapability)
  );
  return valid.length > 0 ? valid : ['chat'];
}

function prettifyProviderName(providerId: string): string {
  return providerId
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

function toCustomProviderDefinition(
  providerId: string,
  config: CustomProviderConfig
): CustomProviderDefinition {
  return {
    id: providerId,
    name: prettifyProviderName(providerId),
    baseUrl: config.baseUrl,
    auth: config.auth,
    models: config.models.map((model): ModelConfig => ({
      id: model.id,
      alias: model.alias,
      contextWindow: model.contextWindow ?? 8192,
      maxOutputTokens: model.maxOutputTokens ?? 4096,
      capabilities: sanitizeCapabilities(model.capabilities),
      enabled: model.enabled,
    })),
    endpoints: config.endpoints,
  };
}

function mergeModelOverrides(
  existing: ModelConfig[],
  overrides: Array<{ id: string; alias?: string; enabled: boolean }>
): ModelConfig[] {
  if (overrides.length === 0) return existing;

  const merged = [...existing];
  for (const override of overrides) {
    const idx = merged.findIndex(
      (model) => model.id === override.id || model.alias === override.id
    );
    if (idx >= 0) {
      merged[idx] = {
        ...merged[idx],
        alias: override.alias ?? merged[idx].alias,
        enabled: override.enabled,
      };
      continue;
    }

    merged.push({
      id: override.id,
      alias: override.alias,
      contextWindow: 8192,
      maxOutputTokens: 4096,
      capabilities: ['chat'],
      enabled: override.enabled,
    });
  }

  return merged;
}

function applyProviderOverrides(registry: ProviderRegistry, config: Config): void {
  for (const [providerId, providerConfig] of Object.entries(config.providers)) {
    const provider = registry.get(providerId);
    if (!provider) continue;

    provider.config.enabled = providerConfig.enabled;
    if (providerConfig.baseUrl) {
      provider.config.baseUrl = providerConfig.baseUrl;
    }
    if (providerConfig.models && providerConfig.models.length > 0) {
      provider.config.models = mergeModelOverrides(provider.config.models, providerConfig.models);
    }
  }

  for (const [providerId, providerConfig] of Object.entries(config.customProviders ?? {})) {
    const provider = registry.get(providerId);
    if (!provider) continue;
    provider.config.enabled = providerConfig.enabled;
  }
}

function createRegistryFromConfig(config: Config): ProviderRegistry {
  const customProviders = Object.entries(config.customProviders ?? {}).map(
    ([providerId, providerConfig]) =>
      toCustomProviderDefinition(providerId, providerConfig)
  );

  const registry = createDefaultRegistry(customProviders);
  applyProviderOverrides(registry, config);
  return registry;
}

export const startCommand = new Command('start')
  .description('Start the untangle-ai API gateway server')
  .option('-p, --port <port>', 'Port to listen on')
  .option('-H, --host <host>', 'Host to bind to')
  .option('-c, --config <path>', 'Path to config file')
  .option('--discover', 'Discover models from provider APIs on startup')
  .option('--no-ui', 'Disable the web dashboard UI')
  .action(async (options) => {
    logger.banner();

    try {
      // Prefer IPv4 in environments where IPv6 resolution is unreliable.
      setDefaultResultOrder('ipv4first');

      logger.info('Loading configuration...');
      const config = loadConfig(options.config);
      const secretsConfig = config.secrets ?? {
        enabled: true,
        allowFileRefs: false,
        baseDir: '.',
      };

      if (config.security?.adminApiKeySecretRef && secretsConfig.enabled) {
        const resolvedAdminKey = resolveSecretReference(config.security.adminApiKeySecretRef, {
          allowFileRefs: secretsConfig.allowFileRefs,
          baseDir: secretsConfig.baseDir,
          env: process.env,
        });
        if (resolvedAdminKey) {
          config.security.adminApiKey = resolvedAdminKey;
        }
      }

      if (options.port !== undefined) {
        const parsedPort = Number.parseInt(options.port, 10);
        if (!Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
          logger.error(`Invalid port: ${options.port}`);
          process.exit(1);
        }
        config.server.port = parsedPort;
      }
      if (options.host !== undefined) {
        config.server.host = options.host;
      }

      const requireAdminAuth = config.security?.requireAdminAuthForApi ?? false;
      const adminToken = config.security?.adminApiKey?.trim();
      if (requireAdminAuth && (!adminToken || ['change-me', 'admin-test-token'].includes(adminToken))) {
        logger.error('Admin auth is required but no valid adminApiKey is configured.');
        logger.error('Set security.adminApiKey or security.adminApiKeySecretRef (env:/file:).');
        process.exit(1);
      }

      const requireDataPlaneAuth = config.security?.requireDataPlaneAuth ?? false;
      if (requireDataPlaneAuth && !config.controlPlane.enabled) {
        logger.warn('Data-plane auth requires the control-plane; enabling in-memory control-plane.');
        config.controlPlane.enabled = true;
      }

      const registry = createRegistryFromConfig(config);
      const controlPlaneBootstrap = await bootstrapControlPlane(config.controlPlane);
      for (const message of controlPlaneBootstrap.messages) {
        const prefixed = `  ${message.message}`;
        if (message.level === 'warn') {
          logger.warn(prefixed);
        } else if (message.level === 'success') {
          logger.success(prefixed);
        } else {
          logger.dim(prefixed);
        }
      }
      const controlPlane = controlPlaneBootstrap.service;

      if (controlPlane) {
        usageTracker.addListener((record) => controlPlane.recordUsageFromTracker(record));
        logger.info('Control-plane foundation enabled.');
      }

      const keyStore = new KeyStore();
      const keyCache = new Map<string, string>();
      const unresolvedSecretRefs = new Set<string>();
      let keyManager: ProviderKeyManager | null = null;
      let masterPassword: string | null = null;
      try {
        masterPassword = resolveMasterPassword();
      } catch (error) {
        logger.warn(`Encrypted key storage unavailable: ${error instanceof Error ? error.message : error}`);
      }

      if (masterPassword) {
        try {
          await keyStore.initialize(masterPassword);
          keyManager = new ProviderKeyManager(keyStore);
        } catch {
          logger.warn('Encrypted key storage unavailable; runtime key management disabled.');
        }
      }

      const getApiKey = async (providerId: string): Promise<string | undefined> => {
        const providerConfig = config.providers[providerId];
        if (providerConfig?.apiKey) {
          return providerConfig.apiKey;
        }
        if (secretsConfig.enabled && providerConfig?.apiKeySecretRef) {
          const fromSecretRef = resolveSecretReference(providerConfig.apiKeySecretRef, {
            allowFileRefs: secretsConfig.allowFileRefs,
            baseDir: secretsConfig.baseDir,
            env: process.env,
          });
          if (fromSecretRef) {
            keyCache.set(providerId, fromSecretRef);
            return fromSecretRef;
          }
          if (!unresolvedSecretRefs.has(providerId)) {
            unresolvedSecretRefs.add(providerId);
            logger.warn(
              `Secret reference for provider "${providerId}" could not be resolved: ${providerConfig.apiKeySecretRef}`
            );
          }
        }

        if (keyCache.has(providerId)) {
          return keyCache.get(providerId);
        }

        if (keyManager) {
          const storedKey = await keyManager.getKey(providerId);
          if (storedKey) {
            keyCache.set(providerId, storedKey);
            return storedKey;
          }
        }

        const envVar = toEnvVar(providerId);
        const envValue = process.env[envVar];
        if (envValue) {
          keyCache.set(providerId, envValue);
          return envValue;
        }

        if (providerId === 'chatgpt') {
          const session = getChatGPTAuthSession();
          if (session.token) {
            keyCache.set(providerId, session.token);
            return session.token;
          }
        }

        return undefined;
      };

      if (options.discover) {
        logger.info('Discovering models from providers...');

        try {
          const orModels = await modelDiscovery.fetchFromOpenRouter();
          logger.dim(`  OpenRouter: Loaded ${orModels.length} models (pricing reference)`);
        } catch {
          logger.dim('  OpenRouter: Could not fetch (will use hardcoded data)');
        }

        for (const provider of registry.listAll()) {
          if (!provider.enabled) continue;

          const apiKey = await getApiKey(provider.id);
          const shouldDiscover = !!apiKey || provider.id === 'openrouter';
          if (!shouldDiscover) continue;

          try {
            const discoveredModels = await modelDiscovery.discoverWithFallback(provider.id, apiKey);
            if (discoveredModels.length > 0) {
              const modelConfigs = discoveredModels.map((model) =>
                modelDiscovery.toModelConfig(model, true)
              );
              registry.updateModels(provider.id, modelConfigs);
              const source = discoveredModels[0]?.source ?? 'unknown';
              logger.success(`  ${provider.name}: ${discoveredModels.length} models (source: ${source})`);
            }
          } catch {
            logger.warn(`  ${provider.name}: Discovery failed, using configured/default models`);
          }
        }

        // Re-apply static model enable/alias overrides from configuration.
        applyProviderOverrides(registry, config);

        try {
          await pricingFetcher.refreshAllPricing();
          const status = pricingFetcher.getCacheStatus();
          logger.success(`  Pricing cache: ${status.size} models`);
        } catch {
          logger.warn('  Could not update pricing cache');
        }
      }

      const setApiKey = keyManager
        ? async (providerId: string, apiKey: string): Promise<void> => {
            await keyManager.addKey(providerId, apiKey);
            keyCache.set(providerId, apiKey);
          }
        : undefined;

      const removeApiKey = keyManager
        ? async (providerId: string): Promise<void> => {
            keyManager.removeKey(providerId);
            keyCache.delete(providerId);
          }
        : undefined;

      const configuredProviders: string[] = [];
      for (const provider of registry.listAll()) {
        const key = await getApiKey(provider.id);
        if (key) configuredProviders.push(provider.name);
      }

      if (configuredProviders.length > 0) {
        logger.info(`Configured providers: ${configuredProviders.join(', ')}`);
      } else {
        logger.warn('No providers configured. Set API keys to send requests.');
        logger.dim('  Example: OPENAI_API_KEY=sk-xxx or ANTHROPIC_API_KEY=sk-ant-xxx');
      }

      logger.dim(`  ${registry.listModels().length} enabled models available`);

      startServer({
        registry,
        config,
        getApiKey,
        setApiKey,
        removeApiKey,
        controlPlane,
        enableUi: Boolean(options.ui),
      });

      logger.success(`Server running at http://${config.server.host}:${config.server.port}`);
      if (options.ui) {
        logger.dim('Dashboard: UI enabled');
      } else {
        logger.dim('Dashboard: disabled (use --no-ui to keep it off)');
      }
      logger.dim('Press Ctrl+C to stop');
    } catch (err) {
      logger.error(`Failed to start: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });
