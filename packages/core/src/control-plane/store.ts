import type {
  SpendSummary,
  UsageEventRecord,
  UsageSummary,
  UsageSummaryFilter,
  VirtualKeyRecord,
} from './types.js';

export interface ControlPlaneStore {
  upsertVirtualKey(record: VirtualKeyRecord): Promise<void> | void;
  getVirtualKeyById(id: string): Promise<VirtualKeyRecord | null> | VirtualKeyRecord | null;
  getVirtualKeyByHash(keyHash: string): Promise<VirtualKeyRecord | null> | VirtualKeyRecord | null;
  listVirtualKeys(): Promise<VirtualKeyRecord[]> | VirtualKeyRecord[];
  revokeVirtualKey(id: string, revokedAt: string): Promise<boolean> | boolean;

  recordUsageEvent(event: UsageEventRecord): Promise<void> | void;
  listUsageEvents(filter?: UsageSummaryFilter, limit?: number): Promise<UsageEventRecord[]> | UsageEventRecord[];
  getUsageSummary(filter?: UsageSummaryFilter): Promise<UsageSummary> | UsageSummary;
  getSpendSummary(now?: Date): Promise<SpendSummary> | SpendSummary;
  clearUsageEvents(): Promise<void> | void;
}
