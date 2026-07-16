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
const {
  MOAGENT_BUILD_IDENTITY,
  MOAGENT_FRAMEWORK_VERSION,
} = jiti('../../src/lib/agent/framework-identity.ts');
const {
  attestProductControlEvidence,
  loadQuantE2eSuite,
} = require('./quant-e2e-suite');

const REPORTS_DIR = path.resolve('tmp/quantpilot-benchmark-reports');
const CASES_PATH = path.resolve('benchmarks/quantpilot/cases.json');
const E2E_SUITE_PATH = path.resolve('benchmarks/quantpilot/e2e-suite.json');

function parseArgs(argv) {
  const args = {
    minPassRate: Number.parseInt(process.env.QUANTPILOT_CI_MIN_PASS_RATE || '100', 10),
    minAverageScore: Number.parseInt(process.env.QUANTPILOT_CI_MIN_AVERAGE_SCORE || '85', 10),
    requireNoFailed: process.env.QUANTPILOT_CI_ALLOW_FAILED !== '1',
    runIfMissing: false,
    caseIds: [],
    mode: process.env.QUANTPILOT_EVAL_MODE || 'contract',
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
  for (const [label, value] of [
    ['maxTurnsPerCase', args.maxTurnsPerCase],
    ['maxCacheMissInputTokensPerCase', args.maxCacheMissInputTokensPerCase],
    ['maxUnexpectedToolFailures', args.maxUnexpectedToolFailures],
  ]) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${label} 必须是非负整数`);
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
  const allCases = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));
  const configuredE2e = args.mode === 'e2e'
    ? loadQuantE2eSuite({
        root: process.cwd(),
        suitePath: E2E_SUITE_PATH,
        cases: allCases,
        requireReleaseCoverage: true,
      })
    : null;
  const requestedIds = args.caseIds.length > 0
    ? args.caseIds
    : args.mode === 'e2e'
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

function latestReportPath(mode) {
  if (!fs.existsSync(REPORTS_DIR)) return null;
  const files = fs
    .readdirSync(REPORTS_DIR)
    .filter((fileName) => /^report-\d+\.json$/.test(fileName))
    .map((fileName) => path.join(REPORTS_DIR, fileName))
    .filter((filePath) => {
      try {
        return reportMode(JSON.parse(fs.readFileSync(filePath, 'utf8'))) === mode;
      } catch {
        return false;
      }
    })
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return files[0] || null;
}

function averageScore(results) {
  if (!Array.isArray(results) || !results.length) return 0;
  const scores = results.map((result) => {
    if (result.passed) return 100;
    const failures = Array.isArray(result.failures) ? result.failures.length : 1;
    return Math.max(0, 60 - failures * 12);
  });
  return Math.round(scores.reduce((total, score) => total + score, 0) / scores.length);
}

function runBenchmark(caseIds, mode) {
  const args = ['run', mode === 'e2e' ? 'benchmark:quant:e2e' : 'benchmark:quant:contract'];
  args.push('--');
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
  let reportPath = latestReportPath(args.mode);
  if (!reportPath && args.runIfMissing) {
    runBenchmark(args.caseIds, args.mode);
    reportPath = latestReportPath(args.mode);
  }
  if (!reportPath) {
    console.error('[eval-ci] 没有找到评测报告。先运行 npm run benchmark:quant，或使用 --run-if-missing。');
    process.exit(1);
  }

  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  const total = Number(report.total || 0);
  const passedCount = Number(report.passedCount || 0);
  const failedCount = Number(report.failedCount || 0);
  const passRate = total ? Math.round((passedCount / total) * 100) : 0;
  const avgScore = averageScore(report.results);
  const problems = [];
  const createdAtMs = Date.parse(report.createdAt || report.metadata?.finishedAt || '');
  const ageHours = Number.isFinite(createdAtMs) ? (Date.now() - createdAtMs) / 3_600_000 : Number.POSITIVE_INFINITY;

  const { cases, e2eSuite } = expectedCases(args);
  const attestation = attestEvalReport(report, {
    mode: args.mode,
    expectedCaseIds: cases.map((testCase) => testCase.id),
    expectedCasesSha256: sha256(JSON.stringify(cases)),
    expectedPromptsSha256: sha256(
      cases.map((testCase) => testCase.question || '').join('\n'),
    ),
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
  if (args.mode === 'e2e' && args.caseIds.length === 0) {
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

  console.log(`[eval-ci] mode=${args.mode} report=${path.relative(process.cwd(), reportPath)}`);
  console.log(`[eval-ci] passed=${passedCount}/${total} passRate=${passRate}% averageScore=${avgScore}`);
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
