export type EvalOracleTarget = 'finalData' | 'sources' | 'quality' | 'page';

export type EvalOracleOperator =
  | 'exists'
  | 'not_exists'
  | 'equals'
  | 'not_equals'
  | 'gte'
  | 'lte'
  | 'between'
  | 'contains'
  | 'not_contains'
  | 'matches'
  | 'not_matches'
  | 'length_gte'
  | 'length_lte';

export interface EvalOracleAssertion {
  id: string;
  target: EvalOracleTarget;
  path?: string;
  operator: EvalOracleOperator;
  value?: unknown;
  min?: number;
  max?: number;
  tolerance?: number;
  message?: string;
  severity?: 'error' | 'warning';
}

export interface EvalOracleCheckResult {
  id: string;
  target: EvalOracleTarget;
  operator: EvalOracleOperator;
  passed: boolean;
  severity: 'error' | 'warning';
  summary: string;
  actual: unknown;
}

type UnknownRecord = Record<string, unknown>;

function valueAtPath(root: unknown, pathValue = ''): unknown {
  if (!pathValue) return root;
  const segments = pathValue.split('.').filter(Boolean);
  let current = root;
  for (const segment of segments) {
    if (Array.isArray(current) && /^\d+$/.test(segment)) {
      current = current[Number(segment)];
      continue;
    }
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as UnknownRecord)[segment];
  }
  return current;
}

const lengthOf = (value: unknown): number | null => {
  if (typeof value === 'string' || Array.isArray(value)) return value.length;
  if (value && typeof value === 'object') return Object.keys(value).length;
  return null;
};

function safePattern(value: unknown): RegExp | null {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    return new RegExp(value, 'iu');
  } catch {
    return null;
  }
}

function matches(assertion: EvalOracleAssertion, actual: unknown): boolean {
  switch (assertion.operator) {
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'not_exists':
      return actual === undefined || actual === null;
    case 'equals': {
      if (typeof actual === 'number' && typeof assertion.value === 'number') {
        return Math.abs(actual - assertion.value) <= Math.max(0, assertion.tolerance ?? 0);
      }
      return JSON.stringify(actual) === JSON.stringify(assertion.value);
    }
    case 'not_equals':
      return JSON.stringify(actual) !== JSON.stringify(assertion.value);
    case 'gte':
      return typeof actual === 'number' && typeof assertion.value === 'number' && actual >= assertion.value;
    case 'lte':
      return typeof actual === 'number' && typeof assertion.value === 'number' && actual <= assertion.value;
    case 'between':
      return typeof actual === 'number' && typeof assertion.min === 'number' && typeof assertion.max === 'number' && actual >= assertion.min && actual <= assertion.max;
    case 'contains':
      return typeof actual === 'string' && String(assertion.value ?? '') !== '' && actual.includes(String(assertion.value));
    case 'not_contains':
      return typeof actual === 'string' && !actual.includes(String(assertion.value ?? ''));
    case 'matches': {
      const pattern = safePattern(assertion.value);
      return typeof actual === 'string' && Boolean(pattern?.test(actual));
    }
    case 'not_matches': {
      const pattern = safePattern(assertion.value);
      return typeof actual === 'string' && pattern !== null && !pattern.test(actual);
    }
    case 'length_gte': {
      const length = lengthOf(actual);
      return length !== null && typeof assertion.value === 'number' && length >= assertion.value;
    }
    case 'length_lte': {
      const length = lengthOf(actual);
      return length !== null && typeof assertion.value === 'number' && length <= assertion.value;
    }
  }
}

function evidenceValue(value: unknown): unknown {
  if (Array.isArray(value)) return { type: 'array', length: value.length };
  if (typeof value === 'string') return value.length <= 500 ? value : `${value.slice(0, 500)}...[truncated]`;
  if (value && typeof value === 'object') {
    return { type: 'object', keys: Object.keys(value).slice(0, 50) };
  }
  return value;
}

export function evaluateOracleAssertions(input: {
  assertions?: readonly EvalOracleAssertion[];
  targets: Record<EvalOracleTarget, unknown>;
}) {
  const checks = (input.assertions ?? []).map((assertion): EvalOracleCheckResult => {
    const actual = valueAtPath(input.targets[assertion.target], assertion.path);
    const passed = matches(assertion, actual);
    return {
      id: assertion.id,
      target: assertion.target,
      operator: assertion.operator,
      passed,
      severity: assertion.severity ?? 'error',
      summary: passed
        ? assertion.message ?? `${assertion.target}.${assertion.path ?? ''} ${assertion.operator} 通过`
        : assertion.message ?? `${assertion.target}.${assertion.path ?? ''} 未满足 ${assertion.operator}`,
      actual: evidenceValue(actual),
    };
  });
  const failed = checks.filter((check) => !check.passed && check.severity === 'error');
  const warnings = checks.filter((check) => !check.passed && check.severity === 'warning');
  return {
    passed: failed.length === 0,
    warning: warnings.length > 0,
    checks,
    failures: failed.map((check) => `oracle:${check.id} ${check.summary}`),
    warnings: warnings.map((check) => `oracle:${check.id} ${check.summary}`),
  };
}
