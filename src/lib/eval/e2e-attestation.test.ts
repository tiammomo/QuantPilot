import { describe, expect, it } from 'vitest';
import { isE2eAgentExecutionAttested, summarizeE2eAgentExecution } from './e2e-attestation';

const executed = {
  id: 'generated-dashboard',
  agentExecuted: true,
  agentExecution: {
    executed: true,
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    requestId: 'parent-request',
    startedAt: '2026-07-14T00:00:00.000Z',
    completedAt: '2026-07-14T00:01:00.000Z',
  },
};

describe('E2E Agent execution attestation', () => {
  it('requires per-case execution identity and timing instead of suite mode', () => {
    expect(isE2eAgentExecutionAttested(executed)).toBe(true);
    expect(isE2eAgentExecutionAttested({
      ...executed,
      id: 'special-contract-case',
      agentExecution: { ...executed.agentExecution, executed: false },
    })).toBe(false);
    expect(isE2eAgentExecutionAttested({ id: 'legacy', agentExecuted: true })).toBe(false);
  });

  it('reports every unattested case for the CI gate', () => {
    expect(summarizeE2eAgentExecution([
      executed,
      { id: 'clarification-only', agentExecuted: false },
    ])).toEqual({
      agentExecuted: false,
      executedCaseCount: 1,
      unattestedCaseIds: ['clarification-only'],
    });
  });
});
