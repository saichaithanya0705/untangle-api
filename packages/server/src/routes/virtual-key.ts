import type { Context } from 'hono';
import type { ControlPlaneService, LimitCheckResult } from '@untangle-ai/core';
import { observabilityMetrics } from '../observability/metrics.js';

export interface VirtualKeyRouteContext {
  controlPlane?: ControlPlaneService;
  virtualKeyHeader?: string;
}

export interface VirtualKeyGateResult {
  virtualKeyId?: string;
  deniedResponse?: Response;
}

function toRetryAfterSeconds(retryAfterMs?: number): string | undefined {
  if (!retryAfterMs || !Number.isFinite(retryAfterMs)) return undefined;
  return String(Math.max(1, Math.ceil(retryAfterMs / 1000)));
}

function toLimitStatus(result: LimitCheckResult): 403 | 429 {
  if (result.reason === 'model_denied') {
    return 403;
  }
  return 429;
}

function toLimitMessage(result: LimitCheckResult): string {
  switch (result.reason) {
    case 'model_denied':
      return 'Model is not allowed for this virtual key.';
    case 'rpm_exceeded':
      return 'Requests per minute limit exceeded for this virtual key.';
    case 'tpm_exceeded':
      return 'Tokens per minute limit exceeded for this virtual key.';
    case 'daily_budget_exceeded':
      return 'Daily budget exceeded for this virtual key.';
    case 'monthly_budget_exceeded':
      return 'Monthly budget exceeded for this virtual key.';
    default:
      return 'Virtual key limits exceeded.';
  }
}

function toLimitType(result: LimitCheckResult): 'permission_error' | 'rate_limit_error' {
  return result.reason === 'model_denied' ? 'permission_error' : 'rate_limit_error';
}

export async function enforceVirtualKeyGate(
  c: Context,
  ctx: VirtualKeyRouteContext,
  input: { modelId?: string; inputTokens?: number } = {},
): Promise<VirtualKeyGateResult> {
  if (!ctx.controlPlane) {
    return {};
  }

  const headerName = (ctx.virtualKeyHeader ?? 'x-untangle-key').trim() || 'x-untangle-key';
  const rawKey = c.req.header(headerName)?.trim();
  if (!rawKey) {
    return {};
  }

  let resolved;
  try {
    resolved = await ctx.controlPlane.resolveVirtualKey(rawKey);
  } catch {
    observabilityMetrics.recordRateLimitHit('control_plane_unavailable');
    return {
      deniedResponse: c.json({
        error: {
          message: 'Control-plane key validation is temporarily unavailable.',
          type: 'api_error',
          code: 'control_plane_unavailable',
        },
      }, 503),
    };
  }
  if (!resolved) {
    return {
      deniedResponse: c.json({
        error: {
          message: 'Invalid or revoked virtual key.',
          type: 'authentication_error',
          code: 'invalid_virtual_key',
        },
      }, 401),
    };
  }

  let limitResult;
  try {
    limitResult = await ctx.controlPlane.checkLimits(resolved.key, {
      modelId: input.modelId,
      inputTokens: input.inputTokens,
    });
  } catch {
    observabilityMetrics.recordRateLimitHit('control_plane_unavailable');
    return {
      deniedResponse: c.json({
        error: {
          message: 'Control-plane limits service is temporarily unavailable.',
          type: 'api_error',
          code: 'control_plane_unavailable',
        },
        keyId: resolved.key.id,
      }, 503),
    };
  }
  if (limitResult.allowed) {
    return { virtualKeyId: resolved.key.id };
  }

  const status = toLimitStatus(limitResult);
  observabilityMetrics.recordRateLimitHit(limitResult.reason ?? 'limit_exceeded');

  const retryAfter = toRetryAfterSeconds(limitResult.retryAfterMs);
  const headers = retryAfter && status === 429
    ? { 'Retry-After': retryAfter }
    : undefined;

  return {
    deniedResponse: c.json({
      error: {
        message: toLimitMessage(limitResult),
        type: toLimitType(limitResult),
        code: limitResult.reason ?? 'limit_exceeded',
      },
      retryAfterMs: limitResult.retryAfterMs,
      keyId: resolved.key.id,
    }, status, headers),
  };
}

export function estimateTextTokens(input: string): number {
  return Math.ceil(input.length / 4);
}
