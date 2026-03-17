import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';
const DEFAULT_PASSWORD_FILE = join(homedir(), '.untangle-api', 'master.key');
const LEGACY_PASSWORD_FILE = join(homedir(), '.untangle-ai', 'master.key');

export function resolveMasterPassword(path = DEFAULT_PASSWORD_FILE): string {
  const envValue = process.env.UNTANGLE_MASTER_PASSWORD?.trim();
  if (envValue) {
    return envValue;
  }

  try {
    const dir = dirname(path);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    if (path === DEFAULT_PASSWORD_FILE && existsSync(LEGACY_PASSWORD_FILE)) {
      const legacyValue = readFileSync(LEGACY_PASSWORD_FILE, 'utf-8').trim();
      if (legacyValue) {
        writeFileSync(path, `${legacyValue}\n`, { encoding: 'utf-8', mode: 0o600 });
        return legacyValue;
      }
    }

    if (existsSync(path)) {
      const value = readFileSync(path, 'utf-8').trim();
      if (value) return value;
    }

    const generated = randomBytes(32).toString('hex');
    writeFileSync(path, `${generated}\n`, { encoding: 'utf-8', mode: 0o600 });
    return generated;
  } catch (error) {
    throw new Error(`Failed to resolve master password: ${error instanceof Error ? error.message : String(error)}`);
  }
}
