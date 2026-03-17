import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { SecurityConfig } from '@untangle-ai/core';
import {
  getAdminSessionCookieName,
  getAdminSessionTtlSeconds,
  issueAdminSession,
  revokeAdminSession,
  secureEquals,
} from '../middleware/admin-auth.js';

interface AdminSessionRoutesContext {
  security?: SecurityConfig;
}

export function createAdminSessionRoutes(ctx: AdminSessionRoutesContext = {}) {
  const app = new Hono();

  app.post('/api/admin/session', async (c) => {
    const expectedToken = ctx.security?.adminApiKey?.trim();
    if (!expectedToken) {
      return c.json({
        error: {
          message: 'Admin authentication is required but no admin token is configured.',
          type: 'configuration_error',
          code: 'admin_auth_misconfigured',
        },
      }, 503);
    }

    const body = await c.req.json().catch(() => null) as { adminKey?: string } | null;
    const adminKey = typeof body?.adminKey === 'string' ? body.adminKey.trim() : '';
    if (!adminKey || !secureEquals(expectedToken, adminKey)) {
      return c.json({
        error: {
          message: 'Admin authentication required for API management routes.',
          type: 'authentication_error',
          code: 'admin_auth_required',
        },
      }, 401);
    }

    const session = issueAdminSession();
    setCookie(c, getAdminSessionCookieName(), session.token, {
      httpOnly: true,
      sameSite: 'Strict',
      secure: new URL(c.req.url).protocol === 'https:',
      path: '/',
      maxAge: getAdminSessionTtlSeconds(),
    });

    return c.json({
      authenticated: true,
      expiresAt: new Date(session.expiresAt).toISOString(),
    });
  });

  app.delete('/api/admin/session', (c) => {
    revokeAdminSession(getCookie(c, getAdminSessionCookieName()));
    deleteCookie(c, getAdminSessionCookieName(), { path: '/' });
    return c.json({ authenticated: false });
  });

  return app;
}
