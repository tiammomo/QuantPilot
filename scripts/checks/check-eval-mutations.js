#!/usr/bin/env node

require('tsconfig-paths/register');

const fs = require('fs');
const path = require('path');
const jiti = require('jiti')(path.join(process.cwd(), 'scripts/checks/check-eval-mutations.js'), {
  interopDefault: true,
});
const { runEvalMutationSuite } = jiti('../../src/lib/eval/mutations.ts');
const { evalSnapshotPayloadSha256 } = jiti('../../src/lib/eval/snapshot-contract.ts');

const thresholdArg = process.argv.find((arg) => arg.startsWith('--min-kill-rate='));
const thresholdIndex = process.argv.indexOf('--min-kill-rate');
const rawThreshold = thresholdArg
  ? thresholdArg.slice('--min-kill-rate='.length)
  : thresholdIndex >= 0 ? process.argv[thresholdIndex + 1] : process.env.QUANTPILOT_EVAL_MIN_MUTATION_KILL_RATE || '100';
const minKillRate = Number.parseInt(rawThreshold, 10);
if (!Number.isSafeInteger(minKillRate) || minKillRate < 0 || minKillRate > 100) {
  throw new Error('--min-kill-rate 必须是 0 到 100 的整数');
}

const catalogPath = path.resolve('benchmarks/quantpilot/mutation-catalog.json');
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
if (catalog.schemaVersion !== 1 || !Array.isArray(catalog.mutations) || catalog.mutations.length === 0) {
  throw new Error('mutation catalog 必须使用 schemaVersion 1 并包含 mutations');
}
const rawReport = runEvalMutationSuite('rule-strict');
const expectedById = new Map(catalog.mutations.map((item) => [item.id, item]));
const actualById = new Map(rawReport.results.map((item) => [item.id, item]));
const catalogProblems = [];
for (const [id, expected] of expectedById) {
  const actual = actualById.get(id);
  if (!actual) catalogProblems.push(`catalog mutation 缺少实现：${id}`);
  else if (actual.category !== expected.category || actual.expectedDetector !== expected.expectedDetector) {
    catalogProblems.push(`catalog mutation 合同漂移：${id}`);
  }
}
for (const id of actualById.keys()) {
  if (!expectedById.has(id)) catalogProblems.push(`mutation 实现未登记：${id}`);
}
const report = {
  ...rawReport,
  catalog: {
    id: catalog.id,
    version: catalog.version,
    sha256: evalSnapshotPayloadSha256(catalog),
  },
};
const outputDir = path.resolve('tmp/quantpilot-eval-mutations');
fs.mkdirSync(outputDir, { recursive: true });
const reportPath = path.join(outputDir, `mutation-report-${Date.now()}.json`);
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

console.log(`[eval-mutation] baseline=${report.baselinePassed ? 'passed' : 'failed'} killed=${report.killed}/${report.total} killRate=${report.killRate}%`);
for (const [category, summary] of Object.entries(report.byCategory)) {
  console.log(`[eval-mutation] ${category}=${summary.killed}/${summary.total} (${summary.killRate}%)`);
}
console.log(`[eval-mutation] report=${path.relative(process.cwd(), reportPath)}`);
if (
  catalogProblems.length > 0 ||
  !report.baselinePassed ||
  report.killRate < Math.max(minKillRate, Number(catalog.minimumKillRate || 0)) ||
  report.survived > 0
) {
  catalogProblems.forEach((problem) => console.error(`- ${problem}`));
  for (const mutation of report.results.filter((item) => !item.killed)) {
    console.error(`- survived ${mutation.id}: expected=${mutation.expectedDetector} detected=${mutation.detectedBy.join(',') || 'none'}`);
  }
  process.exitCode = 1;
}
