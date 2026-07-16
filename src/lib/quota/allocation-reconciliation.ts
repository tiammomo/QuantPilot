import type { Prisma, PrismaClient } from '@prisma/client';

import { acquireQuotaBucketLock } from './locking';
import { calculateQuotaWindow } from './window';

export const PROJECTS_OWNED_METRIC = 'projects.owned';
export const PROJECTS_OWNED_WINDOW = calculateQuotaWindow('lifetime', new Date(0));

type ReconciliationTransaction = Prisma.TransactionClient;
type ReconciliationClient = Pick<PrismaClient, '$transaction'>;

export interface DeletedProjectWithAllocation {
  id: string;
  ownerId: string | null;
  repoPath: string | null;
  createdAt: Date;
  quotaAdjusted: boolean;
  usageEventId: string | null;
}

export interface ProjectAllocationReconciliationResult {
  actorUserId: string;
  status: 'reconciled' | 'unchanged' | 'skipped-active-reservations';
  authoritativeUsed: bigint;
  previousUsed: bigint;
  currentUsed: bigint;
  previousReserved: bigint;
  currentReserved: bigint;
  expiredReservations: number;
  activeReservations: number;
  adjustment: bigint;
}

export interface ProjectAllocationReconciliationSummary {
  actors: number;
  reconciled: number;
  unchanged: number;
  skippedActiveReservations: number;
  expiredReservations: number;
}

function nonNegative(value: bigint): bigint {
  return value > 0n ? value : 0n;
}

export async function acquireProjectsOwnedAllocationLock(
  transaction: Pick<Prisma.TransactionClient, '$queryRaw'>,
  actorUserId: string,
): Promise<void> {
  await acquireQuotaBucketLock(transaction, {
    actorUserId,
    metric: PROJECTS_OWNED_METRIC,
    windowStart: PROJECTS_OWNED_WINDOW.start,
    windowEnd: PROJECTS_OWNED_WINDOW.end,
  });
}

/**
 * Deletes the authoritative project row and applies its allocation decrement
 * in one transaction while holding the lifetime projects.owned bucket lock.
 * Filesystem cleanup intentionally happens after this function returns.
 *
 * A missing or already-underflowed bucket never prevents deletion. In that
 * drift case no negative event is written; the next startup reconciliation
 * restores the gauge from authoritative project ownership.
 */
export async function deleteProjectWithOwnedQuota(
  client: ReconciliationClient,
  projectId: string,
  options: { now?: Date; deletedByUserId?: string | null } = {},
): Promise<DeletedProjectWithAllocation | null> {
  if (!projectId || projectId.length > 191) {
    throw new TypeError('projectId must contain between 1 and 191 characters.');
  }
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new TypeError('now must be a valid date.');

  return client.$transaction(async (transaction) => {
    const preview = await transaction.project.findUnique({
      where: { id: projectId },
      select: { ownerId: true },
    });
    if (!preview) return null;
    if (preview.ownerId) {
      await acquireProjectsOwnedAllocationLock(transaction, preview.ownerId);
    }

    // Refetch after acquiring the actor lock. Two compliant delete requests
    // may both observe the preview, but only the first can delete and meter it.
    const project = await transaction.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        ownerId: true,
        repoPath: true,
        createdAt: true,
        owner: { select: { role: true } },
      },
    });
    if (!project) return null;
    if (project.ownerId !== preview.ownerId) {
      throw new Error('Project ownership changed while acquiring its allocation lock.');
    }

    await transaction.project.delete({ where: { id: project.id } });
    if (!project.ownerId) {
      return {
        id: project.id,
        ownerId: null,
        repoPath: project.repoPath,
        createdAt: project.createdAt,
        quotaAdjusted: false,
        usageEventId: null,
      };
    }

    const bucket = await transaction.usageBucket.findUnique({
      where: {
        actorUserId_metric_windowStart_windowEnd: {
          actorUserId: project.ownerId,
          metric: PROJECTS_OWNED_METRIC,
          windowStart: PROJECTS_OWNED_WINDOW.start,
          windowEnd: PROJECTS_OWNED_WINDOW.end,
        },
      },
    });
    if (!bucket || bucket.used <= 0n) {
      return {
        id: project.id,
        ownerId: project.ownerId,
        repoPath: project.repoPath,
        createdAt: project.createdAt,
        quotaAdjusted: false,
        usageEventId: null,
      };
    }

    await transaction.usageBucket.update({
      where: { id: bucket.id },
      data: {
        used: { decrement: 1n },
        version: { increment: 1 },
        updatedAt: now,
      },
    });
    const event = await transaction.usageEvent.create({
      data: {
        idempotencyKey: `project-delete:${project.id}:${project.createdAt.getTime()}:owned-adjustment`,
        actorUserId: project.ownerId,
        bucketId: bucket.id,
        metric: PROJECTS_OWNED_METRIC,
        quantity: -1n,
        sourceType: 'project_deleted',
        sourceId: project.id,
        enforcementExempt: project.owner?.role === 'admin',
        occurredAt: now,
        metadata: {
          transactional: true,
          deletedByUserId: options.deletedByUserId ?? null,
        },
      },
      select: { id: true },
    });
    return {
      id: project.id,
      ownerId: project.ownerId,
      repoPath: project.repoPath,
      createdAt: project.createdAt,
      quotaAdjusted: true,
      usageEventId: event.id,
    };
  }, { maxWait: 10_000, timeout: 30_000 });
}

