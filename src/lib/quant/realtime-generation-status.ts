export type RealtimeGenerationTerminal = 'success' | 'failure' | 'cancelled' | null;

const WORKSPACE_LIFECYCLE_STATUSES = new Set([
  'agent_execution_completed',
  'agent_execution_failed',
  'validation_running',
  'validation_passed',
  'validation_failed',
  'validation_repairing',
  'validation_repair_failed',
  'preview_starting',
  'preview_ready',
  'preview_failed',
  'agent_paused',
]);

export function classifyRealtimeGenerationStatus(
  status: string,
  metadata?: Record<string, unknown>,
): {
  terminal: RealtimeGenerationTerminal;
  workspaceLifecycle: boolean;
  workspaceStatus: string;
  keepsRequestActive: boolean;
} {
  const terminalFailure = metadata?.terminalFailure === true;
  const terminal: RealtimeGenerationTerminal =
    status === 'preview_ready'
      ? 'success'
      : status === 'preview_failed' ||
          (status === 'validation_failed' && terminalFailure)
        ? 'failure'
        : status === 'agent_paused'
          ? 'cancelled'
          : null;

  return {
    terminal,
    workspaceLifecycle: WORKSPACE_LIFECYCLE_STATUSES.has(status),
    workspaceStatus: status === 'preview_ready' ? 'validation_passed' : status,
    keepsRequestActive:
      terminal === null &&
      WORKSPACE_LIFECYCLE_STATUSES.has(status) &&
      status !== 'agent_paused',
  };
}
