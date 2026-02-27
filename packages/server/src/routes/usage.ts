import { Hono } from 'hono';
import { usageTracker, pricingFetcher, type ControlPlaneService, type ApiCompatibilityConfig } from '@untangle-ai/core';
import { findUnknownFields, resolveApiCompatibility } from './compatibility.js';

interface UsageRoutesContext {
  controlPlane?: ControlPlaneService;
  apiCompatibility?: ApiCompatibilityConfig;
}

export function createUsageRoutes(ctx: UsageRoutesContext = {}) {
  const app = new Hono();
  const compatibility = resolveApiCompatibility(ctx.apiCompatibility);

  // Get usage summary
  app.get('/api/usage', async (c) => {
    const period = c.req.query('period') || 'today';

    let summary;
    switch (period) {
      case 'hour':
        if (ctx.controlPlane) {
          summary = await ctx.controlPlane.getUsageSummary({
            startDate: new Date(Date.now() - (60 * 60 * 1000)),
          });
        } else {
          summary = usageTracker.getRecentUsage(60);
        }
        break;
      case 'day':
      case 'today':
        if (ctx.controlPlane) {
          const dayStart = new Date();
          dayStart.setHours(0, 0, 0, 0);
          summary = await ctx.controlPlane.getUsageSummary({ startDate: dayStart });
        } else {
          summary = usageTracker.getTodayUsage();
        }
        break;
      case 'all':
        summary = ctx.controlPlane
          ? await ctx.controlPlane.getUsageSummary()
          : usageTracker.getSummary();
        break;
      default:
        // Parse as minutes
        const minutes = parseInt(period, 10);
        if (!isNaN(minutes)) {
          if (ctx.controlPlane) {
            summary = await ctx.controlPlane.getUsageSummary({
              startDate: new Date(Date.now() - (minutes * 60 * 1000)),
            });
          } else {
            summary = usageTracker.getRecentUsage(minutes);
          }
        } else {
          if (ctx.controlPlane) {
            const dayStart = new Date();
            dayStart.setHours(0, 0, 0, 0);
            summary = await ctx.controlPlane.getUsageSummary({ startDate: dayStart });
          } else {
            summary = usageTracker.getTodayUsage();
          }
        }
    }

    return c.json(summary);
  });

  app.get('/api/usage/reconciliation', async (c) => {
    if (!ctx.controlPlane) {
      return c.json({
        error: 'Billing reconciliation requires control-plane persistence.',
        code: 'control_plane_required',
      }, 501);
    }

    const toleranceRaw = c.req.query('toleranceUsd');
    const parsedTolerance = toleranceRaw === undefined ? undefined : Number(toleranceRaw);
    if (toleranceRaw !== undefined && !Number.isFinite(parsedTolerance)) {
      return c.json({
        error: 'toleranceUsd must be a finite number when provided',
        code: 'invalid_query',
      }, 400);
    }

    const summary = await ctx.controlPlane.getBillingReconciliation({
      toleranceUsd: parsedTolerance,
    });
    return c.json(summary);
  });

  // Get recent usage records
  app.get('/api/usage/records', async (c) => {
    const rawLimit = parseInt(c.req.query('limit') || '100', 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 1000) : 100;
    const providerId = c.req.query('provider');
    const modelId = c.req.query('model');

    const records = ctx.controlPlane
      ? await ctx.controlPlane.listUsageEvents({
          providerId: providerId || undefined,
          modelId: modelId || undefined,
        }, limit)
      : usageTracker.getRecords({
          limit,
          providerId: providerId || undefined,
          modelId: modelId || undefined,
        });

    return c.json({ records });
  });

  // Get pricing information
  app.get('/api/pricing', (c) => {
    const pricing = pricingFetcher.getAllPricing();
    return c.json({ pricing });
  });

  // Get pricing for specific model
  app.get('/api/pricing/:provider/:model', (c) => {
    const provider = c.req.param('provider');
    const model = c.req.param('model');
    const pricing = pricingFetcher.getPricing(provider, model);

    if (!pricing) {
      return c.json({ error: 'Pricing not found' }, 404);
    }

    return c.json(pricing);
  });

  // Refresh pricing from providers
  app.post('/api/pricing/refresh', async (c) => {
    try {
      await pricingFetcher.refreshAllPricing();
      const pricing = pricingFetcher.getAllPricing();
      return c.json({ message: 'Pricing refreshed', pricing });
    } catch (error) {
      return c.json(
        { error: error instanceof Error ? error.message : 'Failed to refresh pricing' },
        500
      );
    }
  });

  // Calculate cost estimate
  app.post('/api/pricing/calculate', async (c) => {
    const body = await c.req.json().catch(() => null) as {
      provider: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
    } | null;
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const unknownFields = findUnknownFields(
        body as Record<string, unknown>,
        new Set(['provider', 'model', 'inputTokens', 'outputTokens']),
        compatibility,
      );
      if (unknownFields.length > 0) {
        return c.json(
          { error: `Unknown request fields: ${unknownFields.join(', ')}`, code: 'unknown_fields' },
          400
        );
      }
    }
    if (
      !body ||
      typeof body.provider !== 'string' ||
      typeof body.model !== 'string' ||
      typeof body.inputTokens !== 'number' ||
      typeof body.outputTokens !== 'number' ||
      body.inputTokens < 0 ||
      body.outputTokens < 0
    ) {
      return c.json(
        { error: 'Expected { provider: string, model: string, inputTokens: number, outputTokens: number }' },
        400
      );
    }

    const cost = pricingFetcher.calculateCost(
      body.provider,
      body.model,
      body.inputTokens,
      body.outputTokens
    );

    if (!cost) {
      return c.json({ error: 'Pricing not available for this model' }, 404);
    }

    return c.json(cost);
  });

  // Clear usage records
  app.delete('/api/usage', (c) => {
    usageTracker.clearRecords();
    if (ctx.controlPlane) {
      void ctx.controlPlane.clearUsageEvents();
    }
    return c.json({ message: 'Usage records cleared' });
  });

  // Export usage records
  app.get('/api/usage/export', (c) => {
    const json = usageTracker.exportRecords();
    return c.text(json, 200, {
      'Content-Type': 'application/json',
      'Content-Disposition': 'attachment; filename="usage-export.json"',
    });
  });

  return app;
}
