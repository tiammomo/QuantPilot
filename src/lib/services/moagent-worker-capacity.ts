import { randomUUID } from 'node:crypto';

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';

const MAX_CAPACITY = 256;
const MAX_LEASE_TTL_MS = 24 * 60 * 60 * 1_000;
const POOL_PATTERN = /^[a-z][a-z0-9_.:-]{0,127}$/;

export interface MoAgentWorkerSlotFence {
  poolKey: string;
  slotNumber: number;
  activeJobId: string;
  leaseOwner: string;
  fencingToken: number;
}

export interface MoAgentWorkerSlotClaim extends MoAgentWorkerSlotFence {
  leaseExpiresAt: string;
}

export class MoAgentWorkerCapacityError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'MoAgentWorkerCapacityError';
  }
}

function assertInput(input: {
  poolKey: string;
  capacity: number;
  activeJobId: string;
  leaseOwner: string;
  leaseTtlMs: number;
}): void {
  if (!POOL_PATTERN.test(input.poolKey)) {
    throw new MoAgentWorkerCapacityError(
      'WORKER_POOL_INVALID',
      'Worker pool key must be a bounded namespaced identifier.',
    );
  }
  if (!Number.isSafeInteger(input.capacity) || input.capacity < 1 || input.capacity > MAX_CAPACITY) {
    throw new MoAgentWorkerCapacityError(
      'WORKER_POOL_INVALID',
      `Worker pool capacity must be between 1 and ${MAX_CAPACITY}.`,
    );
  }
  if (!input.activeJobId || !input.leaseOwner || input.leaseOwner.length > 256) {
    throw new MoAgentWorkerCapacityError(
      'WORKER_POOL_INVALID',
      'Worker slot job and owner identities are required.',
    );
  }
  if (
    !Number.isSafeInteger(input.leaseTtlMs) ||
    input.leaseTtlMs < 1_000 ||
    input.leaseTtlMs > MAX_LEASE_TTL_MS
  ) {
    throw new MoAgentWorkerCapacityError(
      'WORKER_POOL_INVALID',
      'Worker slot lease TTL must be between one second and one day.',
    );
  }
}

async function databaseNow(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ databaseNow: Date }>>(Prisma.sql`
    SELECT clock_timestamp() AS "databaseNow"
  `);
  const now = rows[0]?.databaseNow;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new MoAgentWorkerCapacityError(
      'WORKER_POOL_DATABASE_CLOCK_UNAVAILABLE',
      'Database clock is unavailable for Worker capacity fencing.',
    );
  }
  return now;
}

export async function claimMoAgentWorkerSlot(input: {
  poolKey: string;
  capacity: number;
  activeJobId: string;
  leaseOwner: string;
  leaseTtlMs: number;
}): Promise<MoAgentWorkerSlotClaim | null> {
  assertInput(input);
  try {
    return await prisma.$transaction(async (tx) => {
      const now = await databaseNow(tx);
      await tx.agentWorkerSlot.createMany({
        data: Array.from({ length: input.capacity }, (_, index) => ({
          poolKey: input.poolKey,
          slotNumber: index + 1,
        })),
        skipDuplicates: true,
      });
      const rows = await tx.$queryRaw<Array<{
        slotNumber: number;
        fencingToken: number;
      }>>(Prisma.sql`
        SELECT
          "slot_number" AS "slotNumber",
          "fencing_token" AS "fencingToken"
        FROM "agent_worker_slots"
        WHERE "pool_key" = ${input.poolKey}
          AND "slot_number" <= ${input.capacity}
          AND (
            "status" = 'free'
            OR (
              "status" = 'held'
              AND "lease_expires_at" <= ${now}
              AND NOT EXISTS (
                SELECT 1
                FROM "agent_generation_jobs" AS "job"
                WHERE "job"."id" = "agent_worker_slots"."active_job_id"
                  AND "job"."status" = 'running'
                  AND "job"."lease_expires_at" > ${now}
              )
            )
          )
        ORDER BY "slot_number" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      `);
      const available = rows[0];
      if (!available) return null;
      const leaseExpiresAt = new Date(now.getTime() + input.leaseTtlMs);
      const updated = await tx.agentWorkerSlot.updateMany({
        where: {
          poolKey: input.poolKey,
          slotNumber: available.slotNumber,
          OR: [
            { status: 'free' },
            { status: 'held', leaseExpiresAt: { lte: now } },
          ],
        },
        data: {
          status: 'held',
          activeJobId: input.activeJobId,
          leaseOwner: input.leaseOwner,
          leaseExpiresAt,
          lastHeartbeatAt: now,
          fencingToken: { increment: 1 },
          version: { increment: 1 },
          acquiredAt: now,
          releasedAt: null,
        },
      });
      if (updated.count !== 1) return null;
      return {
        poolKey: input.poolKey,
        slotNumber: available.slotNumber,
        activeJobId: input.activeJobId,
        leaseOwner: input.leaseOwner,
        fencingToken: available.fencingToken + 1,
        leaseExpiresAt: leaseExpiresAt.toISOString(),
      };
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return null;
    }
    throw error;
  }
}

async function mutateOwnedSlot(input: {
  fence: MoAgentWorkerSlotFence;
  leaseTtlMs?: number;
  release: boolean;
}): Promise<string | null> {
  return prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    const leaseExpiresAt = input.release
      ? null
      : new Date(now.getTime() + input.leaseTtlMs!);
    const changed = await tx.agentWorkerSlot.updateMany({
      where: {
        poolKey: input.fence.poolKey,
        slotNumber: input.fence.slotNumber,
        status: 'held',
        activeJobId: input.fence.activeJobId,
        leaseOwner: input.fence.leaseOwner,
        fencingToken: input.fence.fencingToken,
        leaseExpiresAt: { gt: now },
      },
      data: input.release
        ? {
            status: 'free',
            activeJobId: null,
            leaseOwner: null,
            leaseExpiresAt: null,
            lastHeartbeatAt: null,
            version: { increment: 1 },
            releasedAt: now,
          }
        : {
            leaseExpiresAt,
            lastHeartbeatAt: now,
            version: { increment: 1 },
          },
    });
    if (changed.count !== 1) {
      throw new MoAgentWorkerCapacityError(
        'WORKER_SLOT_LEASE_LOST',
        'Worker no longer owns the global execution slot.',
      );
    }
    return leaseExpiresAt?.toISOString() ?? null;
  });
}

