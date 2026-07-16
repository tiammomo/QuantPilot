import { describe, expect, it } from 'vitest';

import { populationStandardDeviation, wilsonScoreInterval } from './statistics';

describe('evaluation statistics', () => {
  it('does not overstate certainty for a tiny all-pass sample', () => {
    expect(wilsonScoreInterval(2, 2)).toEqual({ lower: 34.24, upper: 100 });
  });

  it('returns a bounded interval and deterministic population deviation', () => {
    expect(wilsonScoreInterval(8, 10)).toEqual({ lower: 49.02, upper: 94.33 });
    expect(populationStandardDeviation([80, 100])).toBe(10);
    expect(populationStandardDeviation([90])).toBe(0);
  });
});
