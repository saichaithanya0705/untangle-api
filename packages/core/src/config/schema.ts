import { z } from 'zod';

export const ModelConfigSchema = z.object({
  id: z.string(),
  alias: z.string().optional(),
  enabled: z.boolean().default(true),
});

export const CustomEndpointSchema = z.object({
  path: z.string(),
  method: z.enum(['POST', 'GET']).default('POST'),
  requestTemplate: z.string(),
  responseTemplate: z.string(),
  streamParser: z.enum(['sse', 'json-lines']).optional(),
});

export const CustomProviderSchema = z.object({
  enabled: z.boolean().default(true),
  baseUrl: z.string(),
  auth: z.object({
    type: z.enum(['header', 'query']).default('header'),
    header: z.string().optional(),
    scheme: z.string().optional(),
    queryParam: z.string().optional(),
  }),
  headers: z.record(z.string(), z.string()).optional(),
  models: z.array(z.object({
    id: z.string(),
    alias: z.string().optional(),
    contextWindow: z.number().optional(),
    maxOutputTokens: z.number().optional(),
    enabled: z.boolean().default(true),
    capabilities: z.array(z.string()).optional(),
  })),
  endpoints: z.object({
    chat: CustomEndpointSchema,
  }),
});

export const ProviderConfigSchema = z.object({
  enabled: z.boolean().default(true),
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
  models: z.array(ModelConfigSchema).optional(),
});

export const ServerConfigSchema = z.object({
  port: z.number().default(3000),
  host: z.string().default('localhost'),
});

export const RetryPolicySchema = z.object({
  maxAttempts: z.number().int().positive().default(3),
  retryableStatusCodes: z.array(z.number().int()).default([408, 409, 429, 500, 502, 503, 504]),
});

export const CircuitBreakerSchema = z.object({
  failureThreshold: z.number().int().positive().default(3),
  resetTimeoutMs: z.number().int().nonnegative().default(30000),
});

export const StreamFallbackPolicySchema = z.object({
  mode: z.enum(['continue-disabled', 'continue-with-policy-prompt']).default('continue-disabled'),
  policyPrompt: z.string().min(1).default(
    'The previous assistant response was interrupted. Continue from the exact point where it stopped without repeating prior text.'
  ),
});

export const RoutingDeploymentSchema = z.object({
  provider: z.string(),
  model: z.string(),
  weight: z.number().positive().default(1),
  priority: z.number().int().nonnegative().default(0),
  enabled: z.boolean().default(true),
});

export const DeploymentGroupSchema = z.object({
  alias: z.string(),
  strategy: z.enum(['priority', 'weighted', 'shuffle', 'least-latency']).default('priority'),
  deployments: z.array(RoutingDeploymentSchema).min(1),
  cooldownMs: z.number().int().nonnegative().default(0),
  retryPolicy: RetryPolicySchema.default({}),
  circuitBreaker: CircuitBreakerSchema.default({}),
  streamFallbackPolicy: StreamFallbackPolicySchema.optional(),
});

export const RoutingConfigSchema = z.object({
  groups: z.array(DeploymentGroupSchema).default([]),
  defaultStrategy: z.enum(['priority', 'weighted', 'shuffle', 'least-latency']).default('priority'),
  defaultCooldownMs: z.number().int().nonnegative().default(0),
  defaultRetryPolicy: RetryPolicySchema.default({}),
  defaultCircuitBreaker: CircuitBreakerSchema.default({}),
  defaultStreamFallbackPolicy: StreamFallbackPolicySchema.optional(),
});

export const ControlPlanePostgresSchema = z.object({
  enabled: z.boolean().default(false),
  connectionString: z.string().optional(),
  schema: z.string().default('public'),
});

export const ControlPlaneRedisSchema = z.object({
  enabled: z.boolean().default(false),
  connectionString: z.string().optional(),
  keyPrefix: z.string().default('untangle'),
});

export const ControlPlaneConfigSchema = z.object({
  enabled: z.boolean().default(false),
  virtualKeyHeader: z.string().default('x-untangle-key'),
  postgres: ControlPlanePostgresSchema.default({}),
  redis: ControlPlaneRedisSchema.default({}),
});

export const ObservabilityLoggingSchema = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export const ObservabilityTracingSchema = z.object({
  enabled: z.boolean().default(true),
  sampleRate: z.number().min(0).max(1).default(1),
  logSpans: z.boolean().default(true),
});

export const ObservabilityMetricsSchema = z.object({
  providerLabels: z.boolean().default(true),
});

export const ObservabilityConfigSchema = z.object({
  logging: ObservabilityLoggingSchema.default({}),
  tracing: ObservabilityTracingSchema.default({}),
  metrics: ObservabilityMetricsSchema.default({}),
});

export const ApiCompatibilitySchema = z.object({
  strictValidation: z.boolean().default(false),
  normalizeLegacyParams: z.boolean().default(true),
});

export const ApiConfigSchema = z.object({
  compatibility: ApiCompatibilitySchema.default({}),
});

export const ConfigSchema = z.object({
  server: ServerConfigSchema.default({}),
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  customProviders: z.record(z.string(), CustomProviderSchema).optional(),
  routing: RoutingConfigSchema.default({}),
  controlPlane: ControlPlaneConfigSchema.default({}),
  observability: ObservabilityConfigSchema.optional(),
  api: ApiConfigSchema.optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type ProviderConfigInput = z.infer<typeof ProviderConfigSchema>;
export type CustomProviderConfig = z.infer<typeof CustomProviderSchema>;
export type RetryPolicyConfig = z.infer<typeof RetryPolicySchema>;
export type CircuitBreakerConfig = z.infer<typeof CircuitBreakerSchema>;
export type StreamFallbackPolicyConfig = z.infer<typeof StreamFallbackPolicySchema>;
export type RoutingDeploymentConfig = z.infer<typeof RoutingDeploymentSchema>;
export type DeploymentGroupConfig = z.infer<typeof DeploymentGroupSchema>;
export type RoutingConfig = z.infer<typeof RoutingConfigSchema>;
export type ControlPlanePostgresConfig = z.infer<typeof ControlPlanePostgresSchema>;
export type ControlPlaneRedisConfig = z.infer<typeof ControlPlaneRedisSchema>;
export type ControlPlaneConfig = z.infer<typeof ControlPlaneConfigSchema>;
export type ObservabilityLoggingConfig = z.infer<typeof ObservabilityLoggingSchema>;
export type ObservabilityTracingConfig = z.infer<typeof ObservabilityTracingSchema>;
export type ObservabilityMetricsConfig = z.infer<typeof ObservabilityMetricsSchema>;
export type ObservabilityConfig = z.infer<typeof ObservabilityConfigSchema>;
export type ApiCompatibilityConfig = z.infer<typeof ApiCompatibilitySchema>;
export type ApiConfig = z.infer<typeof ApiConfigSchema>;
