import { readFileSync, existsSync } from 'fs';
import { homedir } from 'os';
import { resolve, join } from 'path';

const CODEX_AUTH_TOKEN_ENV_KEYS = [
  'UNTANGLE_CODEX_AUTH_TOKEN',
  'CODEX_OPENAI_AUTH_TOKEN',
  'OPENAI_ACCESS_TOKEN',
  'OPENAI_AUTH_TOKEN',
];

const CODEX_AUTH_PATH_ENV = 'UNTANGLE_CODEX_AUTH_PATH';
const CODEX_ORIGINATOR_ENV = 'UNTANGLE_CODEX_ORIGINATOR';
const DEFAULT_CODEX_ORIGINATOR = 'untangle-ai';

export interface ChatGPTAuthSession {
  token: string;
  accountId?: string;
}

export function resolveCodexAuthPath(): string {
  const explicit = process.env[CODEX_AUTH_PATH_ENV];
  if (explicit && explicit.trim().length > 0) {
    return resolve(explicit.trim());
  }
  return join(homedir(), '.codex', 'auth.json');
}

function getAuthTokenFromEnv(): string {
  for (const envName of CODEX_AUTH_TOKEN_ENV_KEYS) {
    const value = process.env[envName];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }
  }
  return '';
}

function parseJwtClaims(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  try {
    const payload = Buffer.from(parts[1], 'base64url').toString('utf-8');
    return JSON.parse(payload) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function normalizeAccountId(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  return undefined;
}

function extractAccountIdFromClaims(claims: Record<string, unknown>): string | undefined {
  const direct = normalizeAccountId(claims.chatgpt_account_id);
  if (direct) return direct;

  const authClaim = claims['https://api.openai.com/auth'];
  if (authClaim && typeof authClaim === 'object' && !Array.isArray(authClaim)) {
    const authAccount = normalizeAccountId((authClaim as Record<string, unknown>).chatgpt_account_id);
    if (authAccount) return authAccount;
  }

  const organizations = claims.organizations;
  if (Array.isArray(organizations) && organizations.length > 0) {
    const first = organizations[0] as Record<string, unknown>;
    const orgId = normalizeAccountId(first?.id);
    if (orgId) return orgId;
  }

  return undefined;
}

export function extractAccountIdFromToken(token: string): string | undefined {
  const claims = parseJwtClaims(token);
  if (!claims) return undefined;
  return extractAccountIdFromClaims(claims);
}

function extractAccountIdFromTokens(tokens: { access_token?: unknown; id_token?: unknown; account_id?: unknown; chatgpt_account_id?: unknown }): string | undefined {
  const direct = normalizeAccountId(tokens.account_id)
    || normalizeAccountId(tokens.chatgpt_account_id);
  if (direct) return direct;
  if (typeof tokens.id_token === 'string') {
    const accountId = extractAccountIdFromToken(tokens.id_token);
    if (accountId) return accountId;
  }
  if (typeof tokens.access_token === 'string') {
    return extractAccountIdFromToken(tokens.access_token);
  }
  return undefined;
}

function getAuthSessionFromFile(authPath: string): ChatGPTAuthSession {
  try {
    if (!existsSync(authPath)) {
      return { token: '' };
    }

    const raw = readFileSync(authPath, 'utf-8');
    const parsed = JSON.parse(raw) as {
      auth_mode?: unknown;
      account_id?: unknown;
      accountId?: unknown;
      chatgpt_account_id?: unknown;
      chatgptAccountId?: unknown;
      tokens?: {
        access_token?: unknown;
        id_token?: unknown;
        refresh_token?: unknown;
        account_id?: unknown;
        chatgpt_account_id?: unknown;
      };
    };

    const authMode = typeof parsed?.auth_mode === 'string'
      ? parsed.auth_mode.trim().toLowerCase()
      : '';
    if (authMode.length > 0 && authMode !== 'chatgpt') {
      return { token: '' };
    }

    const token = typeof parsed?.tokens?.access_token === 'string'
      ? parsed.tokens.access_token.trim()
      : '';
    if (!token) {
      return { token: '' };
    }

    const accountId = normalizeAccountId(parsed.tokens?.account_id)
      || normalizeAccountId(parsed.tokens?.chatgpt_account_id)
      || normalizeAccountId(parsed.account_id)
      || normalizeAccountId(parsed.accountId)
      || normalizeAccountId(parsed.chatgpt_account_id)
      || normalizeAccountId(parsed.chatgptAccountId)
      || extractAccountIdFromTokens(parsed.tokens ?? {});

    return { token, accountId };
  } catch {
    return { token: '' };
  }
}

export function getChatGPTAuthSession(): ChatGPTAuthSession {
  const envToken = getAuthTokenFromEnv();
  if (envToken.length > 0) {
    return {
      token: envToken,
      accountId: extractAccountIdFromToken(envToken),
    };
  }

  return getAuthSessionFromFile(resolveCodexAuthPath());
}

export function getChatGPTAuthToken(): string {
  return getChatGPTAuthSession().token;
}

export function resolveCodexOriginator(): string | undefined {
  const value = process.env[CODEX_ORIGINATOR_ENV];
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  return DEFAULT_CODEX_ORIGINATOR;
}
