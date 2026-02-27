import type { Config } from '@untangle-ai/core';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface ObservabilityRuntimeSettings {
  logging: {
    level: LogLevel;
  };
  tracing: {
    enabled: boolean;
    sampleRate: number;
    logSpans: boolean;
  };
  metrics: {
    providerLabels: boolean;
  };
}

const DEFAULT_SETTINGS: ObservabilityRuntimeSettings = {
  logging: {
    level: 'info',
  },
  tracing: {
    enabled: true,
    sampleRate: 1,
    logSpans: true,
  },
  metrics: {
    providerLabels: true,
  },
};

let settings: ObservabilityRuntimeSettings = { ...DEFAULT_SETTINGS };

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function setObservabilitySettings(config?: Config['observability']): ObservabilityRuntimeSettings {
  settings = {
    logging: {
      level: config?.logging.level ?? DEFAULT_SETTINGS.logging.level,
    },
    tracing: {
      enabled: config?.tracing.enabled ?? DEFAULT_SETTINGS.tracing.enabled,
      sampleRate: clamp(config?.tracing.sampleRate ?? DEFAULT_SETTINGS.tracing.sampleRate, 0, 1),
      logSpans: config?.tracing.logSpans ?? DEFAULT_SETTINGS.tracing.logSpans,
    },
    metrics: {
      providerLabels: config?.metrics.providerLabels ?? DEFAULT_SETTINGS.metrics.providerLabels,
    },
  };
  return settings;
}

export function getObservabilitySettings(): ObservabilityRuntimeSettings {
  return settings;
}

export function shouldLog(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[settings.logging.level];
}

export function emitLogEvent(
  level: LogLevel,
  event: string,
  payload: Record<string, unknown>,
): void {
  if (!shouldLog(level)) return;

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...payload,
  });

  if (level === 'error') {
    console.error(line);
    return;
  }
  console.log(line);
}
