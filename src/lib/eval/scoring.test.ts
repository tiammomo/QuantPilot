import { describe, expect, it } from 'vitest';

import { buildEvalQualitySummary, resultScore } from './scoring';

describe('evaluation scoring', () => {
  it('uses the persisted evaluator score consistently', () => {
    expect(resultScore({ passed: true, evaluation: { score: 87 } })).toBe(87);
    expect(resultScore({ passed: true })).toBe(100);
  });

  it('reports first-pass, repair and repeat stability independently', () => {
    const summary = buildEvalQualitySummary([
      {
        id: 'a',
        passed: true,
        finalPassed: true,
        firstPassPassed: true,
        repairAttempts: 0,
        durationMs: 100,
        evaluation: { score: 92, dimensions: [] },
        stability: { attempts: [{ passed: true }, { passed: false }] },
      },
      {
        id: 'b',
        passed: true,
        finalPassed: true,
        firstPassPassed: false,
        repairAttempts: 1,
        durationMs: 300,
        evaluation: { score: 80, dimensions: [] },
        stability: { attempts: [{ passed: true }, { passed: true }] },
      },
    ], 2);

    expect(summary).toMatchObject({
      firstPassRate: 50,
      finalPassRate: 100,
      repairRate: 50,
      averageScore: 86,
      durationMs: { p50: 100, p95: 300 },
      stability: {
        repeatCount: 2,
        passRate: 75,
        flakyCaseIds: ['a'],
        confidence95: { lower: 30.06, upper: 95.44 },
        scoreStdDev: { average: 10, max: { id: 'a', value: 20 } },
      },
    });
  });
});
