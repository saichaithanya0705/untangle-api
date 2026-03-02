import type { ProviderAdapter, ProviderRegistry } from '../types/provider.js';

export type RoutingStrategy = 'priority' | 'weighted' | 'shuffle' | 'least-latency';
export type DeploymentLane = 'stable' | 'canary' | 'shadow';
export type RolloutMode = 'disabled' | 'canary' | 'ab';

export interface RetryPolicyConfig {
  maxAttempts?: number;
  retryableStatusCodes?: number[];
}

export interface CircuitBreakerConfig {
  failureThreshold?: number;
  resetTimeoutMs?: number;
}

export type StreamFallbackMode = 'continue-disabled' | 'continue-with-policy-prompt';

export interface StreamFallbackPolicyConfig {
  mode?: StreamFallbackMode;
  policyPrompt?: string;
}

export interface RoutingDeploymentConfig {
  provider: string;
  model: string;
  weight?: number;
  priority?: number;
  enabled?: boolean;
  region?: string;
  lane?: DeploymentLane;
}

export interface DeploymentGroupConfig {
  alias: string;
  strategy?: RoutingStrategy;
  deployments: RoutingDeploymentConfig[];
  cooldownMs?: number;
  retryPolicy?: RetryPolicyConfig;
  circuitBreaker?: CircuitBreakerConfig;
  streamFallbackPolicy?: StreamFallbackPolicyConfig;
  rollout?: {
    mode?: RolloutMode;
    canaryPercent?: number;
    includeStableFallback?: boolean;
    shadow?: {
      enabled?: boolean;
      samplePercent?: number;
      maxDeployments?: number;
    };
  };
}

export interface RegionRoutingConfig {
  enabled?: boolean;
  homeRegion?: string;
  defaultClientRegion?: string;
  failoverRegions?: string[];
  allowCrossRegionFallback?: boolean;
  failureEjection?: {
    enabled?: boolean;
    failureThreshold?: number;
    cooldownMs?: number;
  };
}

export interface RoutingConfig {
  groups?: DeploymentGroupConfig[];
  defaultStrategy?: RoutingStrategy;
  defaultCooldownMs?: number;
  defaultRetryPolicy?: RetryPolicyConfig;
  defaultCircuitBreaker?: CircuitBreakerConfig;
  defaultStreamFallbackPolicy?: StreamFallbackPolicyConfig;
  regionRouting?: RegionRoutingConfig;
}

export interface ResolvedDeployment {
  id: string;
  providerId: string;
  modelId: string;
  region?: string;
  lane: DeploymentLane;
  adapter: ProviderAdapter;
  strategy: RoutingStrategy;
  cooldownMs: number;
  priority: number;
  weight: number;
  retryPolicy: Required<RetryPolicyConfig>;
  circuitBreaker: Required<CircuitBreakerConfig>;
  streamFallbackPolicy: Required<StreamFallbackPolicyConfig>;
}

interface DeploymentState {
  consecutiveFailures: number;
  cooldownUntil?: number;
  circuitState: 'closed' | 'open' | 'half-open';
  circuitOpenedAt?: number;
  emaLatencyMs?: number;
}

interface RegionEjectionState {
  consecutiveFailures: number;
  forced: boolean;
  ejectedUntil?: number;
  reason?: string;
}

interface InternalGroupConfig {
  alias: string;
  strategy: RoutingStrategy;
  cooldownMs: number;
  retryPolicy: Required<RetryPolicyConfig>;
  circuitBreaker: Required<CircuitBreakerConfig>;
  streamFallbackPolicy: Required<StreamFallbackPolicyConfig>;
  rollout: {
    mode: RolloutMode;
    canaryPercent: number;
    includeStableFallback: boolean;
    shadow: {
      enabled: boolean;
      samplePercent: number;
      maxDeployments: number;
    };
  };
  deployments: Array<{
    provider: string;
    model: string;
    enabled: boolean;
    priority: number;
    weight: number;
    region?: string;
    lane: DeploymentLane;
  }>;
}

export interface DeploymentSelection {
  deployments: ResolvedDeployment[];
  shadowDeployments: ResolvedDeployment[];
  maxAttempts: number;
}

