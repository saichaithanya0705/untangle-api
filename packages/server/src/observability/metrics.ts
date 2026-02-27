import { getObservabilitySettings } from './settings.js';

type RequestMetric = {
  count: number;
  durationMsTotal: number;
};

type ProviderRequestMetric = {
  count: number;
  durationMsTotal: number;
};

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export class ObservabilityMetrics {
  private requests = new Map<string, RequestMetric>();
  private providerRequests = new Map<string, ProviderRequestMetric>();
  private providerErrors = new Map<string, number>();
  private fallbackCount = 0;
  private rateLimitHits = new Map<string, number>();
  private sampledTraceRequests = 0;
  private unsampledTraceRequests = 0;

  recordRequest(method: string, path: string, status: number, durationMs: number): void {
    const key = `${method}|${path}|${status}`;
    const existing = this.requests.get(key);
    if (existing) {
      existing.count += 1;
      existing.durationMsTotal += durationMs;
      return;
    }

    this.requests.set(key, { count: 1, durationMsTotal: durationMs });
  }

  recordFallback(): void {
    this.fallbackCount += 1;
  }

  recordProviderRequest(
    providerId: string,
    modelId: string,
    endpoint: string,
    status: number,
    durationMs: number,
  ): void {
    const key = `${providerId}|${modelId}|${endpoint}|${status}`;
    const existing = this.providerRequests.get(key);
    if (existing) {
      existing.count += 1;
      existing.durationMsTotal += durationMs;
      return;
    }
    this.providerRequests.set(key, { count: 1, durationMsTotal: durationMs });
  }

  recordProviderError(
    providerId: string,
    modelId: string,
    endpoint: string,
    reason: string,
  ): void {
    const normalizedReason = reason.trim().length > 0 ? reason : 'unknown';
    const key = `${providerId}|${modelId}|${endpoint}|${normalizedReason}`;
    const current = this.providerErrors.get(key) ?? 0;
    this.providerErrors.set(key, current + 1);
  }

  recordRateLimitHit(reason: string): void {
    const key = reason.trim().length > 0 ? reason : 'unknown';
    const current = this.rateLimitHits.get(key) ?? 0;
    this.rateLimitHits.set(key, current + 1);
  }

  recordTraceDecision(sampled: boolean): void {
    if (sampled) {
      this.sampledTraceRequests += 1;
      return;
    }
    this.unsampledTraceRequests += 1;
  }

  renderPrometheus(): string {
    const lines: string[] = [];
    const settings = getObservabilitySettings();
    const includeProviderLabels = settings.metrics.providerLabels;
    lines.push('# HELP untangle_http_requests_total Total HTTP requests served.');
    lines.push('# TYPE untangle_http_requests_total counter');

    for (const [key, value] of this.requests.entries()) {
      const [method, path, status] = key.split('|');
      lines.push(
        `untangle_http_requests_total{method="${escapeLabel(method)}",path="${escapeLabel(path)}",status="${escapeLabel(status)}"} ${value.count}`,
      );
    }

    lines.push('# HELP untangle_http_request_duration_ms_total Cumulative HTTP request duration in ms.');
    lines.push('# TYPE untangle_http_request_duration_ms_total counter');
    for (const [key, value] of this.requests.entries()) {
      const [method, path, status] = key.split('|');
      lines.push(
        `untangle_http_request_duration_ms_total{method="${escapeLabel(method)}",path="${escapeLabel(path)}",status="${escapeLabel(status)}"} ${value.durationMsTotal}`,
      );
    }

    lines.push('# HELP untangle_router_fallback_total Total deployment fallback decisions.');
    lines.push('# TYPE untangle_router_fallback_total counter');
    lines.push(`untangle_router_fallback_total ${this.fallbackCount}`);

    lines.push('# HELP untangle_provider_requests_total Total upstream provider requests.');
    lines.push('# TYPE untangle_provider_requests_total counter');
    for (const [key, value] of this.providerRequests.entries()) {
      const [provider, model, endpoint, status] = key.split('|');
      const providerLabel = includeProviderLabels ? provider : 'all';
      const modelLabel = includeProviderLabels ? model : 'all';
      lines.push(
        `untangle_provider_requests_total{provider="${escapeLabel(providerLabel)}",model="${escapeLabel(modelLabel)}",endpoint="${escapeLabel(endpoint)}",status="${escapeLabel(status)}"} ${value.count}`,
      );
    }

    lines.push('# HELP untangle_provider_request_duration_ms_total Cumulative upstream provider request duration in ms.');
    lines.push('# TYPE untangle_provider_request_duration_ms_total counter');
    for (const [key, value] of this.providerRequests.entries()) {
      const [provider, model, endpoint, status] = key.split('|');
      const providerLabel = includeProviderLabels ? provider : 'all';
      const modelLabel = includeProviderLabels ? model : 'all';
      lines.push(
        `untangle_provider_request_duration_ms_total{provider="${escapeLabel(providerLabel)}",model="${escapeLabel(modelLabel)}",endpoint="${escapeLabel(endpoint)}",status="${escapeLabel(status)}"} ${value.durationMsTotal}`,
      );
    }

    lines.push('# HELP untangle_provider_errors_total Total upstream provider errors.');
    lines.push('# TYPE untangle_provider_errors_total counter');
    for (const [key, count] of this.providerErrors.entries()) {
      const [provider, model, endpoint, reason] = key.split('|');
      const providerLabel = includeProviderLabels ? provider : 'all';
      const modelLabel = includeProviderLabels ? model : 'all';
      lines.push(
        `untangle_provider_errors_total{provider="${escapeLabel(providerLabel)}",model="${escapeLabel(modelLabel)}",endpoint="${escapeLabel(endpoint)}",reason="${escapeLabel(reason)}"} ${count}`,
      );
    }

    lines.push('# HELP untangle_rate_limit_hits_total Total virtual-key limit denials.');
    lines.push('# TYPE untangle_rate_limit_hits_total counter');
    for (const [reason, count] of this.rateLimitHits.entries()) {
      lines.push(`untangle_rate_limit_hits_total{reason="${escapeLabel(reason)}"} ${count}`);
    }

    lines.push('# HELP untangle_trace_requests_total Total requests by trace sampling decision.');
    lines.push('# TYPE untangle_trace_requests_total counter');
    lines.push(`untangle_trace_requests_total{sampled="true"} ${this.sampledTraceRequests}`);
    lines.push(`untangle_trace_requests_total{sampled="false"} ${this.unsampledTraceRequests}`);

    const totalTraceRequests = this.sampledTraceRequests + this.unsampledTraceRequests;
    const observedSampleRate = totalTraceRequests > 0 ? this.sampledTraceRequests / totalTraceRequests : 0;
    const configuredSampleRate = settings.tracing.enabled ? settings.tracing.sampleRate : 0;
    const samplingDrift = Math.abs(configuredSampleRate - observedSampleRate);

    lines.push('# HELP untangle_trace_sampling_rate_observed Observed trace sampling rate.');
    lines.push('# TYPE untangle_trace_sampling_rate_observed gauge');
    lines.push(`untangle_trace_sampling_rate_observed ${observedSampleRate}`);

    lines.push('# HELP untangle_trace_sampling_rate_configured Configured trace sampling rate.');
    lines.push('# TYPE untangle_trace_sampling_rate_configured gauge');
    lines.push(`untangle_trace_sampling_rate_configured ${configuredSampleRate}`);

    lines.push('# HELP untangle_trace_sampling_drift Absolute difference between configured and observed sampling rates.');
    lines.push('# TYPE untangle_trace_sampling_drift gauge');
    lines.push(`untangle_trace_sampling_drift ${samplingDrift}`);

    return `${lines.join('\n')}\n`;
  }
}

export const observabilityMetrics = new ObservabilityMetrics();
