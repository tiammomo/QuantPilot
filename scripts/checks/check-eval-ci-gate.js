#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const REPORTS_DIR = path.resolve('tmp/quantpilot-benchmark-reports');

function parseArgs(argv) {
  const args = {
    minPassRate: Number.parseInt(process.env.QUANTPILOT_CI_MIN_PASS_RATE || '100', 10),
    minAverageScore: Number.parseInt(process.env.QUANTPILOT_CI_MIN_AVERAGE_SCORE || '85', 10),
    requireNoFailed: process.env.QUANTPILOT_CI_ALLOW_FAILED !== '1',
    runIfMissing: false,
    caseIds: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--run-if-missing') {
      args.runIfMissing = true;
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
  return args;
}

function latestReportPath() {
  if (!fs.existsSync(REPORTS_DIR)) return null;
  const files = fs
    .readdirSync(REPORTS_DIR)
    .filter((fileName) => /^report-\d+\.json$/.test(fileName))
    .map((fileName) => path.join(REPORTS_DIR, fileName))
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

function runBenchmark(caseIds) {
  const args = ['run', 'benchmark:quant'];
  if (caseIds.length) {
    args.push('--');
  }
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
  let reportPath = latestReportPath();
  if (!reportPath && args.runIfMissing) {
    runBenchmark(args.caseIds);
    reportPath = latestReportPath();
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

  if (args.requireNoFailed && failedCount > 0) {
    problems.push(`存在失败用例：${failedCount}`);
  }
  if (passRate < args.minPassRate) {
    problems.push(`通过率 ${passRate}% 低于阈值 ${args.minPassRate}%`);
  }
  if (avgScore < args.minAverageScore) {
    problems.push(`平均分 ${avgScore} 低于阈值 ${args.minAverageScore}`);
  }

  console.log(`[eval-ci] report=${path.relative(process.cwd(), reportPath)}`);
  console.log(`[eval-ci] passed=${passedCount}/${total} passRate=${passRate}% averageScore=${avgScore}`);

  if (problems.length) {
    console.error('[eval-ci] 阻断：');
    problems.forEach((problem) => console.error(`- ${problem}`));
    process.exit(1);
  }

  console.log('[eval-ci] ok');
}

main();
