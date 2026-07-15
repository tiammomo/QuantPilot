export type RealtimeGenerationTerminal = 'success' | 'failure' | 'cancelled' | null;

export function shouldRealtimeAssistantUpdateStopWaiting(params: {
  hasContent: boolean;
  isFinal?: boolean;
  metadata?: Record<string, unknown> | null;
}): boolean {
  // Hidden MoAgent turns include the submitted candidate summary. They are
  // physical-run projections, not a user-facing Mission completion message.
  if (
    params.metadata?.hidden_from_ui === true ||
    params.metadata?.isMissionIntermediate === true
  ) return false;
  return params.hasContent || params.isFinal === true;
}

const WORKSPACE_LIFECYCLE_STATUSES = new Set([
  'agent_candidate_complete',
  'agent_execution_completed',
  'agent_execution_failed',
  'evidence_verification',
  'evidence_verification_running',
  'validation_running',
  'validation_checks_passed',
  'validation_passed',
  'validation_failed',
  'validation_repairing',
  'validation_repair_failed',
  'preview_starting',
  'preview_ready',
  'preview_failed',
  'agent_paused',
]);

const WORKSPACE_STATUS_ALIASES: Record<string, string> = {
  // A submitted Agent result is only a candidate. Reuse the existing linear
  // post-execution state while validation and Mission evidence verification
  // continue; never project it as a completed request or ready preview.
  agent_candidate_complete: 'agent_execution_completed',
  evidence_verification: 'validation_running',
  evidence_verification_running: 'validation_running',
  validation_checks_passed: 'validation_running',
};

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
    workspaceStatus:
      WORKSPACE_STATUS_ALIASES[status] ??
      (status === 'preview_ready' ? 'validation_passed' : status),
    keepsRequestActive:
      terminal === null &&
      WORKSPACE_LIFECYCLE_STATUSES.has(status) &&
      status !== 'agent_paused',
  };
}
