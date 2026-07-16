import { describe, expect, it } from 'vitest';

import { runEvalMutationSuite } from './mutations';

describe('evaluation mutation suite', () => {
  it('kills every seeded evaluator defect with its expected detector', () => {
    const report = runEvalMutationSuite('rule-strict', new Date('2026-07-16T00:00:00.000Z'));
    expect(report.baselinePassed).toBe(true);
    expect(report.total).toBeGreaterThanOrEqual(10);
    expect(report.killed).toBe(report.total);
    expect(report.killRate).toBe(100);
    expect(report.results.find((item) => item.id === 'future-data-leak')?.detectedBy).toContain('snapshot');
    expect(report.results.find((item) => item.id === 'unexpected-tool-failure')?.detectedBy).toContain('evaluator');
  });
});
