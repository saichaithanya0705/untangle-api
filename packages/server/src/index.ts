import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { ProviderRegistry, Config } from '@untangle-ai/core';
import { createChatRoutes } from './routes/chat.js';
import { createModelsRoutes } from './routes/models.js';
import { createKeysRoutes } from './routes/keys.js';
import { createUsageRoutes } from './routes/usage.js';
import { createDiscoveryRoutes } from './routes/discovery.js';
import { loggingMiddleware } from './middleware/logging.js';

function findUiDistPath(): string | null {
  const __dirname = dirname(fileURLToPath(import.meta.url));

  const paths = [
    // Development: sibling ui package
    join(__dirname, '../../ui/dist'),
    join(process.cwd(), 'packages/ui/dist'),
    // Published: ui-dist bundled in CLI package
    join(__dirname, '../ui-dist'),
    join(__dirname, '../../ui-dist'),
    join(__dirname, '../../../ui-dist'),
    // npm global install location
    join(__dirname, '../../../../ui-dist'),
  ];

  for (const p of paths) {
    if (existsSync(join(p, 'index.html'))) {
      return p;
    }
  }
  return null;
}

export interface ServerOptions {
  registry: ProviderRegistry;
  config: Config;
  getApiKey: (providerId: string) => Promise<string | undefined> | string | undefined;
  setApiKey?: (providerId: string, apiKey: string) => Promise<void> | void;
  removeApiKey?: (providerId: string) => Promise<void> | void;
  enableUi?: boolean;
}

export function createApp(options: ServerOptions) {
  const { registry, getApiKey, setApiKey, removeApiKey, enableUi } = options;

  const app = new Hono();

  // Middleware
  app.use('*', cors());
  app.use('*', loggingMiddleware());

  // Health check
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // Mount routes
  app.route('/', createChatRoutes({ registry, getApiKey }));
  app.route('/', createModelsRoutes({ registry }));
  app.route('/', createKeysRoutes({ registry, getApiKey, setApiKey, removeApiKey }));
  app.route('/', createUsageRoutes());
  app.route('/', createDiscoveryRoutes({ registry, getApiKey: async (id) => getApiKey(id) }));

  // UI serving
  if (enableUi) {
    const uiPath = findUiDistPath();
    if (uiPath) {
      // Serve static files
      app.get('/assets/*', async (c) => {
        const filePath = join(uiPath, c.req.path);
        if (existsSync(filePath)) {
          const content = readFileSync(filePath);
          const ext = filePath.split('.').pop();
          const types: Record<string, string> = {
            js: 'application/javascript',
            css: 'text/css',
            svg: 'image/svg+xml',
          };
          return c.body(content, 200, { 'Content-Type': types[ext!] || 'application/octet-stream' });
        }
        return c.notFound();
      });

      // Serve index.html for all non-API routes (SPA)
      app.get('*', async (c) => {
        // Skip API routes
        if (c.req.path.startsWith('/v1') || c.req.path.startsWith('/api') || c.req.path === '/health') {
          return c.notFound();
        }
        const indexPath = join(uiPath, 'index.html');
        if (existsSync(indexPath)) {
          const html = readFileSync(indexPath, 'utf-8');
          return c.html(html);
        }
        return c.notFound();
      });

      console.log('Dashboard UI enabled at /');
    } else {
      console.warn('UI dist not found, dashboard disabled');
    }
  }

  return app;
}

export function startServer(options: ServerOptions) {
  const app = createApp(options);
  const { port = 3000, host = 'localhost' } = options.config.server;

  console.log(`Starting untangle-ai server on http://${host}:${port}`);

  serve({
    fetch: app.fetch,
    port,
    hostname: host,
  });

  return app;
}

export { createChatRoutes } from './routes/chat.js';
export { createModelsRoutes } from './routes/models.js';
export { createKeysRoutes } from './routes/keys.js';
export { createUsageRoutes } from './routes/usage.js';
export { createDiscoveryRoutes } from './routes/discovery.js';
export { loggingMiddleware } from './middleware/logging.js';
