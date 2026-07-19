#!/usr/bin/env node

require('tsconfig-paths/register');

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const jiti = require('jiti')(path.join(process.cwd(), 'scripts/checks/check-eval-datasets.js'), {
  interopDefault: true,
});
const { attestEvalDatasetRegistry } = jiti('../../src/lib/eval/dataset-contract.ts');
const { attestEvalDataSnapshot, evalSnapshotPayloadSha256 } = jiti('../../src/lib/eval/snapshot-contract.ts');
const { attestProductionReplayCase } = jiti('../../src/lib/eval/shadow-replay.ts');

const root = process.cwd();
const benchmarkRoot = path.resolve('benchmarks/quantpilot');
const registryPath = path.join(benchmarkRoot, 'datasets.json');
const queryRewriteFixturesPath = path.join(benchmarkRoot, 'query-rewrite-fixtures.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function safeBenchmarkPath(relativePath, label) {
  const resolved = path.resolve(benchmarkRoot, relativePath);
  if (resolved !== benchmarkRoot && !resolved.startsWith(`${benchmarkRoot}${path.sep}`)) {
    throw new Error(`${label} 必须位于 benchmarks/quantpilot 内`);
  }
  return resolved;
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function readExternalCases(definition, problems) {
  const configuredPath = definition.pathEnv ? process.env[definition.pathEnv] : '';
  const requiredByRelease = definition.visibility === 'hidden' && process.env.QUANTPILOT_REQUIRE_HIDDEN_EVAL === '1';
  if (!configuredPath) {
    if (definition.required || requiredByRelease) {
      problems.push(`${definition.id} 缺少 ${definition.pathEnv} 配置`);
    }
    return [];
  }
  const resolved = path.resolve(configuredPath);
  if (!fs.existsSync(resolved)) {
    problems.push(`${definition.id} 外部数据集不存在`);
    return [];
  }
  const relative = path.relative(root, resolved);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', relative], {
      cwd: root,
      stdio: 'ignore',
    });
    if (tracked.status === 0) {
      problems.push(`${definition.id} 非公开数据集被 Git 跟踪，存在测试集泄漏风险`);
    }
  }
  const value = readJson(resolved);
  if (!Array.isArray(value)) {
    problems.push(`${definition.id} 必须是 case 数组`);
    return [];
  }
  return value;
}

