import type { LimitCheckResult, VirtualKeyLimits } from './types.js';

export interface RateLimiter {
  checkAndConsume(
    keyId: string,
    inputTokens: number,
    limits: VirtualKeyLimits,
    now?: Date
  ): Promise<LimitCheckResult> | LimitCheckResult;
}

interface MinuteCounter {
  minuteKey: string;
  requests: number;
  tokens: number;
}

export class InMemoryRateLimiter implements RateLimiter {
  private counters = new Map<string, MinuteCounter>();

  checkAndConsume(
    keyId: string,
    inputTokens: number,
    limits: VirtualKeyLimits,
    now: Date = new Date(),
  ): LimitCheckResult {
    if (!limits.rpm && !limits.tpm) {
      return { allowed: true };
    }

    const minuteKey = `${now.getUTCFullYear()}-${now.getUTCMonth() + 1}-${now.getUTCDate()}-${now.getUTCHours()}-${now.getUTCMinutes()}`;
    const storageKey = `${keyId}:${minuteKey}`;
    const counter = this.counters.get(storageKey) ?? {
      minuteKey,
      requests: 0,
      tokens: 0,
    };

    const nextRequests = counter.requests + 1;
    const nextTokens = counter.tokens + Math.max(0, inputTokens);
    const retryAfterMs = 60_000 - (now.getUTCSeconds() * 1000 + now.getUTCMilliseconds());

    if (limits.rpm && nextRequests > limits.rpm) {
      return {
        allowed: false,
        reason: 'rpm_exceeded',
        retryAfterMs,
      };
    }

    if (limits.tpm && nextTokens > limits.tpm) {
      return {
        allowed: false,
        reason: 'tpm_exceeded',
        retryAfterMs,
      };
    }

    counter.requests = nextRequests;
    counter.tokens = nextTokens;
    this.counters.set(storageKey, counter);
    return { allowed: true };
  }
}