export interface DeploymentSelectionContext {
  clientRegion?: string;
  allowCrossRegionFallback?: boolean;
  rolloutKey?: string;
}

export interface DeploymentFailure {
  retryAfterMs?: number;
}

export interface DeploymentRuntimeState {
  consecutiveFailures: number;
  cooldownUntil?: number;
  circuitState: 'closed' | 'open' | 'half-open';
  circuitOpenedAt?: number;
  emaLatencyMs?: number;
}

export interface SelectionDebugDeployment extends ResolvedDeployment {
  runtimeState: DeploymentRuntimeState;
  eligible: boolean;
}

export interface SelectionDebugSnapshot {
  modelAlias: string;
  strategy: RoutingStrategy;
  maxAttempts: number;
  deployments: SelectionDebugDeployment[];
  shadowDeployments: SelectionDebugDeployment[];
}

export interface RegionEjectionInfo {
  region: string;
  ejected: boolean;
  forced: boolean;
  reason?: string;
  ejectedUntil?: number;
  consecutiveFailures: number;
}

interface RouterDependencies {
  now?: () => number;
  random?: () => number;
}

const DEFAULT_RETRYABLE_STATUS_CODES = [408, 409, 429, 500, 502, 503, 504];
const DEFAULT_RETRY_POLICY: Required<RetryPolicyConfig> = {
  maxAttempts: 3,
  retryableStatusCodes: DEFAULT_RETRYABLE_STATUS_CODES,
};
const DEFAULT_CIRCUIT_BREAKER: Required<CircuitBreakerConfig> = {
  failureThreshold: 3,
  resetTimeoutMs: 30_000,
};
const DEFAULT_STREAM_FALLBACK_POLICY: Required<StreamFallbackPolicyConfig> = {
  mode: 'continue-disabled',
  policyPrompt: 'The previous assistant response was interrupted. Continue from the exact point where it stopped without repeating prior text.',
};
const DEFAULT_ROLLOUT = {
  mode: 'disabled' as RolloutMode,
  canaryPercent: 0,
  includeStableFallback: true,
  shadow: {
    enabled: false,
    samplePercent: 0,
    maxDeployments: 1,
  },
};
const DEFAULT_REGION_ROUTING: Required<Pick<RegionRoutingConfig, 'enabled' | 'allowCrossRegionFallback' | 'failoverRegions'>> = {
  enabled: false,
  allowCrossRegionFallback: true,
  failoverRegions: [],
};
const DEFAULT_REGION_FAILURE_EJECTION = {
  enabled: false,
  failureThreshold: 5,
  cooldownMs: 30_000,
} as const;

export class DeploymentRouter {
  private readonly groups = new Map<string, InternalGroupConfig>();
  private readonly states = new Map<string, DeploymentState>();
  private readonly regionStates = new Map<string, RegionEjectionState>();
  private readonly defaultStrategy: RoutingStrategy;
  private readonly defaultCooldownMs: number;
  private readonly defaultRetryPolicy: Required<RetryPolicyConfig>;
  private readonly defaultCircuitBreaker: Required<CircuitBreakerConfig>;
  private readonly defaultStreamFallbackPolicy: Required<StreamFallbackPolicyConfig>;
  private readonly regionRouting: Required<Pick<RegionRoutingConfig, 'enabled' | 'allowCrossRegionFallback' | 'failoverRegions'>> & {
    homeRegion?: string;
    defaultClientRegion?: string;
    failureEjection: {
      enabled: boolean;
      failureThreshold: number;
      cooldownMs: number;
    };
  };
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(config: RoutingConfig | undefined, deps?: RouterDependencies) {
    this.defaultStrategy = config?.defaultStrategy ?? 'priority';
    this.defaultCooldownMs = config?.defaultCooldownMs ?? 0;
    this.defaultRetryPolicy = this.normalizeRetryPolicy(config?.defaultRetryPolicy);
    this.defaultCircuitBreaker = this.normalizeCircuitBreaker(config?.defaultCircuitBreaker);
    this.defaultStreamFallbackPolicy = this.normalizeStreamFallbackPolicy(config?.defaultStreamFallbackPolicy);
    this.regionRouting = this.normalizeRegionRouting(config?.regionRouting);
    this.now = deps?.now ?? Date.now;
    this.random = deps?.random ?? Math.random;

    for (const group of config?.groups ?? []) {
      const normalized: InternalGroupConfig = {
        alias: group.alias,
        strategy: group.strategy ?? this.defaultStrategy,
        cooldownMs: group.cooldownMs ?? this.defaultCooldownMs,
        retryPolicy: this.normalizeRetryPolicy(group.retryPolicy),
        circuitBreaker: this.normalizeCircuitBreaker(group.circuitBreaker),
        streamFallbackPolicy: this.normalizeStreamFallbackPolicy(
          group.streamFallbackPolicy,
          this.defaultStreamFallbackPolicy,
        ),
        rollout: this.normalizeRollout(group.rollout),
        deployments: (group.deployments ?? [])
          .filter((deployment) => deployment.enabled ?? true)
          .map((deployment, index) => ({
            provider: deployment.provider,
            model: deployment.model,
            enabled: deployment.enabled ?? true,
            priority: deployment.priority ?? index,
            weight: deployment.weight ?? 1,
            region: deployment.region?.trim() || undefined,
            lane: deployment.lane ?? 'stable',
          })),
      };
      this.groups.set(normalized.alias, normalized);
    }
  }

