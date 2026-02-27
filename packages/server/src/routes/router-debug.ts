import { Hono } from 'hono';
import type {
  ProviderRegistry,
  DeploymentRouter,
} from '@untangle-ai/core';

interface RouterDebugContext {
  registry: ProviderRegistry;
  router: DeploymentRouter;
}

export function createRouterDebugRoutes(ctx: RouterDebugContext) {
  const app = new Hono();

  app.get('/api/router/health', (c) => {
    return c.json({
      status: 'ok',
      ...ctx.router.getHealthSnapshot(),
    });
  });

  app.get('/api/router/decisions/:modelAlias', (c) => {
    const modelAlias = c.req.param('modelAlias');
    const snapshot = ctx.router.getSelectionDebug(modelAlias, ctx.registry);
    return c.json(snapshot);
  });

  return app;
}
