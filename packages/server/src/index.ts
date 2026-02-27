import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { cors } from 'hono/cors';
import { readFileSync, existsSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  ControlPlaneService,
  DeploymentRouter,
  type ProviderRegistry,
  type Config,
} from '@untangle-ai/core';
import { createChatRoutes } from './routes/chat.js';
import { createEmbeddingsRoutes } from './routes/embeddings.js';
import { createModelsRoutes } from './routes/models.js';
import { createResponsesRoutes } from './routes/responses.js';
import { createMediaRoutes } from './routes/media.js';
import { createRouterDebugRoutes } from './routes/router-debug.js';
import { createControlPlaneRoutes } from './routes/control-plane.js';
import { createKeysRoutes } from './routes/keys.js';
import { createUsageRoutes } from './routes/usage.js';
import { createDiscoveryRoutes } from './routes/discovery.js';
import { loggingMiddleware } from './middleware/logging.js';
import { observabilityMetrics } from './observability/metrics.js';
import { setObservabilitySettings } from './observability/settings.js';

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
  controlPlane?: ControlPlaneService;
  enableUi?: boolean;
}

export function createApp(options: ServerOptions) {
  const { registry, getApiKey, setApiKey, removeApiKey, enableUi } = options;
  setObservabilitySettings(options.config.observability);
  const router = new DeploymentRouter(options.config.routing);
  const controlPlane = options.controlPlane
    ?? (options.config.controlPlane.enabled ? new ControlPlaneService() : undefined);
  const virtualKeyHeader = options.config.controlPlane.virtualKeyHeader;
  const apiCompatibility = options.config.api?.compatibility;

  const app = new Hono();

  // Middleware
  app.use('*', cors());
  app.use('*', loggingMiddleware());

  // Health check
  app.get('/health', (c) => c.json({ status: 'ok' }));
  app.get('/metrics', (c) => c.text(observabilityMetrics.renderPrometheus(), 200, {
    'Content-Type': 'text/plain; version=0.0.4; charset=utf-8',
  }));
  app.get('/api/settings', (c) => c.json({
    server: {
      host: options.config.server.host,
      port: options.config.server.port,
    },
    observability: {
      level: options.config.observability?.logging.level ?? 'info',
      tracingEnabled: options.config.observability?.tracing.enabled ?? true,
    },
    ui: {
      enabled: !!enableUi,
    },
  }));

  // Mount routes
  app.route('/', createChatRoutes({ registry, getApiKey, router, controlPlane, virtualKeyHeader, apiCompatibility }));
  app.route('/', createEmbeddingsRoutes({ registry, getApiKey, router, controlPlane, virtualKeyHeader, apiCompatibility }));
  app.route('/', createResponsesRoutes({ registry, getApiKey, router, controlPlane, virtualKeyHeader, apiCompatibility }));
  app.route('/', createMediaRoutes({ registry, getApiKey, router, controlPlane, virtualKeyHeader, apiCompatibility }));
  app.route('/', createRouterDebugRoutes({ registry, router }));
  if (controlPlane) {
    app.route('/', createControlPlaneRoutes({ controlPlane, apiCompatibility }));
  }
  app.route('/', createModelsRoutes({ registry }));
  app.route('/', createKeysRoutes({ registry, getApiKey, setApiKey, removeApiKey, apiCompatibility }));
  app.route('/', createUsageRoutes({ controlPlane, apiCompatibility }));
  app.route('/', createDiscoveryRoutes({
    registry,
    getApiKey: async (id) => getApiKey(id),
    apiCompatibility,
  }));

  // UI serving
  if (enableUi) {
    const uiPath = findUiDistPath();
    if (uiPath) {
      // Serve static files
      app.get('/assets/*', async (c) => {
        const assetsRoot = resolve(uiPath, 'assets');
        const relativePath = c.req.path.replace(/^\/assets\//, '');
        const filePath = resolve(assetsRoot, relativePath);
        if (!filePath.startsWith(assetsRoot)) {
          return c.notFound();
        }

        if (existsSync(filePath)) {
          const content = readFileSync(filePath);
          const ext = filePath.split('.').pop()?.toLowerCase();
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
export { createEmbeddingsRoutes } from './routes/embeddings.js';
export { createModelsRoutes } from './routes/models.js';
export { createResponsesRoutes } from './routes/responses.js';
export { createMediaRoutes } from './routes/media.js';
export { createRouterDebugRoutes } from './routes/router-debug.js';
export { createControlPlaneRoutes } from './routes/control-plane.js';
export { createKeysRoutes } from './routes/keys.js';
export { createUsageRoutes } from './routes/usage.js';
export { createDiscoveryRoutes } from './routes/discovery.js';
export { loggingMiddleware } from './middleware/logging.js';
export { observabilityMetrics } from './observability/metrics.js';