  selectDeployments(
    modelAlias: string,
    registry: ProviderRegistry,
    context?: DeploymentSelectionContext,
  ): DeploymentSelection {
    const group = this.groups.get(modelAlias);
    if (!group) {
      const fallback = this.selectSingleModel(modelAlias, registry);
      return {
        deployments: fallback ? [fallback] : [],
        shadowDeployments: [],
        maxAttempts: fallback ? 1 : 0,
      };
    }

    const deployments = this.resolveGroupDeployments(group, registry);
    const { primaryDeployments, shadowDeployments } = this.applyRollout(group, deployments, context);
    const ordered = this.orderDeployments(group.strategy, primaryDeployments, context);
    const eligible = ordered.filter((deployment) => this.canAttempt(deployment));
    const maxAttempts = Math.min(group.retryPolicy.maxAttempts, eligible.length);
    const orderedShadow = this.orderDeployments(group.strategy, shadowDeployments, context)
      .filter((deployment) => this.canAttempt(deployment))
      .slice(0, group.rollout.shadow.maxDeployments);

    return {
      deployments: eligible.slice(0, maxAttempts),
      shadowDeployments: orderedShadow,
      maxAttempts,
    };
  }

  isRetryableStatus(deployment: ResolvedDeployment, status: number): boolean {
    return deployment.retryPolicy.retryableStatusCodes.includes(status);
  }

  isRetryableError(_deployment: ResolvedDeployment, error: unknown): boolean {
    if (!error) return false;
    if (error instanceof TypeError) return true;
    if (error instanceof Error && /timed out|timeout|network|fetch|interrupted|abort(ed)?|stream/i.test(error.message)) {
      return true;
    }
    return false;
  }

  recordSuccess(deployment: ResolvedDeployment, latencyMs: number): void {
    const state = this.getState(deployment.id);
    state.consecutiveFailures = 0;
    state.circuitState = 'closed';
    state.circuitOpenedAt = undefined;
    state.cooldownUntil = undefined;
    state.emaLatencyMs = state.emaLatencyMs === undefined
      ? latencyMs
      : (state.emaLatencyMs * 0.8) + (latencyMs * 0.2);
    this.recordRegionSuccess(deployment.region);
  }

  recordFailure(deployment: ResolvedDeployment, failure?: DeploymentFailure): void {
    const state = this.getState(deployment.id);
    const now = this.now();
    state.consecutiveFailures += 1;

    const retryAfterMs = failure?.retryAfterMs ?? 0;
    const cooldownMs = Math.max(deployment.cooldownMs, retryAfterMs);
    if (cooldownMs > 0) {
      state.cooldownUntil = now + cooldownMs;
    }

    if (state.consecutiveFailures >= deployment.circuitBreaker.failureThreshold || state.circuitState === 'half-open') {
      state.circuitState = 'open';
      state.circuitOpenedAt = now;
    }
    this.recordRegionFailure(deployment.region);
  }

