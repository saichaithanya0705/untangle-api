import { describe, expect, it, vi } from 'vitest';
import { PostgresControlPlaneStore, RedisRateLimiter } from '@untangle-ai/core';

class FakeRedisCounterClient {
  private values = new Map<string, number>();
  private ttlUntil = new Map<string, number>();
  private nowMs = 0;

  private evictIfExpired(key: string): void {
    const expiresAt = this.ttlUntil.get(key);
    if (expiresAt !== undefined && this.nowMs >= expiresAt) {
      this.values.delete(key);
      this.ttlUntil.delete(key);
    }
  }

  advance(ms: number): void {
    this.nowMs += ms;
  }

  async incrBy(key: string, increment: number): Promise<number> {
    this.evictIfExpired(key);
    const next = (this.values.get(key) ?? 0) + increment;
    this.values.set(key, next);
    return next;
  }

  async pExpire(key: string, milliseconds: number): Promise<number> {
    this.ttlUntil.set(key, this.nowMs + milliseconds);
    return 1;
  }

  async pTTL(key: string): Promise<number> {
    this.evictIfExpired(key);
    const expiresAt = this.ttlUntil.get(key);
    if (expiresAt === undefined) return -1;
    return Math.max(0, expiresAt - this.nowMs);
  }
}

describe('PostgreSQL control-plane store adapter', () => {
  it('rejects invalid schema identifiers', () => {
    const client = { query: vi.fn() as any };
    expect(() => new PostgresControlPlaneStore(client, 'public;drop')).toThrow(/Invalid PostgreSQL schema identifier/i);
  });

  it('writes usage events and spend ledger records for non-zero cost events', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 1 });
    const store = new PostgresControlPlaneStore({ query: query as any }, 'public');

    await store.recordUsageEvent({
      id: 'evt_1',
      timestamp: '2026-02-26T10:00:00.000Z',
      virtualKeyId: 'vk_1',
      providerId: 'openai',
      modelId: 'gpt-4o',
      inputTokens: 20,
      outputTokens: 10,
      totalCost: 0.42,
      durationMs: 120,
      success: true,
    });

    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[0]?.[0])).toContain('cp_usage_events');
    expect(String(query.mock.calls[1]?.[0])).toContain('cp_spend_ledger');
  });

  it('skips spend ledger write for zero-cost events and parses aggregate numeric strings', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('count(*) as total_requests')) {
        return {
          rows: [{
            total_requests: '3',
            successful_requests: '2',
            failed_requests: '1',
            total_input_tokens: '200',
            total_output_tokens: '120',
            total_cost_usd: '1.25',
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('today_cost_usd')) {
        return {
          rows: [{
            total_cost_usd: '1.25',
            today_cost_usd: '0.75',
            month_cost_usd: '1.25',
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('group by virtual_key_id')) {
        return {
          rows: [
            { virtual_key_id: 'vk_1', amount_usd: '0.75' },
            { virtual_key_id: 'vk_2', amount_usd: '0.50' },
          ],
          rowCount: 2,
        };
      }
      return { rows: [], rowCount: 1 };
    });

    const store = new PostgresControlPlaneStore({ query: query as any }, 'public');
    await store.recordUsageEvent({
      id: 'evt_zero',
      timestamp: '2026-02-26T10:00:00.000Z',
      virtualKeyId: 'vk_1',
      providerId: 'openai',
      modelId: 'gpt-4o',
      inputTokens: 10,
      outputTokens: 8,
      totalCost: 0,
      durationMs: 80,
      success: true,
    });
    expect(query.mock.calls.filter((call) => String(call[0]).includes('cp_usage_events'))).toHaveLength(1);
    expect(query.mock.calls.filter((call) => String(call[0]).includes('cp_spend_ledger'))).toHaveLength(0);

    const usage = await store.getUsageSummary();
    expect(usage).toEqual({
      totalRequests: 3,
      successfulRequests: 2,
      failedRequests: 1,
      totalInputTokens: 200,
      totalOutputTokens: 120,
      totalCostUsd: 1.25,
    });

    const spend = await store.getSpendSummary(new Date('2026-02-26T18:00:00.000Z'));
    expect(spend.totalCostUsd).toBe(1.25);
    expect(spend.todayCostUsd).toBe(0.75);
    expect(spend.monthCostUsd).toBe(1.25);
    expect(spend.byKeyUsd).toEqual({
      vk_1: 0.75,
      vk_2: 0.5,
    });
  });
});

