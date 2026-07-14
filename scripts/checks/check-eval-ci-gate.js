#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const jiti = require('jiti')(path.join(process.cwd(), 'scripts/checks/check-eval-ci-gate.js'), {
  interopDefault: true,
});
const { summarizeE2eAgentExecution } = jiti('../../src/lib/eval/e2e-attestation.ts');

const REPORTS_DIR = path.resolve('tmp/quantpilot-benchmark-reports');

function parseArgs(argv) {
  const args = {
    minPassRate: Number.parseInt(process.env.QUANTPILOT_CI_MIN_PASS_RATE || '100', 10),
    minAverageScore: Number.parseInt(process.env.QUANTPILOT_CI_MIN_AVERAGE_SCORE || '85', 10),
    requireNoFailed: process.env.QUANTPILOT_CI_ALLOW_FAILED !== '1',
    runIfMissing: false,
    caseIds: [],
    mode: process.env.QUANTPILOT_EVAL_MODE || 'contract',
    maxAgeHours: Number.parseInt(process.env.QUANTPILOT_EVAL_MAX_AGE_HOURS || '168', 10),
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
  return args;
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

  if (reportMode(report) !== args.mode) {
    problems.push(`报告模式 ${reportMode(report)} 与要求的 ${args.mode} 不一致`);
  }
  if (Number.isFinite(args.maxAgeHours) && args.maxAgeHours > 0 && ageHours > args.maxAgeHours) {
    problems.push(`报告已超过 ${args.maxAgeHours} 小时（当前 ${Math.round(ageHours)} 小时）`);
  }
  if (args.mode === 'e2e' && report.metadata?.runtime?.agentExecuted !== true) {
    problems.push('E2E 报告没有真实 Agent 执行标记');
  }
  if (args.mode === 'e2e') {
    const executionSummary = summarizeE2eAgentExecution(Array.isArray(report.results) ? report.results : []);
    if (executionSummary.unattestedCaseIds.length > 0) {
      problems.push(
        `E2E 报告包含未逐 case 证明真实 Agent 执行的用例：${executionSummary.unattestedCaseIds.join(', ')}`,
      );
    }
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

  if (problems.length) {
    console.error('[eval-ci] 阻断：');
    problems.forEach((problem) => console.error(`- ${problem}`));
    process.exit(1);
  }

  console.log('[eval-ci] ok');
}

main();
