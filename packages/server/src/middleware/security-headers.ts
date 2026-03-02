import type { MiddlewareHandler } from 'hono';
import type { SecurityConfig } from '@untangle-ai/core';

export function securityHeadersMiddleware(config?: SecurityConfig): MiddlewareHandler {
  return async (c, next) => {
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-DNS-Prefetch-Control', 'off');
    c.header('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
    c.header('Cross-Origin-Resource-Policy', 'same-site');

    if (config?.hsts?.enabled) {
      const parts = [`max-age=${config.hsts.maxAgeSeconds}`];
      if (config.hsts.includeSubDomains) {
        parts.push('includeSubDomains');
      }
      if (config.hsts.preload) {
        parts.push('preload');
      }
      c.header('Strict-Transport-Security', parts.join('; '));
    }

    await next();
  };
}
