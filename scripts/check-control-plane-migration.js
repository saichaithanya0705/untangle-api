#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const migrationSourcePath = join(root, 'packages/core/src/control-plane/postgres.ts');
const source = readFileSync(migrationSourcePath, 'utf-8');

const requiredSnippets = [
  'migrationName: \'control_plane_base\'',
  'create table if not exists ${qSchema}.cp_virtual_keys',
  'create table if not exists ${qSchema}.cp_usage_events',
  'create table if not exists ${qSchema}.cp_spend_ledger',
  'create index if not exists idx_cp_usage_events_ts',
  'create index if not exists idx_cp_spend_ledger_ts',
];

const missing = requiredSnippets.filter((snippet) => !source.includes(snippet));
if (missing.length > 0) {
  console.error('Migration dry-run check failed. Missing required SQL snippets:');
  for (const snippet of missing) {
    console.error(`  - ${snippet}`);
  }
  process.exit(1);
}

console.log('Migration dry-run checks passed for control_plane_base schema artifact.');
