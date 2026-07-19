import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  claim: vi.fn(),
  heartbeat: vi.fn(),
  release: vi.fn(),
}));

vi.mock('@/lib/services/moagent-generation-lease-store', () => ({
  claimMoAgentGenerationLease: mocks.claim,
  heartbeatMoAgentGenerationLease: mocks.heartbeat,
  releaseMoAgentGenerationLease: mocks.release,
}));

import {
  MoAgentGenerationLeaseSession,
  withMoAgentGenerationLease,
} from './moagent-generation-lease-session';

const claim = {
  projectId: 'project-generation-session',
  operationId: 'request-generation-session',
  requestId: 'request-generation-session',
  stage: 'agent_execution' as const,
  leaseOwner: 'generation-orchestrator:test',
  fencingToken: 4,
  leaseExpiresAt: '2026-07-19T06:02:00.000Z',
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.claim.mockResolvedValue(claim);
  mocks.heartbeat.mockResolvedValue({
    leaseExpiresAt: '2026-07-19T06:02:30.000Z',
  });
  mocks.release.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

async function claimSession() {
  return MoAgentGenerationLeaseSession.claimProject(
    {
      projectId: claim.projectId,
      operationId: claim.operationId,
      requestId: claim.requestId,
      stage: claim.stage,
    },
    {
      leaseOwner: claim.leaseOwner,
      leaseTtlMs: 120_000,
      heartbeatIntervalMs: 30_000,
    }
  );
}

describe('MoAgent generation lease session', () => {
  it('renews and releases the outer orchestration fence', async () => {
    const session = await claimSession();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.heartbeat).toHaveBeenCalledWith({
      fence: {
        projectId: claim.projectId,
        operationId: claim.operationId,
        leaseOwner: claim.leaseOwner,
        fencingToken: claim.fencingToken,
      },
      leaseTtlMs: 120_000,
    });
    await session.release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.heartbeat).toHaveBeenCalledTimes(1);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });

  it('fails closed when an independent heartbeat loses ownership', async () => {
    mocks.heartbeat.mockRejectedValueOnce(new Error('generation lease lost'));
    const session = await claimSession();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(session.failure?.message).toBe('generation lease lost');
    await expect(session.release()).rejects.toThrow('generation lease lost');
    await session.dispose();
  });

  it('preserves the task failure while best-effort releasing the lease', async () => {
    const failure = new Error('model execution failed');

    await expect(
      withMoAgentGenerationLease({
        projectId: claim.projectId,
        operationId: claim.operationId,
        requestId: claim.requestId,
        stage: claim.stage,
        options: {
          leaseOwner: claim.leaseOwner,
          leaseTtlMs: 120_000,
          heartbeatEnabled: false,
        },
        task: async () => {
          throw failure;
        },
      })
    ).rejects.toBe(failure);
    expect(mocks.release).toHaveBeenCalledTimes(1);
  });
});
