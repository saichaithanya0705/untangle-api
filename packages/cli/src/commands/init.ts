import { Command } from 'commander';
import { writeFileSync, existsSync } from 'fs';
import { logger } from '../utils/logger.js';

const DEFAULT_CONFIG = `# Untangle API configuration
# Local development defaults. Before exposing the gateway outside localhost,
# enable admin authentication, protect /metrics, and require data-plane auth.
server:
  port: 3000
  host: localhost

providers:
  openai:
    enabled: true
    # apiKey: sk-... # Or set OPENAI_API_KEY env var
    # models:
    #   - id: gpt-4o
    #     enabled: true
    #   - id: gpt-4o-mini
    #     enabled: true

security:
  requireAdminAuthForApi: false
  protectMetrics: false
  adminHeader: x-untangle-admin-key
  allowBearerToken: true
  requireDataPlaneAuth: false
  dataPlaneHeader: x-untangle-key
  corsAllowedOrigins: []
  corsAllowCredentials: false
  maxBodyBytes: 1048576
  maxMultipartBytes: 10485760
  requireContentLength: true
`;

export const initCommand = new Command('init')
  .description('Initialize a new Untangle API configuration file')
  .option('-f, --force', 'Overwrite existing config file')
  .action((options) => {
    const configPath = './untangle-api.yaml';

    if (existsSync(configPath) && !options.force) {
      logger.error(`Config file already exists: ${configPath}`);
      logger.dim('Use --force to overwrite');
      process.exit(1);
    }

    writeFileSync(configPath, DEFAULT_CONFIG, 'utf-8');
    logger.success(`Created config file: ${configPath}`);
    logger.dim('Edit this file to configure providers, routing, and production security defaults.');
  });