  getLatencyEstimate(deploymentId: string): number | undefined {
    return this.states.get(deploymentId)?.emaLatencyMs;
  }

  getSelectionDebug(
    modelAlias: string,
    registry: ProviderRegistry,
    context?: DeploymentSelectionContext,
  ): SelectionDebugSnapshot {
    const group = this.groups.get(modelAlias);
    if (!group) {
      const fallback = this.selectSingleModel(modelAlias, registry);
      if (!fallback) {
        return {
          modelAlias,
          strategy: this.defaultStrategy,
          maxAttempts: 0,
          deployments: [],
          shadowDeployments: [],
        };
      }

      const state = this.getState(fallback.id);
      return {
        modelAlias,
        strategy: this.defaultStrategy,
        maxAttempts: 1,
        deployments: [{
          ...fallback,
          runtimeState: { ...state },
          eligible: this.canAttempt(fallback),
        }],
        shadowDeployments: [],
      };
    }

    const deployments = this.resolveGroupDeployments(group, registry);
    const { primaryDeployments, shadowDeployments } = this.applyRollout(group, deployments, context);
    const ordered = this.orderDeployments(group.strategy, primaryDeployments, context);
    const debugDeployments = ordered.map((deployment) => {
      const state = this.getState(deployment.id);
      return {
        ...deployment,
        runtimeState: { ...state },
        eligible: this.canAttempt(deployment),
      };
    });
    const debugShadowDeployments = this
      .orderDeployments(group.strategy, shadowDeployments, context)
      .map((deployment) => {
        const state = this.getState(deployment.id);
        return {
          ...deployment,
          runtimeState: { ...state },
          eligible: this.canAttempt(deployment),
        };
      });

    const eligibleCount = debugDeployments.filter((deployment) => deployment.eligible).length;
    return {
      modelAlias,
      strategy: group.strategy,
      maxAttempts: Math.min(group.retryPolicy.maxAttempts, eligibleCount),
      deployments: debugDeployments,
      shadowDeployments: debugShadowDeployments,
    };
  }

  getHealthSnapshot(): {
    groups: Array<{ alias: string; strategy: RoutingStrategy; deploymentCount: number }>;
    states: Array<{ deploymentId: string; state: DeploymentRuntimeState }>;
    regions: RegionEjectionInfo[];
  } {
    return {
      groups: Array.from(this.groups.values()).map((group) => ({
        alias: group.alias,
        strategy: group.strategy,
        deploymentCount: group.deployments.length,
      })),
      states: Array.from(this.states.entries()).map(([deploymentId, state]) => ({
        deploymentId,
        state: { ...state },
      })),
      regions: this.listRegionEjections(),
    };
  }

  ejectRegion(region: string, input?: {
    ttlMs?: number;
    reason?: string;
    forced?: boolean;
  }): boolean {
    const normalizedRegion = region.trim();
    if (normalizedRegion.length === 0) {
      return false;
    }

    const now = this.now();
    const state = this.getRegionState(normalizedRegion);
    const forced = input?.forced ?? true;
    state.forced = forced;

    const ttlMs = input?.ttlMs;
    if (Number.isFinite(ttlMs) && (ttlMs ?? 0) > 0) {
      state.ejectedUntil = now + Number(ttlMs);
    } else if (forced) {
      state.ejectedUntil = undefined;
    } else {
      state.ejectedUntil = now + this.regionRouting.failureEjection.cooldownMs;
    }

    const reason = input?.reason?.trim();
    state.reason = reason && reason.length > 0
      ? reason
      : (forced ? 'manual_failover' : 'auto_failure_ejection');
    return true;
  }

  restoreRegion(region: string): boolean {
    const normalizedRegion = region.trim();
    if (normalizedRegion.length === 0) {
      return false;
    }
    return this.regionStates.delete(normalizedRegion);
  }

