import { Command } from 'commander';
import { createInterface } from 'readline';
import { KeyStore, ProviderKeyManager, defaultRegistry } from '@untangle-ai/core';
import { logger } from '../utils/logger.js';

const MASTER_PASSWORD = process.env.UNTANGLE_MASTER_PASSWORD || 'untangle-ai-default';

async function prompt(question: string, hidden = false): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    if (hidden) {
      process.stdout.write(question);
      let input = '';
      process.stdin.setRawMode?.(true);
      process.stdin.resume();
      process.stdin.on('data', (char) => {
        const c = char.toString();
        if (c === '\n' || c === '\r') {
          process.stdin.setRawMode?.(false);
          process.stdout.write('\n');
          rl.close();
          resolve(input);
        } else if (c === '\u0003') {
          process.exit();
        } else if (c === '\u007F') {
          input = input.slice(0, -1);
        } else {
          input += c;
          process.stdout.write('*');
        }
      });
    } else {
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    }
  });
}

async function getKeyManager(): Promise<ProviderKeyManager> {
  const keyStore = new KeyStore();
  await keyStore.initialize(MASTER_PASSWORD);
  return new ProviderKeyManager(keyStore);
}

const addCommand = new Command('add')
  .description('Add an API key for a provider')
  .argument('<provider>', 'Provider ID (openai, anthropic, google, groq)')
  .action(async (providerId: string) => {
    // Validate provider exists
    const provider = defaultRegistry.get(providerId);
    if (!provider) {
      const available = defaultRegistry.list().map(p => p.id).join(', ');
      logger.error(`Unknown provider: ${providerId}`);
      logger.dim(`Available providers: ${available}`);
      process.exit(1);
    }

    logger.info(`Adding API key for ${provider.config.name}`);

    const apiKey = await prompt('Enter API key: ', true);
    if (!apiKey.trim()) {
      logger.error('API key cannot be empty');
      process.exit(1);
    }

    try {
      const keyManager = await getKeyManager();
      await keyManager.addKey(providerId, apiKey.trim());
      logger.success(`API key saved for ${provider.config.name}`);
    } catch (err) {
      logger.error(`Failed to save key: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

const listCommand = new Command('list')
  .description('List configured API keys')
  .action(async () => {
    try {
      const keyManager = await getKeyManager();
      const stored = keyManager.listProviders();
      const providers = defaultRegistry.list();

      logger.info('API Key Status:\n');

      for (const provider of providers) {
        const entry = stored.find(s => s.providerId === provider.id);
        if (entry) {
          logger.success(`  ${provider.name}: Configured (added ${new Date(entry.addedAt).toLocaleDateString()})`);
        } else {
          logger.dim(`  ${provider.name}: Not configured`);
        }
      }
    } catch (err) {
      logger.error(`Failed to list keys: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

const removeCommand = new Command('remove')
  .description('Remove an API key')
  .argument('<provider>', 'Provider ID')
  .action(async (providerId: string) => {
    try {
      const keyManager = await getKeyManager();

      if (!keyManager.hasKey(providerId)) {
        logger.warn(`No API key stored for ${providerId}`);
        process.exit(1);
      }

      const removed = keyManager.removeKey(providerId);
      if (removed) {
        logger.success(`API key removed for ${providerId}`);
      } else {
        logger.error(`Failed to remove key for ${providerId}`);
      }
    } catch (err) {
      logger.error(`Failed to remove key: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

const testCommand = new Command('test')
  .description('Test an API key by making a simple request')
  .argument('<provider>', 'Provider ID')
  .action(async (providerId: string) => {
    const provider = defaultRegistry.get(providerId);
    if (!provider) {
      logger.error(`Unknown provider: ${providerId}`);
      process.exit(1);
    }

    try {
      const keyManager = await getKeyManager();
      const apiKey = await keyManager.getKey(providerId);

      if (!apiKey) {
        logger.error(`No API key stored for ${providerId}`);
        logger.dim(`Use 'untangle-ai keys add ${providerId}' to add one`);
        process.exit(1);
      }

      logger.info(`Testing ${provider.config.name} API key...`);

      const url = provider.getEndpointUrl('models');
      const headers = {
        ...provider.getAuthHeaders(apiKey),
        'Content-Type': 'application/json',
      };

      const response = await fetch(url, { method: 'GET', headers });

      if (response.ok) {
        logger.success(`API key for ${provider.config.name} is valid!`);
      } else {
        const error = await response.text();
        logger.error(`API key test failed: ${response.status} ${response.statusText}`);
        logger.dim(error);
        process.exit(1);
      }
    } catch (err) {
      logger.error(`Test failed: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    }
  });

export const keysCommand = new Command('keys')
  .description('Manage API keys for providers')
  .addCommand(addCommand)
  .addCommand(listCommand)
  .addCommand(removeCommand)
  .addCommand(testCommand);