/**
 * Makes the lifetime projects.owned allocation match the projects table.
 *
 * The caller must run this inside a database transaction. The function uses
 * the exact advisory-lock domain used by normal quota mutations. Unexpired
 * project-create reservations are deliberately not guessed: an operation may
 * already have inserted its project but not settled its reservation, so the
 * actor is skipped and can be retried after the operation finishes. Expired
 * reservations are reclaimed under the same lock before reconciliation.
 *
 * This is a startup/bootstrap repair primitive, not a periodic cleanup job.
 * Normal project deletion now holds this same lock and commits the project row
 * plus its usage adjustment atomically. Keeping exact, table-wide repair out of
 * recurring cleanup still bounds lock duration and leaves the cleanup job with
 * the single responsibility of expiring abandoned reservations.
 */
export async function reconcileProjectsOwnedAllocation(
  transaction: ReconciliationTransaction,
  actorUserId: string,
  options: { now?: Date; trigger?: string } = {},
): Promise<ProjectAllocationReconciliationResult> {
  if (!actorUserId || actorUserId.length > 191) {
    throw new TypeError('actorUserId must contain between 1 and 191 characters.');
  }
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new TypeError('now must be a valid date.');

  await acquireProjectsOwnedAllocationLock(transaction, actorUserId);

  const actor = await transaction.authUser.findUnique({
    where: { id: actorUserId },
    select: { id: true, role: true },
  });
  if (!actor) throw new Error(`Cannot reconcile project allocation for missing actor ${actorUserId}.`);

  let bucket = await transaction.usageBucket.upsert({
    where: {
      actorUserId_metric_windowStart_windowEnd: {
        actorUserId,
        metric: PROJECTS_OWNED_METRIC,
        windowStart: PROJECTS_OWNED_WINDOW.start,
        windowEnd: PROJECTS_OWNED_WINDOW.end,
      },
    },
    create: {
      actorUserId,
      metric: PROJECTS_OWNED_METRIC,
      windowStart: PROJECTS_OWNED_WINDOW.start,
      windowEnd: PROJECTS_OWNED_WINDOW.end,
    },
    update: {},
  });
  const previousUsed = bucket.used;
  const previousReserved = bucket.reserved;

  const expired = await transaction.quotaReservation.findMany({
    where: {
      bucketId: bucket.id,
      status: 'active',
      expiresAt: { lte: now },
    },
    select: { id: true, reservedQuantity: true },
  });
  if (expired.length > 0) {
    const expiredIds = expired.map((reservation) => reservation.id);
    const changed = await transaction.quotaReservation.updateMany({
      where: {
        id: { in: expiredIds },
        status: 'active',
        expiresAt: { lte: now },
      },
      data: { status: 'expired', releasedAt: now },
    });
    if (changed.count !== expired.length) {
      throw new Error('Project allocation reservations changed outside the shared quota lock.');
    }
    const released = expired.reduce(
      (total, reservation) => total + reservation.reservedQuantity,
      0n,
    );
    bucket = await transaction.usageBucket.update({
      where: { id: bucket.id },
      data: {
        reserved: nonNegative(bucket.reserved - released),
        version: { increment: 1 },
        updatedAt: now,
      },
    });
  }

  const active = await transaction.quotaReservation.findMany({
    where: {
      bucketId: bucket.id,
      status: 'active',
      expiresAt: { gt: now },
    },
    select: { id: true },
  });
  const authoritativeUsed = BigInt(await transaction.project.count({
    where: { ownerId: actorUserId },
  }));

  if (active.length > 0) {
    return {
      actorUserId,
      status: 'skipped-active-reservations',
      authoritativeUsed,
      previousUsed,
      currentUsed: bucket.used,
      previousReserved,
      currentReserved: bucket.reserved,
      expiredReservations: expired.length,
      activeReservations: active.length,
      adjustment: 0n,
    };
  }

  const adjustment = authoritativeUsed - bucket.used;
  const shouldUpdateBucket = adjustment !== 0n || bucket.reserved !== 0n;
  if (shouldUpdateBucket) {
    const version = bucket.version;
    bucket = await transaction.usageBucket.update({
      where: { id: bucket.id },
      data: {
        used: authoritativeUsed,
        reserved: 0n,
        version: { increment: 1 },
        updatedAt: now,
      },
    });
    if (adjustment !== 0n) {
      await transaction.usageEvent.create({
        data: {
          idempotencyKey: `quota-reconcile:projects-owned:${bucket.id}:v${version}:to:${authoritativeUsed}`,
          actorUserId,
          bucketId: bucket.id,
          metric: PROJECTS_OWNED_METRIC,
          quantity: adjustment,
          sourceType: 'allocation_reconciliation',
          sourceId: actorUserId,
          enforcementExempt: actor.role === 'admin',
          occurredAt: now,
          metadata: {
            trigger: options.trigger ?? 'unspecified',
            previousUsed: previousUsed.toString(),
            authoritativeUsed: authoritativeUsed.toString(),
            expiredReservations: expired.length,
          },
        },
      });
    }
  }

  return {
    actorUserId,
    status: adjustment !== 0n ? 'reconciled' : 'unchanged',
    authoritativeUsed,
    previousUsed,
    currentUsed: bucket.used,
    previousReserved,
    currentReserved: bucket.reserved,
    expiredReservations: expired.length,
    activeReservations: 0,
    adjustment,
  };
}

