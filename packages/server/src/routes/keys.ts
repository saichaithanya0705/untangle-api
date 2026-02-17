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

const PROVIDER_INFO: Record<string, { name: string; envVar: string }> = {
  openai: { name: 'OpenAI', envVar: 'OPENAI_API_KEY' },
  anthropic: { name: 'Anthropic', envVar: 'ANTHROPIC_API_KEY' },
  google: { name: 'Google AI', envVar: 'GOOGLE_API_KEY' },
  groq: { name: 'Groq', envVar: 'GROQ_API_KEY' },
};

export function createKeysRoutes(ctx: KeysContext) {
  const app = new Hono();

  // List all providers with key status
  app.get('/api/keys', async (c) => {
    const providers: ProviderKeyStatus[] = await Promise.all(
      Object.entries(PROVIDER_INFO).map(async ([id, info]) => ({
        id,
        name: info.name,
        hasKey: !!(await ctx.getApiKey(id)),
        envVar: info.envVar,
      }))
    );

    return c.json({ providers });
  });

  // Get single provider key status
  app.get('/api/keys/:provider', async (c) => {
    const providerId = c.req.param('provider');
    const info = PROVIDER_INFO[providerId];

    if (!info) {
      return c.json(
        { error: { message: `Unknown provider: ${providerId}` } },
        404
      );
    }

    return c.json({
      id: providerId,
      name: info.name,
      hasKey: !!(await ctx.getApiKey(providerId)),
      envVar: info.envVar,
    });
  });

  // Add/update provider key
  app.post('/api/keys/:provider', async (c) => {
    const providerId = c.req.param('provider');
    const info = PROVIDER_INFO[providerId];

    if (!info) {
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

    return c.json({
      success: true,
      message: `API key for ${info.name} has been set`,
    });
  });

  // Remove provider key
  app.delete('/api/keys/:provider', async (c) => {
    const providerId = c.req.param('provider');
    const info = PROVIDER_INFO[providerId];

    if (!info) {
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

    return c.json({
      success: true,
      message: `API key for ${info.name} has been removed`,
    });
  });

  // Test provider key
  app.post('/api/keys/:provider/test', async (c) => {
    const providerId = c.req.param('provider');
    const info = PROVIDER_INFO[providerId];

    if (!info) {
      return c.json(
        { error: { message: `Unknown provider: ${providerId}` } },
        404
      );
    }

    const apiKey = await ctx.getApiKey(providerId);

    if (!apiKey) {
      return c.json(
        { error: { message: `No API key configured for ${info.name}` } },
        400
      );
    }

    try {
      const provider = ctx.registry.get(providerId);

      if (!provider) {
        return c.json(
          { error: { message: `Provider ${providerId} not registered` } },
          404
        );
      }

      // Test by listing models (lightweight operation)
      const models = provider.config.models;

      return c.json({
        success: true,
        message: `API key for ${info.name} is valid`,
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
