import { describe, expect, it, vi } from 'vitest';

import {
  deleteProjectWithOwnedQuota,
  PROJECTS_OWNED_WINDOW,
  reconcileProjectsOwnedAllocation,
} from './allocation-reconciliation';

const now = new Date('2026-07-17T00:00:00.000Z');

interface ReservationState {
  id: string;
  status: string;
  expiresAt: Date;
  reservedQuantity: bigint;
}

function reconciliationFixture(options: {
  used?: bigint;
  reserved?: bigint;
  projectCount?: number;
  reservations?: ReservationState[];
} = {}) {
  let bucket = {
    id: 'bucket-projects-owned',
    actorUserId: 'member-1',
    metric: 'projects.owned',
    windowStart: PROJECTS_OWNED_WINDOW.start,
    windowEnd: PROJECTS_OWNED_WINDOW.end,
    used: options.used ?? 0n,
    reserved: options.reserved ?? 0n,
    version: 4,
    createdAt: now,
    updatedAt: now,
  };
  const reservations = options.reservations ?? [];
  const events: Array<Record<string, unknown>> = [];
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([{ acquired: 1 }]),
    authUser: {
      findUnique: vi.fn().mockResolvedValue({ id: 'member-1', role: 'member' }),
    },
    project: {
      count: vi.fn().mockResolvedValue(options.projectCount ?? 0),
    },
    quotaReservation: {
      findMany: vi.fn(async ({ where }: { where: { expiresAt: { lte?: Date; gt?: Date } } }) => {
        return reservations.filter((reservation) => {
          if (reservation.status !== 'active') return false;
          if (where.expiresAt.lte) return reservation.expiresAt <= where.expiresAt.lte;
          if (where.expiresAt.gt) return reservation.expiresAt > where.expiresAt.gt;
          return false;
        }).map((reservation) => (
          where.expiresAt.lte
            ? { id: reservation.id, reservedQuantity: reservation.reservedQuantity }
            : { id: reservation.id }
        ));
      }),
      updateMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        let count = 0;
        for (const reservation of reservations) {
          if (where.id.in.includes(reservation.id) && reservation.status === 'active') {
            reservation.status = 'expired';
            count += 1;
          }
        }
        return { count };
      }),
    },
    usageBucket: {
      upsert: vi.fn(async () => bucket),
      update: vi.fn(async ({ data }: {
        data: {
          used?: bigint;
          reserved?: bigint;
          version?: { increment: number };
          updatedAt?: Date;
        };
      }) => {
        bucket = {
          ...bucket,
          ...(data.used !== undefined ? { used: data.used } : {}),
          ...(data.reserved !== undefined ? { reserved: data.reserved } : {}),
          ...(data.version ? { version: bucket.version + data.version.increment } : {}),
          ...(data.updatedAt ? { updatedAt: data.updatedAt } : {}),
        };
        return bucket;
      }),
    },
    usageEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return { id: `event-${events.length}` };
      }),
    },
  };
  return { tx, events, getBucket: () => bucket };
}

