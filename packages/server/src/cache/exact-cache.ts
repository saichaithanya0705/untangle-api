import type { ExactCacheConfig } from '@untangle-ai/core';

export type ExactCacheRoute = 'chat' | 'responses';

interface CacheEntry {
  expiresAt: number;
  value: unknown;
}

interface CacheKeyContext {
  tenantId?: string;
  virtualKeyId?: string;
  clientRegion?: string;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort((left, right) => left.localeCompare(right));
  const serialized = keys.map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`);
  return `{${serialized.join(',')}}`;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function buildExactCacheKey(
  route: ExactCacheRoute,
  payload: unknown,
  context?: CacheKeyContext,
): string {
  return stableSerialize({
    route,
    payload,
    tenant: context?.tenantId ?? null,
    key: context?.virtualKeyId ?? null,
    region: context?.clientRegion ?? null,
  });
}

export class ExactResponseCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly config?: ExactCacheConfig) {}

  isEnabled(route: ExactCacheRoute): boolean {
    if (!this.config?.enabled) {
      return false;
    }
    if (route === 'chat') {
      return this.config.chat;
    }
    if (route === 'responses') {
      return this.config.responses;
    }
    return false;
  }

  get<T>(key: string): T | null {
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    return deepClone(entry.value as T);
  }

  set(key: string, value: unknown): void {
    if (!this.config?.enabled) {
      return;
    }

    while (this.entries.size >= this.config.maxEntries) {
      const firstKey = this.entries.keys().next().value as string | undefined;
      if (!firstKey) break;
      this.entries.delete(firstKey);
    }

    this.entries.set(key, {
      expiresAt: Date.now() + this.config.ttlMs,
      value: deepClone(value),
    });
  }
}
