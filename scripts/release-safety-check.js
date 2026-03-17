#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function run(step, command) {
  console.log(`\n[release-safety] ${step}`);
  execSync(command, { cwd: root, stdio: 'inherit' });
}

run('Migration dry-run checks', 'node scripts/check-control-plane-migration.js');
run('Canary smoke suite', 'pnpm --filter @untangle-ai/server test src/__tests__/release-safety.test.ts src/__tests__/integration.test.ts src/__tests__/control-plane-bootstrap.test.ts');
run('Chaos degradation suite', 'pnpm --filter @untangle-ai/server test src/__tests__/chaos-resilience.test.ts');
run('Soak/memory gate', 'pnpm --filter @untangle-ai/server test src/__tests__/soak-memory.test.ts');
run('Rollback automation artifact', 'node scripts/generate-rollback-plan.js --output artifacts/release/rollback-plan.json');
run('CLI packaging dry-run', 'node scripts/pack-cli.js --dry-run');

console.log('\n[release-safety] all checks passed');
