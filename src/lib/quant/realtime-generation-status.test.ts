import { describe, expect, it } from 'vitest';
import {
  classifyRealtimeGenerationStatus,
  shouldRealtimeAssistantUpdateStopWaiting,
} from './realtime-generation-status';

describe('realtime generation terminal classification', () => {
  it.each([
    'agent_candidate_complete',
    'agent_execution_completed',
    'agent_execution_failed',
    'validation_running',
    'validation_repairing',
    'preview_starting',
  ])('keeps the overall request active for %s', (status) => {
    expect(classifyRealtimeGenerationStatus(status)).toMatchObject({
      terminal: null,
      keepsRequestActive: true,
    });
  });

  it('projects Agent candidate submission into the existing non-terminal linear workflow', () => {
    expect(classifyRealtimeGenerationStatus('agent_candidate_complete')).toEqual({
      terminal: null,
      workspaceLifecycle: true,
      workspaceStatus: 'agent_execution_completed',
      keepsRequestActive: true,
    });
  });

  it.each(['evidence_verification', 'evidence_verification_running'])(
    'keeps Mission evidence verification linear and non-terminal for %s',
    (status) => {
      expect(classifyRealtimeGenerationStatus(status)).toEqual({
        terminal: null,
        workspaceLifecycle: true,
        workspaceStatus: 'validation_running',
        keepsRequestActive: true,
      });
    },
  );

  it('keeps passed checks non-terminal until the accepted preview projection', () => {
    expect(classifyRealtimeGenerationStatus('validation_checks_passed')).toEqual({
      terminal: null,
      workspaceLifecycle: true,
      workspaceStatus: 'validation_running',
      keepsRequestActive: true,
    });
  });

  it('only treats validation failure as terminal when the orchestrator says so', () => {
    expect(classifyRealtimeGenerationStatus('validation_failed').terminal).toBeNull();
    expect(
      classifyRealtimeGenerationStatus('validation_failed', {
        terminalFailure: true,
      }).terminal,
    ).toBe('failure');
  });

  it('uses preview readiness as the successful overall terminal', () => {
    expect(classifyRealtimeGenerationStatus('preview_ready')).toMatchObject({
      terminal: 'success',
      workspaceStatus: 'validation_passed',
    });
  });

  it('uses preview failure as a failed overall terminal', () => {
    expect(classifyRealtimeGenerationStatus('preview_failed')).toMatchObject({
      terminal: 'failure',
      keepsRequestActive: false,
    });
  });

  it('does not let a hidden MoAgent candidate summary stop the waiting state', () => {
    expect(
      shouldRealtimeAssistantUpdateStopWaiting({
        hasContent: true,
        isFinal: true,
        metadata: {
          runtime: 'moagent',
          isMoAgentCandidate: true,
          hidden_from_ui: true,
        },
      }),
    ).toBe(false);
  });

  it('does not treat a visible validation summary as Mission completion', () => {
    expect(
      shouldRealtimeAssistantUpdateStopWaiting({
        hasContent: true,
        isFinal: true,
        metadata: { isMissionIntermediate: true },
      }),
    ).toBe(false);
  });

  it('preserves the legacy waiting behavior for visible assistant updates', () => {
    expect(
      shouldRealtimeAssistantUpdateStopWaiting({ hasContent: true }),
    ).toBe(true);
    expect(
      shouldRealtimeAssistantUpdateStopWaiting({
        hasContent: false,
        isFinal: true,
      }),
    ).toBe(true);
  });
});
