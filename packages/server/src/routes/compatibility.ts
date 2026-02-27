import type { ApiCompatibilityConfig } from '@untangle-ai/core';

const DEFAULT_COMPATIBILITY: ApiCompatibilityConfig = {
  strictValidation: false,
  normalizeLegacyParams: true,
};

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

export function resolveApiCompatibility(config?: ApiCompatibilityConfig): ApiCompatibilityConfig {
  return {
    strictValidation: config?.strictValidation ?? DEFAULT_COMPATIBILITY.strictValidation,
    normalizeLegacyParams: config?.normalizeLegacyParams ?? DEFAULT_COMPATIBILITY.normalizeLegacyParams,
  };
}

export function findUnknownFields(
  body: Record<string, unknown>,
  allowedFields: ReadonlySet<string>,
  compatibility?: ApiCompatibilityConfig,
): string[] {
  if (!resolveApiCompatibility(compatibility).strictValidation) {
    return [];
  }

  const unknown: string[] = [];
  for (const key of Object.keys(body)) {
    if (!allowedFields.has(key)) {
      unknown.push(key);
    }
  }
  return unknown.sort((a, b) => a.localeCompare(b));
}

export function normalizeChatBody(
  rawBody: unknown,
  compatibility?: ApiCompatibilityConfig,
): Record<string, unknown> | null {
  const body = asObject(rawBody);
  if (!body) return null;

  const normalized: Record<string, unknown> = { ...body };
  const cfg = resolveApiCompatibility(compatibility);
  if (!cfg.normalizeLegacyParams) return normalized;

  if (typeof normalized.max_completion_tokens === 'number' && normalized.max_tokens === undefined) {
    normalized.max_tokens = normalized.max_completion_tokens;
  }
  if (normalized.max_completion_tokens !== undefined) {
    delete normalized.max_completion_tokens;
  }

  if (normalized.messages === undefined) {
    const input = normalized.input;
    if (typeof input === 'string') {
      normalized.messages = [{ role: 'user', content: input }];
    } else if (isStringArray(input)) {
      normalized.messages = input.map((value) => ({ role: 'user', content: value }));
    }
  }

  if (normalized.response_format === 'json') {
    normalized.response_format = { type: 'json_object' };
  }

  return normalized;
}

export function normalizeResponsesBody(
  rawBody: unknown,
  compatibility?: ApiCompatibilityConfig,
): Record<string, unknown> | null {
  const body = asObject(rawBody);
  if (!body) return null;

  const normalized: Record<string, unknown> = { ...body };
  const cfg = resolveApiCompatibility(compatibility);
  if (!cfg.normalizeLegacyParams) return normalized;

  if (typeof normalized.max_tokens === 'number' && normalized.max_output_tokens === undefined) {
    normalized.max_output_tokens = normalized.max_tokens;
  }

  if (normalized.input === undefined && normalized.messages !== undefined) {
    normalized.input = normalized.messages;
  }

  if (normalized.input === undefined && typeof normalized.prompt === 'string') {
    normalized.input = normalized.prompt;
  }

  return normalized;
}

export function normalizeEmbeddingsBody(
  rawBody: unknown,
  compatibility?: ApiCompatibilityConfig,
): Record<string, unknown> | null {
  const body = asObject(rawBody);
  if (!body) return null;

  const normalized: Record<string, unknown> = { ...body };
  const cfg = resolveApiCompatibility(compatibility);
  if (!cfg.normalizeLegacyParams) return normalized;

  if (typeof normalized.input === 'number') {
    normalized.input = String(normalized.input);
  }

  return normalized;
}
