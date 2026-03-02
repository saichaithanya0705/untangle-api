import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import type { SecurityConfig } from '@untangle-ai/core';
import { observabilityMetrics } from '../observability/metrics.js';

function secureEquals(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

function resolveAdminToken(
  authorization: string | undefined,
  fallbackHeaderToken: string | undefined,
  allowBearerToken: boolean,
): string | undefined {
  if (fallbackHeaderToken && fallbackHeaderToken.trim().length > 0) {
    return fallbackHeaderToken.trim();
  }

  if (!allowBearerToken || !authorization) {
    return undefined;
  }

  const [scheme, token] = authorization.split(/\s+/, 2);
  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') {
    return undefined;
  }
  return token.trim();
}

export function adminAuthMiddleware(config?: SecurityConfig): MiddlewareHandler {
  const expectedToken = config?.adminApiKey?.trim();
  const protectApi = (config?.requireAdminAuthForApi ?? false) || !!expectedToken;
  const protectMetrics = config?.protectMetrics ?? true;
  const requireAdminAuth = protectApi || protectMetrics;
  if (!requireAdminAuth) {
    return async (_c, next) => {
      await next();
    };
  }

  if (!expectedToken || expectedToken.length === 0) {
    return async (c, next) => {
      const isProtected = (protectApi && c.req.path.startsWith('/api/'))
        || (protectMetrics && c.req.path === '/metrics');
      if (!isProtected) {
        await next();
        return;
      }
      observabilityMetrics.recordAdminAuthDenied('misconfigured_admin_token');
      return c.json({
        error: {
          message: 'Admin authentication is required but no admin token is configured.',
          type: 'configuration_error',
          code: 'admin_auth_misconfigured',
        },
      }, 503);
    };
  }

  const adminHeader = (config?.adminHeader?.trim() || 'x-untangle-admin-key').toLowerCase();
  const allowBearerToken = config?.allowBearerToken ?? true;

  return async (c, next) => {
    const isProtected = (protectApi && c.req.path.startsWith('/api/'))
      || (protectMetrics && c.req.path === '/metrics');
    if (!isProtected) {
      await next();
      return;
    }

    const authorization = c.req.header('authorization');
    const headerToken = c.req.header(adminHeader);
    const token = resolveAdminToken(authorization, headerToken, allowBearerToken);

    if (!token || !secureEquals(expectedToken, token)) {
      observabilityMetrics.recordAdminAuthDenied('invalid_or_missing_token');
      return c.json({
        error: {
          message: 'Admin authentication required for API management routes.',
          type: 'authentication_error',
          code: 'admin_auth_required',
        },
      }, 401);
    }

    await next();
  };
}
