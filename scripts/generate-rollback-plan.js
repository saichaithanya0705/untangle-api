#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';

function getArg(flagName, fallbackValue) {
  const argv = process.argv.slice(2);
  const index = argv.findIndex((value) => value === flagName);
  if (index < 0) return fallbackValue;
  const next = argv[index + 1];
  if (!next || next.startsWith('--')) return fallbackValue;
  return next;
}

function runGit(command) {
  try {
    return execSync(command, {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf-8',
    }).trim();
  } catch {
    return 'unknown';
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const outputArg = getArg('--output', 'observability/release/rollback-plan.json');
const outputPath = resolve(root, outputArg);

const commit = runGit('git rev-parse HEAD');
const branch = runGit('git rev-parse --abbrev-ref HEAD');
const generatedAt = new Date().toISOString();

const plan = {
  generatedAt,
  branch,
  commit,
  strategy: 'safe-revert',
  checkpoints: [
    'Confirm canary regression signal and freeze rollout traffic.',
    'Revert rollout commit(s) without force push.',
    'Redeploy last known-good build.',
    'Run post-rollback smoke checks (/health, /metrics, /api/settings).',
  ],
  commands: [
    `git checkout ${branch}`,
    '# Revert specific rollout commits (newest first):',
    '# git revert <commit_sha>',
    'pnpm run build',
    'pnpm --filter untangle-ai start -- --host 127.0.0.1 --port 4010',
  ],
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf-8');
console.log(`Rollback plan generated: ${outputPath}`);
