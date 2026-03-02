import { readFileSync } from 'fs';
import { isAbsolute, resolve, relative } from 'path';

export interface SecretResolutionOptions {
  allowFileRefs: boolean;
  baseDir: string;
  env: NodeJS.ProcessEnv;
}

function normalizedValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function resolveSecretPath(pathValue: string, baseDir: string): string | undefined {
  const basePath = resolve(baseDir);
  const targetPath = isAbsolute(pathValue) ? resolve(pathValue) : resolve(basePath, pathValue);
  const rel = relative(basePath, targetPath);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return undefined;
  }
  return targetPath;
}

function readSecretFile(pathValue: string, baseDir: string): string | undefined {
  const targetPath = resolveSecretPath(pathValue, baseDir);
  if (!targetPath) return undefined;
  const fileContent = readFileSync(targetPath, 'utf-8');
  return normalizedValue(fileContent);
}

export function resolveSecretReference(
  secretRef: string | undefined,
  options: SecretResolutionOptions,
): string | undefined {
  const normalizedRef = normalizedValue(secretRef);
  if (!normalizedRef) {
    return undefined;
  }

  if (normalizedRef.startsWith('env:')) {
    const envName = normalizedValue(normalizedRef.slice('env:'.length));
    if (!envName) return undefined;
    return normalizedValue(options.env[envName]);
  }

  if (normalizedRef.startsWith('file:')) {
    if (!options.allowFileRefs) {
      return undefined;
    }
    const filePath = normalizedValue(normalizedRef.slice('file:'.length));
    if (!filePath) return undefined;
    try {
      return readSecretFile(filePath, options.baseDir);
    } catch {
      return undefined;
    }
  }

  return normalizedValue(options.env[normalizedRef]);
}
