import type { MiddlewareHandler } from 'hono';
import type { SecurityConfig } from '@untangle-ai/core';

function isBodyMethod(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH';
}

export function bodyLimitMiddleware(config?: SecurityConfig): MiddlewareHandler {
  const maxBodyBytes = config?.maxBodyBytes ?? 1024 * 1024;
  const maxMultipartBytes = config?.maxMultipartBytes ?? 10 * 1024 * 1024;
  const requireContentLength = config?.requireContentLength ?? false;

  return async (c, next) => {
    if (!isBodyMethod(c.req.method)) {
      await next();
      return;
    }

    const contentType = c.req.header('content-type')?.toLowerCase() ?? '';
    const contentLengthHeader = c.req.header('content-length');
    const hasBody = contentLengthHeader !== undefined;

    if (!hasBody) {
      if (requireContentLength && (contentType.includes('application/json') || contentType.includes('multipart/form-data'))) {
        return c.json({
          error: {
            message: 'Content-Length header is required for request bodies.',
            type: 'invalid_request_error',
            code: 'content_length_required',
          },
        }, 411);
      }
      await next();
      return;
    }

    const contentLength = Number.parseInt(contentLengthHeader ?? '', 10);
    if (!Number.isFinite(contentLength) || contentLength < 0) {
      return c.json({
        error: {
          message: 'Invalid Content-Length header.',
          type: 'invalid_request_error',
          code: 'invalid_content_length',
        },
      }, 400);
    }

    const limit = contentType.includes('multipart/form-data') ? maxMultipartBytes : maxBodyBytes;
    if (contentLength > limit) {
      return c.json({
        error: {
          message: `Request body too large. Limit is ${limit} bytes.`,
          type: 'invalid_request_error',
          code: 'payload_too_large',
        },
      }, 413);
    }

    await next();
  };
}
