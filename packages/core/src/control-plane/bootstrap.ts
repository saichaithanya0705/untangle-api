import type { ControlPlaneStore } from './store.js';
import type { RateLimiter } from './limiter.js';
import { ControlPlaneService } from './service.js';
import { InMemoryControlPlaneStore } from './in-memory-store.js';
import { InMemoryRateLimiter } from './limiter.js';
import { PostgresControlPlaneStore } from './postgres-store.js';
import { RedisRateLimiter } from './redis-limiter.js';
import { CONTROL_PLANE_POSTGRES_SCHEMA } from './postgres.js';

export interface ControlPlaneBootstrapConfig {
  enabled: boolean;
  postgres: {
    enabled: boolean;
    connectionString?: string;
    schema: string;
  };
  redis: {
    enabled: boolean;
    connectionString?: string;
    keyPrefix: string;
  };
}

export type ControlPlaneBootstrapMessageLevel = 'warn' | 'success' | 'dim';

export interface ControlPlaneBootstrapMessage {
  level: ControlPlaneBootstrapMessageLevel;
  message: string;
}

export interface ControlPlaneBootstrapResult {
  service?: ControlPlaneService;
  storeType: 'in-memory' | 'postgres';
  limiterType: 'in-memory' | 'redis';
  messages: ControlPlaneBootstrapMessage[];
}

export interface ControlPlaneBootstrapDependencies {
  createPostgresStore?: (connectionString: string, schema: string) => Promise<ControlPlaneStore>;
  createRedisLimiter?: (connectionString: string, keyPrefix: string) => Promise<RateLimiter>;
}

async function defaultCreatePostgresStore(
  connectionString: string,
  schema: string,
): Promise<ControlPlaneStore> {
  const store = await PostgresControlPlaneStore.fromConnectionString(connectionString, schema);
  await store.ensureBaseSchema();
  return store;
}

async function defaultCreateRedisLimiter(
  connectionString: string,
  keyPrefix: string,
): Promise<RateLimiter> {
  return RedisRateLimiter.fromConnectionString(connectionString, keyPrefix);
}

export async function bootstrapControlPlane(
  config: ControlPlaneBootstrapConfig,
  deps: ControlPlaneBootstrapDependencies = {},
): Promise<ControlPlaneBootstrapResult> {
  if (!config.enabled) {
    return {
      service: undefined,
      storeType: 'in-memory',
      limiterType: 'in-memory',
      messages: [],
    };
  }

  const messages: ControlPlaneBootstrapMessage[] = [];
  const createPostgresStore = deps.createPostgresStore ?? defaultCreatePostgresStore;
  const createRedisLimiter = deps.createRedisLimiter ?? defaultCreateRedisLimiter;

  let store: ControlPlaneStore = new InMemoryControlPlaneStore();
  let limiter: RateLimiter = new InMemoryRateLimiter();
  let storeType: 'in-memory' | 'postgres' = 'in-memory';
  let limiterType: 'in-memory' | 'redis' = 'in-memory';

  if (config.postgres.enabled) {
    if (!config.postgres.connectionString) {
      messages.push({
        level: 'warn',
        message: 'controlPlane.postgres.enabled=true but no connectionString set; using in-memory store.',
      });
    } else {
      try {
        store = await createPostgresStore(config.postgres.connectionString, config.postgres.schema);
        storeType = 'postgres';
        messages.push({
          level: 'success',
          message: 'Control-plane PostgreSQL persistence enabled.',
        });
      } catch (error) {
        messages.push({
          level: 'warn',
          message: `Failed to initialize PostgreSQL store; using in-memory store. (${error instanceof Error ? error.message : String(error)})`,
        });
      }
    }

    messages.push({
      level: 'dim',
      message: `Migration artifact: ${CONTROL_PLANE_POSTGRES_SCHEMA.migrationName}`,
    });
  }

  if (config.redis.enabled) {
    if (!config.redis.connectionString) {
      messages.push({
        level: 'warn',
        message: 'controlPlane.redis.enabled=true but no connectionString set; using in-memory limiter.',
      });
    } else {
      try {
        limiter = await createRedisLimiter(config.redis.connectionString, config.redis.keyPrefix);
        limiterType = 'redis';
        messages.push({
          level: 'success',
          message: 'Control-plane Redis rate limiter enabled.',
        });
      } catch (error) {
        messages.push({
          level: 'warn',
          message: `Failed to initialize Redis limiter; using in-memory limiter. (${error instanceof Error ? error.message : String(error)})`,
        });
      }
    }
  }

  return {
    service: new ControlPlaneService(store, limiter),
    storeType,
    limiterType,
    messages,
  };
}
