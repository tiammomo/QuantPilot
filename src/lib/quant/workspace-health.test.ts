import { describe, expect, it } from 'vitest';
import { deriveWorkspaceLifecycle } from './workspace-health';

describe('deriveWorkspaceLifecycle', () => {
  it('treats clarification as awaiting input instead of a failed repair lifecycle', () => {
    expect(
      deriveWorkspaceLifecycle({
        runPlanStatus: 'needs_clarification',
        generationState: {
          status: 'needs_clarification',
          requestId: 'request-clarification',
          updatedAt: '2026-07-14T00:00:00.000Z',
        },
      })
    ).toMatchObject({
      status: 'awaiting_input',
      active: true,
      requestId: 'request-clarification',
    });
  });

  it('uses queue and repair state to expose active lifecycle phases', () => {
    expect(
      deriveWorkspaceLifecycle({
        queue: {
          items: [{ requestId: 'queued-request', status: 'queued' }],
        },
      }).status
    ).toBe('queued');

    expect(
      deriveWorkspaceLifecycle({
        generationState: {
          status: 'repairing',
          requestId: 'repair-request',
          updatedAt: '2026-07-14T00:00:00.000Z',
        },
        queue: {
          activeRequestId: 'repair-request',
          items: [{ requestId: 'repair-request', status: 'running' }],
        },
      })
    ).toMatchObject({ status: 'repairing', active: true });
  });

  it('does not let a stale clarification plan override a terminal cancellation', () => {
    expect(
      deriveWorkspaceLifecycle({
        runPlanStatus: 'needs_clarification',
        generationState: {
          status: 'cancelled',
          requestId: 'cancelled-request',
          updatedAt: '2026-07-14T00:00:00.000Z',
        },
      }).status
    ).toBe('cancelled');
  });
});
