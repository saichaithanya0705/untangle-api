import { createHash, randomBytes } from 'node:crypto';
import type { UsageRecord } from '../pricing/tracker.js';
import type { RateLimiter } from './limiter.js';
import { InMemoryRateLimiter } from './limiter.js';
import type { ControlPlaneStore } from './store.js';
import { InMemoryControlPlaneStore } from './in-memory-store.js';
import type {
  BillingReconciliationByKey,
  BillingReconciliationSummary,
  LimitCheckResult,
  ProviderBillingExportRecord,
  ProviderBillingReconciliationByModel,
  ProviderBillingReconciliationSummary,
  SpendSummary,
  UsageEventRecord,
  UsageSummary,
  UsageSummaryFilter,
  VirtualKeyLimits,
  VirtualKeyRecord,
} from './types.js';

export interface CreateVirtualKeyInput {
  name: string;
  rawKey: string;
  limits?: VirtualKeyLimits;
  metadata?: Record<string, string>;
}

export interface ResolveVirtualKeyResult {
  key: VirtualKeyRecord;
}

export class ControlPlaneService {
  constructor(
    private readonly store: ControlPlaneStore = new InMemoryControlPlaneStore(),
    private readonly limiter: RateLimiter = new InMemoryRateLimiter(),
  ) {}

  async createVirtualKey(input: CreateVirtualKeyInput): Promise<VirtualKeyRecord> {
    const id = `vk_${randomBytes(12).toString('hex')}`;
    const record: VirtualKeyRecord = {
      id,
      name: input.name,
      keyHash: this.hashKey(input.rawKey),
      createdAt: new Date().toISOString(),
      limits: input.limits ?? {},
      metadata: input.metadata ?? {},
    };
    await this.store.upsertVirtualKey(record);
    return record;
  }

  async listVirtualKeys(): Promise<VirtualKeyRecord[]> {
    return this.store.listVirtualKeys();
  }

  async revokeVirtualKey(id: string): Promise<boolean> {
    return this.store.revokeVirtualKey(id, new Date().toISOString());
  }

  async resolveVirtualKey(rawKey: string): Promise<ResolveVirtualKeyResult | null> {
    const keyHash = this.hashKey(rawKey);
    const key = await this.store.getVirtualKeyByHash(keyHash);
    if (!key || key.revokedAt) return null;
    return { key };
  }

  async checkLimits(
    key: VirtualKeyRecord,
    input: { modelId?: string; inputTokens?: number; now?: Date },
  ): Promise<LimitCheckResult> {
    const modelId = input.modelId ?? '';
    const inputTokens = Math.max(0, input.inputTokens ?? 0);
    const now = input.now ?? new Date();

    if (key.limits.allowedModels && key.limits.allowedModels.length > 0 && modelId.length > 0) {
      if (!key.limits.allowedModels.includes(modelId)) {
        return { allowed: false, reason: 'model_denied' };
      }
    }
    if (key.limits.deniedModels && key.limits.deniedModels.length > 0 && modelId.length > 0) {
      if (key.limits.deniedModels.includes(modelId)) {
        return { allowed: false, reason: 'model_denied' };
      }
    }

    const limiterResult = await this.limiter.checkAndConsume(
      key.id,
      inputTokens,
      key.limits,
      now,
    );
    if (!limiterResult.allowed) return limiterResult;

    const usage = await this.store.getUsageSummary({
      virtualKeyId: key.id,
      startDate: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
    });

    if (key.limits.dailyBudgetUsd && usage.totalCostUsd > key.limits.dailyBudgetUsd) {
      return { allowed: false, reason: 'daily_budget_exceeded' };
    }

    const monthUsage = await this.store.getUsageSummary({
      virtualKeyId: key.id,
      startDate: new Date(now.getFullYear(), now.getMonth(), 1),
    });
    if (key.limits.monthlyBudgetUsd && monthUsage.totalCostUsd > key.limits.monthlyBudgetUsd) {
      return { allowed: false, reason: 'monthly_budget_exceeded' };
    }

    return { allowed: true };
  }

  async recordUsageEvent(event: UsageEventRecord): Promise<void> {
    await this.store.recordUsageEvent(event);
  }

