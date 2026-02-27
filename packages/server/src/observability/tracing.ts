import { randomBytes } from 'node:crypto';
import type { Context } from 'hono';
import { observabilityMetrics } from './metrics.js';
import { emitLogEvent, getObservabilitySettings } from './settings.js';

interface ParsedTraceparent {
  version: string;
  traceId: string;
  parentSpanId: string;
  flags: string;
}

export interface RequestTraceContext {
  traceId: string;
  spanId: string;
  sampled: boolean;
  traceparent: string;
  parentSpanId?: string;
}

interface ProviderSpanInput {
  providerId: string;
  modelId: string;
  endpoint: string;
  attempt: number;
}

const TRACEPARENT_PATTERN = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

function toLowerHex(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function parseTraceparent(value: string | null | undefined): ParsedTraceparent | null {
  if (!value) return null;
  const match = TRACEPARENT_PATTERN.exec(value.trim());
  if (!match) return null;

  const [, version, traceId, parentSpanId, flags] = match;
  if (/^0+$/.test(traceId) || /^0+$/.test(parentSpanId)) {
    return null;
  }

  return {
    version: version.toLowerCase(),
    traceId: traceId.toLowerCase(),
    parentSpanId: parentSpanId.toLowerCase(),
    flags: flags.toLowerCase(),
  };
}

function buildTraceparent(traceId: string, spanId: string, sampled: boolean): string {
  return `00-${traceId}-${spanId}-${sampled ? '01' : '00'}`;
}

function isSampled(flags: string): boolean {
  const parsed = Number.parseInt(flags, 16);
  if (!Number.isFinite(parsed)) return true;
  return (parsed & 0x01) === 0x01;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function initRequestTrace(incomingTraceparent?: string | null): RequestTraceContext {
  const settings = getObservabilitySettings();
  const parsed = parseTraceparent(incomingTraceparent);
  const traceId = parsed?.traceId ?? toLowerHex(16);
  const spanId = toLowerHex(8);
  const sampled = parsed
    ? (settings.tracing.enabled && isSampled(parsed.flags))
    : (settings.tracing.enabled && Math.random() <= settings.tracing.sampleRate);

  return {
    traceId,
    spanId,
    sampled,
    traceparent: buildTraceparent(traceId, spanId, sampled),
    parentSpanId: parsed?.parentSpanId,
  };
}

function startProviderSpan(c: Context, input: ProviderSpanInput): {
  traceparent: string;
  end: (status: 'ok' | 'error', attributes?: Record<string, unknown>) => void;
} {
  const traceId = readString(c.get('traceId')) ?? toLowerHex(16);
  const parentSpanId = readString(c.get('requestSpanId'));
  const sampled = readBoolean(c.get('traceSampled')) ?? true;
  const settings = getObservabilitySettings();
  const spanId = toLowerHex(8);
  const traceparent = buildTraceparent(traceId, spanId, sampled);
  const start = Date.now();
  const shouldLogSpans = settings.tracing.enabled && settings.tracing.logSpans && sampled;

  if (shouldLogSpans) {
    emitLogEvent('debug', 'trace_span_start', {
      traceId,
      spanId,
      parentSpanId: parentSpanId ?? null,
      name: 'provider.request',
      attributes: {
        providerId: input.providerId,
        modelId: input.modelId,
        endpoint: input.endpoint,
        attempt: input.attempt,
      },
    });
  }

  return {
    traceparent,
    end: (status, attributes) => {
      if (!shouldLogSpans) return;
      const level = status === 'ok' ? 'debug' : 'warn';
      emitLogEvent(level, 'trace_span_end', {
        traceId,
        spanId,
        parentSpanId: parentSpanId ?? null,
        name: 'provider.request',
        status,
        durationMs: Date.now() - start,
        attributes: {
          providerId: input.providerId,
          modelId: input.modelId,
          endpoint: input.endpoint,
          attempt: input.attempt,
          ...(attributes ?? {}),
        },
      });
    },
  };
}

export async function tracedFetch(
  c: Context,
  url: string,
  init: RequestInit,
  spanInput: ProviderSpanInput,
): Promise<Response> {
  const span = startProviderSpan(c, spanInput);
  const start = Date.now();
  const headers = new Headers(init.headers);
  if (!headers.has('traceparent')) {
    headers.set('traceparent', span.traceparent);
  }

  try {
    const response = await fetch(url, {
      ...init,
      headers,
    });
    observabilityMetrics.recordProviderRequest(
      spanInput.providerId,
      spanInput.modelId,
      spanInput.endpoint,
      response.status,
      Date.now() - start,
    );
    if (response.status >= 400) {
      observabilityMetrics.recordProviderError(
        spanInput.providerId,
        spanInput.modelId,
        spanInput.endpoint,
        `status_${response.status}`,
      );
    }
    span.end(response.status >= 400 ? 'error' : 'ok', {
      httpStatus: response.status,
    });
    return response;
  } catch (error) {
    observabilityMetrics.recordProviderError(
      spanInput.providerId,
      spanInput.modelId,
      spanInput.endpoint,
      'network_error',
    );
    span.end('error', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
