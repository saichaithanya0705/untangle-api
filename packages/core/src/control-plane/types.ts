export interface VirtualKeyLimits {
  rpm?: number;
  tpm?: number;
  dailyBudgetUsd?: number;
  monthlyBudgetUsd?: number;
  allowedModels?: string[];
  deniedModels?: string[];
}

export interface VirtualKeyRecord {
  id: string;
  name: string;
  keyHash: string;
  createdAt: string;
  revokedAt?: string;
  limits: VirtualKeyLimits;
  metadata?: Record<string, string>;
}

export interface UsageEventRecord {
  id: string;
  timestamp: string;
  virtualKeyId?: string;
  providerId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
  durationMs: number;
  success: boolean;
  error?: string;
}

export interface SpendSummary {
  totalCostUsd: number;
  todayCostUsd: number;
  monthCostUsd: number;
  byKeyUsd: Record<string, number>;
}

export interface BillingReconciliationByKey {
  virtualKeyId: string;
  usageCostUsd: number;
  spendLedgerCostUsd: number;
  deltaUsd: number;
  withinTolerance: boolean;
}

export interface BillingReconciliationSummary {
  usageTotalCostUsd: number;
  spendLedgerTotalCostUsd: number;
  deltaUsd: number;
  toleranceUsd: number;
  withinTolerance: boolean;
  byKey: BillingReconciliationByKey[];
}

export interface ProviderBillingExportRecord {
  providerId: string;
  modelId?: string;
  costUsd: number;
  timestamp?: string;
  requestCount?: number;
}

export interface ProviderBillingReconciliationByModel {
  modelId: string;
  usageCostUsd: number;
  billingExportCostUsd: number;
  deltaUsd: number;
  withinTolerance: boolean;
}

export interface ProviderBillingReconciliationSummary {
  providerId: string;
  usageTotalCostUsd: number;
  billingExportTotalCostUsd: number;
  deltaUsd: number;
  toleranceUsd: number;
  withinTolerance: boolean;
  usageEventsCompared: number;
  recordsInExport: number;
  byModel: ProviderBillingReconciliationByModel[];
}

export interface UsageSummary {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
}

export interface UsageSummaryFilter {
  startDate?: Date;
  endDate?: Date;
  virtualKeyId?: string;
  providerId?: string;
  modelId?: string;
}

export interface LimitCheckResult {
  allowed: boolean;
  reason?: 'model_denied' | 'rpm_exceeded' | 'tpm_exceeded' | 'daily_budget_exceeded' | 'monthly_budget_exceeded';
  retryAfterMs?: number;
}

export interface PostgresSchemaArtifact {
  migrationName: string;
  sql: string;
}