  listRegionEjections(): RegionEjectionInfo[] {
    const regionSet = new Set<string>();
    for (const region of this.regionStates.keys()) {
      regionSet.add(region);
    }
    for (const group of this.groups.values()) {
      for (const deployment of group.deployments) {
        if (deployment.region) {
          regionSet.add(deployment.region);
        }
      }
    }
    for (const region of this.regionRouting.failoverRegions) {
      regionSet.add(region);
    }
    if (this.regionRouting.homeRegion) {
      regionSet.add(this.regionRouting.homeRegion);
    }
    if (this.regionRouting.defaultClientRegion) {
      regionSet.add(this.regionRouting.defaultClientRegion);
    }

    return Array.from(regionSet)
      .sort((left, right) => left.localeCompare(right))
      .map((region) => {
        const state = this.regionStates.get(region);
        return {
          region,
          ejected: this.isRegionEjected(region),
          forced: state?.forced ?? false,
          reason: state?.reason,
          ejectedUntil: state?.ejectedUntil,
          consecutiveFailures: state?.consecutiveFailures ?? 0,
        };
      });
  }

  private selectSingleModel(modelAlias: string, registry: ProviderRegistry): ResolvedDeployment | null {
    const adapter = registry.getForModel(modelAlias);
    if (!adapter) return null;

    const modelId = adapter.getModelConfig(modelAlias)?.id ?? modelAlias;
    return {
      id: `${adapter.config.id}:${modelId}`,
      providerId: adapter.config.id,
      modelId,
      region: this.regionRouting.homeRegion,
      lane: 'stable',
      adapter,
      strategy: this.defaultStrategy,
      cooldownMs: this.defaultCooldownMs,
      priority: 0,
      weight: 1,
      retryPolicy: this.defaultRetryPolicy,
      circuitBreaker: this.defaultCircuitBreaker,
      streamFallbackPolicy: this.defaultStreamFallbackPolicy,
    };
  }

  private resolveGroupDeployments(group: InternalGroupConfig, registry: ProviderRegistry): ResolvedDeployment[] {
    const deployments: ResolvedDeployment[] = [];

    for (const configured of group.deployments) {
      const adapter = registry.get(configured.provider);
      if (!adapter || !adapter.config.enabled) continue;
      if (!adapter.supportsModel(configured.model)) continue;

      deployments.push({
        id: `${configured.provider}:${configured.model}:${configured.lane}:${configured.region ?? 'global'}`,
        providerId: configured.provider,
        modelId: configured.model,
        region: configured.region,
        lane: configured.lane,
        adapter,
        strategy: group.strategy,
        cooldownMs: group.cooldownMs,
        priority: configured.priority,
        weight: configured.weight,
        retryPolicy: group.retryPolicy,
        circuitBreaker: group.circuitBreaker,
        streamFallbackPolicy: group.streamFallbackPolicy,
      });
    }

    return deployments;
  }

  private applyRollout(
    group: InternalGroupConfig,
    deployments: ResolvedDeployment[],
    context?: DeploymentSelectionContext,
  ): {
    primaryDeployments: ResolvedDeployment[];
    shadowDeployments: ResolvedDeployment[];
  } {
    const stable = deployments.filter((deployment) => deployment.lane !== 'canary' && deployment.lane !== 'shadow');
    const canary = deployments.filter((deployment) => deployment.lane === 'canary');
    const shadow = deployments.filter((deployment) => deployment.lane === 'shadow');

    const mode = group.rollout.mode;
    const canaryPercent = group.rollout.canaryPercent;
    const includeStableFallback = group.rollout.includeStableFallback;
    const rolloutKey = context?.rolloutKey;

    let useCanary = false;
    if (canary.length > 0) {
      if (mode === 'canary') {
        useCanary = this.resolveRolloutPercentDecision(canaryPercent, rolloutKey);
      } else if (mode === 'ab') {
        useCanary = this.resolveRolloutPercentDecision(canaryPercent, rolloutKey);
      }
    }

    let primaryDeployments: ResolvedDeployment[];
    if (useCanary && canary.length > 0) {
      primaryDeployments = includeStableFallback ? [...canary, ...stable] : [...canary];
    } else {
      primaryDeployments = stable.length > 0 ? [...stable] : [...canary];
    }

    const useShadow = group.rollout.shadow.enabled
      && shadow.length > 0
      && this.resolveRolloutPercentDecision(group.rollout.shadow.samplePercent, rolloutKey);
    const shadowDeployments = useShadow ? shadow : [];

    return {
      primaryDeployments,
      shadowDeployments,
    };
  }

