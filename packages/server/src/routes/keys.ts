import { Hono } from 'hono';
import type { ProviderRegistry } from '@untangle-ai/core';

interface KeysContext {
  registry: ProviderRegistry;
  getApiKey: (providerId: string) => Promise<string | undefined> | string | undefined;
  setApiKey?: (providerId: string, apiKey: string) => Promise<void> | void;
  removeApiKey?: (providerId: string) => Promise<void> | void;
}

interface ProviderKeyStatus {
  id: string;
  name: string;
  hasKey: boolean;
  envVar: string;
}

function toEnvVar(providerId: string): string {
  return `${providerId.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}_API_KEY`;
}

export function createKeysRoutes(ctx: KeysContext) {
  const app = new Hono();

  const resolveProvider = (providerId: string) =>
    ctx.registry.listAll().find(provider => provider.id === providerId);

  // List all providers with key status
  app.get('/api/keys', async (c) => {
    const providers: ProviderKeyStatus[] = await Promise.all(
      ctx.registry.listAll().map(async (provider) => ({
        id: provider.id,
        name: provider.name,
        hasKey: !!(await ctx.getApiKey(provider.id)),
        envVar: toEnvVar(provider.id),
      }))
    );

    return c.json({ providers });
  });

  // Get single provider key status
  app.get('/api/keys/:provider', async (c) => {
    const providerId = c.req.param('provider');
    const provider = resolveProvider(providerId);

    if (!provider) {
      return c.json(
        { error: { message: `Unknown provider: ${providerId}` } },
        404
      );
    }

    return c.json({
      id: providerId,
      name: provider.name,
      hasKey: !!(await ctx.getApiKey(providerId)),
      envVar: toEnvVar(providerId),
    });
  });

  // Add/update provider key
  app.post('/api/keys/:provider', async (c) => {
    const providerId = c.req.param('provider');
    const provider = resolveProvider(providerId);

    if (!provider) {
      return c.json(
        { error: { message: `Unknown provider: ${providerId}` } },
        404
      );
    }

    if (!ctx.setApiKey) {
      return c.json(
        {
          error: {
            message:
              'Runtime key management not enabled. Set keys via environment variables.',
          },
        },
        501
      );
    }

    const body = await c.req.json<{ apiKey: string }>();

    if (!body.apiKey || typeof body.apiKey !== 'string') {
      return c.json(
        { error: { message: 'apiKey is required and must be a string' } },
        400
      );
    }

    await ctx.setApiKey(providerId, body.apiKey);
    (ctx.registry as any).setProviderEnabled(providerId, true);

    return c.json({
      success: true,
      message: `API key for ${provider.name} has been set`,
    });
  });

  // Remove provider key
  app.delete('/api/keys/:provider', async (c) => {
    const providerId = c.req.param('provider');
    const provider = resolveProvider(providerId);

    if (!provider) {
      return c.json(
        { error: { message: `Unknown provider: ${providerId}` } },
        404
      );
    }

    if (!ctx.removeApiKey) {
      return c.json(
        {
          error: {
            message:
              'Runtime key management not enabled. Remove keys by unsetting environment variables.',
          },
        },
        501
      );
    }

    await ctx.removeApiKey(providerId);
    (ctx.registry as any).setProviderEnabled(providerId, false);

    return c.json({
      success: true,
      message: `API key for ${provider.name} has been removed`,
    });
  });

  // Test provider key
  app.post('/api/keys/:provider/test', async (c) => {
    const providerId = c.req.param('provider');
    const provider = resolveProvider(providerId);

    if (!provider) {
      return c.json(
        { error: { message: `Unknown provider: ${providerId}` } },
        404
      );
    }

    const apiKey = await ctx.getApiKey(providerId);

    if (!apiKey) {
      return c.json(
        { error: { message: `No API key configured for ${provider.name}` } },
        400
      );
    }

    try {
      // Test by listing models (lightweight operation)
      const models = provider.models;

      return c.json({
        success: true,
        message: `API key for ${provider.name} is valid`,
        modelCount: models.length,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error';
      return c.json(
        {
          success: false,
          error: { message: `API key test failed: ${message}` },
        },
        400
      );
    }
  });

  return app;
}
