#!/usr/bin/env node

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const databaseUrl = process.env.PI_AGENT_TEST_DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error(
    '[pi-agent-postgres] PI_AGENT_TEST_DATABASE_URL is required; use an isolated disposable PostgreSQL database.'
  );
  process.exit(1);
}

const prismaPackage = require.resolve('prisma/package.json');
const prismaBin = path.join(path.dirname(prismaPackage), 'build', 'index.js');
console.log('[pi-agent-postgres] Applying versioned migrations to the disposable database...');
const provision = spawnSync(
  process.execPath,
  [prismaBin, 'migrate', 'deploy'],
  {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: 'inherit',
  }
);
if (provision.error) {
  console.error(`[pi-agent-postgres] Failed to provision schema: ${provision.error.message}`);
  process.exit(1);
}
if (provision.signal || provision.status !== 0) {
  console.error(
    `[pi-agent-postgres] Schema provisioning failed${
      provision.signal ? ` on signal ${provision.signal}` : ` with status ${provision.status}`
    }.`
  );
  process.exit(1);
}

const vitestPackage = require.resolve('vitest/package.json');
const vitestBin = path.join(path.dirname(vitestPackage), 'vitest.mjs');
const testFiles = [
  'src/lib/agent/runtime/prisma-repository.integration.test.ts',
  'src/lib/services/pi-agent-tool-approval-store.integration.test.ts',
  'src/lib/ops/product-health.integration.test.ts',
  'src/lib/quant/market-freshness.integration.test.ts',
  'src/lib/eval/queue-store.integration.test.ts',
];
const result = spawnSync(process.execPath, [vitestBin, 'run', ...testFiles], {
  cwd: process.cwd(),
  env: { ...process.env, DATABASE_URL: databaseUrl },
  stdio: 'inherit',
});

if (result.error) {
  console.error(`[pi-agent-postgres] Failed to start Vitest: ${result.error.message}`);
  process.exit(1);
}
if (result.signal) {
  console.error(`[pi-agent-postgres] Vitest exited on signal ${result.signal}.`);
  process.exit(1);
}
process.exit(result.status ?? 1);
