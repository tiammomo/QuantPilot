import type { MoAgentToolEffect, MoAgentToolResult } from '@/lib/agent/types';

const DEFINITELY_PRE_EXECUTION_FAILURE_CODES = new Set([
  'UNKNOWN_TOOL',
  'INVALID_TOOL_ARGUMENTS',
  'INVALID_TOOL_INPUT',
  // Workspace policy, input size, and exact-match checks happen before the
  // durable commit authorization and before the atomic target rename.
  'ABSOLUTE_PATH_DENIED',
  'BINARY_FILE_DENIED',
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
  'EDIT_MATCH_AMBIGUOUS',
  'EDIT_MATCH_NOT_FOUND',
  'EXECUTABLE_CONFIG_DENIED',
  'FILE_TOO_LARGE',
  'INVALID_PATH',
  'INVALID_BATCH_WRITE',
  'INVALID_BATCH_WRITE_LIMIT',
  'INVALID_WORKSPACE',
  'NOT_A_FILE',
  'PATH_NOT_FOUND',
  'PATH_RESOLUTION_FAILED',
  'PATH_TRAVERSAL_DENIED',
  'SENSITIVE_PATH_DENIED',
  'SEMANTIC_EDIT_FILE_TYPE_MISMATCH',
  'SEMANTIC_REPLACEMENT_IDENTITY_MISMATCH',
  'SEMANTIC_REPLACEMENT_INVALID',
  'SEMANTIC_SOURCE_LOCATION_MISSING',
  'SEMANTIC_SOURCE_PARSE_FAILED',
  'SEMANTIC_TARGET_AMBIGUOUS',
  'SEMANTIC_TARGET_NOT_FOUND',
  'SEMANTIC_TARGET_UNSAFE',
  'SYMLINK_ESCAPE_DENIED',
  'SYMLINK_WRITE_DENIED',
  'WORKSPACE_COMMIT_FENCE_REQUIRED',
  'WORKSPACE_JOURNAL_PREPARE_FAILED',
  // The physical effect may have started, but the durable journal proved and
  // restored every target before this failure was surfaced.
  'WORKSPACE_MUTATION_ROLLED_BACK',
  'WORKSPACE_WRITE_CONFLICT',
  'WRITE_PATH_DENIED',
  'WRITE_TOO_LARGE',
]);

/**
 * A mutating tool failure is fail-closed unless the framework can prove that
 * execution never started. Timeouts, aborts, thrown errors, and tool-declared
 * failures may have crossed an irreversible side-effect boundary.
 */
export function mutationOutcomeRequiresReconciliation(
  effect: MoAgentToolEffect,
  result: MoAgentToolResult
): boolean {
  return (
    !result.ok &&
    (effect === 'workspace_write' || effect === 'external_write') &&
    !DEFINITELY_PRE_EXECUTION_FAILURE_CODES.has(result.error.code)
  );
}
