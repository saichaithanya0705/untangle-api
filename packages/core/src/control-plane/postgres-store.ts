import type {
  SpendSummary,
  UsageEventRecord,
  UsageSummary,
  UsageSummaryFilter,
  VirtualKeyRecord,
} from './types.js';
import type { ControlPlaneStore } from './store.js';
import { renderControlPlanePostgresSchemaSql } from './postgres.js';

interface QueryResult<T = unknown> {
  rows: T[];
  rowCount?: number | null;
}

export interface SqlQueryClient {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
  end?: () => Promise<void>;
}

interface PgVirtualKeyRow {
  id: string;
  name: string;
  key_hash: string;
  created_at: string | Date;
  revoked_at: string | Date | null;
  limits: unknown;
  metadata: unknown;
}

interface PgUsageRow {
  id: string;
  ts: string | Date;
  virtual_key_id: string | null;
  provider_id: string;
  model_id: string;
  input_tokens: number;
  output_tokens: number;
  total_cost_usd: number | string;
  duration_ms: number;
  success: boolean;
  error: string | null;
}

interface PgUsageSummaryRow {
  total_requests: number | string;
  successful_requests: number | string;
  failed_requests: number | string;
  total_input_tokens: number | string;
  total_output_tokens: number | string;
  total_cost_usd: number | string;
}

interface PgSpendRow {
  total_cost_usd: number | string;
  today_cost_usd: number | string;
  month_cost_usd: number | string;
}

interface PgSpendByKeyRow {
  virtual_key_id: string | null;
  amount_usd: number | string;
}

function isSafeIdentifier(value: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value);
}

