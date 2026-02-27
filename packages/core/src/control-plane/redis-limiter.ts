import type { LimitCheckResult, VirtualKeyLimits } from './types.js';
import type { RateLimiter } from './limiter.js';

export interface RedisCounterClient {
  incrBy(key: string, increment: number): Promise<number>;
  pExpire(key: string, milliseconds: number): Promise<number>;
  pTTL(key: string): Promise<number>;
  quit?: () => Promise<void>;
}

function toMinuteBucket(now: Date): string {
  return `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}`;
}

export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly client: RedisCounterClient,
    private readonly keyPrefix: string = 'untangle',
  ) {}

  static async fromConnectionString(
    connectionString: string,
    keyPrefix: string = 'untangle',
  ): Promise<RedisRateLimiter> {
    const moduleName = 'redis';
    const redisModule = await import(moduleName);
    const createClient = (redisModule as {
      createClient?: (options: { url: string }) => {
        connect: () => Promise<void>;
        incrBy: (key: string, value: number) => Promise<number>;
        pExpire: (key: string, milliseconds: number) => Promise<number>;
        pTTL: (key: string) => Promise<number>;
        quit: () => Promise<void>;
      };
    }).createClient;

    if (!createClient) {
      throw new Error('Redis client is not available. Install `redis` to enable Redis-backed rate limiting.');
    }

    const client = createClient({ url: connectionString });
    await client.connect();
    return new RedisRateLimiter({
      incrBy: (key, value) => client.incrBy(key, value),
      pExpire: (key, ms) => client.pExpire(key, ms),
      pTTL: (key) => client.pTTL(key),
      quit: () => client.quit(),
    }, keyPrefix);
  }

  async close(): Promise<void> {
    if (this.client.quit) {
      await this.client.quit();
    }
  }

  async checkAndConsume(
    keyId: string,
    inputTokens: number,
    limits: VirtualKeyLimits,
    now: Date = new Date(),
  ): Promise<LimitCheckResult> {
    if (!limits.rpm && !limits.tpm) {
      return { allowed: true };
    }

    const bucket = toMinuteBucket(now);
    const reqKey = `${this.keyPrefix}:cp:rpm:${keyId}:${bucket}`;
    const tokKey = `${this.keyPrefix}:cp:tpm:${keyId}:${bucket}`;
    const ttlMs = 65_000;

    const requestedTokens = Math.max(0, inputTokens);
    const nextRequests = await this.client.incrBy(reqKey, 1);
    if (nextRequests === 1) {
      await this.client.pExpire(reqKey, ttlMs);
    }

    let nextTokens = 0;
    if (limits.tpm) {
      nextTokens = await this.client.incrBy(tokKey, requestedTokens);
      if (nextTokens === requestedTokens) {
        await this.client.pExpire(tokKey, ttlMs);
      }
    }

    const reqExceeded = !!limits.rpm && nextRequests > limits.rpm;
    const tokExceeded = !!limits.tpm && nextTokens > limits.tpm;
    if (!reqExceeded && !tokExceeded) {
      return { allowed: true };
    }

    const reqTtl = await this.client.pTTL(reqKey);
    const tokTtl = limits.tpm ? await this.client.pTTL(tokKey) : -1;
    const retryAfterMs = Math.max(reqTtl, tokTtl, 1000);

    if (reqExceeded) {
      return {
        allowed: false,
        reason: 'rpm_exceeded',
        retryAfterMs,
      };
    }

    return {
      allowed: false,
      reason: 'tpm_exceeded',
      retryAfterMs,
    };
  }
}

