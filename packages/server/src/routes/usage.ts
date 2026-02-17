import { Hono } from 'hono';
import { usageTracker, pricingFetcher } from '@untangle-ai/core';

export function createUsageRoutes() {
  const app = new Hono();

  // Get usage summary
  app.get('/api/usage', (c) => {
    const period = c.req.query('period') || 'today';

    let summary;
    switch (period) {
      case 'hour':
        summary = usageTracker.getRecentUsage(60);
        break;
      case 'day':
      case 'today':
        summary = usageTracker.getTodayUsage();
        break;
      case 'all':
        summary = usageTracker.getSummary();
        break;
      default:
        // Parse as minutes
        const minutes = parseInt(period, 10);
        if (!isNaN(minutes)) {
          summary = usageTracker.getRecentUsage(minutes);
        } else {
          summary = usageTracker.getTodayUsage();
        }
    }

    return c.json(summary);
  });

  // Get recent usage records
  app.get('/api/usage/records', (c) => {
    const limit = parseInt(c.req.query('limit') || '100', 10);
    const providerId = c.req.query('provider');
    const modelId = c.req.query('model');

    const records = usageTracker.getRecords({
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
    await pricingFetcher.refreshAllPricing();
    const pricing = pricingFetcher.getAllPricing();
    return c.json({ message: 'Pricing refreshed', pricing });
  });

  // Calculate cost estimate
  app.post('/api/pricing/calculate', async (c) => {
    const body = await c.req.json<{
      provider: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
    }>();

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
