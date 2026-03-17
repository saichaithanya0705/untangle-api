import { readFileSync, existsSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { ConfigSchema, SecurityConfigSchema, type Config } from './schema.js';

export function loadConfig(configPath?: string): Config {
  const paths = configPath
    ? [configPath]
    : [
        './untangle-api.yaml',
        './untangle-api.yml',
        './untangle.yaml',
        './untangle.yml',
        './config/untangle-api.yaml',
        './config/untangle.yaml',
      ];

  for (const path of paths) {
    if (existsSync(path)) {
      const content = readFileSync(path, 'utf-8');
      const rawConfig = parseYaml(content);
      const parsed = ConfigSchema.parse(rawConfig);
      parsed.security = SecurityConfigSchema.parse(parsed.security ?? {});
      return parsed;
    }
  }

  // Return default config if no file found
  const parsed = ConfigSchema.parse({});
  parsed.security = SecurityConfigSchema.parse(parsed.security ?? {});
  return parsed;
}

export function parseConfig(content: string): Config {
  const rawConfig = parseYaml(content);
  const parsed = ConfigSchema.parse(rawConfig);
  parsed.security = SecurityConfigSchema.parse(parsed.security ?? {});
  return parsed;
}
