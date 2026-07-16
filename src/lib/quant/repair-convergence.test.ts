import { describe, expect, it } from 'vitest';

import { shouldEscalateStalledRepair } from './repair-convergence';

describe('validation repair convergence', () => {
  it('escalates a failed repair when the blocking checks did not change', () => {
    expect(shouldEscalateStalledRepair({
      repairAttempt: 1,
      maxRepairAttempts: 3,
      repairExecutionFailed: true,
      previousFailedCheckIds: ['visual_presentation'],
      currentFailedCheckIds: ['visual_presentation'],
    })).toBe(true);
  });

  it('keeps normal retries when validation made progress or execution completed', () => {
    expect(shouldEscalateStalledRepair({
      repairAttempt: 1,
      maxRepairAttempts: 3,
      repairExecutionFailed: true,
      previousFailedCheckIds: ['next_build', 'visual_presentation'],
      currentFailedCheckIds: ['visual_presentation'],
    })).toBe(false);
    expect(shouldEscalateStalledRepair({
      repairAttempt: 1,
      maxRepairAttempts: 3,
      repairExecutionFailed: false,
      previousFailedCheckIds: ['visual_presentation'],
      currentFailedCheckIds: ['visual_presentation'],
    })).toBe(false);
  });

  it('does not alter the final configured attempt', () => {
    expect(shouldEscalateStalledRepair({
      repairAttempt: 3,
      maxRepairAttempts: 3,
      repairExecutionFailed: true,
      previousFailedCheckIds: ['visual_presentation'],
      currentFailedCheckIds: ['visual_presentation'],
    })).toBe(false);
  });
});
