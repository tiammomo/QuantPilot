import type { MoAgentToolEffect, MoAgentToolResult } from '@/lib/agent/types';

const DEFINITELY_PRE_EXECUTION_FAILURE_CODES = new Set([
  'UNKNOWN_TOOL',
  'INVALID_TOOL_ARGUMENTS',
  'INVALID_TOOL_INPUT',
  // Workspace policy, input size, and exact-match checks happen before the
  // durable commit authorization and before the atomic target rename.
  'ABSOLUTE_PATH_DENIED',
  'BINARY_FILE_DENIED',
  'EDIT_MATCH_AMBIGUOUS',
  'EDIT_MATCH_NOT_FOUND',
  'EXECUTABLE_CONFIG_DENIED',
  'FILE_TOO_LARGE',
  'INVALID_PATH',
  'INVALID_WORKSPACE',
  'NOT_A_FILE',
  'PATH_NOT_FOUND',
  'PATH_RESOLUTION_FAILED',
  'PATH_TRAVERSAL_DENIED',
  'SENSITIVE_PATH_DENIED',
  'SYMLINK_ESCAPE_DENIED',
  'SYMLINK_WRITE_DENIED',
  'WORKSPACE_COMMIT_FENCE_REQUIRED',
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
