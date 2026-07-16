function normalizedFailureIds(values: readonly string[]): string[] {
  return Array.from(new Set(values.filter(Boolean))).sort();
}

/**
 * Escalate only when an Agent repair itself failed and validation proves that
 * it made no check-level progress. A successful repair that still needs one
 * more iteration keeps the normal attempt budget.
 */
export function shouldEscalateStalledRepair(params: {
  repairAttempt: number;
  maxRepairAttempts: number;
  repairExecutionFailed: boolean;
  previousFailedCheckIds: readonly string[];
  currentFailedCheckIds: readonly string[];
}): boolean {
  if (
    !params.repairExecutionFailed ||
    params.repairAttempt >= params.maxRepairAttempts
  ) {
    return false;
  }

  const previous = normalizedFailureIds(params.previousFailedCheckIds);
  const current = normalizedFailureIds(params.currentFailedCheckIds);
  return previous.length > 0 &&
    previous.length === current.length &&
    previous.every((value, index) => value === current[index]);
}
