#!/usr/bin/env node

const path = require('path');
const { spawnSync } = require('child_process');
const { performance } = require('perf_hooks');

const ROOT = process.cwd();
const MARKET_DATA_ROOT = path.join(ROOT, 'services', 'market-data');
const includeSecurity = process.argv.includes('--security');
const includeRuntime = process.argv.includes('--runtime');
const generateContractEvidence = process.argv.includes('--eval-contract');
const includeE2eEvidence = process.argv.includes('--e2e-evidence');

const checks = [
  ['AI provider boundary', 'npm', ['run', 'check:ai-provider-boundary'], ROOT],
  ['Documentation links', 'npm', ['run', 'check:docs'], ROOT],
  ['Skills registry', 'npm', ['run', 'check:skills'], ROOT],
  ['Generated artifact policy', 'npm', ['run', 'check:generated-artifacts'], ROOT],
  ['Scaffold template builds', 'npm', ['run', 'check:scaffold-templates'], ROOT],
  ['Validation repair contract', 'npm', ['run', 'check:validation-repair'], ROOT],
  ['Validation freshness contract', 'npm', ['run', 'check:validation-stale'], ROOT],
  ['Backend architecture', 'npm', ['run', 'check:backend-architecture'], ROOT],
  ['Module boundaries', 'npm', ['run', 'check:module-boundaries'], ROOT],
  ['Service catalog', 'npm', ['run', 'check:service-catalog'], ROOT],
  ['Quant guardrails', 'npm', ['run', 'check:quant-guardrails'], ROOT],
  ['Benchmark coverage', 'npm', ['run', 'check:benchmark-coverage'], ROOT],
  ['Frontend lint', 'npm', ['run', 'lint'], ROOT],
  ['Frontend unit tests', 'npm', ['run', 'test:unit'], ROOT],
  ['Frontend types', 'npm', ['run', 'type-check'], ROOT],
  ['Backend lint', 'uv', ['run', 'ruff', 'check', 'src', 'tests'], MARKET_DATA_ROOT],
  ['Backend tests', 'uv', ['run', 'pytest', '-q'], MARKET_DATA_ROOT],
  ['Production build', 'npm', ['run', 'build'], ROOT],
];

if (includeSecurity) {
  checks.splice(1, 0, ['Dependency security audit', 'npm', ['run', 'security:audit'], ROOT]);
}
if (includeRuntime) {
  checks.push(['Runtime and infrastructure doctor', 'npm', ['run', 'doctor:full'], ROOT]);
}
if (generateContractEvidence) {
  checks.push(
    ['Generate current-build contract evidence', 'npm', ['run', 'benchmark:quant:contract'], ROOT],
    ['Attest current-build contract evidence', 'npm', ['run', 'eval:ci'], ROOT],
  );
}
if (includeE2eEvidence) {
  checks.push(['Current-build live Mission E2E evidence', 'npm', ['run', 'eval:ci:e2e'], ROOT]);
}

const startedAt = performance.now();
const results = [];

for (const [name, command, args, cwd] of checks) {
  console.log(`\n[release] ${name}`);
  const stepStartedAt = performance.now();
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    shell: false,
    stdio: 'inherit',
  });
  const durationMs = performance.now() - stepStartedAt;
  const passed = result.status === 0 && !result.error;
  results.push({ name, passed, durationMs });
  if (!passed) {
    console.error(`[release] failed: ${name}${result.error ? ` (${result.error.message})` : ''}`);
    break;
  }
}

console.log('\n[release] summary');
for (const result of results) {
  console.log(`- ${result.passed ? 'PASS' : 'FAIL'} ${result.name} (${(result.durationMs / 1000).toFixed(1)}s)`);
}
console.log(`[release] total ${((performance.now() - startedAt) / 1000).toFixed(1)}s`);

if (results.length !== checks.length || results.some((result) => !result.passed)) {
  process.exit(1);
}

console.log('[release] ready');
