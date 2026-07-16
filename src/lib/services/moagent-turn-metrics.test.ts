import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findRequest: vi.fn(),
  findRuns: vi.fn(),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    userRequest: { findFirst: mocks.findRequest },
    agentRun: { findMany: mocks.findRuns },
  },
}));

import { collectMoAgentTurnMetrics } from './moagent-turn-metrics';

function run(overrides: Record<string, unknown> = {}) {
  return {
    status: 'candidate_complete',
    turnCount: 2,
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    cachedInputTokens: 60,
    cacheMissInputTokens: 40,
    reasoningTokens: 5,
    events: [{
      eventType: 'run_finished',
      payload: { usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } },
    }],
    ...overrides,
  };
}

describe('MoAgent conversation turn metrics collector', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findRequest.mockResolvedValue({
      createdAt: new Date('2026-07-15T00:00:00.000Z'),
      completedAt: new Date('2026-07-15T00:02:18.000Z'),
    });
    mocks.findRuns.mockResolvedValue([]);
  });

  it('aggregates the exact root and registered repair requests', async () => {
    mocks.findRuns.mockResolvedValue([
      run(),
      run({
        status: 'failed',
        turnCount: 3,
        inputTokens: 80,
        outputTokens: 10,
        totalTokens: 90,
        cachedInputTokens: 20,
        cacheMissInputTokens: 60,
        reasoningTokens: 2,
      }),
    ]);

    await expect(collectMoAgentTurnMetrics({
      projectId: 'project-a',
      requestId: 'request-a',
      relatedRequestIds: ['request-a-validation-repair'],
    })).resolves.toEqual({
      schemaVersion: 1,
      elapsedMs: 138_000,
      agentRunCount: 2,
      modelTurnCount: 5,
      inputTokens: 180,
      outputTokens: 30,
      totalTokens: 210,
      cachedInputTokens: 80,
      cacheMissInputTokens: 100,
      reasoningTokens: 7,
      tokenAccounting: 'provider',
    });
    expect(mocks.findRuns).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        projectId: 'project-a',
        requestId: {
          in: ['request-a', 'request-a-validation-repair'],
        },
      },
    }));
  });

  it('reports a deterministic zero-token platform-only turn', async () => {
    await expect(collectMoAgentTurnMetrics({
      projectId: 'project-a',
      requestId: 'request-a',
    })).resolves.toEqual(expect.objectContaining({
      elapsedMs: 138_000,
      agentRunCount: 0,
      totalTokens: 0,
      tokenAccounting: 'provider',
    }));
  });

  it('marks estimated, mixed and incomplete accounting honestly', async () => {
    mocks.findRuns.mockResolvedValue([
      run({
        events: [{
          eventType: 'run_finished',
          payload: { usage: { usageSource: 'estimated' } },
        }],
      }),
    ]);
    await expect(collectMoAgentTurnMetrics({
      projectId: 'project-a',
      requestId: 'request-a',
    })).resolves.toEqual(expect.objectContaining({ tokenAccounting: 'estimated' }));

    mocks.findRuns.mockResolvedValue([
      run(),
      run({
        events: [{
          eventType: 'usage',
          payload: { totalUsage: { usageSource: 'estimated' } },
        }],
      }),
    ]);
    await expect(collectMoAgentTurnMetrics({
      projectId: 'project-a',
      requestId: 'request-a',
    })).resolves.toEqual(expect.objectContaining({ tokenAccounting: 'mixed' }));

    mocks.findRuns.mockResolvedValue([
      run({ status: 'interrupted', events: [] }),
    ]);
    await expect(collectMoAgentTurnMetrics({
      projectId: 'project-a',
      requestId: 'request-a',
    })).resolves.toEqual(expect.objectContaining({ tokenAccounting: 'partial' }));
  });

  it('fails closed when the root request does not exist', async () => {
    mocks.findRequest.mockResolvedValue(null);
    await expect(collectMoAgentTurnMetrics({
      projectId: 'project-a',
      requestId: 'request-a',
    })).rejects.toThrow('cannot find the root user request');
  });
});
