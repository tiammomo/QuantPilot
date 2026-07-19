import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  begin: vi.fn(),
  heartbeat: vi.fn(),
  abandon: vi.fn(),
}));

vi.mock('@/lib/services/moagent-mission-store', () => ({
  beginMoAgentMissionVerification: mocks.begin,
  heartbeatMoAgentMissionVerification: mocks.heartbeat,
  abandonMoAgentMissionVerification: mocks.abandon,
}));

import { MoAgentMissionVerificationSession } from './moagent-mission-verification-session';

const mission = {
  id: 'mission-session',
  generationId: '11111111-1111-4111-8111-111111111111',
  projectId: 'project-session',
  requestId: 'request-session',
  status: 'verifying' as const,
  version: 2,
  candidateVersion: 1,
  specHash: `sha256:${'a'.repeat(64)}`,
  acceptedReceiptId: null,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.begin.mockResolvedValue({
    mission,
    leaseOwner: 'mission-verifier:test-session',
    fencingToken: 7,
    leaseExpiresAt: '2026-07-15T05:02:00.000Z',
  });
  mocks.heartbeat.mockResolvedValue({
    leaseExpiresAt: '2026-07-15T05:02:30.000Z',
  });
  mocks.abandon.mockResolvedValue({ ...mission, status: 'candidate_complete' });
});

afterEach(() => {
  vi.useRealTimers();
});

async function claimSession() {
  return MoAgentMissionVerificationSession.claim({
    missionId: mission.id,
    projectId: mission.projectId,
    requestId: mission.requestId,
  }, {
    leaseOwner: 'mission-verifier:test-session',
    leaseTtlMs: 120_000,
    heartbeatIntervalMs: 30_000,
  });
}

describe('MoAgent Mission verification session', () => {
  it('renews the durable lease and stops heartbeats after a fenced commit', async () => {
    const session = await claimSession();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.heartbeat).toHaveBeenCalledWith({
      missionId: mission.id,
      projectId: mission.projectId,
      requestId: mission.requestId,
      leaseOwner: 'mission-verifier:test-session',
      fencingToken: 7,
      leaseTtlMs: 120_000,
    });
    await expect(session.commit(async (fence) => fence.fencingToken)).resolves.toBe(7);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.heartbeat).toHaveBeenCalledTimes(1);

    await session.dispose();
    expect(mocks.abandon).not.toHaveBeenCalled();
  });

  it('returns an uncommitted claim to candidate_complete on dispose', async () => {
    const session = await claimSession();

    await session.dispose();

    expect(mocks.abandon).toHaveBeenCalledWith({
      missionId: mission.id,
      projectId: mission.projectId,
      requestId: mission.requestId,
      leaseOwner: 'mission-verifier:test-session',
      fencingToken: 7,
    });
  });

  it('fails closed after an independent heartbeat loses the lease', async () => {
    mocks.heartbeat.mockRejectedValueOnce(new Error('verification lease lost'));
    const session = await claimSession();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(session.failure?.message).toBe('verification lease lost');
    await expect(session.commit(async () => 'unsafe')).rejects.toThrow(
      'verification lease lost',
    );
    await session.dispose();
    expect(mocks.abandon).toHaveBeenCalledTimes(1);
  });
});
