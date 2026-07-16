import { populationStandardDeviation, roundTo, wilsonScoreInterval } from './statistics';

export const EVAL_SCORE_DIMENSION_IDS = [
  'contract',
  'grounding',
  'task',
  'visual',
  'reliability',
  'efficiency',
  'safety',
] as const;

export type EvalScoreDimensionId = (typeof EVAL_SCORE_DIMENSION_IDS)[number];

export interface EvalScoreDimension {
  id: EvalScoreDimensionId;
  label: string;
  score: number;
  weight: number;
  status: 'passed' | 'warning' | 'failed' | 'unknown';
  summary: string;
}

export interface EvalQualitySummary {
  caseCount: number;
  firstPassCount: number;
  finalPassCount: number;
  firstPassRate: number;
  finalPassRate: number;
  repairedCaseCount: number;
  repairRate: number;
  averageScore: number;
  durationMs: {
    total: number;
    average: number;
    p50: number;
    p95: number;
  };
  dimensions: Record<EvalScoreDimensionId, number>;
  stability: {
    repeatCount: number;
    attemptCount: number;
    passedAttemptCount: number;
    passRate: number;
    flakyCaseIds: string[];
    confidence95: {
      lower: number;
      upper: number;
    };
    scoreStdDev: {
      average: number;
      max: { id: string | null; value: number };
    };
  };
}

type UnknownRecord = Record<string, unknown>;

const record = (value: unknown): UnknownRecord =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {};

const finiteNumber = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;

const boundedScore = (value: unknown, fallback = 0): number =>
  Math.min(100, Math.max(0, Math.round(finiteNumber(value, fallback))));

const percentage = (numerator: number, denominator: number): number =>
  denominator > 0 ? Math.round((numerator / denominator) * 100) : 0;

function percentile(values: number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index] ?? 0;
}

/**
 * One canonical score reader for the web mapper and the CI gate. Reports v6+
 * persist their evaluator score. Older reports retain the conservative legacy
 * projection so historical dashboards remain readable.
 */
export function resultScore(value: unknown): number {
  const result = record(value);
  const evaluation = record(result.evaluation);
  if (typeof evaluation.score === 'number' && Number.isFinite(evaluation.score)) {
    return boundedScore(evaluation.score);
  }
  if (typeof result.score === 'number' && Number.isFinite(result.score)) {
    return boundedScore(result.score);
  }
  const failures = Array.isArray(result.failures) ? result.failures.length : 0;
  if (result.passed === true) return 100;
  return Math.max(0, 60 - failures * 12);
}

export function weightedDimensionScore(dimensions: readonly EvalScoreDimension[]): number {
  const totalWeight = dimensions.reduce((total, dimension) => total + dimension.weight, 0);
  if (totalWeight <= 0) return 0;
  return boundedScore(
    dimensions.reduce(
      (total, dimension) => total + boundedScore(dimension.score) * dimension.weight,
      0,
    ) / totalWeight,
  );
}

export function buildEvalQualitySummary(values: readonly unknown[], repeatCount = 1): EvalQualitySummary {
  const results = values.map(record);
  const caseCount = results.length;
  const firstPassCount = results.filter((result) => result.firstPassPassed === true).length;
  const finalPassCount = results.filter((result) => result.finalPassed === true || result.passed === true).length;
  const repairedCaseCount = results.filter((result) => finiteNumber(result.repairAttempts) > 0).length;
  const scores = results.map(resultScore);
  const durations = results.map((result) => Math.max(0, finiteNumber(result.durationMs)));
  const dimensionTotals = Object.fromEntries(
    EVAL_SCORE_DIMENSION_IDS.map((id) => [id, [] as number[]]),
  ) as Record<EvalScoreDimensionId, number[]>;
  let attemptCount = 0;
  let passedAttemptCount = 0;
  const flakyCaseIds: string[] = [];
  const scoreDeviations: Array<{ id: string; value: number }> = [];

  for (const result of results) {
    const evaluation = record(result.evaluation);
    const dimensions = Array.isArray(evaluation.dimensions) ? evaluation.dimensions.map(record) : [];
    for (const dimension of dimensions) {
      const id = typeof dimension.id === 'string' ? dimension.id as EvalScoreDimensionId : null;
      if (id && id in dimensionTotals) dimensionTotals[id].push(boundedScore(dimension.score));
    }

    const stability = record(result.stability);
    const attempts = Array.isArray(stability.attempts) ? stability.attempts.map(record) : [];
    const effectiveAttempts = attempts.length > 0
      ? attempts
      : [{ passed: result.passed === true }];
    const passed = effectiveAttempts.filter((attempt) => attempt.passed === true).length;
    const caseId = typeof result.id === 'string' ? result.id : 'unknown';
    attemptCount += effectiveAttempts.length;
    passedAttemptCount += passed;
    scoreDeviations.push({
      id: caseId,
      value: populationStandardDeviation(
        effectiveAttempts.map((attempt) => resultScore(attempt)),
      ),
    });
    if (passed > 0 && passed < effectiveAttempts.length) {
      flakyCaseIds.push(caseId);
    }
  }

  const average = (items: number[]) =>
    items.length > 0 ? Math.round(items.reduce((total, item) => total + item, 0) / items.length) : 0;

  const maxScoreDeviation = scoreDeviations.reduce(
    (maximum, item) => item.value > maximum.value ? item : maximum,
    { id: null as string | null, value: 0 },
  );

  return {
    caseCount,
    firstPassCount,
    finalPassCount,
    firstPassRate: percentage(firstPassCount, caseCount),
    finalPassRate: percentage(finalPassCount, caseCount),
    repairedCaseCount,
    repairRate: percentage(repairedCaseCount, caseCount),
    averageScore: average(scores),
    durationMs: {
      total: durations.reduce((total, duration) => total + duration, 0),
      average: average(durations),
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
    },
    dimensions: Object.fromEntries(
      EVAL_SCORE_DIMENSION_IDS.map((id) => [id, average(dimensionTotals[id])]),
    ) as Record<EvalScoreDimensionId, number>,
    stability: {
      repeatCount: Math.max(1, Math.floor(repeatCount)),
      attemptCount,
      passedAttemptCount,
      passRate: percentage(passedAttemptCount, attemptCount),
      flakyCaseIds,
      confidence95: wilsonScoreInterval(passedAttemptCount, attemptCount),
      scoreStdDev: {
        average: scoreDeviations.length > 0
          ? roundTo(scoreDeviations.reduce((total, item) => total + item.value, 0) / scoreDeviations.length)
          : 0,
        max: maxScoreDeviation,
      },
    },
  };
}
