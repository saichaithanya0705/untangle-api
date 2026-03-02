import { Hono } from 'hono';
import type { DeploymentRouter, ProviderRegistry } from '@untangle-ai/core';

interface AdminOpsContext {
  registry: ProviderRegistry;
  router: DeploymentRouter;
}

interface AdminIacSpec {
  providers?: Array<{
    id: string;
    enabled?: boolean;
    models?: Array<{
      id: string;
      enabled: boolean;
    }>;
  }>;
  routing?: {
    regions?: Array<{
      region: string;
      ejected: boolean;
      ttlMs?: number;
      reason?: string;
      forced?: boolean;
    }>;
  };
}

interface PlanSummary {
  providerChanges: Array<{ id: string; from: boolean; to: boolean }>;
  modelChanges: Array<{ providerId: string; modelId: string; from: boolean; to: boolean }>;
  regionChanges: Array<{ region: string; fromEjected: boolean; toEjected: boolean }>;
  warnings: string[];
}

function isValidSpec(value: unknown): value is AdminIacSpec {
  return !!value && typeof value === 'object';
}

function getCurrentState(ctx: AdminOpsContext) {
  return {
    providers: ctx.registry.listAll().map((provider) => ({
      id: provider.id,
      enabled: provider.enabled,
      models: provider.models.map((model) => ({
        id: model.id,
        alias: model.alias,
        enabled: model.enabled,
      })),
    })),
    routing: {
      regions: ctx.router.listRegionEjections(),
    },
  };
}

function buildPlan(ctx: AdminOpsContext, spec: AdminIacSpec): PlanSummary {
  const currentProviders = new Map(ctx.registry.listAll().map((provider) => [provider.id, provider]));
  const currentRegions = new Map(ctx.router.listRegionEjections().map((region) => [region.region, region]));

  const providerChanges: PlanSummary['providerChanges'] = [];
  const modelChanges: PlanSummary['modelChanges'] = [];
  const regionChanges: PlanSummary['regionChanges'] = [];
  const warnings: string[] = [];

  for (const desiredProvider of spec.providers ?? []) {
    const currentProvider = currentProviders.get(desiredProvider.id);
    if (!currentProvider) {
      warnings.push(`Unknown provider: ${desiredProvider.id}`);
      continue;
    }

    if (typeof desiredProvider.enabled === 'boolean' && desiredProvider.enabled !== currentProvider.enabled) {
      providerChanges.push({
        id: desiredProvider.id,
        from: currentProvider.enabled,
        to: desiredProvider.enabled,
      });
    }

    for (const desiredModel of desiredProvider.models ?? []) {
      const currentModel = currentProvider.models.find((model) =>
        model.id === desiredModel.id || model.alias === desiredModel.id
      );
      if (!currentModel) {
        warnings.push(`Unknown model "${desiredModel.id}" for provider "${desiredProvider.id}"`);
        continue;
      }
      if (currentModel.enabled !== desiredModel.enabled) {
        modelChanges.push({
          providerId: desiredProvider.id,
          modelId: desiredModel.id,
          from: currentModel.enabled,
          to: desiredModel.enabled,
        });
      }
    }
  }

  for (const desiredRegion of spec.routing?.regions ?? []) {
    const currentRegion = currentRegions.get(desiredRegion.region);
    const fromEjected = currentRegion?.ejected ?? false;
    if (fromEjected !== desiredRegion.ejected) {
      regionChanges.push({
        region: desiredRegion.region,
        fromEjected,
        toEjected: desiredRegion.ejected,
      });
    }
  }

  return {
    providerChanges,
    modelChanges,
    regionChanges,
    warnings,
  };
}

function applyPlan(ctx: AdminOpsContext, spec: AdminIacSpec, plan: PlanSummary): void {
  for (const change of plan.providerChanges) {
    ctx.registry.setProviderEnabled(change.id, change.to);
  }

  for (const change of plan.modelChanges) {
    ctx.registry.setModelEnabled(change.providerId, change.modelId, change.to);
  }

  for (const desiredRegion of spec.routing?.regions ?? []) {
    if (desiredRegion.ejected) {
      ctx.router.ejectRegion(desiredRegion.region, {
        ttlMs: desiredRegion.ttlMs,
        reason: desiredRegion.reason,
        forced: desiredRegion.forced,
      });
    } else {
      ctx.router.restoreRegion(desiredRegion.region);
    }
  }
}

export function createAdminOpsRoutes(ctx: AdminOpsContext) {
  const app = new Hono();

  app.get('/api/admin/iac/export', (c) => {
    return c.json({
      version: 'v1',
      generatedAt: new Date().toISOString(),
      spec: getCurrentState(ctx),
    });
  });

  app.post('/api/admin/iac/plan', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!isValidSpec(body)) {
      return c.json({
        error: {
          message: 'Invalid IaC spec payload',
          code: 'invalid_body',
        },
      }, 400);
    }

    const plan = buildPlan(ctx, body);
    return c.json({
      dryRun: true,
      plan,
    });
  });

  app.post('/api/admin/iac/apply', async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!isValidSpec(body)) {
      return c.json({
        error: {
          message: 'Invalid IaC spec payload',
          code: 'invalid_body',
        },
      }, 400);
    }

    const dryRun = c.req.query('dryRun') === 'true';
    const plan = buildPlan(ctx, body);
    if (!dryRun) {
      applyPlan(ctx, body, plan);
    }

    return c.json({
      applied: !dryRun,
      plan,
      state: getCurrentState(ctx),
    });
  });

  return app;
}