export async function heartbeatMoAgentWorkerSlot(input: {
  fence: MoAgentWorkerSlotFence;
  leaseTtlMs: number;
}): Promise<{ leaseExpiresAt: string }> {
  assertInput({
    poolKey: input.fence.poolKey,
    capacity: input.fence.slotNumber,
    activeJobId: input.fence.activeJobId,
    leaseOwner: input.fence.leaseOwner,
    leaseTtlMs: input.leaseTtlMs,
  });
  const leaseExpiresAt = await mutateOwnedSlot({
    fence: input.fence,
    leaseTtlMs: input.leaseTtlMs,
    release: false,
  });
  return { leaseExpiresAt: leaseExpiresAt! };
}

export async function releaseMoAgentWorkerSlot(
  fence: MoAgentWorkerSlotFence,
): Promise<void> {
  await mutateOwnedSlot({ fence, release: true });
}

export class MoAgentWorkerCapacitySession {
  private timer: ReturnType<typeof setInterval> | null = null;
  private fatalError: Error | null = null;

  private constructor(
    readonly claim: MoAgentWorkerSlotClaim,
    private readonly leaseTtlMs: number,
    heartbeatIntervalMs: number,
  ) {
    this.timer = setInterval(() => {
      if (this.fatalError) return;
      void heartbeatMoAgentWorkerSlot({
        fence: this.claim,
        leaseTtlMs: this.leaseTtlMs,
      }).catch((error) => {
        this.fatalError = error instanceof Error ? error : new Error(String(error));
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
      });
    }, heartbeatIntervalMs);
    this.timer.unref?.();
  }

  static async tryClaim(input: {
    poolKey?: string;
    capacity: number;
    activeJobId: string;
    leaseOwner?: string;
    leaseTtlMs: number;
    heartbeatIntervalMs: number;
  }): Promise<MoAgentWorkerCapacitySession | null> {
    if (input.heartbeatIntervalMs >= input.leaseTtlMs) {
      throw new MoAgentWorkerCapacityError(
        'WORKER_POOL_INVALID',
        'Worker slot heartbeat interval must be smaller than its lease TTL.',
      );
    }
    const claim = await claimMoAgentWorkerSlot({
      poolKey: input.poolKey ?? 'generation.default',
      capacity: input.capacity,
      activeJobId: input.activeJobId,
      leaseOwner: input.leaseOwner ?? `worker-slot:${process.pid}:${randomUUID()}`,
      leaseTtlMs: input.leaseTtlMs,
    });
    return claim
      ? new MoAgentWorkerCapacitySession(
          claim,
          input.leaseTtlMs,
          input.heartbeatIntervalMs,
        )
      : null;
  }

  assertHealthy(): void {
    if (this.fatalError) throw this.fatalError;
  }

  async release(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.assertHealthy();
    await releaseMoAgentWorkerSlot(this.claim);
  }
}
