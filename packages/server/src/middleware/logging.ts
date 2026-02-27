import type { MiddlewareHandler } from 'hono';
import { randomUUID } from 'node:crypto';
import { observabilityMetrics } from '../observability/metrics.js';
import { initRequestTrace } from '../observability/tracing.js';
import { emitLogEvent } from '../observability/settings.js';

export function loggingMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const start = Date.now();
    const method = c.req.method;
    const path = c.req.path;
    const requestId = c.req.header('x-request-id') ?? randomUUID();
    const trace = initRequestTrace(c.req.header('traceparent'));
    observabilityMetrics.recordTraceDecision(trace.sampled);

    c.set('requestId', requestId);
    c.set('traceId', trace.traceId);
    c.set('requestSpanId', trace.spanId);
    c.set('traceSampled', trace.sampled);
    c.header('x-request-id', requestId);
    c.header('traceparent', trace.traceparent);

    await next();

    const duration = Date.now() - start;
    const status = c.res.status;
    observabilityMetrics.recordRequest(method, path, status, duration);

    emitLogEvent('info', 'http_request', {
      requestId,
      traceId: trace.traceId,
      spanId: trace.spanId,
      method,
      path,
      status,
      durationMs: duration,
    });
  };
}
