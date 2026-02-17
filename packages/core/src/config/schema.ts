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

export const ConfigSchema = z.object({
  server: ServerConfigSchema.default({}),
  providers: z.record(z.string(), ProviderConfigSchema).default({}),
  customProviders: z.record(z.string(), CustomProviderSchema).optional(),
});

export type Config = z.infer<typeof ConfigSchema>;
export type ServerConfig = z.infer<typeof ServerConfigSchema>;
export type ProviderConfigInput = z.infer<typeof ProviderConfigSchema>;
export type CustomProviderConfig = z.infer<typeof CustomProviderSchema>;
