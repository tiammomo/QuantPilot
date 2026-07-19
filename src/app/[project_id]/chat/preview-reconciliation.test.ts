import { describe, expect, it } from 'vitest';

import type { QuantGenerationTerminalSnapshot } from '@/lib/quant/generation-terminal';
import { planPreviewReconciliation } from './preview-reconciliation';

function snapshot(
  overrides: Partial<QuantGenerationTerminalSnapshot> = {},
): QuantGenerationTerminalSnapshot {
  return {
    requestId: 'request-1',
    status: 'preview_pending',
    terminal: false,
    validationStatus: 'passed',
    validationRunId: 'request-1',
    validationMatchesCurrentRun: true,
    missionAcceptanceRequired: true,
    missionAcceptanceSatisfied: true,
    acceptedReceiptId: 'receipt-1',
    previewStatus: 'stopped',
    previewUrl: null,
    previewPort: null,
    persistedPreviewUrl: null,
    errorMessage: null,
    ...overrides,
  };
}

describe('planPreviewReconciliation', () => {
  it('withholds even a contradictory ready URL until the Mission is accepted', () => {
    expect(
      planPreviewReconciliation({
        projectId: 'project-1',
        snapshot: snapshot({
          status: 'ready',
          previewUrl: 'http://localhost:4100',
          missionAcceptanceSatisfied: false,
          acceptedReceiptId: null,
        }),
        currentPreviewUrl: 'http://localhost:4099',
        attemptedRecoveryKey: null,
      }),
    ).toEqual({ action: 'withhold_until_acceptance' });
  });

  it.each(['failed', 'needs_revalidation', 'cancelled', 'needs_clarification', 'refused'] as const)(
    'does not turn an unaccepted %s Mission into an acceptance wait loop',
    (status) => {
      expect(
        planPreviewReconciliation({
          projectId: 'project-1',
          snapshot: snapshot({
            status,
            terminal: true,
            missionAcceptanceSatisfied: false,
            acceptedReceiptId: null,
          }),
          currentPreviewUrl: null,
          attemptedRecoveryKey: null,
        }),
      ).toEqual({ action: 'wait' });
    },
  );

  it('starts an accepted pending preview only once per request', () => {
    const first = planPreviewReconciliation({
      projectId: 'project-1',
      snapshot: snapshot(),
      currentPreviewUrl: null,
      attemptedRecoveryKey: null,
    });

    expect(first).toEqual({
      action: 'start_once',
      attemptKey: 'project-1:request-1',
    });
    expect(
      planPreviewReconciliation({
        projectId: 'project-1',
        snapshot: snapshot(),
        currentPreviewUrl: null,
        attemptedRecoveryKey: 'project-1:request-1',
      }),
    ).toEqual({ action: 'wait' });
  });

  it('allows the same one-shot recovery for a legacy pre-Mission run', () => {
    expect(
      planPreviewReconciliation({
        projectId: 'project-legacy',
        snapshot: snapshot({
          requestId: null,
          missionAcceptanceRequired: false,
          missionAcceptanceSatisfied: true,
          acceptedReceiptId: null,
        }),
        currentPreviewUrl: null,
        attemptedRecoveryKey: null,
      }),
    ).toEqual({
      action: 'start_once',
      attemptKey: 'project-legacy:legacy',
    });
  });

  it('adopts a ready URL without starting and becomes a no-op once adopted', () => {
    const readySnapshot = snapshot({
      status: 'ready',
      terminal: true,
      previewStatus: 'running',
      previewUrl: 'http://localhost:4100',
      previewPort: 4100,
    });

    expect(
      planPreviewReconciliation({
        projectId: 'project-1',
        snapshot: readySnapshot,
        currentPreviewUrl: null,
        attemptedRecoveryKey: null,
      }),
    ).toEqual({
      action: 'ready',
      previewUrl: 'http://localhost:4100',
      shouldAdoptUrl: true,
    });
    expect(
      planPreviewReconciliation({
        projectId: 'project-1',
        snapshot: readySnapshot,
        currentPreviewUrl: 'http://localhost:4100',
        attemptedRecoveryKey: null,
      }),
    ).toEqual({
      action: 'ready',
      previewUrl: 'http://localhost:4100',
      shouldAdoptUrl: false,
    });
  });

  it('never restarts while the page already has a preview URL', () => {
    expect(
      planPreviewReconciliation({
        projectId: 'project-1',
        snapshot: snapshot(),
        currentPreviewUrl: 'http://localhost:4100',
        attemptedRecoveryKey: null,
      }),
    ).toEqual({ action: 'wait' });
  });
});
