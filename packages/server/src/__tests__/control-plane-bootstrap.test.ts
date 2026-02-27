import { describe, expect, it, vi } from 'vitest';
import {
  bootstrapControlPlane,
  InMemoryControlPlaneStore,
  InMemoryRateLimiter,
} from '@untangle-ai/core';

describe('Control-plane bootstrap fallback behavior', () => {
  it('returns no service when control-plane is disabled', async () => {
    const result = await bootstrapControlPlane({
      enabled: false,
      postgres: { enabled: false, schema: 'public' },
      redis: { enabled: false, keyPrefix: 'untangle' },
    });

    expect(result.service).toBeUndefined();
    expect(result.messages).toEqual([]);
    expect(result.storeType).toBe('in-memory');
    expect(result.limiterType).toBe('in-memory');
  });

  it('falls back to in-memory adapters when connection strings are missing', async () => {
    const createPostgresStore = vi.fn();
    const createRedisLimiter = vi.fn();

    const result = await bootstrapControlPlane({
      enabled: true,
      postgres: {
        enabled: true,
        schema: 'public',
      },
      redis: {
        enabled: true,
        keyPrefix: 'untangle',
      },
    }, {
      createPostgresStore,
      createRedisLimiter,
    });

    expect(result.service).toBeDefined();
    expect(result.storeType).toBe('in-memory');
    expect(result.limiterType).toBe('in-memory');
    expect(createPostgresStore).not.toHaveBeenCalled();
    expect(createRedisLimiter).not.toHaveBeenCalled();
    expect(result.messages.some((m) => m.level === 'warn' && m.message.includes('postgres.enabled=true but no connectionString'))).toBe(true);
    expect(result.messages.some((m) => m.level === 'warn' && m.message.includes('redis.enabled=true but no connectionString'))).toBe(true);
    expect(result.messages.some((m) => m.level === 'dim' && m.message.includes('Migration artifact:'))).toBe(true);
  });

  it('falls back to in-memory adapters when postgres/redis initialization fails', async () => {
    const result = await bootstrapControlPlane({
      enabled: true,
      postgres: {
        enabled: true,
        connectionString: 'postgres://localhost/test',
        schema: 'public',
      },
      redis: {
        enabled: true,
        connectionString: 'redis://localhost:6379/0',
        keyPrefix: 'untangle',
      },
    }, {
      createPostgresStore: vi.fn().mockRejectedValue(new Error('pg offline')),
      createRedisLimiter: vi.fn().mockRejectedValue(new Error('redis offline')),
    });

    expect(result.service).toBeDefined();
    expect(result.storeType).toBe('in-memory');
    expect(result.limiterType).toBe('in-memory');
    expect(result.messages.some((m) => m.level === 'warn' && m.message.includes('pg offline'))).toBe(true);
    expect(result.messages.some((m) => m.level === 'warn' && m.message.includes('redis offline'))).toBe(true);
  });

  it('uses persistent adapters when initialization succeeds', async () => {
    const store = new InMemoryControlPlaneStore();
    const limiter = new InMemoryRateLimiter();

    const result = await bootstrapControlPlane({
      enabled: true,
      postgres: {
        enabled: true,
        connectionString: 'postgres://localhost/test',
        schema: 'public',
      },
      redis: {
        enabled: true,
        connectionString: 'redis://localhost:6379/0',
        keyPrefix: 'untangle',
      },
    }, {
      createPostgresStore: vi.fn().mockResolvedValue(store),
      createRedisLimiter: vi.fn().mockResolvedValue(limiter),
    });

    expect(result.service).toBeDefined();
    expect(result.storeType).toBe('postgres');
    expect(result.limiterType).toBe('redis');
    expect(result.messages.some((m) => m.level === 'success' && m.message.includes('PostgreSQL persistence enabled'))).toBe(true);
    expect(result.messages.some((m) => m.level === 'success' && m.message.includes('Redis rate limiter enabled'))).toBe(true);

    const created = await result.service!.createVirtualKey({
      name: 'Persisted key',
      rawKey: 'cp_persist_123',
      limits: { rpm: 10 },
    });
    const keys = await result.service!.listVirtualKeys();
    expect(keys.some((key) => key.id === created.id)).toBe(true);
  });
});
