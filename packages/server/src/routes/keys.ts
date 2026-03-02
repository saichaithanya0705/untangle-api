import { Hono } from 'hono';
import type { ProviderRegistry, ApiCompatibilityConfig } from '@untangle-ai/core';
import { findUnknownFields, resolveApiCompatibility } from './compatibility.js';

interface KeysContext {
  registry: ProviderRegistry;
  getApiKey: (providerId: string) => Promise<string | undefined> | string | undefined;
  setApiKey?: (providerId: string, apiKey: string) => Promise<void> | void;
  removeApiKey?: (providerId: string) => Promise<void> | void;
  apiCompatibility?: ApiCompatibilityConfig;
}

interface ProviderKeyStatus {
  id: string;
  name: string;
  hasKey: boolean;
  envVar: string;
}

const ENV_VAR_OVERRIDES: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_API_KEY',
  groq: 'GROQ_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  chatgpt: 'UNTANGLE_CODEX_AUTH_TOKEN',
};

function toEnvVar(providerId: string): string {
  return ENV_VAR_OVERRIDES[providerId]
    ?? `${providerId.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase()}_API_KEY`;
}

export function createKeysRoutes(ctx: KeysContext) {
  const app = new Hono();
  const compatibility = resolveApiCompatibility(ctx.apiCompatibility);

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
    const provider = ctx.registry.get(providerId);

    if (!provider) {
      return c.json(
        { error: { message: `Unknown provider: ${providerId}` } },
        404
      );
    }

    return c.json({
      id: providerId,
      name: provider.config.name,
      hasKey: !!(await ctx.getApiKey(providerId)),
      envVar: toEnvVar(providerId),
    });
  });

  // Add/update provider key
  app.post('/api/keys/:provider', async (c) => {
    const providerId = c.req.param('provider');
    const provider = ctx.registry.get(providerId);

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

    const body = await c.req.json().catch(() => null) as { apiKey?: string } | null;
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const unknownFields = findUnknownFields(
        body as Record<string, unknown>,
        new Set(['apiKey']),
        compatibility,
      );
      if (unknownFields.length > 0) {
        return c.json(
          { error: { message: `Unknown request fields: ${unknownFields.join(', ')}`, code: 'unknown_fields' } },
          400
        );
      }
    }

    if (!body || !body.apiKey || typeof body.apiKey !== 'string') {
      return c.json(
        { error: { message: 'apiKey is required and must be a string', code: 'invalid_body' } },
        400
      );
    }

    await ctx.setApiKey(providerId, body.apiKey);
    ctx.registry.setProviderEnabled(providerId, true);

    return c.json({
      success: true,
      message: `API key for ${provider.config.name} has been set`,
    });
  });

  // Remove provider key
  app.delete('/api/keys/:provider', async (c) => {
    const providerId = c.req.param('provider');
    const provider = ctx.registry.get(providerId);

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

    return c.json({
      success: true,
      message: `API key for ${provider.config.name} has been removed`,
    });
  });

  // Test provider key
  app.post('/api/keys/:provider/test', async (c) => {
    const providerId = c.req.param('provider');
    const provider = ctx.registry.get(providerId);

    if (!provider) {
      return c.json(
        { error: { message: `Unknown provider: ${providerId}` } },
        404
      );
    }

    const apiKey = await ctx.getApiKey(providerId);

    if (!apiKey) {
      return c.json({
        success: false,
        error: { message: `No API key configured for ${provider.config.name}` },
      });
    }

    try {
      const endpoint = provider.getEndpointUrl('models', { apiKey });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          ...provider.getAuthHeaders(apiKey),
        },
        signal: controller.signal,
      }).finally(() => clearTimeout(timeout));

      if (!response.ok) {
        const message = response.status === 401 || response.status === 403
          ? 'Authentication failed with upstream provider. Verify API key format and permissions.'
          : response.status === 429
            ? 'Upstream provider rate-limited the validation request. Try again in a moment.'
            : `Upstream test failed (${response.status}).`;

        return c.json({
          success: false,
          error: { message },
        });
      }

      const payload = await response.json().catch(() => ({})) as {
        data?: unknown[];
        models?: unknown[];
      };
      const modelCount = Array.isArray(payload.data)
        ? payload.data.length
        : Array.isArray(payload.models)
          ? payload.models.length
          : provider.config.models.length;

      return c.json({
        success: true,
        message: `API key for ${provider.config.name} is valid`,
        modelCount,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Unknown error';
      return c.json(
        {
          success: false,
          error: { message: `API key test failed: ${message}` },
        }
      );
    }
  });

  return app;
}
