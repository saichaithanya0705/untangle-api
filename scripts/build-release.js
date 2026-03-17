#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const cliPackage = JSON.parse(
  readFileSync(join(root, 'packages/cli/package.json'), 'utf-8'),
);

function run(step, command) {
  console.log(`\n[release] ${step}`);
  execSync(command, { cwd: root, stdio: 'inherit' });
}

console.log('Preparing Untangle API release assets...');
run('Build workspace', 'pnpm run build');

const uiDist = join(root, 'packages/ui/dist');
const cliUiDist = join(root, 'packages/cli/ui-dist');
if (!existsSync(uiDist)) {
  throw new Error('UI build output was not produced at packages/ui/dist.');
}

if (existsSync(cliUiDist)) {
  rmSync(cliUiDist, { recursive: true, force: true });
}

mkdirSync(cliUiDist, { recursive: true });
cpSync(uiDist, cliUiDist, { recursive: true });

console.log('[release] Bundled UI assets into packages/cli/ui-dist');
console.log(`\nRelease assets are ready for ${cliPackage.name}@${cliPackage.version}.`);
console.log('Create a validated tarball with `pnpm run pack:cli`.');
