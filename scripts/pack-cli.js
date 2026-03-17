#!/usr/bin/env node
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const cliDir = join(root, 'packages/cli');
const artifactsDir = join(root, 'artifacts/packages');
const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const cliPackage = JSON.parse(readFileSync(join(cliDir, 'package.json'), 'utf-8'));

function runPackCommand(args) {
  if (process.platform === 'win32') {
    return execSync(`${npmCommand} ${args.join(' ')}`, {
      cwd: cliDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }

  return execFileSync(npmCommand, args, {
    cwd: cliDir,
    encoding: 'utf-8',
  });
}

function parsePackOutput(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error('npm pack produced no JSON output.');
  }

  const start = trimmed.lastIndexOf('\n[');
  const json = start >= 0 ? trimmed.slice(start + 1) : trimmed;
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('npm pack JSON output had an unexpected shape.');
  }
  return parsed[parsed.length - 1];
}

function isAllowedTarballPath(path) {
  return path === 'package.json'
    || path === 'README.md'
    || path === 'LICENSE'
    || path === 'dist'
    || path.startsWith('dist/')
    || path === 'ui-dist'
    || path.startsWith('ui-dist/');
}

const packArgs = ['pack', '--json'];
if (dryRun) {
  packArgs.splice(1, 0, '--dry-run');
}

console.log(
  `[pack-cli] Packing ${cliPackage.name}@${cliPackage.version}${dryRun ? ' (dry run)' : ''}`,
);

const rawOutput = runPackCommand(packArgs);
const result = parsePackOutput(rawOutput);
const files = Array.isArray(result.files) ? result.files : [];
const unexpectedFiles = files
  .map((entry) => entry.path)
  .filter((path) => !isAllowedTarballPath(path));

if (unexpectedFiles.length > 0) {
  console.error('[pack-cli] Unexpected files would be published:');
  for (const path of unexpectedFiles) {
    console.error(` - ${path}`);
  }
  process.exit(1);
}

console.log(`[pack-cli] Tarball file count: ${files.length}`);

if (dryRun) {
  console.log('[pack-cli] Dry run passed.');
  process.exit(0);
}

if (!result.filename) {
  throw new Error('npm pack did not return a filename.');
}

const sourceTarball = join(cliDir, result.filename);
if (!existsSync(sourceTarball)) {
  throw new Error(`npm pack reported ${result.filename}, but the file was not created.`);
}

mkdirSync(artifactsDir, { recursive: true });
const destinationTarball = join(artifactsDir, result.filename);
if (existsSync(destinationTarball)) {
  rmSync(destinationTarball, { force: true });
}
renameSync(sourceTarball, destinationTarball);

console.log(`[pack-cli] Wrote ${relative(root, destinationTarball)}`);
