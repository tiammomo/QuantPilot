import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const transactionClient = {
    $queryRaw: vi.fn(),
    agentWorkerSlot: {
      createMany: vi.fn(),
      updateMany: vi.fn(),
    },
  };
  return {
    transactionClient,
    transaction: vi.fn(async (
      callback: (tx: typeof transactionClient) => unknown,
    ) => callback(transactionClient)),
  };
});

vi.mock('@/lib/db/client', () => ({
  prisma: {
    $transaction: mocks.transaction,
  },
}));

import {
  claimMoAgentWorkerSlot,
  heartbeatMoAgentWorkerSlot,
  releaseMoAgentWorkerSlot,
} from './moagent-worker-capacity';

const now = new Date('2026-07-23T05:00:00.000Z');

function claimInput() {
  return {
    poolKey: 'generation.default',
    capacity: 2,
    activeJobId: '2ab5adf1-3b1d-4ed3-b57e-44695a6cd4df',
    leaseOwner: 'worker-slot:test',
    leaseTtlMs: 120_000,
  };
}

describe('MoAgent global Worker capacity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.transactionClient.agentWorkerSlot.createMany.mockResolvedValue({
      count: 2,
    });
    mocks.transactionClient.agentWorkerSlot.updateMany.mockResolvedValue({
      count: 1,
    });
  });

  it('claims one database-backed slot with a monotonic fencing token', async () => {
    mocks.transactionClient.$queryRaw
      .mockResolvedValueOnce([{ databaseNow: now }])
      .mockResolvedValueOnce([{ slotNumber: 1, fencingToken: 7 }]);

    const claim = await claimMoAgentWorkerSlot(claimInput());

    expect(claim).toMatchObject({
      poolKey: 'generation.default',
      slotNumber: 1,
      fencingToken: 8,
      activeJobId: claimInput().activeJobId,
    });
    expect(mocks.transactionClient.agentWorkerSlot.createMany)
      .toHaveBeenCalledWith({
        data: [
          { poolKey: 'generation.default', slotNumber: 1 },
          { poolKey: 'generation.default', slotNumber: 2 },
        ],
        skipDuplicates: true,
      });
  });

  it('returns null when the shared pool has no free slot', async () => {
    mocks.transactionClient.$queryRaw
      .mockResolvedValueOnce([{ databaseNow: now }])
      .mockResolvedValueOnce([]);

    await expect(claimMoAgentWorkerSlot(claimInput())).resolves.toBeNull();
    expect(mocks.transactionClient.agentWorkerSlot.updateMany)
      .not.toHaveBeenCalled();
  });

  it('heartbeats and releases only the exact fenced owner', async () => {
    const fence = {
      poolKey: 'generation.default',
      slotNumber: 1,
      activeJobId: claimInput().activeJobId,
      leaseOwner: 'worker-slot:test',
      fencingToken: 8,
    };
    mocks.transactionClient.$queryRaw.mockResolvedValue([{ databaseNow: now }]);

    await expect(heartbeatMoAgentWorkerSlot({
      fence,
      leaseTtlMs: 120_000,
    })).resolves.toEqual({
      leaseExpiresAt: '2026-07-23T05:02:00.000Z',
    });
    await expect(releaseMoAgentWorkerSlot(fence)).resolves.toBeUndefined();
    expect(mocks.transactionClient.agentWorkerSlot.updateMany)
      .toHaveBeenCalledTimes(2);
  });
});
