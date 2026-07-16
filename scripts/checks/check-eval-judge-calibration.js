#!/usr/bin/env node

require('tsconfig-paths/register');

const fs = require('fs');
const path = require('path');
const jiti = require('jiti')(path.join(process.cwd(), 'scripts/checks/check-eval-judge-calibration.js'), {
  interopDefault: true,
});
const { evaluateEvalJudgeCalibration } = jiti('../../src/lib/eval/judge-calibration.ts');

function argument(name, fallback) {
  const exact = process.argv.indexOf(name);
  if (exact >= 0 && process.argv[exact + 1]) return process.argv[exact + 1];
  const prefix = `${name}=`;
  return process.argv.find((item) => item.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

const configuredInput = argument(
  '--input',
  process.env.QUANTPILOT_EVAL_JUDGE_CALIBRATION_PATH || 'benchmarks/quantpilot/judge-calibration.contract.json',
);
const inputPath = path.resolve(configuredInput);
if (!fs.existsSync(inputPath)) throw new Error(`Judge 校准集不存在：${configuredInput}`);
const dataset = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
if (dataset.schemaVersion !== 1 || !Array.isArray(dataset.samples)) {
  throw new Error('Judge 校准集必须使用 schemaVersion 1 并包含 samples');
}
const requireProduction = process.env.QUANTPILOT_REQUIRE_PRODUCTION_JUDGE_CALIBRATION === '1';
if (requireProduction && dataset.datasetKind !== 'human_blind_calibration') {
  throw new Error('发布门要求外部 human_blind_calibration，不能使用 pipeline_contract');
}
const result = evaluateEvalJudgeCalibration({
  samples: dataset.samples,
  minAgreementRate: Number(argument('--min-agreement-rate', '80')),
  minKappa: Number(argument('--min-kappa', '0.6')),
  maxScoreMeanAbsoluteError: Number(argument('--max-score-mae', '15')),
  requireIndependent: process.env.QUANTPILOT_REQUIRE_INDEPENDENT_JUDGE === '1' || dataset.datasetKind === 'human_blind_calibration',
});
console.log(
  `[eval-judge] kind=${dataset.datasetKind} samples=${result.summary.caseCount} ` +
  `agreement=${result.summary.verdictAgreementRate}% kappa=${result.summary.cohenKappa} ` +
  `scoreMAE=${result.summary.scoreMeanAbsoluteError} independent=${result.summary.independentSampleCount}/${result.summary.caseCount}`,
);
if (!result.passed) {
  result.problems.forEach((problem) => console.error(`- ${problem}`));
  process.exitCode = 1;
}
