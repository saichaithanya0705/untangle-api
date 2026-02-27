import { Hono } from 'hono';
import type {
  ControlPlaneService,
  ApiCompatibilityConfig,
  ProviderBillingExportRecord,
  ProviderBillingReconciliationSummary,
} from '@untangle-ai/core';
import { CONTROL_PLANE_POSTGRES_SCHEMA } from '@untangle-ai/core';
import { findUnknownFields, resolveApiCompatibility } from './compatibility.js';

interface ControlPlaneContext {
  controlPlane: ControlPlaneService;
  apiCompatibility?: ApiCompatibilityConfig;
}

function reconcileProviderExportFromUsageEvents(input: {
  providerId: string;
  toleranceUsd?: number;
  records: ProviderBillingExportRecord[];
  usageEvents: Array<{ providerId: string; modelId?: string; totalCost: number }>;
}): ProviderBillingReconciliationSummary {
  const providerId = input.providerId.trim();
  const toleranceUsd = Math.max(0, input.toleranceUsd ?? 0.0001);
  const exportRecords = input.records.filter((record) => record.providerId === providerId);

  const usageByModel = new Map<string, number>();
  let usageTotalCostUsd = 0;
  for (const event of input.usageEvents) {
    if (event.providerId !== providerId) continue;
    const modelId = event.modelId?.trim() || 'unknown-model';
    usageTotalCostUsd += event.totalCost;
    usageByModel.set(modelId, (usageByModel.get(modelId) ?? 0) + event.totalCost);
  }

  const exportByModel = new Map<string, number>();
  let billingExportTotalCostUsd = 0;
  for (const record of exportRecords) {
    const modelId = record.modelId?.trim() || 'unknown-model';
    billingExportTotalCostUsd += record.costUsd;
    exportByModel.set(modelId, (exportByModel.get(modelId) ?? 0) + record.costUsd);
  }

  const byModel: ProviderBillingReconciliationSummary['byModel'] = [];
  const modelIds = new Set<string>([
    ...usageByModel.keys(),
    ...exportByModel.keys(),
  ]);
  for (const modelId of Array.from(modelIds).sort((left, right) => left.localeCompare(right))) {
    const usageCostUsd = usageByModel.get(modelId) ?? 0;
    const billingExportCostUsd = exportByModel.get(modelId) ?? 0;
    const deltaUsd = usageCostUsd - billingExportCostUsd;
    byModel.push({
      modelId,
      usageCostUsd,
      billingExportCostUsd,
      deltaUsd,
      withinTolerance: Math.abs(deltaUsd) <= toleranceUsd,
    });
  }

  const deltaUsd = usageTotalCostUsd - billingExportTotalCostUsd;
  const withinTolerance = Math.abs(deltaUsd) <= toleranceUsd
    && byModel.every((entry) => entry.withinTolerance);

  return {
    providerId,
    usageTotalCostUsd,
    billingExportTotalCostUsd,
    deltaUsd,
    toleranceUsd,
    withinTolerance,
    usageEventsCompared: input.usageEvents.length,
    recordsInExport: exportRecords.length,
    byModel,
  };
}

