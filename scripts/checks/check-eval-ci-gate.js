#!/usr/bin/env node

require('tsconfig-paths/register');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const jiti = require('jiti')(path.join(process.cwd(), 'scripts/checks/check-eval-ci-gate.js'), {
  interopDefault: true,
});
const {
  DEFAULT_MOAGENT_E2E_QUALITY_THRESHOLDS,
} = jiti('../../src/lib/eval/e2e-attestation.ts');
const { attestEvalReport } = jiti('../../src/lib/eval/report-attestation.ts');
const { compareEvalReports } = jiti('../../src/lib/eval/regression.ts');
const { buildEvalQualitySummary, resultScore } = jiti('../../src/lib/eval/scoring.ts');
const { evalSnapshotPayloadSha256 } = jiti('../../src/lib/eval/snapshot-contract.ts');
const { normalizedPromptHash } = jiti('../../src/lib/eval/dataset-contract.ts');
const {
  MOAGENT_BUILD_IDENTITY,
  MOAGENT_FRAMEWORK_VERSION,
} = jiti('../../src/lib/agent/framework-identity.ts');
const {
  getDefaultModelForCli,
  getModelDefinitionsForCli,
} = jiti('../../src/lib/constants/models.ts');
const {
  attestProductControlEvidence,
  loadQuantE2eSuite,
} = require('./quant-e2e-suite');

const REPORTS_DIR = path.resolve('tmp/quantpilot-benchmark-reports');
const CASES_PATH = path.resolve('benchmarks/quantpilot/cases.json');
const E2E_SUITE_PATH = path.resolve('benchmarks/quantpilot/e2e-suite.json');
const DATASET_REGISTRY_PATH = path.resolve('benchmarks/quantpilot/datasets.json');
const SNAPSHOT_MANIFEST_PATH = path.resolve('benchmarks/quantpilot/snapshot-manifest.json');

