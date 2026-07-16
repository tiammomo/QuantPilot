import { roundTo } from './statistics';

export type EvalCalibrationVerdict = 'passed' | 'warning' | 'failed';

export interface EvalJudgeCalibrationSample {
  caseId: string;
  human: { verdict: EvalCalibrationVerdict; score: number };
  judge: {
    verdict: EvalCalibrationVerdict;
    score: number;
    independentFromGenerator: boolean;
  };
}

const VERDICTS: EvalCalibrationVerdict[] = ['passed', 'warning', 'failed'];

function boundedScore(value: number): number {
  return Math.min(100, Math.max(0, Number.isFinite(value) ? value : 0));
}

export function buildEvalJudgeCalibration(samples: readonly EvalJudgeCalibrationSample[]) {
  const caseCount = samples.length;
  const agreementCount = samples.filter((sample) => sample.human.verdict === sample.judge.verdict).length;
  const observedAgreement = caseCount > 0 ? agreementCount / caseCount : 0;
  const expectedAgreement = caseCount > 0
    ? VERDICTS.reduce((total, verdict) => {
        const humanCount = samples.filter((sample) => sample.human.verdict === verdict).length;
        const judgeCount = samples.filter((sample) => sample.judge.verdict === verdict).length;
        return total + (humanCount / caseCount) * (judgeCount / caseCount);
      }, 0)
    : 0;
  const kappa = caseCount === 0
    ? 0
    : expectedAgreement === 1
      ? observedAgreement === 1 ? 1 : 0
      : (observedAgreement - expectedAgreement) / (1 - expectedAgreement);
  const scoreErrors = samples.map((sample) => ({
    caseId: sample.caseId,
    value: Math.abs(boundedScore(sample.human.score) - boundedScore(sample.judge.score)),
  }));
  const worstScoreError = scoreErrors.reduce(
    (maximum, item) => item.value > maximum.value ? item : maximum,
    { caseId: null as string | null, value: 0 },
  );
  return {
    caseCount,
    agreementCount,
    verdictAgreementRate: caseCount > 0 ? roundTo((agreementCount / caseCount) * 100) : 0,
    cohenKappa: roundTo(kappa, 3),
    scoreMeanAbsoluteError: caseCount > 0
      ? roundTo(scoreErrors.reduce((total, item) => total + item.value, 0) / caseCount)
      : 0,
    worstScoreError,
    independentSampleCount: samples.filter((sample) => sample.judge.independentFromGenerator).length,
    disagreements: samples
      .filter((sample) => sample.human.verdict !== sample.judge.verdict)
      .map((sample) => sample.caseId),
  };
}

export function evaluateEvalJudgeCalibration(input: {
  samples: readonly EvalJudgeCalibrationSample[];
  minAgreementRate?: number;
  minKappa?: number;
  maxScoreMeanAbsoluteError?: number;
  requireIndependent?: boolean;
}) {
  const summary = buildEvalJudgeCalibration(input.samples);
  const problems: string[] = [];
  const minAgreementRate = input.minAgreementRate ?? 80;
  const minKappa = input.minKappa ?? 0.6;
  const maxScoreMeanAbsoluteError = input.maxScoreMeanAbsoluteError ?? 15;
  if (summary.caseCount === 0) problems.push('Judge 校准集不能为空');
  if (summary.verdictAgreementRate < minAgreementRate) {
    problems.push(`Judge verdict 一致率 ${summary.verdictAgreementRate}% 低于 ${minAgreementRate}%`);
  }
  if (summary.cohenKappa < minKappa) {
    problems.push(`Judge Cohen kappa ${summary.cohenKappa} 低于 ${minKappa}`);
  }
  if (summary.scoreMeanAbsoluteError > maxScoreMeanAbsoluteError) {
    problems.push(`Judge 分数 MAE ${summary.scoreMeanAbsoluteError} 高于 ${maxScoreMeanAbsoluteError}`);
  }
  if (input.requireIndependent && summary.independentSampleCount !== summary.caseCount) {
    problems.push(`Judge 独立样本仅 ${summary.independentSampleCount}/${summary.caseCount}`);
  }
  return { passed: problems.length === 0, problems, summary };
}