export function createControlPlaneRoutes(ctx: ControlPlaneContext) {
  const app = new Hono();
  const compatibility = resolveApiCompatibility(ctx.apiCompatibility);
  const PROVIDER_EXPORT_RECONCILIATION_ALLOWED_FIELDS = new Set([
    'providerId',
    'toleranceUsd',
    'startDate',
    'endDate',
    'records',
  ]);
  const PROVIDER_EXPORT_RECONCILIATION_RECORD_ALLOWED_FIELDS = new Set([
    'providerId',
    'modelId',
    'costUsd',
    'timestamp',
    'requestCount',
  ]);

  app.get('/api/control-plane/schema/postgres', (c) => {
    return c.text(CONTROL_PLANE_POSTGRES_SCHEMA.sql, 200, {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Migration-Name': CONTROL_PLANE_POSTGRES_SCHEMA.migrationName,
    });
  });

  app.get('/api/control-plane/keys', async (c) => {
    const keys = await ctx.controlPlane.listVirtualKeys();
    return c.json({
      keys: keys.map((key) => ({
        id: key.id,
        name: key.name,
        createdAt: key.createdAt,
        revokedAt: key.revokedAt ?? null,
        limits: key.limits,
        metadata: key.metadata ?? {},
      })),
    });
  });

  app.post('/api/control-plane/keys', async (c) => {
    const body = await c.req.json().catch(() => null) as {
      name?: string;
      key?: string;
      limits?: {
        rpm?: number;
        tpm?: number;
        dailyBudgetUsd?: number;
        monthlyBudgetUsd?: number;
        allowedModels?: string[];
        deniedModels?: string[];
      };
      metadata?: Record<string, string>;
    } | null;

    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const unknownFields = findUnknownFields(
        body as Record<string, unknown>,
        new Set(['name', 'key', 'limits', 'metadata']),
        compatibility,
      );
      if (unknownFields.length > 0) {
        return c.json({
          error: {
            message: `Unknown request fields: ${unknownFields.join(', ')}`,
            code: 'unknown_fields',
          },
        }, 400);
      }
    }

    if (!body || typeof body.name !== 'string' || body.name.length === 0 || typeof body.key !== 'string' || body.key.length === 0) {
      return c.json({
        error: {
          message: 'Expected { name: string, key: string, limits?: object, metadata?: object }',
          code: 'invalid_body',
        },
      }, 400);
    }

    const record = await ctx.controlPlane.createVirtualKey({
      name: body.name,
      rawKey: body.key,
      limits: body.limits,
      metadata: body.metadata,
    });

    return c.json({
      id: record.id,
      name: record.name,
      createdAt: record.createdAt,
      limits: record.limits,
    }, 201);
  });

  app.post('/api/control-plane/keys/:id/revoke', async (c) => {
    const id = c.req.param('id');
    const revoked = await ctx.controlPlane.revokeVirtualKey(id);
    if (!revoked) {
      return c.json({ error: { message: `Virtual key not found or already revoked: ${id}` } }, 404);
    }
    return c.json({ id, revoked: true });
  });

  app.post('/api/control-plane/limits/check', async (c) => {
    const body = await c.req.json().catch(() => null) as {
      key?: string;
      modelId?: string;
      inputTokens?: number;
    } | null;

    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const unknownFields = findUnknownFields(
        body as Record<string, unknown>,
        new Set(['key', 'modelId', 'inputTokens']),
        compatibility,
      );
      if (unknownFields.length > 0) {
        return c.json({
          error: {
            message: `Unknown request fields: ${unknownFields.join(', ')}`,
            code: 'unknown_fields',
          },
        }, 400);
      }
    }

    if (!body || typeof body.key !== 'string' || body.key.length === 0) {
      return c.json({
        error: {
          message: 'Expected { key: string, modelId?: string, inputTokens?: number }',
          code: 'invalid_body',
        },
      }, 400);
    }

    const resolved = await ctx.controlPlane.resolveVirtualKey(body.key);
    if (!resolved) {
      return c.json({
        allowed: false,
        reason: 'invalid_key',
      }, 401);
    }

    const result = await ctx.controlPlane.checkLimits(resolved.key, {
      modelId: body.modelId,
      inputTokens: body.inputTokens,
    });

    return c.json({
      keyId: resolved.key.id,
      ...result,
    });
  });

  app.get('/api/control-plane/usage', async (c) => {
    const period = c.req.query('period') || 'today';
    let filter: { startDate?: Date } = {};

    if (period === 'today' || period === 'day') {
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      filter = { startDate: dayStart };
    } else if (period === 'hour') {
      filter = { startDate: new Date(Date.now() - (60 * 60 * 1000)) };
    }

    const summary = await ctx.controlPlane.getUsageSummary(filter);
    return c.json(summary);
  });

  app.get('/api/control-plane/spend', async (c) => {
    const summary = await ctx.controlPlane.getSpendSummary();
    return c.json(summary);
  });

  app.get('/api/control-plane/reconciliation', async (c) => {
    const toleranceRaw = c.req.query('toleranceUsd');
    const parsedTolerance = toleranceRaw === undefined ? undefined : Number(toleranceRaw);
    if (toleranceRaw !== undefined && !Number.isFinite(parsedTolerance)) {
      return c.json({
        error: {
          message: 'toleranceUsd must be a finite number when provided',
          code: 'invalid_query',
        },
      }, 400);
    }

    const summary = await ctx.controlPlane.getBillingReconciliation({
      toleranceUsd: parsedTolerance,
    });
    return c.json(summary);
  });

  app.post('/api/control-plane/reconciliation/provider-export', async (c) => {
    const body = await c.req.json().catch(() => null) as {
      providerId?: string;
      toleranceUsd?: number;
      startDate?: string;
      endDate?: string;
      records?: Array<{
        providerId?: string;
        modelId?: string;
        costUsd?: number;
        timestamp?: string;
        requestCount?: number;
      }>;
    } | null;

    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const unknownFields = findUnknownFields(
        body as Record<string, unknown>,
        PROVIDER_EXPORT_RECONCILIATION_ALLOWED_FIELDS,
        compatibility,
      );
      if (unknownFields.length > 0) {
        return c.json({
          error: {
            message: `Unknown request fields: ${unknownFields.join(', ')}`,
            code: 'unknown_fields',
          },
        }, 400);
      }
    }

    if (!body || typeof body.providerId !== 'string' || body.providerId.trim().length === 0 || !Array.isArray(body.records)) {
      return c.json({
        error: {
          message: 'Expected { providerId: string, records: ProviderBillingExportRecord[], toleranceUsd?: number, startDate?: string, endDate?: string }',
          code: 'invalid_body',
        },
      }, 400);
    }

    if (body.toleranceUsd !== undefined && (!Number.isFinite(body.toleranceUsd) || body.toleranceUsd < 0)) {
      return c.json({
        error: {
          message: 'toleranceUsd must be a non-negative finite number when provided',
          code: 'invalid_body',
        },
      }, 400);
    }

    const startDate = body.startDate ? new Date(body.startDate) : undefined;
    const endDate = body.endDate ? new Date(body.endDate) : undefined;
    if ((startDate && Number.isNaN(startDate.getTime())) || (endDate && Number.isNaN(endDate.getTime()))) {
      return c.json({
        error: {
          message: 'startDate/endDate must be valid ISO-8601 timestamps when provided',
          code: 'invalid_body',
        },
      }, 400);
    }

    for (const [index, record] of body.records.entries()) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        return c.json({
          error: {
            message: `records[${index}] must be an object`,
            code: 'invalid_body',
          },
        }, 400);
      }
      const unknownRecordFields = findUnknownFields(
        record as Record<string, unknown>,
        PROVIDER_EXPORT_RECONCILIATION_RECORD_ALLOWED_FIELDS,
        compatibility,
      );
      if (unknownRecordFields.length > 0) {
        return c.json({
          error: {
            message: `Unknown fields in records[${index}]: ${unknownRecordFields.join(', ')}`,
            code: 'unknown_fields',
          },
        }, 400);
      }
      if (!Number.isFinite(record.costUsd) || Number(record.costUsd) < 0) {
        return c.json({
          error: {
            message: `records[${index}].costUsd must be a non-negative finite number`,
            code: 'invalid_body',
          },
        }, 400);
      }
      if (record.requestCount !== undefined && (!Number.isFinite(record.requestCount) || Number(record.requestCount) < 0)) {
        return c.json({
          error: {
            message: `records[${index}].requestCount must be a non-negative finite number`,
            code: 'invalid_body',
          },
        }, 400);
      }
      if (record.timestamp !== undefined) {
        const timestamp = new Date(record.timestamp);
        if (Number.isNaN(timestamp.getTime())) {
          return c.json({
            error: {
              message: `records[${index}].timestamp must be a valid ISO-8601 timestamp`,
              code: 'invalid_body',
            },
          }, 400);
        }
      }
    }

    const providerId = body.providerId.trim();
    const reconciliationInput = {
      providerId,
      toleranceUsd: body.toleranceUsd,
      startDate,
      endDate,
      records: body.records.map((record) => ({
        providerId: (record.providerId?.trim() || providerId),
        modelId: record.modelId?.trim(),
        costUsd: Number(record.costUsd),
        timestamp: record.timestamp,
        requestCount: record.requestCount !== undefined ? Number(record.requestCount) : undefined,
      })),
    };

    const reconcileProviderBillingExport = (
      ctx.controlPlane as unknown as {
        reconcileProviderBillingExport?: (input: {
          providerId: string;
          toleranceUsd?: number;
          startDate?: Date;
          endDate?: Date;
          records: ProviderBillingExportRecord[];
        }) => Promise<ProviderBillingReconciliationSummary>;
      }
    ).reconcileProviderBillingExport;

    let summary: ProviderBillingReconciliationSummary;
    if (typeof reconcileProviderBillingExport === 'function') {
      summary = await reconcileProviderBillingExport.call(ctx.controlPlane, reconciliationInput);
    } else {
      const usageEvents = await ctx.controlPlane.listUsageEvents({
        providerId: reconciliationInput.providerId,
        startDate: reconciliationInput.startDate,
        endDate: reconciliationInput.endDate,
      }, Number.MAX_SAFE_INTEGER);
      summary = reconcileProviderExportFromUsageEvents({
        providerId: reconciliationInput.providerId,
        toleranceUsd: reconciliationInput.toleranceUsd,
        records: reconciliationInput.records,
        usageEvents,
      });
    }

    return c.json(summary);
  });

  app.get('/api/control-plane/usage/events', async (c) => {
    const rawLimit = Number.parseInt(c.req.query('limit') ?? '100', 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 5000) : 100;
    const events = await ctx.controlPlane.listUsageEvents(undefined, limit);
    return c.json({ events });
  });

  return app;
}
