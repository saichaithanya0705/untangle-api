#!/usr/bin/env node

import { Command } from 'commander';
import { startCommand } from './commands/start.js';
import { initCommand } from './commands/init.js';
import { keysCommand } from './commands/keys.js';

const program = new Command()
  .name('untangle-ai')
  .description('Unified AI API Gateway - proxy requests to multiple AI providers')
  .version('0.1.0');

program.addCommand(startCommand);
program.addCommand(initCommand);
program.addCommand(keysCommand);

// Default to start if no command given
program.action(() => {
  startCommand.parseAsync(process.argv.slice(2));
});

program.parse();
