/**
 * Usage tracker - tracks token consumption and costs per request/session
 */

import { pricingFetcher, type ModelPricing } from './fetcher.js';

export interface UsageRecord {
  id: string;
  timestamp: string;
  providerId: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  inputCost: number;
  outputCost: number;
  totalCost: number;
  durationMs: number;
  success: boolean;
  error?: string;
}

export interface UsageSummary {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  byProvider: Record<string, {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
  }>;
  byModel: Record<string, {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    cost: number;
  }>;
}

export interface UsageFilter {
  startDate?: Date;
  endDate?: Date;
  providerId?: string;
  modelId?: string;
  limit?: number;
}

export class UsageTracker {
  private records: UsageRecord[] = [];
  private maxRecords: number = 10000; // Keep last 10k records in memory

  /**
   * Record a completed request
   */
  recordUsage(
    providerId: string,
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    durationMs: number,
    success: boolean,
    error?: string
  ): UsageRecord {
    const cost = pricingFetcher.calculateCost(providerId, modelId, inputTokens, outputTokens);

    const record: UsageRecord = {
      id: `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      timestamp: new Date().toISOString(),
      providerId,
      modelId,
      inputTokens,
      outputTokens,
      inputCost: cost?.inputCost ?? 0,
      outputCost: cost?.outputCost ?? 0,
      totalCost: cost?.totalCost ?? 0,
      durationMs,
      success,
      error,
    };

    this.records.push(record);

    // Trim old records if we exceed max
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords);
    }

    return record;
  }

  /**
   * Get usage records with optional filtering
   */
  getRecords(filter?: UsageFilter): UsageRecord[] {
    let filtered = [...this.records];

    if (filter?.startDate) {
      const start = filter.startDate.toISOString();
      filtered = filtered.filter(r => r.timestamp >= start);
    }

    if (filter?.endDate) {
      const end = filter.endDate.toISOString();
      filtered = filtered.filter(r => r.timestamp <= end);
    }

    if (filter?.providerId) {
      filtered = filtered.filter(r => r.providerId === filter.providerId);
    }

    if (filter?.modelId) {
      filtered = filtered.filter(r => r.modelId === filter.modelId);
    }

    if (filter?.limit) {
      filtered = filtered.slice(-filter.limit);
    }

    return filtered;
  }

  /**
   * Get usage summary with aggregations
   */
  getSummary(filter?: UsageFilter): UsageSummary {
    const records = this.getRecords(filter);

    const summary: UsageSummary = {
      totalRequests: records.length,
      successfulRequests: records.filter(r => r.success).length,
      failedRequests: records.filter(r => !r.success).length,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      byProvider: {},
      byModel: {},
    };

    for (const record of records) {
      summary.totalInputTokens += record.inputTokens;
      summary.totalOutputTokens += record.outputTokens;
      summary.totalCost += record.totalCost;

      // By provider
      if (!summary.byProvider[record.providerId]) {
        summary.byProvider[record.providerId] = {
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
        };
      }
      summary.byProvider[record.providerId].requests++;
      summary.byProvider[record.providerId].inputTokens += record.inputTokens;
      summary.byProvider[record.providerId].outputTokens += record.outputTokens;
      summary.byProvider[record.providerId].cost += record.totalCost;

      // By model
      const modelKey = `${record.providerId}:${record.modelId}`;
      if (!summary.byModel[modelKey]) {
        summary.byModel[modelKey] = {
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          cost: 0,
        };
      }
      summary.byModel[modelKey].requests++;
      summary.byModel[modelKey].inputTokens += record.inputTokens;
      summary.byModel[modelKey].outputTokens += record.outputTokens;
      summary.byModel[modelKey].cost += record.totalCost;
    }

    return summary;
  }

  /**
   * Get recent usage (last N minutes)
   */
  getRecentUsage(minutes: number = 60): UsageSummary {
    const startDate = new Date(Date.now() - minutes * 60 * 1000);
    return this.getSummary({ startDate });
  }

  /**
   * Get today's usage
   */
  getTodayUsage(): UsageSummary {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return this.getSummary({ startDate: today });
  }

  /**
   * Clear all records
   */
  clearRecords(): void {
    this.records = [];
  }

  /**
   * Export records as JSON
   */
  exportRecords(): string {
    return JSON.stringify(this.records, null, 2);
  }

  /**
   * Import records from JSON
   */
  importRecords(json: string): void {
    const imported = JSON.parse(json) as UsageRecord[];
    this.records = [...this.records, ...imported];
    if (this.records.length > this.maxRecords) {
      this.records = this.records.slice(-this.maxRecords);
    }
  }
}

export const usageTracker = new UsageTracker();
