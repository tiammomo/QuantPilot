import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  workerFindMany: vi.fn(),
  slotFindMany: vi.fn(),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    $queryRaw: mocks.queryRaw,
    agentWorkerInstance: {
      findMany: mocks.workerFindMany,
    },
    agentWorkerSlot: {
      findMany: mocks.slotFindMany,
    },
  },
}));

import { getAgentWorkerRuntimeDashboard } from './agent-worker-observability';

const now = new Date('2026-07-23T07:00:00.000Z');
const workerId = '97f96039-0fed-4a2e-a057-1b0570dd8e67';
const jobId = '72e1db38-1070-4204-a3d3-2d21e8dde29e';

function queue(overrides: Record<string, unknown> = {}) {
  return {
    pendingJobs: 0n,
    retryWaitJobs: 0n,
    runningJobs: 1n,
    failedJobsLast24h: 0n,
    completedJobsLast24h: 3n,
    queuedActors: 0n,
    oldestQueuedAt: null,
    ...overrides,
  };
}

function worker() {
  return {
    id: workerId,
    poolKey: 'generation.default',
    hostname: 'worker-a',
    processId: 42,
    processConcurrency: 2,
    globalConcurrency: 2,
    status: 'running',
    startedAt: new Date('2026-07-23T06:00:00.000Z'),
    lastHeartbeatAt: new Date('2026-07-23T06:59:30.000Z'),
    leaseExpiresAt: new Date('2026-07-23T07:01:30.000Z'),
    stoppedAt: null,
    createdAt: new Date('2026-07-23T06:00:00.000Z'),
    updatedAt: new Date('2026-07-23T06:59:30.000Z'),
  };
}

function heldSlot() {
  return {
    poolKey: 'generation.default',
    slotNumber: 1,
    status: 'held',
    activeJobId: jobId,
    leaseOwner: `worker-instance:${workerId}`,
    leaseExpiresAt: new Date('2026-07-23T07:01:30.000Z'),
    lastHeartbeatAt: new Date('2026-07-23T06:59:30.000Z'),
    fencingToken: 1,
    version: 1,
    acquiredAt: new Date('2026-07-23T06:58:00.000Z'),
    releasedAt: null,
    createdAt: new Date('2026-07-23T06:58:00.000Z'),
    updatedAt: new Date('2026-07-23T06:59:30.000Z'),
  };
}

describe('Agent Worker runtime observability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queryRaw
      .mockResolvedValueOnce([{ databaseNow: now }])
      .mockResolvedValueOnce([queue()]);
    mocks.workerFindMany.mockResolvedValue([worker()]);
    mocks.slotFindMany.mockResolvedValue([heldSlot()]);
  });

  it('projects live Worker, global slot and queue facts into one healthy snapshot', async () => {
    const dashboard = await getAgentWorkerRuntimeDashboard({
      dispatchMode: 'worker',
    });

    expect(dashboard.status).toBe('ok');
    expect(dashboard.summary).toMatchObject({
      activeWorkers: 1,
      processCapacity: 2,
      globalCapacity: 2,
      heldSlots: 1,
      availableSlots: 1,
      runningJobs: 1,
      completedJobsLast24h: 3,
      configurationConsistent: true,
    });
    expect(dashboard.slots[0]).toMatchObject({
      status: 'held',
      workerId,
      activeJobId: jobId,
    });
  });

  it('reports a failed consumer gap when queued jobs have no live Worker', async () => {
    mocks.workerFindMany.mockResolvedValue([]);
    mocks.slotFindMany.mockResolvedValue([]);
    mocks.queryRaw.mockReset();
    mocks.queryRaw
      .mockResolvedValueOnce([{ databaseNow: now }])
      .mockResolvedValueOnce([queue({
        pendingJobs: 2n,
        runningJobs: 0n,
        queuedActors: 2n,
        oldestQueuedAt: new Date('2026-07-23T06:55:00.000Z'),
      })]);

    const dashboard = await getAgentWorkerRuntimeDashboard({
      dispatchMode: 'worker',
    });

    expect(dashboard.status).toBe('failed');
    expect(dashboard.summary.oldestQueueAgeSeconds).toBe(300);
    expect(dashboard.alerts).toContainEqual(expect.objectContaining({
      id: 'worker-consumer-missing',
      severity: 'failed',
    }));
  });

  it('degrades to an explicit unavailable snapshot instead of breaking the ops page', async () => {
    mocks.queryRaw.mockReset();
    mocks.queryRaw.mockRejectedValue(new Error('database unavailable'));

    const dashboard = await getAgentWorkerRuntimeDashboard({
      dispatchMode: 'worker',
    });

    expect(dashboard).toMatchObject({
      available: false,
      status: 'unavailable',
      error: 'database unavailable',
    });
  });
});
