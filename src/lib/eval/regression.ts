import { resultScore } from './scoring';

type UnknownRecord = Record<string, unknown>;

const record = (value: unknown): UnknownRecord =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as UnknownRecord
    : {};

export interface EvalCaseRegression {
  id: string;
  baselineScore: number;
  currentScore: number;
  scoreDelta: number;
  baselinePassed: boolean;
  currentPassed: boolean;
  baselineFirstPassPassed: boolean;
  currentFirstPassPassed: boolean;
}

export function compareEvalReports(currentValue: unknown, baselineValue: unknown) {
  const current = record(currentValue);
  const baseline = record(baselineValue);
  const currentResults = Array.isArray(current.results) ? current.results.map(record) : [];
  const baselineResults = Array.isArray(baseline.results) ? baseline.results.map(record) : [];
  const baselineById = new Map(
    baselineResults
      .filter((result) => typeof result.id === 'string')
      .map((result) => [String(result.id), result]),
  );
  const cases: EvalCaseRegression[] = currentResults.flatMap((result) => {
    const id = typeof result.id === 'string' ? result.id : '';
    const previous = baselineById.get(id);
    if (!id || !previous) return [];
    const baselineScore = resultScore(previous);
    const currentScore = resultScore(result);
    return [{
      id,
      baselineScore,
      currentScore,
      scoreDelta: currentScore - baselineScore,
      baselinePassed: previous.passed === true,
      currentPassed: result.passed === true,
      baselineFirstPassPassed: previous.firstPassPassed === true,
      currentFirstPassPassed: result.firstPassPassed === true,
    }];
  });
  const scoreDelta = cases.length > 0
    ? Math.round(cases.reduce((total, item) => total + item.scoreDelta, 0) / cases.length)
    : 0;
  return {
    matchedCaseCount: cases.length,
    currentOnlyCaseIds: currentResults
      .map((result) => String(result.id ?? ''))
      .filter((id) => id && !baselineById.has(id)),
    baselineOnlyCaseIds: baselineResults
      .map((result) => String(result.id ?? ''))
      .filter((id) => id && !currentResults.some((result) => result.id === id)),
    scoreDelta,
    passRegressions: cases.filter((item) => item.baselinePassed && !item.currentPassed).map((item) => item.id),
    firstPassRegressions: cases
      .filter((item) => item.baselineFirstPassPassed && !item.currentFirstPassPassed)
      .map((item) => item.id),
    cases,
  };
}
