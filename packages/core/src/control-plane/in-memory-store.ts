import type {
  SpendSummary,
  UsageEventRecord,
  UsageSummary,
  UsageSummaryFilter,
  VirtualKeyRecord,
} from './types.js';
import type { ControlPlaneStore } from './store.js';

export class InMemoryControlPlaneStore implements ControlPlaneStore {
  private keys = new Map<string, VirtualKeyRecord>();
  private keyHashToId = new Map<string, string>();
  private usageEvents: UsageEventRecord[] = [];
  private readonly maxUsageEvents = 100_000;

  upsertVirtualKey(record: VirtualKeyRecord): void {
    this.keys.set(record.id, record);
    this.keyHashToId.set(record.keyHash, record.id);
  }

  getVirtualKeyById(id: string): VirtualKeyRecord | null {
    return this.keys.get(id) ?? null;
  }

  getVirtualKeyByHash(keyHash: string): VirtualKeyRecord | null {
    const id = this.keyHashToId.get(keyHash);
    if (!id) return null;
    return this.keys.get(id) ?? null;
  }

  listVirtualKeys(): VirtualKeyRecord[] {
    return Array.from(this.keys.values())
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  revokeVirtualKey(id: string, revokedAt: string): boolean {
    const current = this.keys.get(id);
    if (!current || current.revokedAt) return false;
    this.keys.set(id, { ...current, revokedAt });
    return true;
  }

  recordUsageEvent(event: UsageEventRecord): void {
    this.usageEvents.push(event);
    if (this.usageEvents.length > this.maxUsageEvents) {
      this.usageEvents = this.usageEvents.slice(-this.maxUsageEvents);
    }
  }

  listUsageEvents(filter?: UsageSummaryFilter, limit: number = 100): UsageEventRecord[] {
    let items = [...this.usageEvents];

    if (filter?.startDate) {
      const start = filter.startDate.toISOString();
      items = items.filter((event) => event.timestamp >= start);
    }
    if (filter?.endDate) {
      const end = filter.endDate.toISOString();
      items = items.filter((event) => event.timestamp <= end);
    }
    if (filter?.virtualKeyId) {
      items = items.filter((event) => event.virtualKeyId === filter.virtualKeyId);
    }
    if (filter?.providerId) {
      items = items.filter((event) => event.providerId === filter.providerId);
    }
    if (filter?.modelId) {
      items = items.filter((event) => event.modelId === filter.modelId);
    }

    const bounded = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 5000) : 100;
    return items.slice(-bounded);
  }

  getUsageSummary(filter?: UsageSummaryFilter): UsageSummary {
    const records = this.listUsageEvents(filter, Number.MAX_SAFE_INTEGER);

    const summary: UsageSummary = {
      totalRequests: records.length,
      successfulRequests: records.filter((record) => record.success).length,
      failedRequests: records.filter((record) => !record.success).length,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCostUsd: 0,
    };

    for (const record of records) {
      summary.totalInputTokens += record.inputTokens;
      summary.totalOutputTokens += record.outputTokens;
      summary.totalCostUsd += record.totalCost;
    }

    return summary;
  }

  getSpendSummary(now: Date = new Date()): SpendSummary {
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);

    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const summary: SpendSummary = {
      totalCostUsd: 0,
      todayCostUsd: 0,
      monthCostUsd: 0,
      byKeyUsd: {},
    };

    for (const event of this.usageEvents) {
      summary.totalCostUsd += event.totalCost;
      const ts = new Date(event.timestamp);

      if (ts >= todayStart) {
        summary.todayCostUsd += event.totalCost;
      }
      if (ts >= monthStart) {
        summary.monthCostUsd += event.totalCost;
      }

      if (event.virtualKeyId) {
        summary.byKeyUsd[event.virtualKeyId] = (summary.byKeyUsd[event.virtualKeyId] ?? 0) + event.totalCost;
      }
    }

    return summary;
  }

  clearUsageEvents(): void {
    this.usageEvents = [];
  }
}
