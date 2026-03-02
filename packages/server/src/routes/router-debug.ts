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
    const clientRegion = c.req.query('clientRegion')?.trim() || undefined;
    const rolloutKey = c.req.query('rolloutKey')?.trim() || undefined;
    const allowCrossRegionFallbackQuery = c.req.query('allowCrossRegionFallback');
    const allowCrossRegionFallback = allowCrossRegionFallbackQuery === undefined
      ? undefined
      : allowCrossRegionFallbackQuery.toLowerCase() !== 'false';
    const snapshot = ctx.router.getSelectionDebug(modelAlias, ctx.registry, {
      clientRegion,
      rolloutKey,
      allowCrossRegionFallback,
    });
    return c.json(snapshot);
  });

  app.get('/api/router/regions', (c) => {
    return c.json({
      regions: ctx.router.listRegionEjections(),
    });
  });

  app.post('/api/router/regions/:region/eject', async (c) => {
    const region = c.req.param('region')?.trim() ?? '';
    if (region.length === 0) {
      return c.json({
        error: { message: 'Region is required', code: 'invalid_region' },
      }, 400);
    }

    const body = await c.req.json().catch(() => null) as {
      ttlMs?: number;
      reason?: string;
      forced?: boolean;
    } | null;
    if (body && typeof body !== 'object') {
      return c.json({
        error: { message: 'Invalid request body', code: 'invalid_body' },
      }, 400);
    }

    if (body?.ttlMs !== undefined && (!Number.isFinite(body.ttlMs) || body.ttlMs <= 0)) {
      return c.json({
        error: { message: 'ttlMs must be a positive number when provided', code: 'invalid_body' },
      }, 400);
    }

    const ok = ctx.router.ejectRegion(region, {
      ttlMs: body?.ttlMs,
      reason: body?.reason,
      forced: body?.forced,
    });
    if (!ok) {
      return c.json({
        error: { message: `Invalid region: ${region}`, code: 'invalid_region' },
      }, 400);
    }

    return c.json({
      region,
      ejected: true,
      regions: ctx.router.listRegionEjections(),
    });
  });

  app.post('/api/router/regions/:region/restore', (c) => {
    const region = c.req.param('region')?.trim() ?? '';
    if (region.length === 0) {
      return c.json({
        error: { message: 'Region is required', code: 'invalid_region' },
      }, 400);
    }

    const restored = ctx.router.restoreRegion(region);
    return c.json({
      region,
      restored,
      regions: ctx.router.listRegionEjections(),
    });
  });

  return app;
}