function quoteIdentifier(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function asNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function asObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

export class PostgresControlPlaneStore implements ControlPlaneStore {
  private readonly qSchema: string;

  constructor(
    private readonly client: SqlQueryClient,
    schema: string = 'public',
  ) {
    const normalizedSchema = schema.trim().length > 0 ? schema.trim() : 'public';
    if (!isSafeIdentifier(normalizedSchema)) {
      throw new Error(`Invalid PostgreSQL schema identifier: ${schema}`);
    }
    this.qSchema = quoteIdentifier(normalizedSchema);
  }

  static async fromConnectionString(
    connectionString: string,
    schema: string = 'public',
  ): Promise<PostgresControlPlaneStore> {
    const moduleName = 'pg';
    const pgModule = await import(moduleName);
    const Pool = (pgModule as { Pool?: new (config: { connectionString: string }) => {
      query: SqlQueryClient['query'];
      end: () => Promise<void>;
    } }).Pool;

    if (!Pool) {
      throw new Error('PostgreSQL driver is not available. Install `pg` to enable PostgreSQL control-plane persistence.');
    }

    const pool = new Pool({ connectionString });
    return new PostgresControlPlaneStore({
      query: (sql, params) => pool.query(sql, params),
      end: () => pool.end(),
    }, schema);
  }

  async ensureBaseSchema(): Promise<void> {
    await this.client.query(renderControlPlanePostgresSchemaSql(this.schemaName));
  }

  async close(): Promise<void> {
    if (this.client.end) {
      await this.client.end();
    }
  }

  async upsertVirtualKey(record: VirtualKeyRecord): Promise<void> {
    await this.client.query(
      `
      insert into ${this.qSchema}.cp_virtual_keys (id, name, key_hash, limits, metadata, created_at, revoked_at)
      values ($1, $2, $3, $4::jsonb, $5::jsonb, $6::timestamptz, $7::timestamptz)
      on conflict (id) do update set
        name = excluded.name,
        key_hash = excluded.key_hash,
        limits = excluded.limits,
        metadata = excluded.metadata,
        created_at = excluded.created_at,
        revoked_at = excluded.revoked_at
      `,
      [
        record.id,
        record.name,
        record.keyHash,
        JSON.stringify(record.limits ?? {}),
        JSON.stringify(record.metadata ?? {}),
        record.createdAt,
        record.revokedAt ?? null,
      ],
    );
  }

  async getVirtualKeyById(id: string): Promise<VirtualKeyRecord | null> {
    const result = await this.client.query<PgVirtualKeyRow>(
      `
      select id, name, key_hash, created_at, revoked_at, limits, metadata
      from ${this.qSchema}.cp_virtual_keys
      where id = $1
      limit 1
      `,
      [id],
    );

    const row = result.rows[0];
    return row ? this.toVirtualKey(row) : null;
  }

  async getVirtualKeyByHash(keyHash: string): Promise<VirtualKeyRecord | null> {
    const result = await this.client.query<PgVirtualKeyRow>(
      `
      select id, name, key_hash, created_at, revoked_at, limits, metadata
      from ${this.qSchema}.cp_virtual_keys
      where key_hash = $1
      limit 1
      `,
      [keyHash],
    );

    const row = result.rows[0];
    return row ? this.toVirtualKey(row) : null;
  }

  async listVirtualKeys(): Promise<VirtualKeyRecord[]> {
    const result = await this.client.query<PgVirtualKeyRow>(
      `
      select id, name, key_hash, created_at, revoked_at, limits, metadata
      from ${this.qSchema}.cp_virtual_keys
      order by created_at asc
      `,
    );
    return result.rows.map((row) => this.toVirtualKey(row));
  }

  async revokeVirtualKey(id: string, revokedAt: string): Promise<boolean> {
    const result = await this.client.query(
      `
      update ${this.qSchema}.cp_virtual_keys
      set revoked_at = $2::timestamptz
      where id = $1 and revoked_at is null
      `,
      [id, revokedAt],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async recordUsageEvent(event: UsageEventRecord): Promise<void> {
    await this.client.query(
      `
      insert into ${this.qSchema}.cp_usage_events (
        id, ts, virtual_key_id, provider_id, model_id, input_tokens, output_tokens, total_cost_usd, duration_ms, success, error
      )
      values ($1, $2::timestamptz, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      on conflict (id) do nothing
      `,
      [
        event.id,
        event.timestamp,
        event.virtualKeyId ?? null,
        event.providerId,
        event.modelId,
        event.inputTokens,
        event.outputTokens,
        event.totalCost,
        event.durationMs,
        event.success,
        event.error ?? null,
      ],
    );

    if (event.totalCost !== 0) {
      await this.client.query(
        `
        insert into ${this.qSchema}.cp_spend_ledger (
          usage_event_id, ts, virtual_key_id, amount_usd, provider_id, model_id
        )
        values ($1, $2::timestamptz, $3, $4, $5, $6)
        `,
        [
          event.id,
          event.timestamp,
          event.virtualKeyId ?? null,
          event.totalCost,
          event.providerId,
          event.modelId,
        ],
      );
    }
  }

  async listUsageEvents(filter?: UsageSummaryFilter, limit: number = 100): Promise<UsageEventRecord[]> {
    const { whereSql, params } = this.buildUsageFilter(filter);
    const boundedLimit = Number.isFinite(limit) && limit > 0 ? Math.min(limit, 5000) : 100;

    const result = await this.client.query<PgUsageRow>(
      `
      select
        id, ts, virtual_key_id, provider_id, model_id, input_tokens, output_tokens, total_cost_usd, duration_ms, success, error
      from ${this.qSchema}.cp_usage_events
      ${whereSql}
      order by ts desc
      limit ${boundedLimit}
      `,
      params,
    );

    return result.rows.map((row) => ({
      id: row.id,
      timestamp: new Date(row.ts).toISOString(),
      virtualKeyId: row.virtual_key_id ?? undefined,
      providerId: row.provider_id,
      modelId: row.model_id,
      inputTokens: asNumber(row.input_tokens),
      outputTokens: asNumber(row.output_tokens),
      totalCost: asNumber(row.total_cost_usd),
      durationMs: asNumber(row.duration_ms),
      success: Boolean(row.success),
      error: row.error ?? undefined,
    }));
  }

  async getUsageSummary(filter?: UsageSummaryFilter): Promise<UsageSummary> {
    const { whereSql, params } = this.buildUsageFilter(filter);

    const result = await this.client.query<PgUsageSummaryRow>(
      `
      select
        count(*) as total_requests,
        sum(case when success then 1 else 0 end) as successful_requests,
        sum(case when success then 0 else 1 end) as failed_requests,
        coalesce(sum(input_tokens), 0) as total_input_tokens,
        coalesce(sum(output_tokens), 0) as total_output_tokens,
        coalesce(sum(total_cost_usd), 0) as total_cost_usd
      from ${this.qSchema}.cp_usage_events
      ${whereSql}
      `,
      params,
    );

    const row = result.rows[0];
    return {
      totalRequests: asNumber(row?.total_requests),
      successfulRequests: asNumber(row?.successful_requests),
      failedRequests: asNumber(row?.failed_requests),
      totalInputTokens: asNumber(row?.total_input_tokens),
      totalOutputTokens: asNumber(row?.total_output_tokens),
      totalCostUsd: asNumber(row?.total_cost_usd),
    };
  }

  async getSpendSummary(now: Date = new Date()): Promise<SpendSummary> {
    const dayStart = new Date(now);
    dayStart.setHours(0, 0, 0, 0);

    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const totals = await this.client.query<PgSpendRow>(
      `
      select
        coalesce(sum(amount_usd), 0) as total_cost_usd,
        coalesce(sum(case when ts >= $1::timestamptz then amount_usd else 0 end), 0) as today_cost_usd,
        coalesce(sum(case when ts >= $2::timestamptz then amount_usd else 0 end), 0) as month_cost_usd
      from ${this.qSchema}.cp_spend_ledger
      `,
      [dayStart.toISOString(), monthStart.toISOString()],
    );

    const byKeyRows = await this.client.query<PgSpendByKeyRow>(
      `
      select virtual_key_id, coalesce(sum(amount_usd), 0) as amount_usd
      from ${this.qSchema}.cp_spend_ledger
      where virtual_key_id is not null
      group by virtual_key_id
      `,
    );

    const byKeyUsd: Record<string, number> = {};
    for (const row of byKeyRows.rows) {
      if (!row.virtual_key_id) continue;
      byKeyUsd[row.virtual_key_id] = asNumber(row.amount_usd);
    }

    const row = totals.rows[0];
    return {
      totalCostUsd: asNumber(row?.total_cost_usd),
      todayCostUsd: asNumber(row?.today_cost_usd),
      monthCostUsd: asNumber(row?.month_cost_usd),
      byKeyUsd,
    };
  }

  async clearUsageEvents(): Promise<void> {
    await this.client.query(`delete from ${this.qSchema}.cp_spend_ledger`);
    await this.client.query(`delete from ${this.qSchema}.cp_usage_events`);
  }

  private get schemaName(): string {
    return this.qSchema.slice(1, -1).replace(/""/g, '"');
  }

  private toVirtualKey(row: PgVirtualKeyRow): VirtualKeyRecord {
    return {
      id: row.id,
      name: row.name,
      keyHash: row.key_hash,
      createdAt: new Date(row.created_at).toISOString(),
      revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : undefined,
      limits: asObject(row.limits),
      metadata: asObject(row.metadata) as Record<string, string>,
    };
  }

  private buildUsageFilter(filter?: UsageSummaryFilter): { whereSql: string; params: unknown[] } {
    const clauses: string[] = [];
    const params: unknown[] = [];
    let index = 1;

    if (filter?.startDate) {
      clauses.push(`ts >= $${index}::timestamptz`);
      params.push(filter.startDate.toISOString());
      index += 1;
    }
    if (filter?.endDate) {
      clauses.push(`ts <= $${index}::timestamptz`);
      params.push(filter.endDate.toISOString());
      index += 1;
    }
    if (filter?.virtualKeyId) {
      clauses.push(`virtual_key_id = $${index}`);
      params.push(filter.virtualKeyId);
      index += 1;
    }
    if (filter?.providerId) {
      clauses.push(`provider_id = $${index}`);
      params.push(filter.providerId);
      index += 1;
    }
    if (filter?.modelId) {
      clauses.push(`model_id = $${index}`);
      params.push(filter.modelId);
      index += 1;
    }

    return {
      whereSql: clauses.length > 0 ? `where ${clauses.join(' and ')}` : '',
      params,
    };
  }
}

