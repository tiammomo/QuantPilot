type JsonRecord = Record<string, unknown>;
const record = (value: unknown): JsonRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : {};

/** Verify observed checks as well as the runner's aggregate flag. Missing optional stages remain absent. */
export function assessDeterministicGate(value: unknown): { passed: boolean; failures: string[] } {
  const result = record(value);
  const failures: string[] = [];
  if (result.passed !== true) failures.push('runner_not_passed');
  if (Array.isArray(result.failures) && result.failures.length) failures.push('runner_has_failures');
  for (const key of ['validation', 'artifacts']) {
    const stage = record(result[key]);
    if (stage.status === 'failed' || stage.passed === false) failures.push(`${key}_failed`);
    const checks = Array.isArray(stage.checks) ? stage.checks.map(record) : [];
    if (checks.some(check => check.status === 'failed' || check.passed === false)) failures.push(`${key}_check_failed`);
  }
  const oracle = record(record(result.artifacts).oracle);
  if (oracle.passed === false || (Array.isArray(oracle.checks) && oracle.checks.some(value => {
    const check = record(value);
    return check.passed !== true && check.severity !== 'warning';
  }))) failures.push('oracle_failed');
  if (result.visualCheck != null && record(result.visualCheck).passed !== true) failures.push('visual_failed');
  for (const [label, source, field] of [
    ['event_error', record(result.eventAudit), 'errorCount'],
    ['unexpected_tool_failure', record(record(result.agentExecution).tools), 'unexpectedFailureCount'],
  ] as const) {
    if (!Object.hasOwn(source, field)) continue;
    const count = source[field];
    if (!Number.isSafeInteger(count) || (count as number) < 0) failures.push(`${label}_count_invalid`);
    else if (count !== 0) failures.push(label);
  }
  return { passed: failures.length === 0, failures };
}
