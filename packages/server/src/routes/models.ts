import { Hono } from 'hono';
import type { ProviderRegistry, OpenAIModelInfo } from '@untangle-ai/core';

interface ModelsContext {
  registry: ProviderRegistry;
}

export function createModelsRoutes(ctx: ModelsContext) {
  const app = new Hono();
  const now = () => Math.floor(Date.now() / 1000);

  app.get('/v1/models', (c) => {
    const models = ctx.registry.listModels().map(({ model, provider }): OpenAIModelInfo => ({
      id: model.alias || model.id,
      object: 'model',
      created: now(),
      owned_by: provider.id,
    }));

    return c.json({
      object: 'list',
      data: models,
    });
  });

  app.get('/v1/models/:modelId', (c) => {
    const modelId = c.req.param('modelId');
    const models = ctx.registry.listModels();
    const found = models.find(({ model }) => model.id === modelId || model.alias === modelId);

    if (!found) {
      return c.json({ error: { message: `Model not found: ${modelId}`, type: 'invalid_request_error', code: null } }, 404);
    }

    return c.json({
      id: found.model.alias || found.model.id,
      object: 'model',
      created: now(),
      owned_by: found.provider.id,
    });
  });

  return app;
}
