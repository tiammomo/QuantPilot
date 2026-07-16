import { describe, expect, it } from 'vitest';

import { compareEvalReports } from './regression';

describe('paired evaluation regression', () => {
  it('compares only matching case ids and surfaces pass regressions', () => {
    const comparison = compareEvalReports({
      results: [
        { id: 'a', passed: false, firstPassPassed: false, evaluation: { score: 70 } },
        { id: 'b', passed: true, firstPassPassed: true, evaluation: { score: 90 } },
      ],
    }, {
      results: [
        { id: 'a', passed: true, firstPassPassed: true, evaluation: { score: 90 } },
        { id: 'c', passed: true, firstPassPassed: true, evaluation: { score: 80 } },
      ],
    });

    expect(comparison).toMatchObject({
      matchedCaseCount: 1,
      scoreDelta: -20,
      passRegressions: ['a'],
      firstPassRegressions: ['a'],
      currentOnlyCaseIds: ['b'],
      baselineOnlyCaseIds: ['c'],
    });
  });
});
