import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findRequest: vi.fn(),
  findRuns: vi.fn(),
}));

const context = {
  schemaVersion: 1,
  runId: 'latest-run',
  model: 'test-model',
  turn: 2,
  observedAt: 1_780_000_000_000,
  source: 'estimated',
  inputTokens: 60,
  inputBudgetTokens: 850,
  contextWindowTokens: 1000,
  reservedOutputTokens: 100,
  compacted: false,
};

vi.mock('@/lib/db/client', () => ({
  prisma: {
    userRequest: { findFirst: mocks.findRequest },
    agentRun: { findMany: mocks.findRuns },
  },
}));

import { collectPiAgentTurnMetrics } from './pi-agent-turn-metrics';

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
    events: [
      {
        eventType: 'run_finished',
        payload: { usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, usageSource: 'provider' } },
      },
    ],
    ...overrides,
  };
}

describe('PI Agent conversation turn metrics collector', () => {
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

    await expect(
      collectPiAgentTurnMetrics({
        projectId: 'project-a',
        requestId: 'request-a',
        relatedRequestIds: ['request-a-validation-repair'],
      })
    ).resolves.toEqual({
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
    expect(mocks.findRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          projectId: 'project-a',
          requestId: {
            in: ['request-a', 'request-a-validation-repair'],
          },
        },
      })
    );
  });

  it('reports a deterministic zero-token platform-only turn', async () => {
    await expect(
      collectPiAgentTurnMetrics({
        projectId: 'project-a',
        requestId: 'request-a',
      })
    ).resolves.toEqual(
      expect.objectContaining({
        elapsedMs: 138_000,
        agentRunCount: 0,
        totalTokens: 0,
        tokenAccounting: 'provider',
      })
    );
  });

  it('marks estimated, mixed and incomplete accounting honestly', async () => {
    mocks.findRuns.mockResolvedValue([
      run({
        events: [
          {
            eventType: 'run_finished',
            payload: { usage: { usageSource: 'estimated' } },
          },
        ],
      }),
    ]);
    await expect(
      collectPiAgentTurnMetrics({
        projectId: 'project-a',
        requestId: 'request-a',
      })
    ).resolves.toEqual(expect.objectContaining({ tokenAccounting: 'estimated' }));

    mocks.findRuns.mockResolvedValue([
      run(),
      run({
        events: [
          {
            eventType: 'usage',
            payload: { totalUsage: { usageSource: 'estimated' } },
          },
        ],
      }),
    ]);
    await expect(
      collectPiAgentTurnMetrics({
        projectId: 'project-a',
        requestId: 'request-a',
      })
    ).resolves.toEqual(expect.objectContaining({ tokenAccounting: 'mixed' }));

    mocks.findRuns.mockResolvedValue([run({ status: 'interrupted', events: [] })]);
    await expect(
      collectPiAgentTurnMetrics({
        projectId: 'project-a',
        requestId: 'request-a',
      })
    ).resolves.toEqual(expect.objectContaining({ tokenAccounting: 'partial' }));
  });

  it('fails closed when the root request does not exist', async () => {
    mocks.findRequest.mockResolvedValue(null);
    await expect(
      collectPiAgentTurnMetrics({
        projectId: 'project-a',
        requestId: 'request-a',
      })
    ).rejects.toThrow('cannot find the root user request');
  });

  it('uses only the latest run measurement while accumulating every related run', async () => {
    mocks.findRuns.mockResolvedValue([
      run({
        id: 'latest-run',
        events: [
          { eventType: 'run_finished', payload: { usage: { usageSource: 'provider' }, contextSnapshot: context } },
        ],
      }),
      run({ id: 'older-run' }),
    ]);
    const metrics = await collectPiAgentTurnMetrics({ projectId: 'project-a', requestId: 'request-a' });
    expect(metrics).toMatchObject({ inputTokens: 200, contextSnapshot: { inputTokens: 60, runId: 'latest-run' } });
    expect(mocks.findRuns).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })
    );
  });

  it.each([undefined, { ...context, runId: 'wrong-run' }])(
    'does not reuse a previous run context when the latest measurement is unavailable or mismatched',
    async (contextSnapshot) => {
      mocks.findRuns.mockResolvedValue([
        run({
          id: 'new-run',
          events: [{ eventType: 'run_finished', payload: { usage: { usageSource: 'provider' }, contextSnapshot } }],
        }),
        run({
          id: 'latest-run',
          events: [
            { eventType: 'run_finished', payload: { usage: { usageSource: 'provider' }, contextSnapshot: context } },
          ],
        }),
      ]);
      expect(await collectPiAgentTurnMetrics({ projectId: 'project-a', requestId: 'request-a' })).not.toHaveProperty(
        'contextSnapshot'
      );
    }
  );

  it.each([undefined, 'provider'] as const)('requires provenance even for a zero-token run: %s', async (source) => {
    mocks.findRuns.mockResolvedValue([
      run({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cachedInputTokens: 0,
        cacheMissInputTokens: 0,
        reasoningTokens: 0,
        events: [{ eventType: 'run_finished', payload: { usage: { totalTokens: 0, usageSource: source } } }],
      }),
    ]);
    const metrics = await collectPiAgentTurnMetrics({ projectId: 'project-a', requestId: 'request-a' });
    expect(metrics.totalTokens).toBe(0);
    expect(metrics.tokenAccounting).toBe(source === 'provider' ? 'provider' : 'partial');
  });

  it.each([
    run({ events: [] }),
    run({ events: [{ eventType: 'run_finished', payload: { usage: { totalTokens: 120 } } }] }),
    run({ totalTokens: 0, events: [{ eventType: 'run_finished', payload: { usage: { usageSource: 'partial' } } }] }),
  ])('does not claim precise accounting for legacy or incomplete evidence', async (incomplete) => {
    mocks.findRuns.mockResolvedValue([incomplete]);
    const metrics = await collectPiAgentTurnMetrics({ projectId: 'project-a', requestId: 'request-a' });
    expect(metrics.tokenAccounting).toBe('partial');
  });
});
