import { describe, expect, it } from 'vitest';

import { mutationOutcomeRequiresReconciliation } from './tool-outcome';

const safeFailure = (code: string) => ({
  ok: false as const,
  error: { code, message: 'Rejected before the workspace mutation boundary.' },
});

describe('mutation outcome classification', () => {
  it.each([
    'DASHBOARD_SPEC_ASSERTION_FAILED',
    'DASHBOARD_SPEC_COMPONENTS_MISMATCH',
    'DASHBOARD_SPEC_COMPONENT_UNSUPPORTED',
    'DASHBOARD_SPEC_CONTRACT_INCOMPLETE',
    'DASHBOARD_SPEC_CONTRACT_INVALID',
    'DASHBOARD_SPEC_CONTRACT_MISMATCH',
    'DASHBOARD_SPEC_CONTRACT_TOO_LARGE',
    'DASHBOARD_SPEC_DATA_PREREQUISITE_FAILED',
    'DASHBOARD_SPEC_PLAN_NOT_READY',
    'DASHBOARD_SPEC_TEMPLATE_UNSUPPORTED',
    'DASHBOARD_SPEC_VARIANT_UNSUPPORTED',
    'DASHBOARD_SPEC_VISUALIZATION_NOT_REQUIRED',
    'DUPLICATE_BATCH_TARGET',
    'INVALID_BATCH_WRITE',
    'INVALID_BATCH_WRITE_LIMIT',
    'SEMANTIC_EDIT_FILE_TYPE_MISMATCH',
    'SEMANTIC_REPLACEMENT_IDENTITY_MISMATCH',
    'SEMANTIC_REPLACEMENT_INVALID',
    'SEMANTIC_SOURCE_LOCATION_MISSING',
    'SEMANTIC_SOURCE_PARSE_FAILED',
    'SEMANTIC_TARGET_AMBIGUOUS',
    'SEMANTIC_TARGET_NOT_FOUND',
    'SEMANTIC_TARGET_UNSAFE',
    'WORKSPACE_WRITE_CONFLICT',
  ])('allows correction after a definite pre-mutation %s failure', (code) => {
    expect(mutationOutcomeRequiresReconciliation('workspace_write', safeFailure(code)))
      .toBe(false);
  });

  it('still stops on an unknown mutating outcome', () => {
    expect(mutationOutcomeRequiresReconciliation(
      'workspace_write',
      safeFailure('TOOL_EXECUTION_FAILED'),
    )).toBe(true);
  });

  it('never applies mutation reconciliation to a read failure', () => {
    expect(mutationOutcomeRequiresReconciliation(
      'read',
      safeFailure('TOOL_EXECUTION_FAILED'),
    )).toBe(false);
  });
});
