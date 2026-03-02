import type { Context } from 'hono';
import type { DeploymentSelectionContext, RoutingConfig } from '@untangle-ai/core';

const DEFAULT_REGION_HINT_HEADERS = ['x-untangle-region', 'x-region'];
const DEFAULT_ROLLOUT_KEY_HEADERS = ['x-untangle-rollout-key', 'x-untangle-ab-key'];

function normalizeRegion(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function resolveDeploymentSelectionContext(
  c: Context,
  routingConfig: RoutingConfig | undefined,
): DeploymentSelectionContext | undefined {
  let rolloutKey: string | undefined;
  for (const header of DEFAULT_ROLLOUT_KEY_HEADERS) {
    const value = c.req.header(header)?.trim();
    if (value && value.length > 0) {
      rolloutKey = value;
      break;
    }
  }

  const regionRouting = routingConfig?.regionRouting;
  if (!regionRouting?.enabled) {
    return rolloutKey ? { rolloutKey } : undefined;
  }

  let clientRegion: string | undefined;
  for (const header of DEFAULT_REGION_HINT_HEADERS) {
    const value = normalizeRegion(c.req.header(header));
    if (value) {
      clientRegion = value;
      break;
    }
  }

  const fallbackAllowed = regionRouting.allowCrossRegionFallback;
  return {
    clientRegion,
    allowCrossRegionFallback: typeof fallbackAllowed === 'boolean' ? fallbackAllowed : undefined,
    rolloutKey,
  };
}
