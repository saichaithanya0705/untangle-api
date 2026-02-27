import type { ProviderAdapter, ProviderRegistry } from '../types/provider.js';

export type RoutingStrategy = 'priority' | 'weighted' | 'shuffle' | 'least-latency';

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
}

export interface DeploymentGroupConfig {
  alias: string;
  strategy?: RoutingStrategy;
  deployments: RoutingDeploymentConfig[];
  cooldownMs?: number;
  retryPolicy?: RetryPolicyConfig;
  circuitBreaker?: CircuitBreakerConfig;
  streamFallbackPolicy?: StreamFallbackPolicyConfig;
}

export interface RoutingConfig {
  groups?: DeploymentGroupConfig[];
  defaultStrategy?: RoutingStrategy;
  defaultCooldownMs?: number;
  defaultRetryPolicy?: RetryPolicyConfig;
  defaultCircuitBreaker?: CircuitBreakerConfig;
  defaultStreamFallbackPolicy?: StreamFallbackPolicyConfig;
}

export interface ResolvedDeployment {
  id: string;
  providerId: string;
  modelId: string;
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

interface InternalGroupConfig {
  alias: string;
  strategy: RoutingStrategy;
  cooldownMs: number;
  retryPolicy: Required<RetryPolicyConfig>;
  circuitBreaker: Required<CircuitBreakerConfig>;
  streamFallbackPolicy: Required<StreamFallbackPolicyConfig>;
  deployments: Array<Required<Omit<RoutingDeploymentConfig, 'provider' | 'model'>> & {
    provider: string;
    model: string;
  }>;
}

export interface DeploymentSelection {
  deployments: ResolvedDeployment[];
  maxAttempts: number;
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

export class DeploymentRouter {
  private readonly groups = new Map<string, InternalGroupConfig>();
  private readonly states = new Map<string, DeploymentState>();
  private readonly defaultStrategy: RoutingStrategy;
  private readonly defaultCooldownMs: number;
  private readonly defaultRetryPolicy: Required<RetryPolicyConfig>;
  private readonly defaultCircuitBreaker: Required<CircuitBreakerConfig>;
  private readonly defaultStreamFallbackPolicy: Required<StreamFallbackPolicyConfig>;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(config: RoutingConfig | undefined, deps?: RouterDependencies) {
    this.defaultStrategy = config?.defaultStrategy ?? 'priority';
    this.defaultCooldownMs = config?.defaultCooldownMs ?? 0;
    this.defaultRetryPolicy = this.normalizeRetryPolicy(config?.defaultRetryPolicy);
    this.defaultCircuitBreaker = this.normalizeCircuitBreaker(config?.defaultCircuitBreaker);
    this.defaultStreamFallbackPolicy = this.normalizeStreamFallbackPolicy(config?.defaultStreamFallbackPolicy);
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
        deployments: (group.deployments ?? [])
          .filter((deployment) => deployment.enabled ?? true)
          .map((deployment, index) => ({
            provider: deployment.provider,
            model: deployment.model,
            enabled: deployment.enabled ?? true,
            priority: deployment.priority ?? index,
            weight: deployment.weight ?? 1,
          })),
      };
      this.groups.set(normalized.alias, normalized);
    }
  }

  selectDeployments(modelAlias: string, registry: ProviderRegistry): DeploymentSelection {
    const group = this.groups.get(modelAlias);
    if (!group) {
      const fallback = this.selectSingleModel(modelAlias, registry);
      return {
        deployments: fallback ? [fallback] : [],
        maxAttempts: fallback ? 1 : 0,
      };
    }

    const deployments = this.resolveGroupDeployments(group, registry);

    const ordered = this.orderDeployments(group.strategy, deployments);
    const eligible = ordered.filter((deployment) => this.canAttempt(deployment));
    const maxAttempts = Math.min(group.retryPolicy.maxAttempts, eligible.length);

    return {
      deployments: eligible.slice(0, maxAttempts),
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
  }

  getLatencyEstimate(deploymentId: string): number | undefined {
    return this.states.get(deploymentId)?.emaLatencyMs;
  }

  getSelectionDebug(modelAlias: string, registry: ProviderRegistry): SelectionDebugSnapshot {
    const group = this.groups.get(modelAlias);
    if (!group) {
      const fallback = this.selectSingleModel(modelAlias, registry);
      if (!fallback) {
        return {
          modelAlias,
          strategy: this.defaultStrategy,
          maxAttempts: 0,
          deployments: [],
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
      };
    }

    const deployments = this.resolveGroupDeployments(group, registry);
    const ordered = this.orderDeployments(group.strategy, deployments);
    const debugDeployments = ordered.map((deployment) => {
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
    };
  }

  getHealthSnapshot(): {
    groups: Array<{ alias: string; strategy: RoutingStrategy; deploymentCount: number }>;
    states: Array<{ deploymentId: string; state: DeploymentRuntimeState }>;
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
    };
  }

  private selectSingleModel(modelAlias: string, registry: ProviderRegistry): ResolvedDeployment | null {
    const adapter = registry.getForModel(modelAlias);
    if (!adapter) return null;

    const modelId = adapter.getModelConfig(modelAlias)?.id ?? modelAlias;
    return {
      id: `${adapter.config.id}:${modelId}`,
      providerId: adapter.config.id,
      modelId,
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
        id: `${configured.provider}:${configured.model}`,
        providerId: configured.provider,
        modelId: configured.model,
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

  private orderDeployments(strategy: RoutingStrategy, deployments: ResolvedDeployment[]): ResolvedDeployment[] {
    if (deployments.length <= 1) return deployments;

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
}
