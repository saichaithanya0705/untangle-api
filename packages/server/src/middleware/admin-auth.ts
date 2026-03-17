import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import type { SecurityConfig } from '@untangle-ai/core';
import { observabilityMetrics } from '../observability/metrics.js';

const ADMIN_SESSION_COOKIE_NAME = 'untangle_admin_session';
const ADMIN_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const adminSessions = new Map<string, { expiresAt: number }>();

export function secureEquals(expected: string, actual: string): boolean {
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  if (expectedBuffer.length !== actualBuffer.length) {
    return false;
  }
  return timingSafeEqual(expectedBuffer, actualBuffer);
}

function purgeExpiredAdminSessions(now: number = Date.now()): void {
  for (const [token, session] of adminSessions.entries()) {
    if (now >= session.expiresAt) {
      adminSessions.delete(token);
    }
  }
}

function hasValidAdminSession(token: string | undefined): boolean {
  if (!token) return false;
  purgeExpiredAdminSessions();
  const session = adminSessions.get(token);
  if (!session) {
    return false;
  }
  if (Date.now() >= session.expiresAt) {
    adminSessions.delete(token);
    return false;
  }
  return true;
}

export function issueAdminSession(): { token: string; expiresAt: number } {
  purgeExpiredAdminSessions();
  const token = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
  adminSessions.set(token, { expiresAt });
  return { token, expiresAt };
}

export function revokeAdminSession(token: string | undefined): void {
  if (!token) return;
  adminSessions.delete(token);
}

export function getAdminSessionCookieName(): string {
  return ADMIN_SESSION_COOKIE_NAME;
}

export function getAdminSessionTtlSeconds(): number {
  return Math.floor(ADMIN_SESSION_TTL_MS / 1000);
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
  const protectMetrics = config?.protectMetrics ?? false;
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
    const isAdminSessionRoute = c.req.path === '/api/admin/session';
    if (isAdminSessionRoute && (c.req.method === 'POST' || c.req.method === 'DELETE')) {
      await next();
      return;
    }

    const isProtected = (protectApi && c.req.path.startsWith('/api/'))
      || (protectMetrics && c.req.path === '/metrics');
    if (!isProtected) {
      await next();
      return;
    }

    const sessionToken = getCookie(c, ADMIN_SESSION_COOKIE_NAME);
    if (hasValidAdminSession(sessionToken)) {
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