  async recordUsageFromTracker(record: UsageRecord, virtualKeyId?: string): Promise<void> {
    const effectiveVirtualKeyId = virtualKeyId ?? record.metadata?.virtualKeyId;
    await this.store.recordUsageEvent({
      id: record.id,
      timestamp: record.timestamp,
      virtualKeyId: effectiveVirtualKeyId,
      providerId: record.providerId,
      modelId: record.modelId,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      totalCost: record.totalCost,
      durationMs: record.durationMs,
      success: record.success,
      error: record.error,
    });
  }

  async listUsageEvents(filter?: UsageSummaryFilter, limit?: number): Promise<UsageEventRecord[]> {
    return this.store.listUsageEvents(filter, limit);
  }

  async getUsageSummary(filter?: UsageSummaryFilter): Promise<UsageSummary> {
    return this.store.getUsageSummary(filter);
  }

  async getSpendSummary(now?: Date): Promise<SpendSummary> {
    return this.store.getSpendSummary(now);
  }

  async getBillingReconciliation(input?: {
    now?: Date;
    toleranceUsd?: number;
  }): Promise<BillingReconciliationSummary> {
    const toleranceUsd = Math.max(0, input?.toleranceUsd ?? 0.0001);
    const usageSummary = await this.store.getUsageSummary();
    const spendSummary = await this.store.getSpendSummary(input?.now);
    const keys = await this.store.listVirtualKeys();
    const keyIds = new Set<string>([
      ...keys.map((key) => key.id),
      ...Object.keys(spendSummary.byKeyUsd),
    ]);

    const byKey: BillingReconciliationByKey[] = [];
    for (const keyId of Array.from(keyIds).sort((left, right) => left.localeCompare(right))) {
      const usageByKey = await this.store.getUsageSummary({ virtualKeyId: keyId });
      const usageCostUsd = usageByKey.totalCostUsd;
      const spendLedgerCostUsd = spendSummary.byKeyUsd[keyId] ?? 0;
      const deltaUsd = usageCostUsd - spendLedgerCostUsd;
      byKey.push({
        virtualKeyId: keyId,
        usageCostUsd,
        spendLedgerCostUsd,
        deltaUsd,
        withinTolerance: Math.abs(deltaUsd) <= toleranceUsd,
      });
    }

    const deltaUsd = usageSummary.totalCostUsd - spendSummary.totalCostUsd;
    const withinTolerance = Math.abs(deltaUsd) <= toleranceUsd && byKey.every((entry) => entry.withinTolerance);

    return {
      usageTotalCostUsd: usageSummary.totalCostUsd,
      spendLedgerTotalCostUsd: spendSummary.totalCostUsd,
      deltaUsd,
      toleranceUsd,
      withinTolerance,
      byKey,
    };
  }

  async reconcileProviderBillingExport(input: {
    providerId: string;
    records: ProviderBillingExportRecord[];
    startDate?: Date;
    endDate?: Date;
    toleranceUsd?: number;
  }): Promise<ProviderBillingReconciliationSummary> {
    const providerId = input.providerId.trim();
    if (providerId.length === 0) {
      throw new Error('providerId is required');
    }
    const toleranceUsd = Math.max(0, input.toleranceUsd ?? 0.0001);
    const records = input.records.filter((record) => record.providerId === providerId);

    const usageEvents = await this.store.listUsageEvents({
      providerId,
      startDate: input.startDate,
      endDate: input.endDate,
    }, Number.MAX_SAFE_INTEGER);

    const usageByModel = new Map<string, number>();
    let usageTotalCostUsd = 0;
    for (const event of usageEvents) {
      const modelId = event.modelId?.trim() || 'unknown-model';
      usageTotalCostUsd += event.totalCost;
      usageByModel.set(modelId, (usageByModel.get(modelId) ?? 0) + event.totalCost);
    }

    const exportByModel = new Map<string, number>();
    let billingExportTotalCostUsd = 0;
    for (const record of records) {
      const modelId = record.modelId?.trim() || 'unknown-model';
      billingExportTotalCostUsd += record.costUsd;
      exportByModel.set(modelId, (exportByModel.get(modelId) ?? 0) + record.costUsd);
    }

    const byModel: ProviderBillingReconciliationByModel[] = [];
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
      usageEventsCompared: usageEvents.length,
      recordsInExport: records.length,
      byModel,
    };
  }

  async clearUsageEvents(): Promise<void> {
    await this.store.clearUsageEvents();
  }

  private hashKey(rawKey: string): string {
    return createHash('sha256').update(rawKey, 'utf-8').digest('hex');
  }
}