  private resolveRolloutPercentDecision(percent: number, key?: string): boolean {
    const normalizedPercent = Math.min(100, Math.max(0, percent));
    if (normalizedPercent <= 0) return false;
    if (normalizedPercent >= 100) return true;
    if (key && key.trim().length > 0) {
      return this.rolloutBucket(key) < normalizedPercent;
    }
    return (this.random() * 100) < normalizedPercent;
  }

  private rolloutBucket(key: string): number {
    let hash = 0;
    for (const char of key) {
      hash = ((hash * 31) + char.charCodeAt(0)) >>> 0;
    }
    return hash % 100;
  }

  private orderDeployments(
    strategy: RoutingStrategy,
    deployments: ResolvedDeployment[],
    context?: DeploymentSelectionContext,
  ): ResolvedDeployment[] {
    if (deployments.length <= 1) return deployments;

    const strategyOrdered = (() => {
      switch (strategy) {
        case 'shuffle':
          return this.shuffle(deployments);
        case 'weighted':
          return this.weightedOrder(deployments);
        case 'least-latency':
          return [...deployments].sort((left, right) => {
            const leftLatency = this.states.get(left.id)?.emaLatencyMs ?? Number.POSITIVE_INFINITY;
            const rightLatency = this.states.get(right.id)?.emaLatencyMs ?? Number.POSITIVE_INFINITY;
            if (leftLatency === rightLatency) {
              return left.priority - right.priority;
            }
            return leftLatency - rightLatency;
          });
        case 'priority':
        default:
          return [...deployments].sort((left, right) => left.priority - right.priority);
      }
    })();

    const available = strategyOrdered.filter((deployment) =>
      !deployment.region || !this.isRegionEjected(deployment.region)
    );
    if (available.length === 0 && strategyOrdered.some((deployment) => deployment.region)) {
      return [];
    }

    return this.applyRegionPreference(available, context);
  }

  private applyRegionPreference(
    deployments: ResolvedDeployment[],
    context?: DeploymentSelectionContext,
  ): ResolvedDeployment[] {
    if (!this.regionRouting.enabled || deployments.length <= 1) {
      return deployments;
    }

    const effectiveClientRegion = context?.clientRegion?.trim()
      || this.regionRouting.defaultClientRegion?.trim();
    const allowCrossRegionFallback = context?.allowCrossRegionFallback
      ?? this.regionRouting.allowCrossRegionFallback;

    const preferenceOrder: string[] = [];
    const seenRegions = new Set<string>();
    const pushUnique = (candidate: string | undefined) => {
      const normalized = candidate?.trim();
      if (!normalized || seenRegions.has(normalized)) {
        return;
      }
      seenRegions.add(normalized);
      preferenceOrder.push(normalized);
    };

    pushUnique(effectiveClientRegion);
    for (const region of this.regionRouting.failoverRegions) {
      pushUnique(region);
    }
    pushUnique(this.regionRouting.homeRegion);

    if (preferenceOrder.length === 0) {
      return deployments;
    }

    const regionRank = new Map<string, number>();
    preferenceOrder.forEach((region, index) => {
      regionRank.set(region, index);
    });

    const ranked = deployments.map((deployment, index) => {
      const rank = deployment.region ? (regionRank.get(deployment.region) ?? Number.MAX_SAFE_INTEGER) : Number.MAX_SAFE_INTEGER;
      return { deployment, index, rank };
    });

    if (!allowCrossRegionFallback && effectiveClientRegion) {
      const localOnly = ranked
        .filter((item) => item.deployment.region === effectiveClientRegion)
        .sort((left, right) => left.index - right.index)
        .map((item) => item.deployment);

      if (localOnly.length > 0) {
        return localOnly;
      }
    }

    return ranked
      .sort((left, right) => {
        if (left.rank !== right.rank) return left.rank - right.rank;
        return left.index - right.index;
      })
      .map((item) => item.deployment);
  }