/**
 * Reconciles every actor that currently owns a project or already has a
 * projects.owned bucket. Actors are sorted so concurrent bootstrap processes
 * acquire advisory locks in the same order.
 */
export async function reconcileAllProjectsOwnedAllocationsInTransaction(
  transaction: ReconciliationTransaction,
  options: { now?: Date; trigger?: string } = {},
): Promise<ProjectAllocationReconciliationSummary> {
  const [owners, existingBuckets] = await Promise.all([
    transaction.project.findMany({
      where: { ownerId: { not: null } },
      select: { ownerId: true },
      distinct: ['ownerId'],
    }),
    transaction.usageBucket.findMany({
      where: {
        metric: PROJECTS_OWNED_METRIC,
        windowStart: PROJECTS_OWNED_WINDOW.start,
        windowEnd: PROJECTS_OWNED_WINDOW.end,
      },
      select: { actorUserId: true },
    }),
  ]);
  const actorUserIds = [...new Set([
    ...owners.flatMap((project) => project.ownerId ? [project.ownerId] : []),
    ...existingBuckets.map((bucket) => bucket.actorUserId),
  ])].sort();

  const results: ProjectAllocationReconciliationResult[] = [];
  for (const actorUserId of actorUserIds) {
    results.push(await reconcileProjectsOwnedAllocation(transaction, actorUserId, options));
  }
  return {
    actors: results.length,
    reconciled: results.filter((result) => result.status === 'reconciled').length,
    unchanged: results.filter((result) => result.status === 'unchanged').length,
    skippedActiveReservations: results.filter(
      (result) => result.status === 'skipped-active-reservations',
    ).length,
    expiredReservations: results.reduce(
      (total, result) => total + result.expiredReservations,
      0,
    ),
  };
}

export async function reconcileAllProjectsOwnedAllocations(
  client: ReconciliationClient,
  options: { now?: Date; trigger?: string } = {},
): Promise<ProjectAllocationReconciliationSummary> {
  return client.$transaction(
    (transaction) => reconcileAllProjectsOwnedAllocationsInTransaction(transaction, options),
    { maxWait: 10_000, timeout: 60_000 },
  );
}