function parseArgs(argv) {
  const args = {
    minPassRate: Number.parseInt(process.env.QUANTPILOT_CI_MIN_PASS_RATE || '100', 10),
    minAverageScore: Number.parseInt(process.env.QUANTPILOT_CI_MIN_AVERAGE_SCORE || '85', 10),
    minFirstPassRate: Number.parseInt(process.env.QUANTPILOT_CI_MIN_FIRST_PASS_RATE || '0', 10),
    minStabilityRate: Number.parseInt(process.env.QUANTPILOT_CI_MIN_STABILITY_RATE || '100', 10),
    minStabilityConfidenceLower: Number.parseInt(
      process.env.QUANTPILOT_CI_MIN_STABILITY_CONFIDENCE_LOWER || '0',
      10,
    ),
    maxScoreStandardDeviation: Number.parseInt(
      process.env.QUANTPILOT_CI_MAX_SCORE_STANDARD_DEVIATION || '100',
      10,
    ),
    maxRepairRate: Number.parseInt(process.env.QUANTPILOT_CI_MAX_REPAIR_RATE || '100', 10),
    baselineReport: process.env.QUANTPILOT_EVAL_BASELINE_REPORT || null,
    report: process.env.QUANTPILOT_EVAL_REPORT || null,
    maxScoreRegression: Number.parseInt(process.env.QUANTPILOT_CI_MAX_SCORE_REGRESSION || '0', 10),
    requireNoFailed: process.env.QUANTPILOT_CI_ALLOW_FAILED !== '1',
    runIfMissing: false,
    caseIds: [],
    mode: process.env.QUANTPILOT_EVAL_MODE || 'contract',
    datasetVisibility: process.env.QUANTPILOT_EVAL_DATASET_VISIBILITY || 'public',
    casesFile: process.env.QUANTPILOT_EVAL_CASES_PATH || null,
    model: process.env.QUANTPILOT_EVAL_MODEL || getDefaultModelForCli('moagent'),
    maxAgeHours: Number.parseInt(process.env.QUANTPILOT_EVAL_MAX_AGE_HOURS || '168', 10),
    maxTurnsPerCase: Number.parseInt(
      process.env.MOAGENT_E2E_MAX_TURNS_PER_CASE ||
      String(DEFAULT_MOAGENT_E2E_QUALITY_THRESHOLDS.maxTurnsPerCase),
      10,
    ),
    maxCacheMissInputTokensPerCase: Number.parseInt(
      process.env.MOAGENT_E2E_MAX_CACHE_MISS_INPUT_TOKENS_PER_CASE ||
      String(DEFAULT_MOAGENT_E2E_QUALITY_THRESHOLDS.maxCacheMissInputTokensPerCase),
      10,
    ),
    maxUnexpectedToolFailures: Number.parseInt(
      process.env.MOAGENT_E2E_MAX_UNEXPECTED_TOOL_FAILURES ||
      String(DEFAULT_MOAGENT_E2E_QUALITY_THRESHOLDS.maxUnexpectedToolFailures),
      10,
    ),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--run-if-missing') {
      args.runIfMissing = true;
      continue;
    }
    if (arg === '--mode' && argv[index + 1]) {
      args.mode = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith('--mode=')) {
      args.mode = arg.slice('--mode='.length);
      continue;
    }
    if (arg === '--dataset-visibility' && argv[index + 1]) {
      args.datasetVisibility = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith('--dataset-visibility=')) {
      args.datasetVisibility = arg.slice('--dataset-visibility='.length);
      continue;
    }
    if (arg === '--cases-file' && argv[index + 1]) {
      args.casesFile = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith('--cases-file=')) {
      args.casesFile = arg.slice('--cases-file='.length);
      continue;
    }
    if (arg === '--model' && argv[index + 1]) {
      args.model = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith('--model=')) {
      args.model = arg.slice('--model='.length);
      continue;
    }
    if (arg === '--max-age-hours' && argv[index + 1]) {
      args.maxAgeHours = Number.parseInt(argv[index + 1], 10);
      index += 1;
      continue;
    }
    if (arg.startsWith('--max-age-hours=')) {
      args.maxAgeHours = Number.parseInt(arg.slice('--max-age-hours='.length), 10);
      continue;
    }
    if (arg === '--allow-failed') {
      args.requireNoFailed = false;
      continue;
    }
    if (arg === '--min-pass-rate' && argv[index + 1]) {
      args.minPassRate = Number.parseInt(argv[index + 1], 10);
      index += 1;
      continue;
    }
    if (arg.startsWith('--min-pass-rate=')) {
      args.minPassRate = Number.parseInt(arg.slice('--min-pass-rate='.length), 10);
      continue;
    }
    if (arg === '--min-average-score' && argv[index + 1]) {
      args.minAverageScore = Number.parseInt(argv[index + 1], 10);
      index += 1;
      continue;
    }
    if (arg.startsWith('--min-average-score=')) {
      args.minAverageScore = Number.parseInt(arg.slice('--min-average-score='.length), 10);
      continue;
    }
    if (arg === '--min-first-pass-rate' && argv[index + 1]) {
      args.minFirstPassRate = Number.parseInt(argv[index + 1], 10);
      index += 1;
      continue;
    }
    if (arg.startsWith('--min-first-pass-rate=')) {
      args.minFirstPassRate = Number.parseInt(arg.slice('--min-first-pass-rate='.length), 10);
      continue;
    }
    if (arg === '--min-stability-rate' && argv[index + 1]) {
      args.minStabilityRate = Number.parseInt(argv[index + 1], 10);
      index += 1;
      continue;
    }
    if (arg.startsWith('--min-stability-rate=')) {
      args.minStabilityRate = Number.parseInt(arg.slice('--min-stability-rate='.length), 10);
      continue;
    }
    if (arg === '--min-stability-confidence-lower' && argv[index + 1]) {
      args.minStabilityConfidenceLower = Number.parseInt(argv[index + 1], 10);
      index += 1;
      continue;
    }
    if (arg.startsWith('--min-stability-confidence-lower=')) {
      args.minStabilityConfidenceLower = Number.parseInt(
        arg.slice('--min-stability-confidence-lower='.length),
        10,
      );
      continue;
    }
    if (arg === '--max-score-standard-deviation' && argv[index + 1]) {
      args.maxScoreStandardDeviation = Number.parseInt(argv[index + 1], 10);
      index += 1;
      continue;
    }
    if (arg.startsWith('--max-score-standard-deviation=')) {
      args.maxScoreStandardDeviation = Number.parseInt(
        arg.slice('--max-score-standard-deviation='.length),
        10,
      );
      continue;
    }
    if (arg === '--max-repair-rate' && argv[index + 1]) {
      args.maxRepairRate = Number.parseInt(argv[index + 1], 10);
      index += 1;
      continue;
    }
    if (arg.startsWith('--max-repair-rate=')) {
      args.maxRepairRate = Number.parseInt(arg.slice('--max-repair-rate='.length), 10);
      continue;
    }
    if (arg === '--baseline-report' && argv[index + 1]) {
      args.baselineReport = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === '--report' && argv[index + 1]) {
      args.report = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg.startsWith('--report=')) {
      args.report = arg.slice('--report='.length);
      continue;
    }
    if (arg.startsWith('--baseline-report=')) {
      args.baselineReport = arg.slice('--baseline-report='.length);
      continue;
    }
    if (arg === '--max-score-regression' && argv[index + 1]) {
      args.maxScoreRegression = Number.parseInt(argv[index + 1], 10);
      index += 1;
      continue;
    }
    if (arg.startsWith('--max-score-regression=')) {
      args.maxScoreRegression = Number.parseInt(arg.slice('--max-score-regression='.length), 10);
      continue;
    }
    if (arg === '--max-turns-per-case' && argv[index + 1]) {
      args.maxTurnsPerCase = Number.parseInt(argv[index + 1], 10);
      index += 1;
      continue;
    }
    if (arg.startsWith('--max-turns-per-case=')) {
      args.maxTurnsPerCase = Number.parseInt(arg.slice('--max-turns-per-case='.length), 10);
      continue;
    }
    if (arg === '--max-cache-miss-input-tokens-per-case' && argv[index + 1]) {
      args.maxCacheMissInputTokensPerCase = Number.parseInt(argv[index + 1], 10);
      index += 1;
      continue;
    }
    if (arg.startsWith('--max-cache-miss-input-tokens-per-case=')) {
      args.maxCacheMissInputTokensPerCase = Number.parseInt(
        arg.slice('--max-cache-miss-input-tokens-per-case='.length),
        10,
      );
      continue;
    }
    if (arg === '--max-unexpected-tool-failures' && argv[index + 1]) {
      args.maxUnexpectedToolFailures = Number.parseInt(argv[index + 1], 10);
      index += 1;
      continue;
    }
    if (arg.startsWith('--max-unexpected-tool-failures=')) {
      args.maxUnexpectedToolFailures = Number.parseInt(
        arg.slice('--max-unexpected-tool-failures='.length),
        10,
      );
      continue;
    }
    if (arg === '--case' && argv[index + 1]) {
      args.caseIds.push(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith('--case=')) {
      args.caseIds.push(arg.slice('--case='.length));
    }
  }
  if (!['contract', 'e2e'].includes(args.mode)) {
    throw new Error(`不支持的评测模式：${args.mode}`);
  }
  if (!['public', 'hidden', 'production_replay'].includes(args.datasetVisibility)) {
    throw new Error(`不支持的 dataset visibility：${args.datasetVisibility}`);
  }
  if (args.datasetVisibility !== 'public') {
    args.casesFile = args.casesFile || (args.datasetVisibility === 'hidden'
      ? process.env.QUANTPILOT_HIDDEN_EVAL_CASES_PATH
      : process.env.QUANTPILOT_PRODUCTION_REPLAY_CASES_PATH) || null;
    if (!args.casesFile) throw new Error(`${args.datasetVisibility} 门禁缺少外部 cases file`);
    if (args.mode !== 'e2e') throw new Error(`${args.datasetVisibility} 门禁必须使用 e2e 模式`);
  } else if (args.casesFile) {
    throw new Error('public 门禁固定使用仓库 cases.json，不能替换 cases file');
  }
  args.casesFile = path.resolve(args.casesFile || CASES_PATH);
  const requestedModel = args.model.trim().toLowerCase();
  const modelDefinition = getModelDefinitionsForCli('moagent').find((definition) =>
    definition.id.toLowerCase() === requestedModel ||
    definition.aliases.some((alias) => alias.toLowerCase() === requestedModel));
  if (!modelDefinition) throw new Error(`评测门收到未注册的 MoAgent 模型：${args.model || '(empty)'}`);
  args.model = modelDefinition.id;
  for (const [label, value] of [
    ['maxTurnsPerCase', args.maxTurnsPerCase],
    ['maxCacheMissInputTokensPerCase', args.maxCacheMissInputTokensPerCase],
    ['maxUnexpectedToolFailures', args.maxUnexpectedToolFailures],
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${label} 必须是非负整数`);
    }
  }
  for (const [label, value] of [
    ['minPassRate', args.minPassRate],
    ['minAverageScore', args.minAverageScore],
    ['minFirstPassRate', args.minFirstPassRate],
    ['minStabilityRate', args.minStabilityRate],
    ['minStabilityConfidenceLower', args.minStabilityConfidenceLower],
    ['maxScoreStandardDeviation', args.maxScoreStandardDeviation],
    ['maxRepairRate', args.maxRepairRate],
    ['maxScoreRegression', args.maxScoreRegression],
  ]) {
    if (!Number.isSafeInteger(value) || value < 0 || value > 100) {
      throw new Error(`${label} 必须是 0 到 100 的整数`);
    }
  }
  for (const [label, value, releaseMaximum] of [
    [
      'maxTurnsPerCase',
      args.maxTurnsPerCase,
      DEFAULT_MOAGENT_E2E_QUALITY_THRESHOLDS.maxTurnsPerCase,
    ],
    [
      'maxCacheMissInputTokensPerCase',
      args.maxCacheMissInputTokensPerCase,
      DEFAULT_MOAGENT_E2E_QUALITY_THRESHOLDS.maxCacheMissInputTokensPerCase,
    ],
    [
      'maxUnexpectedToolFailures',
      args.maxUnexpectedToolFailures,
      DEFAULT_MOAGENT_E2E_QUALITY_THRESHOLDS.maxUnexpectedToolFailures,
    ],
  ]) {
    if (value > releaseMaximum) {
      throw new Error(
        `${label} 只能收紧发布上限 ${releaseMaximum}，不能通过 CLI 或环境变量放宽`,
      );
    }
  }
  return args;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function expectedCases(args) {
  const allCases = JSON.parse(fs.readFileSync(args.casesFile, 'utf8'));
  if (!Array.isArray(allCases)) throw new Error('评测数据集必须是 case 数组');
  const configuredE2e = args.mode === 'e2e' && args.datasetVisibility === 'public'
    ? loadQuantE2eSuite({
        root: process.cwd(),
        suitePath: E2E_SUITE_PATH,
        cases: allCases,
        requireReleaseCoverage: true,
      })
    : null;
  const requestedIds = args.caseIds.length > 0
    ? args.caseIds
    : configuredE2e
      ? configuredE2e.caseIds
      : allCases.map((testCase) => testCase.id);
  const selected = new Set(requestedIds);
  const cases = allCases.filter((testCase) => selected.has(testCase.id));
  const missing = requestedIds.filter((id) => !cases.some((testCase) => testCase.id === id));
  if (missing.length > 0 || cases.length !== selected.size) {
    throw new Error(`评测门包含未知 case：${missing.join(', ')}`);
  }
  return { cases, e2eSuite: configuredE2e };
}

function reportMode(report) {
  return report?.metadata?.suite?.mode || 'contract';
}

function reportDatasetVisibility(report) {
  return report?.metadata?.dataset?.visibility || 'public';
}

function latestReportPath(mode, datasetVisibility) {
  if (!fs.existsSync(REPORTS_DIR)) return null;
  const files = fs
    .readdirSync(REPORTS_DIR)
    .filter((fileName) => /^report-\d+\.json$/.test(fileName))
    .map((fileName) => path.join(REPORTS_DIR, fileName))
    .filter((filePath) => {
      try {
        const report = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return reportMode(report) === mode && reportDatasetVisibility(report) === datasetVisibility;
      } catch {
        return false;
      }
    })
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] || null;
}

function averageScore(results) {
  if (!Array.isArray(results) || !results.length) return 0;
  const scores = results.map(resultScore);
  return Math.round(scores.reduce((total, score) => total + score, 0) / scores.length);
}

function runBenchmark(caseIds, mode, datasetVisibility, casesFile, model) {
  const args = ['run', mode === 'e2e' ? 'benchmark:quant:e2e' : 'benchmark:quant:contract'];
  args.push('--');
  args.push('--dataset-visibility', datasetVisibility);
  args.push('--model', model);
  if (datasetVisibility !== 'public') args.push('--cases-file', casesFile);
  caseIds.forEach((caseId) => {
    args.push('--case', caseId);
  });
  const result = spawnSync('npm', args, {
    stdio: 'inherit',
    env: { ...process.env, QUANTPILOT_EVAL_TRIGGER: 'ci' },
  });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let reportPath = args.report
    ? path.resolve(args.report)
    : latestReportPath(args.mode, args.datasetVisibility);
  if (args.report && !fs.existsSync(reportPath)) {
    console.error(`[eval-ci] 指定报告不存在：${args.report}`);
    process.exit(1);
  }
  if (!reportPath && args.runIfMissing) {
    runBenchmark(args.caseIds, args.mode, args.datasetVisibility, args.casesFile, args.model);
    reportPath = latestReportPath(args.mode, args.datasetVisibility);
  }
  if (!reportPath) {
    console.error('[eval-ci] 没有找到评测报告。先运行 npm run benchmark:quant:contract，或使用 --run-if-missing。');
    process.exit(1);
  }

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const total = Number(report.total || 0);
  const passedCount = Number(report.passedCount || 0);
  const failedCount = Number(report.failedCount || 0);
  const passRate = total ? Math.round((passedCount / total) * 100) : 0;
  const avgScore = averageScore(report.results);
  const qualitySummary = buildEvalQualitySummary(
    report.results || [],
    Number(report.metadata?.selection?.repeat || 1),
  );
  const problems = [];
  const createdAtMs = Date.parse(report.createdAt || report.metadata?.finishedAt || '');
  const ageHours = Number.isFinite(createdAtMs) ? (Date.now() - createdAtMs) / 3_600_000 : Number.POSITIVE_INFINITY;

  const { cases, e2eSuite } = expectedCases(args);
  const datasetRegistry = JSON.parse(fs.readFileSync(DATASET_REGISTRY_PATH, 'utf8'));
  const snapshotManifest = JSON.parse(fs.readFileSync(SNAPSHOT_MANIFEST_PATH, 'utf8'));
  const expectedCaseIds = new Set(cases.map((testCase) => testCase.id));
  const expectedDataSnapshots = (snapshotManifest.snapshots || [])
    .filter((snapshot) => expectedCaseIds.has(snapshot.caseId))
    .map((snapshot) => ({
      caseId: snapshot.caseId,
      id: snapshot.id,
      asOf: snapshot.asOf,
      payloadSha256: snapshot.payloadSha256,
    }));
  const attestation = attestEvalReport(report, {
    mode: args.mode,
    expectedCaseIds: cases.map((testCase) => testCase.id),
    expectedCasesSha256: sha256(JSON.stringify(cases)),
    expectedPromptsSha256: sha256(
      cases.map((testCase) => testCase.question || '').join('\n'),
    ),
    expectedDatasetRegistrySha256: evalSnapshotPayloadSha256(datasetRegistry),
    expectedSnapshotManifestSha256: evalSnapshotPayloadSha256(snapshotManifest),
    expectedDataSnapshots,
    expectedDatasetVisibility: args.datasetVisibility,
    expectedRuntimeProvider: getModelDefinitionsForCli('moagent')
      .find((definition) => definition.id === args.model).provider,
    expectedRuntimeModel: args.model,
    expectedResultQuestions: Object.fromEntries(cases.map((testCase) => [
      testCase.id,
      args.datasetVisibility === 'public'
        ? testCase.question
        : `[redacted:${normalizedPromptHash(testCase.question || '')}]`,
    ])),
    frameworkVersion: MOAGENT_FRAMEWORK_VERSION,
    buildRevision: MOAGENT_BUILD_IDENTITY.buildRevision,
    gitRevision: MOAGENT_BUILD_IDENTITY.gitRevision,
    qualityThresholds: {
      maxTurnsPerCase: args.maxTurnsPerCase,
      maxCacheMissInputTokensPerCase: args.maxCacheMissInputTokensPerCase,
      maxUnexpectedToolFailures: args.maxUnexpectedToolFailures,
    },
  });
  problems.push(...attestation.problems);
  if (args.mode === 'e2e' && args.datasetVisibility === 'public' && args.caseIds.length === 0) {
    const productControlAttestation = attestProductControlEvidence(
      report?.metadata?.releaseControls,
      {
        suite: e2eSuite,
        frameworkVersion: MOAGENT_FRAMEWORK_VERSION,
        buildRevision: MOAGENT_BUILD_IDENTITY.buildRevision,
        gitRevision: MOAGENT_BUILD_IDENTITY.gitRevision,
      },
    );
    problems.push(...productControlAttestation.problems);
    const expectedReleasePassed = report.passed === true &&
      attestation.passed &&
      productControlAttestation.passed;
    if (report.releasePassed !== expectedReleasePassed) {
      problems.push('报告 releasePassed 与 live-model/product-control 重算结果不一致');
    }
  }
  if (Number.isFinite(ageHours) && ageHours < -(5 / 60)) {
    problems.push('报告时间位于允许时钟偏差之外的未来');
  }
  if (Number.isFinite(args.maxAgeHours) && args.maxAgeHours > 0 && ageHours > args.maxAgeHours) {
    problems.push(`报告已超过 ${args.maxAgeHours} 小时（当前 ${Math.round(ageHours)} 小时）`);
  }
  if (args.requireNoFailed && failedCount > 0) {
    problems.push(`存在失败用例：${failedCount}`);
  }
  if (passRate < args.minPassRate) {
    problems.push(`通过率 ${passRate}% 低于阈值 ${args.minPassRate}%`);
  }
  if (avgScore < args.minAverageScore) {
    problems.push(`平均分 ${avgScore} 低于阈值 ${args.minAverageScore}`);
  }
  if (qualitySummary.firstPassRate < args.minFirstPassRate) {
    problems.push(`首轮通过率 ${qualitySummary.firstPassRate}% 低于阈值 ${args.minFirstPassRate}%`);
  }
  if (qualitySummary.stability.passRate < args.minStabilityRate) {
    problems.push(`重复运行稳定率 ${qualitySummary.stability.passRate}% 低于阈值 ${args.minStabilityRate}%`);
  }
  if (qualitySummary.stability.confidence95.lower < args.minStabilityConfidenceLower) {
    problems.push(
      `重复运行稳定率 95% 置信下界 ${qualitySummary.stability.confidence95.lower}% ` +
      `低于阈值 ${args.minStabilityConfidenceLower}%`,
    );
  }
  if (qualitySummary.stability.scoreStdDev.max.value > args.maxScoreStandardDeviation) {
    problems.push(
      `最大逐 case 分数标准差 ${qualitySummary.stability.scoreStdDev.max.value} ` +
      `高于阈值 ${args.maxScoreStandardDeviation} ` +
      `(${qualitySummary.stability.scoreStdDev.max.id ?? 'unknown'})`,
    );
  }
  if (qualitySummary.repairRate > args.maxRepairRate) {
    problems.push(`修复率 ${qualitySummary.repairRate}% 高于阈值 ${args.maxRepairRate}%`);
  }

  let regression = null;
  if (args.baselineReport) {
    const baselinePath = path.resolve(args.baselineReport);
    if (!fs.existsSync(baselinePath)) {
      problems.push(`baseline 报告不存在：${args.baselineReport}`);
    } else {
      const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
      if (reportMode(baseline) !== args.mode) {
        problems.push('baseline 报告模式与当前报告不一致');
      } else if (reportDatasetVisibility(baseline) !== args.datasetVisibility) {
        problems.push('baseline 与当前报告的数据集可见性不一致');
      } else if (baseline.schemaVersion !== report.schemaVersion) {
        problems.push('baseline 与当前报告的 schemaVersion 不一致');
      } else if (
        baseline.metadata?.evaluator?.id !== report.metadata?.evaluator?.id ||
        baseline.metadata?.evaluator?.version !== report.metadata?.evaluator?.version ||
        baseline.metadata?.evaluator?.rubricVersion !== report.metadata?.evaluator?.rubricVersion
      ) {
        problems.push('baseline 与当前报告的 evaluator/rubric 版本不一致');
      } else if (baseline.metadata?.provenance?.casesSha256 !== report.metadata?.provenance?.casesSha256) {
        problems.push('baseline 与当前报告的 case 数据集版本不一致');
      } else if (
        baseline.metadata?.provenance?.datasetRegistrySha256 !== report.metadata?.provenance?.datasetRegistrySha256 ||
        baseline.metadata?.provenance?.snapshotManifestSha256 !== report.metadata?.provenance?.snapshotManifestSha256
      ) {
        problems.push('baseline 与当前报告的数据集或 snapshot 合同不一致');
      } else {
        regression = compareEvalReports(report, baseline);
        if (regression.matchedCaseCount !== total) {
          problems.push(`baseline 只匹配 ${regression.matchedCaseCount}/${total} 个 case`);
        }
        if (regression.passRegressions.length > 0) {
          problems.push(`出现通过状态回归：${regression.passRegressions.join(', ')}`);
        }
        if (regression.firstPassRegressions.length > 0) {
          problems.push(`出现首轮通过回归：${regression.firstPassRegressions.join(', ')}`);
        }
        if (regression.scoreDelta < -args.maxScoreRegression) {
          problems.push(`成对平均分回归 ${regression.scoreDelta}，超过允许值 ${args.maxScoreRegression}`);
        }
        const caseScoreRegressions = regression.cases
          .filter((item) => item.scoreDelta < -args.maxScoreRegression)
          .map((item) => `${item.id}(${item.scoreDelta})`);
        if (caseScoreRegressions.length > 0) {
          problems.push(`出现逐 case 分数回归：${caseScoreRegressions.join(', ')}`);
        }
      }
    }
  }

  console.log(`[eval-ci] mode=${args.mode} report=${path.relative(process.cwd(), reportPath)}`);
  console.log(`[eval-ci] passed=${passedCount}/${total} passRate=${passRate}% averageScore=${avgScore}`);
  console.log(
    `[eval-ci] firstPass=${qualitySummary.firstPassRate}% repair=${qualitySummary.repairRate}% ` +
    `stability=${qualitySummary.stability.passRate}% ` +
    `ci95=${qualitySummary.stability.confidence95.lower}-${qualitySummary.stability.confidence95.upper}% ` +
    `scoreStdDevMax=${qualitySummary.stability.scoreStdDev.max.value} ` +
    `durationP95=${qualitySummary.durationMs.p95}ms`,
  );
  if (regression) {
    console.log(
      `[eval-ci] paired baseline matched=${regression.matchedCaseCount} ` +
      `scoreDelta=${regression.scoreDelta}`,
    );
  }
  if (attestation.quality) {
    console.log(
      `[eval-ci] turns(avg/max)=${attestation.quality.summary.turns.average}/` +
      `${attestation.quality.summary.turns.max.value} ` +
      `cacheMiss(avg/max)=${attestation.quality.summary.cacheMissInputTokens.average}/` +
      `${attestation.quality.summary.cacheMissInputTokens.max.value} ` +
      `unexpectedToolFailures=${attestation.quality.summary.tools.unexpectedFailureCount}`,
    );
  }

  if (problems.length) {
    console.error('[eval-ci] 阻断：');
    problems.forEach((problem) => console.error(`- ${problem}`));
    process.exit(1);
  }

  console.log('[eval-ci] ok');
}

main();
