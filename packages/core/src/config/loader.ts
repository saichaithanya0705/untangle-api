import { readFileSync, existsSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { ConfigSchema, type Config } from './schema.js';

export function loadConfig(configPath?: string): Config {
  const paths = configPath
    ? [configPath]
    : ['./untangle.yaml', './untangle.yml', './config/untangle.yaml'];

  for (const path of paths) {
    if (existsSync(path)) {
      const content = readFileSync(path, 'utf-8');
      const rawConfig = parseYaml(content);
      return ConfigSchema.parse(rawConfig);
    }
  }

  // Return default config if no file found
  return ConfigSchema.parse({});
}

export function parseConfig(content: string): Config {
  const rawConfig = parseYaml(content);
  return ConfigSchema.parse(rawConfig);
}
