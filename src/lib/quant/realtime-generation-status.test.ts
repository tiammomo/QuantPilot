import { describe, expect, it } from 'vitest';
import { classifyRealtimeGenerationStatus } from './realtime-generation-status';

describe('realtime generation terminal classification', () => {
  it.each([
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
});