describe('projects.owned allocation reconciliation', () => {
  it('converges to the authoritative project count and is idempotent', async () => {
    const fixture = reconciliationFixture({ used: 1n, projectCount: 3 });

    await expect(reconcileProjectsOwnedAllocation(fixture.tx as never, 'member-1', {
      now,
      trigger: 'test',
    })).resolves.toMatchObject({
      status: 'reconciled',
      adjustment: 2n,
      currentUsed: 3n,
    });
    await expect(reconcileProjectsOwnedAllocation(fixture.tx as never, 'member-1', {
      now,
      trigger: 'test',
    })).resolves.toMatchObject({
      status: 'unchanged',
      adjustment: 0n,
      currentUsed: 3n,
    });

    expect(fixture.events).toHaveLength(1);
    expect(fixture.events[0]).toMatchObject({
      metric: 'projects.owned',
      quantity: 2n,
      sourceType: 'allocation_reconciliation',
    });
  });

  it('skips an actor while a live project-create reservation is ambiguous', async () => {
    const fixture = reconciliationFixture({
      used: 0n,
      reserved: 1n,
      projectCount: 1,
      reservations: [{
        id: 'reservation-live',
        status: 'active',
        expiresAt: new Date('2026-07-17T00:30:00.000Z'),
        reservedQuantity: 1n,
      }],
    });

    await expect(reconcileProjectsOwnedAllocation(fixture.tx as never, 'member-1', { now }))
      .resolves.toMatchObject({
        status: 'skipped-active-reservations',
        activeReservations: 1,
        currentUsed: 0n,
        currentReserved: 1n,
      });
    expect(fixture.tx.usageEvent.create).not.toHaveBeenCalled();
  });

  it('reclaims expired reservations under the bucket lock before repairing usage', async () => {
    const fixture = reconciliationFixture({
      used: 0n,
      reserved: 1n,
      projectCount: 1,
      reservations: [{
        id: 'reservation-expired',
        status: 'active',
        expiresAt: new Date('2026-07-16T23:59:00.000Z'),
        reservedQuantity: 1n,
      }],
    });

    await expect(reconcileProjectsOwnedAllocation(fixture.tx as never, 'member-1', { now }))
      .resolves.toMatchObject({
        status: 'reconciled',
        expiredReservations: 1,
        currentUsed: 1n,
        currentReserved: 0n,
      });
    expect(fixture.getBucket()).toMatchObject({ used: 1n, reserved: 0n });
  });
});

describe('transactional project deletion allocation', () => {
  function deletionFixture(used: bigint) {
    const project = {
      id: 'project-1',
      ownerId: 'member-1',
      repoPath: '/tmp/project-1',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      owner: { role: 'member' },
    };
    let existing: typeof project | null = project;
    let currentUsed = used;
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([{ acquired: 1 }]),
      project: {
        findUnique: vi.fn(async ({ select }: { select: { ownerId: true } }) => (
          existing
            ? select.ownerId && Object.keys(select).length === 1
              ? { ownerId: existing.ownerId }
              : existing
            : null
        )),
        delete: vi.fn(async () => {
          existing = null;
          return project;
        }),
      },
      usageBucket: {
        findUnique: vi.fn(async () => ({
          id: 'bucket-1',
          used: currentUsed,
        })),
        update: vi.fn(async () => {
          currentUsed -= 1n;
          return { id: 'bucket-1', used: currentUsed };
        }),
      },
      usageEvent: {
        create: vi.fn().mockResolvedValue({ id: 'delete-event-1' }),
      },
    };
    const client = {
      $transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)),
    };
    return { client, tx, getUsed: () => currentUsed };
  }

  it('deletes and decrements through one transaction and meters only once', async () => {
    const fixture = deletionFixture(2n);

    await expect(deleteProjectWithOwnedQuota(fixture.client as never, 'project-1', { now }))
      .resolves.toMatchObject({
        id: 'project-1',
        repoPath: '/tmp/project-1',
        quotaAdjusted: true,
        usageEventId: 'delete-event-1',
      });
    await expect(deleteProjectWithOwnedQuota(fixture.client as never, 'project-1', { now }))
      .resolves.toBeNull();

    expect(fixture.client.$transaction).toHaveBeenCalledTimes(2);
    expect(fixture.tx.project.delete).toHaveBeenCalledOnce();
    expect(fixture.tx.usageEvent.create).toHaveBeenCalledOnce();
    expect(fixture.getUsed()).toBe(1n);
  });

  it('never blocks deletion when the historical gauge is already zero', async () => {
    const fixture = deletionFixture(0n);

    await expect(deleteProjectWithOwnedQuota(fixture.client as never, 'project-1', { now }))
      .resolves.toMatchObject({ quotaAdjusted: false, usageEventId: null });
    expect(fixture.tx.project.delete).toHaveBeenCalledOnce();
    expect(fixture.tx.usageBucket.update).not.toHaveBeenCalled();
    expect(fixture.tx.usageEvent.create).not.toHaveBeenCalled();
  });
});
