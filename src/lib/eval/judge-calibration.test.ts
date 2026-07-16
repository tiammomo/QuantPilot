import { describe, expect, it } from 'vitest';

import { evaluateEvalJudgeCalibration, type EvalJudgeCalibrationSample } from './judge-calibration';

const samples: EvalJudgeCalibrationSample[] = [
  { caseId: 'pass', human: { verdict: 'passed', score: 95 }, judge: { verdict: 'passed', score: 91, independentFromGenerator: true } },
  { caseId: 'warning', human: { verdict: 'warning', score: 72 }, judge: { verdict: 'warning', score: 75, independentFromGenerator: true } },
  { caseId: 'fail', human: { verdict: 'failed', score: 30 }, judge: { verdict: 'failed', score: 35, independentFromGenerator: true } },
];

describe('judge calibration', () => {
  it('calculates agreement, kappa and score error', () => {
    const result = evaluateEvalJudgeCalibration({ samples, requireIndependent: true });
    expect(result.passed).toBe(true);
    expect(result.summary).toMatchObject({
      verdictAgreementRate: 100,
      cohenKappa: 1,
      scoreMeanAbsoluteError: 4,
      independentSampleCount: 3,
    });
  });

  it('blocks a correlated and badly calibrated judge', () => {
    const result = evaluateEvalJudgeCalibration({
      samples: samples.map((sample) => ({
        ...sample,
        judge: { verdict: 'passed' as const, score: 100, independentFromGenerator: false },
      })),
      requireIndependent: true,
    });
    expect(result.passed).toBe(false);
    expect(result.problems).toEqual(expect.arrayContaining([
      expect.stringContaining('Cohen kappa'),
      'Judge 独立样本仅 0/3',
    ]));
  });
});
