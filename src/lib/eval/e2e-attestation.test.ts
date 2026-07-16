import { describe, expect, it } from 'vitest';
import {
  evaluateMoAgentE2eQuality,
  isE2eAgentExecutionAttested,
  summarizeE2eAgentExecution,
  summarizeMoAgentE2eQuality,
} from './e2e-attestation';

const executed = {
  id: 'generated-dashboard',
  requestId: 'parent-request',
  passed: true,
  failures: [],
  agentExecuted: true,
  validation: {
    status: 'passed',
    checks: [{ status: 'passed' }],
  },
  visualCheck: { passed: true },
  eventAudit: { errorCount: 0 },
  missionAcceptance: {
    missionId: 'mission-generated-dashboard',
    generationId: '10000000-0000-4000-8000-000000000001',
    status: 'completed',
    candidateVersion: 1,
    acceptedReceiptId: 'receipt-generated-dashboard',
    acceptedReceiptHash: `sha256:${'d'.repeat(64)}`,
    acceptedReceiptType: 'acceptance',
    acceptedReceiptVerdict: 'accepted',
    acceptedSourceRunId: 'run-generated-dashboard',
    acceptedSourceRequestId: 'parent-request',
    acceptedCandidateSource: 'moagent_submit_result',
  },
  agentExecution: {
    executed: true,
    cli: 'moagent',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    requestId: 'parent-request',
    runIds: ['run-generated-dashboard'],
    runs: [{
      id: 'run-generated-dashboard',
      runInstanceId: '10000000-0000-4000-8000-000000000002',
      requestId: 'parent-request',
      status: 'candidate_complete',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      frameworkVersion: 'moagent:1.8.0',
      buildRevision: 'build-a',
      startedAt: '2026-07-14T00:00:00.000Z',
      completedAt: '2026-07-14T00:01:00.000Z',
      turns: 6,
      usage: {
        inputTokens: 30_000,
        outputTokens: 3_000,
        totalTokens: 33_000,
        cachedInputTokens: 6_000,
        cacheMissInputTokens: 24_000,
        reasoningTokens: 0,
      },
      tools: {
        total: 4,
        succeeded: 4,
        failed: 0,
        uncertain: 0,
        unexpectedFailureCount: 0,
        workspaceWriteSucceeded: 1,
        submitResultSucceeded: 1,
      },
    }],
    missionId: 'mission-generated-dashboard',
    generationId: '10000000-0000-4000-8000-000000000001',
    missionStatus: 'completed',
    candidateVersion: 1,
    acceptedReceiptId: 'receipt-generated-dashboard',
    acceptedReceiptHash: `sha256:${'d'.repeat(64)}`,
    acceptedReceiptType: 'acceptance',
    acceptedReceiptVerdict: 'accepted',
    acceptedSourceRunId: 'run-generated-dashboard',
    acceptedSourceRequestId: 'parent-request',
    acceptedCandidateSource: 'moagent_submit_result',
    frameworkVersion: 'moagent:1.8.0',
    buildRevision: 'build-a',
    gitRevision: 'a'.repeat(40),
    startedAt: '2026-07-14T00:00:00.000Z',
    completedAt: '2026-07-14T00:01:00.000Z',
    turns: 6,
    usage: {
      inputTokens: 30_000,
      outputTokens: 3_000,
      totalTokens: 33_000,
      cachedInputTokens: 6_000,
      cacheMissInputTokens: 24_000,
      reasoningTokens: 0,
    },
    tools: {
      total: 4,
      succeeded: 4,
      failed: 0,
      uncertain: 0,
      unexpectedFailureCount: 0,
      workspaceWriteSucceeded: 1,
      submitResultSucceeded: 1,
    },
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

  it('rejects contract/legacy provenance even when agentExecuted is forged true', () => {
    expect(isE2eAgentExecutionAttested({
      ...executed,
      agentExecution: { ...executed.agentExecution, cli: 'claude' },
    })).toBe(false);
    expect(isE2eAgentExecutionAttested({
      ...executed,
      agentExecution: { ...executed.agentExecution, runIds: [] },
    })).toBe(false);
    expect(isE2eAgentExecutionAttested({
      ...executed,
      agentExecution: { ...executed.agentExecution, frameworkVersion: 'moagent:1.6.0' },
    })).toBe(false);
    expect(isE2eAgentExecutionAttested({
      ...executed,
      agentExecution: { ...executed.agentExecution, gitRevision: null },
    })).toBe(false);
    expect(isE2eAgentExecutionAttested({
      ...executed,
      agentExecution: {
        ...executed.agentExecution,
        missionStatus: 'candidate_complete',
        acceptedReceiptId: null,
      },
    })).toBe(false);
    expect(isE2eAgentExecutionAttested({
      ...executed,
      requestId: 'different-request',
    })).toBe(false);
    expect(isE2eAgentExecutionAttested({
      ...executed,
      agentExecution: { ...executed.agentExecution, provider: 'openai' },
    })).toBe(false);
    expect(isE2eAgentExecutionAttested({
      ...executed,
      agentExecution: {
        ...executed.agentExecution,
        acceptedReceiptHash: 'not-a-receipt-hash',
      },
    })).toBe(false);
    expect(isE2eAgentExecutionAttested({
      ...executed,
      agentExecution: {
        ...executed.agentExecution,
        startedAt: '2026-07-14T00:02:00.000Z',
        completedAt: '2026-07-14T00:01:00.000Z',
      },
    })).toBe(false);
  });

  it('rejects missing or arithmetically inconsistent provider token truth', () => {
    expect(isE2eAgentExecutionAttested({
      ...executed,
      agentExecution: {
        ...executed.agentExecution,
        usage: {
          inputTokens: 30_000,
          outputTokens: 3_000,
          totalTokens: 33_000,
          cacheMissInputTokens: 24_000,
        },
      },
    })).toBe(false);
    expect(isE2eAgentExecutionAttested({
      ...executed,
      agentExecution: {
        ...executed.agentExecution,
        usage: {
          inputTokens: 30_000,
          outputTokens: 3_000,
          totalTokens: 33_001,
          cachedInputTokens: 0,
          cacheMissInputTokens: 0,
        },
      },
    })).toBe(false);
    expect(summarizeMoAgentE2eQuality([{
      ...executed,
      id: 'missing-cache-truth',
      agentExecution: {
        ...executed.agentExecution,
        usage: {
          inputTokens: 30_000,
          outputTokens: 3_000,
          totalTokens: 33_000,
          cachedInputTokens: 0,
          cacheMissInputTokens: 0,
        },
      },
    }])).toMatchObject({
      measuredCaseCount: 0,
      missingMetricsCaseIds: ['missing-cache-truth'],
    });
    expect(isE2eAgentExecutionAttested({
      ...executed,
      agentExecution: {
        ...executed.agentExecution,
        tools: {
          total: 4,
          succeeded: 4,
          failed: 1,
          uncertain: 0,
          unexpectedFailureCount: 0,
        },
      },
    })).toBe(false);
  });

  it('rejects platform recovery, broken accepted-source lineage, and contradictory evidence', () => {
    expect(isE2eAgentExecutionAttested({
      ...executed,
      agentExecution: {
        ...executed.agentExecution,
        acceptedCandidateSource: 'platform_template_recovery',
      },
      missionAcceptance: {
        ...executed.missionAcceptance,
        acceptedCandidateSource: 'platform_template_recovery',
      },
    })).toBe(false);

    expect(isE2eAgentExecutionAttested({
      ...executed,
      agentExecution: {
        ...executed.agentExecution,
        acceptedSourceRunId: 'run-not-in-lineage',
      },
      missionAcceptance: {
        ...executed.missionAcceptance,
        acceptedSourceRunId: 'run-not-in-lineage',
      },
    })).toBe(false);

    const noWorkspaceWriteTools = {
      ...executed.agentExecution.tools,
      workspaceWriteSucceeded: 0,
    };
    expect(isE2eAgentExecutionAttested({
      ...executed,
      agentExecution: {
        ...executed.agentExecution,
        tools: noWorkspaceWriteTools,
        runs: [{
          ...executed.agentExecution.runs[0],
          tools: noWorkspaceWriteTools,
        }],
      },
    })).toBe(false);

    expect(isE2eAgentExecutionAttested({
      ...executed,
      failures: ['visual validation failed'],
    })).toBe(false);
    expect(isE2eAgentExecutionAttested({
      ...executed,
      missionAcceptance: {
        ...executed.missionAcceptance,
        acceptedReceiptId: 'different-receipt',
      },
    })).toBe(false);
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

  it('summarizes and gates real turns, cache-miss input, and unexpected tool failures', () => {
    const expensive = {
      ...executed,
      id: 'expensive-dashboard',
      agentExecution: {
        ...executed.agentExecution,
        turns: 18,
        usage: {
          inputTokens: 200_001,
          outputTokens: 5_000,
          totalTokens: 205_001,
          cachedInputTokens: 20_000,
          cacheMissInputTokens: 180_001,
          reasoningTokens: 0,
        },
        tools: {
          total: 6,
          succeeded: 4,
          failed: 1,
          uncertain: 1,
          unexpectedFailureCount: 2,
          workspaceWriteSucceeded: 1,
          submitResultSucceeded: 1,
        },
        runs: [{
          ...executed.agentExecution.runs[0],
          turns: 18,
          usage: {
            inputTokens: 200_001,
            outputTokens: 5_000,
            totalTokens: 205_001,
            cachedInputTokens: 20_000,
            cacheMissInputTokens: 180_001,
            reasoningTokens: 0,
          },
          tools: {
            total: 6,
            succeeded: 4,
            failed: 1,
            uncertain: 1,
            unexpectedFailureCount: 2,
            workspaceWriteSucceeded: 1,
            submitResultSucceeded: 1,
          },
        }],
      },
    };

    expect(summarizeMoAgentE2eQuality([executed, expensive])).toMatchObject({
      caseCount: 2,
      measuredCaseCount: 2,
      turns: { total: 24, average: 12, max: { id: 'expensive-dashboard', value: 18 } },
      cacheMissInputTokens: {
        total: 204_001,
        average: 102_001,
        max: { id: 'expensive-dashboard', value: 180_001 },
      },
      tools: {
        unexpectedFailureCount: 2,
        affectedCaseIds: ['expensive-dashboard'],
      },
    });

    const gate = evaluateMoAgentE2eQuality([executed, expensive], {
      maxTurnsPerCase: 16,
      maxCacheMissInputTokensPerCase: 180_000,
      maxUnexpectedToolFailures: 0,
    });
    expect(gate.passed).toBe(false);
    expect(gate.problems).toEqual([
      'expensive-dashboard turns=18 超过阈值 16',
      'expensive-dashboard cache-miss input tokens=180001 超过阈值 180000',
      'unexpected tool failures=2 超过阈值 0',
    ]);
  });
});
