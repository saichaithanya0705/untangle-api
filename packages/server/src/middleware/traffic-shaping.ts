import type { MiddlewareHandler } from 'hono';
import type { TrafficShapingConfig } from '@untangle-ai/core';
import { observabilityMetrics } from '../observability/metrics.js';

interface AdaptiveState {
  currentRps: number;
  lastAdjustedAt: number;
  emaLatencyMs: number;
  emaErrorRate: number;
}

interface TokenBucketState {
  tokens: number;
  lastRefillAt: number;
}

interface TenantBucket {
  bucket: TokenBucketState;
  adaptive: AdaptiveState;
  lastSeen: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function trafficShapingMiddleware(config?: TrafficShapingConfig): MiddlewareHandler {
  if (!config?.enabled) {
    return async (_c, next) => {
      await next();
    };
  }

  const resolvedConfig = config;
  const adaptive = resolvedConfig.adaptive;
  const adaptiveEnabled = adaptive.enabled;
  const minRps = adaptiveEnabled ? Math.max(0.1, adaptive.minRps) : resolvedConfig.requestsPerSecond;
  const maxRps = adaptiveEnabled ? Math.max(minRps, adaptive.maxRps) : resolvedConfig.requestsPerSecond;

  const buckets = new Map<string, TenantBucket>();
  const maxBuckets = 10000;

  function getClientId(c: Parameters<MiddlewareHandler>[0]): string {
    const tenantId = c.get('tenantId') as string | undefined;
    if (tenantId) return tenantId;
    const forwardedFor = c.req.header('x-forwarded-for');
    if (forwardedFor) return forwardedFor.split(',')[0]?.trim() || 'unknown';
    const realIp = c.req.header('x-real-ip');
    if (realIp) return realIp.trim();
    return 'anonymous';
  }

  function getBucket(id: string): TenantBucket {
    let entry = buckets.get(id);
    if (!entry) {
      entry = {
        bucket: {
          tokens: Math.max(1, resolvedConfig.burst),
          lastRefillAt: Date.now(),
        },
        adaptive: {
          currentRps: clamp(resolvedConfig.requestsPerSecond, minRps, maxRps),
          lastAdjustedAt: Date.now(),
          emaLatencyMs: 0,
          emaErrorRate: 0,
        },
        lastSeen: Date.now(),
      };
      buckets.set(id, entry);
      if (buckets.size > maxBuckets) {
        const oldest = Array.from(buckets.entries()).sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
        if (oldest) buckets.delete(oldest[0]);
      }
    }
    entry.lastSeen = Date.now();
    return entry;
  }

  return async (c, next) => {
    if (!c.req.path.startsWith('/v1/')) {
      await next();
      return;
    }

    const clientId = getClientId(c);
    const state = getBucket(clientId);
    const adaptiveState = state.adaptive;
    const bucket = state.bucket;

    const now = Date.now();
    const elapsedMs = Math.max(0, now - bucket.lastRefillAt);
    const refillTokens = (elapsedMs / 1000) * adaptiveState.currentRps;
    bucket.tokens = Math.min(resolvedConfig.burst, bucket.tokens + refillTokens);
    bucket.lastRefillAt = now;

    if (bucket.tokens < 1) {
      observabilityMetrics.recordTrafficShapingThrottle('token_bucket');
      c.header('Retry-After', '1');
      c.header('x-untangle-traffic-shaping', 'throttled');
      return c.json({
        error: {
          message: 'Traffic shaping throttle exceeded. Retry later.',
          type: 'rate_limit_error',
          code: 'traffic_shaping_throttled',
        },
      }, 429);
    }

    bucket.tokens -= 1;

    const startedAt = Date.now();
    await next();
    const latencyMs = Date.now() - startedAt;
    const errored = c.res.status >= 500 || c.res.status === 429;

    if (!adaptiveEnabled) {
      return;
    }

    const alpha = 0.2;
    adaptiveState.emaLatencyMs = adaptiveState.emaLatencyMs === 0
      ? latencyMs
      : ((1 - alpha) * adaptiveState.emaLatencyMs) + (alpha * latencyMs);
    const errorSample = errored ? 1 : 0;
    adaptiveState.emaErrorRate = ((1 - alpha) * adaptiveState.emaErrorRate) + (alpha * errorSample);

    const elapsedSinceAdjust = Date.now() - adaptiveState.lastAdjustedAt;
    if (elapsedSinceAdjust < adaptive.adjustIntervalMs) {
      return;
    }
    adaptiveState.lastAdjustedAt = Date.now();

    const shouldDecrease = adaptiveState.emaLatencyMs > adaptive.targetLatencyMs
      || adaptiveState.emaErrorRate > adaptive.errorRateThreshold;

    if (shouldDecrease) {
      adaptiveState.currentRps = clamp(
        adaptiveState.currentRps * adaptive.decreaseFactor,
        minRps,
        maxRps,
      );
    } else {
      adaptiveState.currentRps = clamp(
        adaptiveState.currentRps + adaptive.increaseStep,
        minRps,
        maxRps,
      );
    }
    observabilityMetrics.setTrafficShapingCurrentRps(adaptiveState.currentRps);
  };
}
