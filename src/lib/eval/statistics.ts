export interface PercentageInterval {
  lower: number;
  upper: number;
}

export function roundTo(value: number, digits = 2): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** Math.max(0, Math.floor(digits));
  return Math.round(value * factor) / factor;
}

/**
 * Wilson score interval is stable for small samples and avoids reporting a
 * misleading 100%-100% confidence interval after only one or two attempts.
 */
export function wilsonScoreInterval(
  passed: number,
  total: number,
  z = 1.959963984540054,
): PercentageInterval {
  if (!Number.isFinite(total) || total <= 0) return { lower: 0, upper: 0 };
  const sampleSize = Math.max(1, Math.floor(total));
  const successes = Math.min(sampleSize, Math.max(0, Math.floor(passed)));
  const proportion = successes / sampleSize;
  const zSquared = z ** 2;
  const denominator = 1 + zSquared / sampleSize;
  const centre = proportion + zSquared / (2 * sampleSize);
  const margin = z * Math.sqrt(
    (proportion * (1 - proportion) + zSquared / (4 * sampleSize)) / sampleSize,
  );
  return {
    lower: roundTo(Math.max(0, ((centre - margin) / denominator) * 100)),
    upper: roundTo(Math.min(100, ((centre + margin) / denominator) * 100)),
  };
}

export function populationStandardDeviation(values: readonly number[]): number {
  const finite = values.filter(Number.isFinite);
  if (finite.length <= 1) return 0;
  const average = finite.reduce((total, value) => total + value, 0) / finite.length;
  const variance = finite.reduce(
    (total, value) => total + (value - average) ** 2,
    0,
  ) / finite.length;
  return roundTo(Math.sqrt(variance));
}