  private shuffle(deployments: ResolvedDeployment[]): ResolvedDeployment[] {
    const result = [...deployments];
    for (let i = result.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.random() * (i + 1));
      [result[i], result[j]] = [result[j], result[i]];
    }
    return result;
  }

  private weightedOrder(deployments: ResolvedDeployment[]): ResolvedDeployment[] {
    const pool = [...deployments];
    const ordered: ResolvedDeployment[] = [];

    while (pool.length > 0) {
      const totalWeight = pool.reduce((sum, item) => sum + Math.max(item.weight, 0), 0);
      if (totalWeight <= 0) {
        ordered.push(...this.shuffle(pool));
        break;
      }

      let cursor = this.random() * totalWeight;
      let selectedIndex = 0;

      for (let i = 0; i < pool.length; i += 1) {
        cursor -= Math.max(pool[i].weight, 0);
        if (cursor <= 0) {
          selectedIndex = i;
          break;
        }
      }

      ordered.push(pool[selectedIndex]);
      pool.splice(selectedIndex, 1);
    }

    return ordered;
  }

  private canAttempt(deployment: ResolvedDeployment): boolean {
    const state = this.getState(deployment.id);
    const now = this.now();

    if (state.cooldownUntil !== undefined && now < state.cooldownUntil) {
      return false;
    }

    if (state.circuitState === 'open') {
      const openedAt = state.circuitOpenedAt ?? now;
      if (now - openedAt < deployment.circuitBreaker.resetTimeoutMs) {
        return false;
      }
      state.circuitState = 'half-open';
    }

    return true;
  }

  private getState(deploymentId: string): DeploymentState {
    let state = this.states.get(deploymentId);
    if (!state) {
      state = { consecutiveFailures: 0, circuitState: 'closed' };
      this.states.set(deploymentId, state);
    }
    return state;
  }

  private getRegionState(region: string): RegionEjectionState {
    let state = this.regionStates.get(region);
    if (!state) {
      state = {
        consecutiveFailures: 0,
        forced: false,
      };
      this.regionStates.set(region, state);
    }
    return state;
  }

  private recordRegionFailure(region: string | undefined): void {
    const normalizedRegion = region?.trim();
    if (!normalizedRegion) return;

    const state = this.getRegionState(normalizedRegion);
    state.consecutiveFailures += 1;
    if (state.forced) {
      return;
    }

    const config = this.regionRouting.failureEjection;
    if (!config.enabled) {
      return;
    }

    if (state.consecutiveFailures >= config.failureThreshold) {
      state.ejectedUntil = this.now() + config.cooldownMs;
      state.reason = 'auto_failure_ejection';
      state.forced = false;
    }
  }

  private recordRegionSuccess(region: string | undefined): void {
    const normalizedRegion = region?.trim();
    if (!normalizedRegion) return;

    const state = this.regionStates.get(normalizedRegion);
    if (!state) return;

    if (!state.forced && !this.isRegionEjected(normalizedRegion)) {
      this.regionStates.delete(normalizedRegion);
      return;
    }

    if (!state.forced) {
      state.consecutiveFailures = 0;
    }
  }

  private isRegionEjected(region: string): boolean {
    const state = this.regionStates.get(region);
    if (!state) {
      return false;
    }
    if (state.forced) {
      return true;
    }
    if (state.ejectedUntil === undefined) {
      return false;
    }

    if (this.now() < state.ejectedUntil) {
      return true;
    }

    this.regionStates.delete(region);
    return false;
  }

  private normalizeRetryPolicy(policy: RetryPolicyConfig | undefined): Required<RetryPolicyConfig> {
    return {
      maxAttempts: Math.max(1, policy?.maxAttempts ?? DEFAULT_RETRY_POLICY.maxAttempts),
      retryableStatusCodes: policy?.retryableStatusCodes && policy.retryableStatusCodes.length > 0
        ? [...policy.retryableStatusCodes]
        : [...DEFAULT_RETRY_POLICY.retryableStatusCodes],
    };
  }

  private normalizeCircuitBreaker(config: CircuitBreakerConfig | undefined): Required<CircuitBreakerConfig> {
    return {
      failureThreshold: Math.max(1, config?.failureThreshold ?? DEFAULT_CIRCUIT_BREAKER.failureThreshold),
      resetTimeoutMs: Math.max(0, config?.resetTimeoutMs ?? DEFAULT_CIRCUIT_BREAKER.resetTimeoutMs),
    };
  }

  private normalizeStreamFallbackPolicy(
    config: StreamFallbackPolicyConfig | undefined,
    seed?: Required<StreamFallbackPolicyConfig>,
  ): Required<StreamFallbackPolicyConfig> {
    const base = seed ?? DEFAULT_STREAM_FALLBACK_POLICY;
    const mode = config?.mode ?? base.mode;
    const candidatePrompt = config?.policyPrompt?.trim() ?? '';
    return {
      mode,
      policyPrompt: candidatePrompt.length > 0 ? candidatePrompt : base.policyPrompt,
    };
  }

  private normalizeRollout(
    config: DeploymentGroupConfig['rollout'] | undefined,
  ): InternalGroupConfig['rollout'] {
    const mode = config?.mode ?? DEFAULT_ROLLOUT.mode;
    const normalizedMode: RolloutMode = mode === 'canary' || mode === 'ab' || mode === 'disabled'
      ? mode
      : DEFAULT_ROLLOUT.mode;

    const normalizePercent = (value: number | undefined, fallback: number): number => {
      if (!Number.isFinite(value)) {
        return fallback;
      }
      return Math.min(100, Math.max(0, Number(value)));
    };

    const canaryPercent = normalizePercent(config?.canaryPercent, DEFAULT_ROLLOUT.canaryPercent);
    const shadowSamplePercent = normalizePercent(
      config?.shadow?.samplePercent,
      DEFAULT_ROLLOUT.shadow.samplePercent,
    );
    const maxDeployments = Math.max(
      1,
      Math.floor(config?.shadow?.maxDeployments ?? DEFAULT_ROLLOUT.shadow.maxDeployments),
    );

    return {
      mode: normalizedMode,
      canaryPercent,
      includeStableFallback: config?.includeStableFallback ?? DEFAULT_ROLLOUT.includeStableFallback,
      shadow: {
        enabled: config?.shadow?.enabled ?? DEFAULT_ROLLOUT.shadow.enabled,
        samplePercent: shadowSamplePercent,
        maxDeployments,
      },
    };
  }

  private normalizeRegionRouting(
    config: RegionRoutingConfig | undefined,
  ): Required<Pick<RegionRoutingConfig, 'enabled' | 'allowCrossRegionFallback' | 'failoverRegions'>> & {
    homeRegion?: string;
    defaultClientRegion?: string;
    failureEjection: {
      enabled: boolean;
      failureThreshold: number;
      cooldownMs: number;
    };
  } {
    const normalizeText = (value: string | undefined): string | undefined => {
      const trimmed = value?.trim();
      return trimmed && trimmed.length > 0 ? trimmed : undefined;
    };

    const normalizedFailover = (config?.failoverRegions ?? [])
      .map((region) => region.trim())
      .filter((region) => region.length > 0);

    return {
      enabled: config?.enabled ?? DEFAULT_REGION_ROUTING.enabled,
      allowCrossRegionFallback: config?.allowCrossRegionFallback ?? DEFAULT_REGION_ROUTING.allowCrossRegionFallback,
      failoverRegions: normalizedFailover.length > 0
        ? normalizedFailover
        : [...DEFAULT_REGION_ROUTING.failoverRegions],
      homeRegion: normalizeText(config?.homeRegion),
      defaultClientRegion: normalizeText(config?.defaultClientRegion),
      failureEjection: {
        enabled: config?.failureEjection?.enabled ?? DEFAULT_REGION_FAILURE_EJECTION.enabled,
        failureThreshold: Math.max(
          1,
          config?.failureEjection?.failureThreshold ?? DEFAULT_REGION_FAILURE_EJECTION.failureThreshold,
        ),
        cooldownMs: Math.max(
          0,
          config?.failureEjection?.cooldownMs ?? DEFAULT_REGION_FAILURE_EJECTION.cooldownMs,
        ),
      },
    };
  }
}
