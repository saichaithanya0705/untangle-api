import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { usageTracker, type ControlPlaneService, type ProviderRegistry } from '@untangle-ai/core';
import { observabilityMetrics } from '../observability/metrics.js';

interface DashboardShareRoutesContext {
  registry: ProviderRegistry;
  getApiKey: (providerId: string) => Promise<string | undefined> | string | undefined;
  controlPlane?: ControlPlaneService;
}

interface UsageSummary {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  byProvider: Record<string, { requests: number; inputTokens: number; outputTokens: number; cost: number }>;
}

interface SharedDashboardProvider {
  id: string;
  name: string;
  enabled: boolean;
  hasKey: boolean;
  activeModels: number;
  totalModels: number;
}

interface SharedDashboardTopProvider {
  id: string;
  name: string;
  requests: number;
  totalCost: number;
}

interface DashboardShareSnapshot {
  generatedAt: string;
  expiresAt: string;
  summary: {
    serverStatus: 'online';
    totalProviders: number;
    enabledProviders: number;
    totalModels: number;
    activeModels: number;
    keysConfigured: number;
    totalRequests: number;
    successfulRequests: number;
    totalTokens: number;
    totalCost: number;
  };
  providers: SharedDashboardProvider[];
  topProviders: SharedDashboardTopProvider[];
}

interface ShareTokenPayload {
  version: 1;
  expiresAt: number;
  snapshot: DashboardShareSnapshot;
}

const SHARE_TTL_MS = 72 * 60 * 60 * 1000;
const shareSigningSecret = randomBytes(32);

function signPayload(encodedPayload: string): string {
  return createHmac('sha256', shareSigningSecret).update(encodedPayload).digest('base64url');
}

function encodeToken(payload: ShareTokenPayload): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encodedPayload}.${signPayload(encodedPayload)}`;
}

function decodeToken(token: string): ShareTokenPayload | null {
  const [encodedPayload, signature] = token.split('.', 2);
  if (!encodedPayload || !signature) {
    return null;
  }

  const expectedSignature = signPayload(encodedPayload);
  const provided = Buffer.from(signature);
  const expected = Buffer.from(expectedSignature);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf-8')) as ShareTokenPayload;
    if (decoded.version !== 1 || Date.now() >= decoded.expiresAt) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function normalizeUsageSummary(raw: unknown): UsageSummary {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawByProvider = source.byProvider && typeof source.byProvider === 'object'
    ? source.byProvider as Record<string, Record<string, unknown>>
    : {};

  return {
    totalRequests: typeof source.totalRequests === 'number' ? source.totalRequests : 0,
    successfulRequests: typeof source.successfulRequests === 'number' ? source.successfulRequests : 0,
    failedRequests: typeof source.failedRequests === 'number' ? source.failedRequests : 0,
    totalInputTokens: typeof source.totalInputTokens === 'number' ? source.totalInputTokens : 0,
    totalOutputTokens: typeof source.totalOutputTokens === 'number' ? source.totalOutputTokens : 0,
    totalCost: typeof source.totalCost === 'number'
      ? source.totalCost
      : (typeof source.totalCostUsd === 'number' ? source.totalCostUsd : 0),
    byProvider: Object.fromEntries(
      Object.entries(rawByProvider).map(([providerId, value]) => [
        providerId,
        {
          requests: typeof value.requests === 'number' ? value.requests : 0,
          inputTokens: typeof value.inputTokens === 'number' ? value.inputTokens : 0,
          outputTokens: typeof value.outputTokens === 'number' ? value.outputTokens : 0,
          cost: typeof value.cost === 'number'
            ? value.cost
            : (typeof value.costUsd === 'number' ? value.costUsd : 0),
        },
      ]),
    ),
  };
}

async function getTodayUsageSummary(controlPlane?: ControlPlaneService): Promise<UsageSummary> {
  if (!controlPlane) {
    return normalizeUsageSummary(usageTracker.getTodayUsage());
  }

  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  return normalizeUsageSummary(await controlPlane.getUsageSummary({ startDate: dayStart }));
}

async function buildSnapshot(ctx: DashboardShareRoutesContext): Promise<DashboardShareSnapshot> {
  const providers = ctx.registry.listAll();
  const providerSummaries = await Promise.all(
    providers.map(async (provider) => ({
      id: provider.id,
      name: provider.name,
      enabled: provider.enabled,
      hasKey: !!(await ctx.getApiKey(provider.id)),
      activeModels: provider.enabled ? provider.models.filter((model) => model.enabled).length : 0,
      totalModels: provider.models.length,
    })),
  );

  const usage = await getTodayUsageSummary(ctx.controlPlane);
  const providerNames = new Map(providerSummaries.map((provider) => [provider.id, provider.name]));
  const totalModels = providerSummaries.reduce((sum, provider) => sum + provider.totalModels, 0);
  const activeModels = providerSummaries.reduce((sum, provider) => sum + provider.activeModels, 0);
  const expiresAtMs = Date.now() + SHARE_TTL_MS;

  return {
    generatedAt: new Date().toISOString(),
    expiresAt: new Date(expiresAtMs).toISOString(),
    summary: {
      serverStatus: 'online',
      totalProviders: providerSummaries.length,
      enabledProviders: providerSummaries.filter((provider) => provider.enabled).length,
      totalModels,
      activeModels,
      keysConfigured: providerSummaries.filter((provider) => provider.hasKey).length,
      totalRequests: usage.totalRequests,
      successfulRequests: usage.successfulRequests,
      totalTokens: usage.totalInputTokens + usage.totalOutputTokens,
      totalCost: usage.totalCost,
    },
    providers: providerSummaries,
    topProviders: Object.entries(usage.byProvider)
      .sort(([, left], [, right]) => right.requests - left.requests)
      .slice(0, 3)
      .map(([providerId, stats]) => ({
        id: providerId,
        name: providerNames.get(providerId) ?? providerId,
        requests: stats.requests,
        totalCost: stats.cost,
      })),
  };
}

export function createDashboardShareRoutes(ctx: DashboardShareRoutesContext) {
  const app = new Hono();

  app.post('/api/dashboard/share', async (c) => {
    const snapshot = await buildSnapshot(ctx);
    const token = encodeToken({
      version: 1,
      expiresAt: new Date(snapshot.expiresAt).getTime(),
      snapshot,
    });

    observabilityMetrics.recordGrowthEvent('share_generated');

    return c.json({
      token,
      expiresAt: snapshot.expiresAt,
    });
  });

  app.get('/public/dashboard-share/:token', (c) => {
    const payload = decodeToken(c.req.param('token'));
    if (!payload) {
      return c.json({
        error: {
          message: 'This snapshot link is invalid or has expired.',
          code: 'invalid_share_token',
        },
      }, 404);
    }

    observabilityMetrics.recordGrowthEvent('share_opened');

    return c.json({
      snapshot: payload.snapshot,
    });
  });

  return app;
}
