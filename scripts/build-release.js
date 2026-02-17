#!/usr/bin/env node
import { execSync } from 'child_process';
import { cpSync, mkdirSync, existsSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

console.log('Building untangle-ai for release...\n');

// Build all packages
console.log('1. Building all packages...');
execSync('pnpm run build', { stdio: 'inherit', cwd: root });

// Copy UI dist to CLI package
console.log('\n2. Copying UI assets to CLI package...');
const uiDist = join(root, 'packages/ui/dist');
const cliUiDist = join(root, 'packages/cli/ui-dist');

if (existsSync(cliUiDist)) {
  rmSync(cliUiDist, { recursive: true });
}

if (existsSync(uiDist)) {
  mkdirSync(cliUiDist, { recursive: true });
  cpSync(uiDist, cliUiDist, { recursive: true });
  console.log('   UI assets copied to packages/cli/ui-dist');
} else {
  console.log('   Warning: UI dist not found, skipping');
}

console.log('\n✓ Build complete!');
console.log('\nTo publish to npm:');
console.log('  cd packages/core && npm publish --access public');
console.log('  cd packages/server && npm publish --access public');
console.log('  cd packages/cli && npm publish');
console.log('\nOr test locally:');
console.log('  cd packages/cli && npm pack');
console.log('  npm install -g untangle-ai-0.1.0.tgz');