function main() {
  const problems = [];
  const registry = readJson(registryPath);
  const publicDefinition = registry.datasets.find((item) => item.visibility === 'public');
  if (!publicDefinition?.path) throw new Error('dataset registry 缺少 public dataset');
  const publicCases = readJson(safeBenchmarkPath(publicDefinition.path, publicDefinition.id));
  const queryRewriteFixtures = readJson(queryRewriteFixturesPath);
  if (
    queryRewriteFixtures.schemaVersion !== 1 ||
    queryRewriteFixtures.provider !== 'contract-fixture' ||
    typeof queryRewriteFixtures.model !== 'string' ||
    !queryRewriteFixtures.model
  ) {
    problems.push('query rewrite fixture 必须声明 schemaVersion=1、contract-fixture provider 和 model');
  }
  const fixtureCases = queryRewriteFixtures.cases && typeof queryRewriteFixtures.cases === 'object'
    ? queryRewriteFixtures.cases
    : {};
  const fixtureFreeTypes = new Set(['runtime_registry', 'repair_plan', 'renderer_capability_contract']);
  const expectedFixtureCases = publicCases.filter((testCase) => !fixtureFreeTypes.has(testCase.type));
  for (const testCase of expectedFixtureCases) {
    const phases = fixtureCases[testCase.id];
    const requiredPhases = testCase.type === 'clarification_continuation'
      ? ['primary', 'followup']
      : ['primary'];
    for (const phase of requiredPhases) {
      const fixture = phases?.[phase];
      if (!fixture) {
        problems.push(`${testCase.id}: 缺少 query rewrite ${phase} fixture`);
        continue;
      }
      if (
        !Array.isArray(fixture.targetCandidates) ||
        !['comprehensive', 'technical', 'fundamental', 'events', 'comparison', 'strategy', 'backtest', 'portfolio_risk']
          .includes(fixture.analysisFocusId) ||
        !['dashboard', 'answer'].includes(fixture.outputIntent) ||
        typeof fixture.broadUniverse !== 'boolean' ||
        typeof fixture.confidence !== 'number'
      ) {
        problems.push(`${testCase.id}/${phase}: query rewrite fixture 结构无效`);
      }
    }
  }
  const publicCaseIds = new Set(publicCases.map((testCase) => testCase.id));
  for (const fixtureCaseId of Object.keys(fixtureCases)) {
    if (!publicCaseIds.has(fixtureCaseId)) {
      problems.push(`query rewrite fixture 引用了未知 case：${fixtureCaseId}`);
    }
  }
  const externalDatasets = {};
  for (const definition of registry.datasets.filter((item) => item.visibility !== 'public')) {
    externalDatasets[definition.visibility] = readExternalCases(definition, problems);
  }
  const datasetAttestation = attestEvalDatasetRegistry({ registry, publicCases, externalDatasets });
  problems.push(...datasetAttestation.problems);
  for (const testCase of externalDatasets.production_replay || []) {
    const privacy = attestProductionReplayCase(testCase);
    problems.push(...privacy.problems.map((item) => `${testCase.id || '<missing-id>'}: ${item}`));
  }

  const snapshotManifestPath = safeBenchmarkPath(registry.snapshotManifest, 'snapshotManifest');
  const snapshotManifest = readJson(snapshotManifestPath);
  const snapshots = Array.isArray(snapshotManifest.snapshots) ? snapshotManifest.snapshots : [];
  if (snapshotManifest.schemaVersion !== 1 || !snapshotManifest.id || !snapshotManifest.version) {
    problems.push('snapshot manifest 缺少 schemaVersion/id/version');
  }
  const snapshotCaseIds = new Set();
  for (const snapshot of snapshots) {
    if (snapshotCaseIds.has(snapshot.caseId)) problems.push(`snapshot caseId 重复：${snapshot.caseId}`);
    snapshotCaseIds.add(snapshot.caseId);
    const testCase = publicCases.find((item) => item.id === snapshot.caseId);
    if (!testCase) {
      problems.push(`snapshot 引用了未知 case：${snapshot.caseId}`);
      continue;
    }
    let payload;
    try {
      payload = readJson(safeBenchmarkPath(snapshot.fixturePath, `${snapshot.caseId} fixture`));
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
      continue;
    }
    const attestation = attestEvalDataSnapshot(snapshot, payload, {
      expectedCaseId: snapshot.caseId,
    });
    problems.push(...attestation.problems.map((item) => `${snapshot.caseId}: ${item}`));
    if (payload.asOf !== snapshot.asOf) problems.push(`${snapshot.caseId}: fixture asOf 与 manifest 不一致`);
    const expectedSymbols = [...new Set([...(testCase.expectedSymbols || []), testCase.expectedSymbol].filter(Boolean))].sort();
    const fixtureSymbols = Array.isArray(payload.expectedSymbols) ? [...payload.expectedSymbols].sort() : [];
    if (!sameStrings(expectedSymbols, fixtureSymbols)) {
      problems.push(`${snapshot.caseId}: fixture expectedSymbols 与 case 不一致`);
    }
    const expectedOracleIds = (testCase.oracleAssertions || []).map((item) => item.id).sort();
    const fixtureOracleIds = Array.isArray(payload.oracleIds) ? [...payload.oracleIds].sort() : [];
    if (!sameStrings(expectedOracleIds, fixtureOracleIds)) {
      problems.push(`${snapshot.caseId}: fixture oracleIds 与 case 不一致`);
    }
  }
  const productionCaseIds = publicCases.filter((item) => item.productionSupported === true).map((item) => item.id);
  const missingSnapshots = productionCaseIds.filter((id) => !snapshotCaseIds.has(id));
  problems.push(...missingSnapshots.map((id) => `${id}: production case 缺少可重放 snapshot`));

  const manifestSha256 = evalSnapshotPayloadSha256(snapshotManifest);
  console.log(
    `[eval-datasets] public=${datasetAttestation.summary.publicCaseCount} ` +
    `hidden=${datasetAttestation.summary.hiddenCaseCount} replay=${datasetAttestation.summary.productionReplayCaseCount} ` +
    `snapshots=${snapshots.length}/${productionCaseIds.length}`,
  );
  console.log(`[eval-datasets] snapshotManifestSha256=${manifestSha256}`);
  if (problems.length > 0) {
    console.error('[eval-datasets] failed:');
    problems.forEach((problem) => console.error(`- ${problem}`));
    process.exitCode = 1;
    return;
  }
  console.log('[eval-datasets] ok: public/hidden 污染防护与生产 snapshot 合同通过');
}

main();