describe('Redis rate limiter adapter', () => {
  it('enforces rpm threshold and provides retryAfterMs', async () => {
    const client = new FakeRedisCounterClient();
    const limiter = new RedisRateLimiter(client, 'untangle-test');

    const first = await limiter.checkAndConsume('vk_1', 1, { rpm: 2 }, new Date('2026-02-26T10:00:00.000Z'));
    const second = await limiter.checkAndConsume('vk_1', 1, { rpm: 2 }, new Date('2026-02-26T10:00:01.000Z'));
    const third = await limiter.checkAndConsume('vk_1', 1, { rpm: 2 }, new Date('2026-02-26T10:00:02.000Z'));

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(true);
    expect(third.allowed).toBe(false);
    expect(third.reason).toBe('rpm_exceeded');
    expect((third.retryAfterMs ?? 0)).toBeGreaterThanOrEqual(1000);
  });

  it('enforces tpm threshold and reports token-denial reason', async () => {
    const client = new FakeRedisCounterClient();
    const limiter = new RedisRateLimiter(client, 'untangle-test');

    const first = await limiter.checkAndConsume('vk_2', 6, { tpm: 10 }, new Date('2026-02-26T10:00:00.000Z'));
    const second = await limiter.checkAndConsume('vk_2', 6, { tpm: 10 }, new Date('2026-02-26T10:00:10.000Z'));

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
    expect(second.reason).toBe('tpm_exceeded');
    expect((second.retryAfterMs ?? 0)).toBeGreaterThanOrEqual(1000);

    client.advance(65_000);
    const afterWindow = await limiter.checkAndConsume('vk_2', 4, { tpm: 10 }, new Date('2026-02-26T10:01:20.000Z'));
    expect(afterWindow.allowed).toBe(true);
  });
});

const postgresUrl = process.env.UNTANGLE_TEST_POSTGRES_URL;
const redisUrl = process.env.UNTANGLE_TEST_REDIS_URL;
const describePostgresIntegration = postgresUrl ? describe : describe.skip;
const describeRedisIntegration = redisUrl ? describe : describe.skip;

describePostgresIntegration('PostgreSQL adapter integration (optional, container-backed)', () => {
  it('persists and resolves virtual keys with a real PostgreSQL instance', async () => {
    const schema = `cpitest_${Math.random().toString(16).slice(2, 10)}`;
    const store = await PostgresControlPlaneStore.fromConnectionString(postgresUrl!, schema);
    await store.ensureBaseSchema();

    await store.upsertVirtualKey({
      id: 'vk_integration_1',
      name: 'Integration key',
      keyHash: 'hash-integration-1',
      createdAt: new Date('2026-02-26T00:00:00.000Z').toISOString(),
      limits: { rpm: 3 },
      metadata: { source: 'integration' },
    });

    const byHash = await store.getVirtualKeyByHash('hash-integration-1');
    expect(byHash?.id).toBe('vk_integration_1');

    await store.recordUsageEvent({
      id: 'evt_integration_1',
      timestamp: new Date('2026-02-26T12:00:00.000Z').toISOString(),
      virtualKeyId: 'vk_integration_1',
      providerId: 'openai',
      modelId: 'gpt-4o',
      inputTokens: 10,
      outputTokens: 5,
      totalCost: 0.15,
      durationMs: 100,
      success: true,
    });

    const usage = await store.getUsageSummary({ virtualKeyId: 'vk_integration_1' });
    expect(usage.totalRequests).toBeGreaterThanOrEqual(1);
    expect(usage.totalCostUsd).toBeGreaterThan(0);

    await store.close();
  });
});

describeRedisIntegration('Redis limiter integration (optional, container-backed)', () => {
  it('enforces rpm limits with a real Redis instance', async () => {
    const prefix = `untangle-ci-${Math.random().toString(16).slice(2, 8)}`;
    const limiter = await RedisRateLimiter.fromConnectionString(redisUrl!, prefix);

    const first = await limiter.checkAndConsume('vk_ci_1', 1, { rpm: 1 }, new Date('2026-02-26T10:00:00.000Z'));
    const second = await limiter.checkAndConsume('vk_ci_1', 1, { rpm: 1 }, new Date('2026-02-26T10:00:01.000Z'));

    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
    expect(second.reason).toBe('rpm_exceeded');

    await limiter.close();
  });
});
