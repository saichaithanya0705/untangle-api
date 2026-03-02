// Types
export type {
  OpenAIMessage,
  OpenAIRequest,
  OpenAIResponse,
  OpenAIChoice,
  OpenAIUsage,
  OpenAIStreamChunk,
  OpenAIError,
  OpenAITool,
  OpenAIToolCall,
  OpenAIModelInfo,
} from './types/openai.js';

export type {
  ModelCapability,
  ModelConfig,
  ProviderConfig,
  ProviderAdapter,
  ProviderRegistry as IProviderRegistry,
} from './types/provider.js';

// Classes
export { BaseProviderAdapter } from './providers/base.js';
export { ProviderRegistry, defaultRegistry, registerDefaultProviders, createDefaultRegistry } from './providers/registry.js';
export { OpenAIAdapter, openaiAdapter } from './providers/openai.js';
export { ChatGPTAdapter, chatgptAdapter } from './providers/chatgpt.js';
export { AnthropicAdapter, anthropicAdapter } from './providers/anthropic.js';
export { GoogleAdapter, googleAdapter } from './providers/google.js';
export { GroqAdapter, groqAdapter } from './providers/groq.js';
export { OpenRouterAdapter, openrouterAdapter } from './providers/openrouter.js';
export {
  getChatGPTAuthSession,
  getChatGPTAuthToken,
  resolveCodexAuthPath,
  resolveCodexOriginator,
} from './providers/chatgpt-auth.js';

// Config
export {
  ConfigSchema,
  SecurityConfigSchema,
  type Config,
  type ServerConfig,
  type CustomProviderConfig,
  type RoutingConfig,
  type DeploymentGroupConfig,
  type RoutingDeploymentConfig,
  type RetryPolicyConfig,
  type CircuitBreakerConfig,
  type StreamFallbackPolicyConfig,
  type ControlPlaneConfig,
  type ControlPlanePostgresConfig,
  type ControlPlaneRedisConfig,
  type ObservabilityLoggingConfig,
  type ObservabilityTracingConfig,
  type ObservabilityMetricsConfig,
  type ObservabilityConfig,
  type ApiCompatibilityConfig,
  type ApiConfig,
  type ExactCacheConfig,
  type CacheConfig,
  type AdaptiveTrafficShapingConfig,
  type TrafficShapingConfig,
  type SecretsConfig,
  type SecurityConfig,
} from './config/schema.js';
export { loadConfig, parseConfig } from './config/loader.js';

// Routing
export {
  DeploymentRouter,
  type RoutingStrategy,
  type DeploymentLane,
  type RolloutMode,
  type StreamFallbackMode,
  type RegionRoutingConfig,
  type ResolvedDeployment,
  type DeploymentSelection,
  type DeploymentSelectionContext,
  type DeploymentFailure,
  type DeploymentRuntimeState,
  type SelectionDebugDeployment,
  type SelectionDebugSnapshot,
  type RegionEjectionInfo,
} from './routing/index.js';

// Encryption
export { KeyStore, type EncryptedData, ProviderKeyManager } from './encryption/index.js';

// Templates
export {
  TemplateEngine,
  defaultEngine,
  CustomProviderAdapter,
  createCustomProvider,
  type CustomProviderDefinition,
} from './templates/index.js';

// Pricing & Usage
export {
  PricingFetcher,
  pricingFetcher,
  type ModelPricing,
  type PricingCache,
  UsageTracker,
  usageTracker,
  type UsageRecord,
  type UsageSummary,
  type UsageFilter,
  type UsageRecordListener,
} from './pricing/index.js';

// Control Plane
export {
  ControlPlaneService,
  InMemoryControlPlaneStore,
  InMemoryRateLimiter,
  PostgresControlPlaneStore,
  RedisRateLimiter,
  CONTROL_PLANE_POSTGRES_SCHEMA,
  renderControlPlanePostgresSchemaSql,
  type SqlQueryClient,
  type RedisCounterClient,
  type CreateVirtualKeyInput,
  type ResolveVirtualKeyResult,
  type VirtualKeyLimits,
  type VirtualKeyRecord,
  type UsageEventRecord,
  type UsageSummaryFilter,
  type SpendSummary,
  type LimitCheckResult,
  type PostgresSchemaArtifact,
  type BillingReconciliationByKey,
  type BillingReconciliationSummary,
  type ProviderBillingExportRecord,
  type ProviderBillingReconciliationByModel,
  type ProviderBillingReconciliationSummary,
  bootstrapControlPlane,
  type ControlPlaneBootstrapConfig,
  type ControlPlaneBootstrapMessage,
  type ControlPlaneBootstrapMessageLevel,
  type ControlPlaneBootstrapResult,
  type ControlPlaneBootstrapDependencies,
} from './control-plane/index.js';

// Model Discovery
export {
  ModelDiscovery,
  modelDiscovery,
  type DiscoveredModel,
  type ModelDiscoveryResult,
} from './discovery/index.js';
