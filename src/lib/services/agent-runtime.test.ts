import { describe, expect, it } from 'vitest';
import {
  cancelAgentRuns,
  completeAgentRun,
  isAgentRunCancelled,
  registerAgentRun,
} from './agent-runtime';

describe('agent runtime cancellation', () => {
  it('cancels an SDK AbortController by project and request id', () => {
    const projectId = `project-${Date.now()}`;
    const requestId = 'request-sdk';
    const controller = new AbortController();

    registerAgentRun({
      projectId,
      requestId,
      cli: 'moagent',
      cancel: (reason) => controller.abort(new Error(reason)),
    });

    const result = cancelAgentRuns(projectId, requestId, 'user paused');
    expect(result.cancelled).toBe(1);
    expect(controller.signal.aborted).toBe(true);
    expect(isAgentRunCancelled(projectId, requestId)).toBe(true);
    expect(completeAgentRun(projectId, requestId)).toBe(false);
  });
});
