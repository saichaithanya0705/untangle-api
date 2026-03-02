import type { MiddlewareHandler } from 'hono';
import type { ControlPlaneService, SecurityConfig } from '@untangle-ai/core';

export interface DataPlaneAuthOptions {
  controlPlane?: ControlPlaneService;
  security?: SecurityConfig;
  virtualKeyHeader?: string;
}

export function dataPlaneAuthMiddleware(options: DataPlaneAuthOptions): MiddlewareHandler {
  const requireAuth = options.security?.requireDataPlaneAuth ?? false;
  const headerName = (options.security?.dataPlaneHeader
    ?? options.virtualKeyHeader
    ?? 'x-untangle-key').trim().toLowerCase();

  return async (c, next) => {
    if (!c.req.path.startsWith('/v1/')) {
      await next();
      return;
    }

    const rawKey = c.req.header(headerName)?.trim();
    if (!rawKey) {
      if (!requireAuth) {
        await next();
        return;
      }
      return c.json({
        error: {
          message: 'Authentication required for data-plane requests.',
          type: 'authentication_error',
          code: 'data_plane_auth_required',
        },
      }, 401);
    }

    if (!options.controlPlane) {
      if (!requireAuth) {
        c.set('tenantId', rawKey);
        await next();
        return;
      }
      return c.json({
        error: {
          message: 'Control-plane is required to validate data-plane credentials.',
          type: 'configuration_error',
          code: 'control_plane_required',
        },
      }, 503);
    }

    const resolved = await options.controlPlane.resolveVirtualKey(rawKey).catch(() => null);
    if (!resolved) {
      return c.json({
        error: {
          message: 'Invalid or revoked virtual key.',
          type: 'authentication_error',
          code: 'invalid_virtual_key',
        },
      }, 401);
    }

    c.set('tenantId', resolved.key.id);
    c.set('virtualKeyRecord', resolved.key);
    await next();
  };
}
