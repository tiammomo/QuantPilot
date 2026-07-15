import type { QuantGenerationTerminalSnapshot } from '@/lib/quant/generation-terminal';

export type PreviewReconciliationPlan =
  | {
      action: 'ready';
      previewUrl: string;
      shouldAdoptUrl: boolean;
    }
  | {
      action: 'start_once';
      attemptKey: string;
    }
  | {
      action: 'withhold_until_acceptance';
    }
  | {
      action: 'wait';
    };

function recoveryAttemptKey(
  projectId: string,
  snapshot: QuantGenerationTerminalSnapshot,
): string {
  return `${projectId}:${snapshot.requestId ?? 'legacy'}`;
}

/**
 * Converts the server's Mission-aware terminal snapshot into a client action.
 *
 * The raw Project preview URL and the validation report are intentionally not
 * inputs: neither proves that a new MoAgent Mission was accepted. This keeps
 * provisional previews hidden and makes automatic recovery idempotent per run.
 */
export function planPreviewReconciliation(params: {
  projectId: string;
  snapshot: QuantGenerationTerminalSnapshot;
  currentPreviewUrl: string | null;
  attemptedRecoveryKey: string | null;
}): PreviewReconciliationPlan {
  const { projectId, snapshot, currentPreviewUrl, attemptedRecoveryKey } = params;

  // Terminal failures/cancellation take precedence over acceptance waiting;
  // otherwise an unaccepted failed Mission would look perpetually active.
  if (
    snapshot.status === 'failed' ||
    snapshot.status === 'cancelled' ||
    snapshot.status === 'needs_clarification'
  ) {
    return { action: 'wait' };
  }

  if (
    snapshot.missionAcceptanceRequired &&
    !snapshot.missionAcceptanceSatisfied
  ) {
    return { action: 'withhold_until_acceptance' };
  }

  if (snapshot.status === 'ready' && snapshot.previewUrl) {
    return {
      action: 'ready',
      previewUrl: snapshot.previewUrl,
      shouldAdoptUrl: currentPreviewUrl !== snapshot.previewUrl,
    };
  }

  // A URL already adopted for this mounted project is sufficient. In
  // particular, do not POST again while the next status poll catches up.
  if (currentPreviewUrl) {
    return { action: 'wait' };
  }

  if (
    snapshot.status === 'preview_pending' &&
    snapshot.validationStatus === 'passed'
  ) {
    const attemptKey = recoveryAttemptKey(projectId, snapshot);
    return attemptedRecoveryKey === attemptKey
      ? { action: 'wait' }
      : { action: 'start_once', attemptKey };
  }

  return { action: 'wait' };
}
