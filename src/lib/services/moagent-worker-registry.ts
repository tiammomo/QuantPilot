import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';

import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';

const MAX_PROCESS_CONCURRENCY = 16;
const MAX_GLOBAL_CONCURRENCY = 256;
const MAX_LEASE_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const POOL_PATTERN = /^[a-z][a-z0-9_.:-]{0,127}$/;

export interface MoAgentWorkerInstanceClaim {
  id: string;
  poolKey: string;
  hostname: string;
  processId: number;
  processConcurrency: number;
  globalConcurrency: number;
  leaseExpiresAt: string;
  lastHeartbeatAt: string;
  startedAt: string;
}

export class MoAgentWorkerRegistryError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'MoAgentWorkerRegistryError';
  }
}

function assertInput(input: {
  id: string;
  poolKey: string;
  hostname: string;
  processId: number;
  processConcurrency: number;
  globalConcurrency: number;
  leaseTtlMs: number;
}): void {
  if (!POOL_PATTERN.test(input.poolKey)) {
    throw new MoAgentWorkerRegistryError(
      'WORKER_REGISTRY_INVALID',
      'Worker pool key must be a bounded namespaced identifier.',
    );
  }
  if (!input.id || input.id.length > 128 || !input.hostname || input.hostname.length > 255) {
    throw new MoAgentWorkerRegistryError(
      'WORKER_REGISTRY_INVALID',
      'Worker instance and hostname identities are required.',
    );
  }
  if (!Number.isSafeInteger(input.processId) || input.processId < 1) {
    throw new MoAgentWorkerRegistryError(
      'WORKER_REGISTRY_INVALID',
      'Worker process ID must be a positive integer.',
    );
  }
  if (
    !Number.isSafeInteger(input.processConcurrency)
    || input.processConcurrency < 1
    || input.processConcurrency > MAX_PROCESS_CONCURRENCY
  ) {
    throw new MoAgentWorkerRegistryError(
      'WORKER_REGISTRY_INVALID',
      `Worker process concurrency must be between 1 and ${MAX_PROCESS_CONCURRENCY}.`,
    );
  }
  if (
    !Number.isSafeInteger(input.globalConcurrency)
    || input.globalConcurrency < 1
    || input.globalConcurrency > MAX_GLOBAL_CONCURRENCY
    || input.processConcurrency > input.globalConcurrency
  ) {
    throw new MoAgentWorkerRegistryError(
      'WORKER_REGISTRY_INVALID',
      `Worker global concurrency must be between 1 and ${MAX_GLOBAL_CONCURRENCY} and no smaller than process concurrency.`,
    );
  }
  if (
    !Number.isSafeInteger(input.leaseTtlMs)
    || input.leaseTtlMs < 1_000
    || input.leaseTtlMs > MAX_LEASE_TTL_MS
  ) {
    throw new MoAgentWorkerRegistryError(
      'WORKER_REGISTRY_INVALID',
      'Worker instance lease TTL must be between one second and one day.',
    );
  }
}

async function databaseNow(tx: Prisma.TransactionClient): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ databaseNow: Date }>>(Prisma.sql`
    SELECT clock_timestamp() AS "databaseNow"
  `);
  const now = rows[0]?.databaseNow;
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
    throw new MoAgentWorkerRegistryError(
      'WORKER_REGISTRY_DATABASE_CLOCK_UNAVAILABLE',
      'Database clock is unavailable for Worker process fencing.',
    );
  }
  return now;
}

async function lockPool(
  tx: Prisma.TransactionClient,
  poolKey: string,
): Promise<void> {
  const lockKey = `agent-worker-pool:${poolKey}`;
  await tx.$queryRaw<Array<{ locked: boolean }>>(Prisma.sql`
    SELECT TRUE AS "locked"
    FROM (
      SELECT pg_advisory_xact_lock(
        hashtextextended(${lockKey}, 0)
      )
    ) AS "pool_lock"
  `);
}

export async function registerMoAgentWorkerInstance(input: {
  id?: string;
  poolKey?: string;
  hostname?: string;
  processId?: number;
  processConcurrency: number;
  globalConcurrency: number;
  leaseTtlMs: number;
  retentionMs?: number;
}): Promise<MoAgentWorkerInstanceClaim> {
  const normalized = {
    id: input.id ?? randomUUID(),
    poolKey: input.poolKey ?? 'generation.default',
    hostname: input.hostname ?? hostname(),
    processId: input.processId ?? process.pid,
    processConcurrency: input.processConcurrency,
    globalConcurrency: input.globalConcurrency,
    leaseTtlMs: input.leaseTtlMs,
  };
  assertInput(normalized);
  const retentionMs = input.retentionMs ?? DEFAULT_RETENTION_MS;
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 0) {
    throw new MoAgentWorkerRegistryError(
      'WORKER_REGISTRY_INVALID',
      'Worker registry retention must be a non-negative integer.',
    );
  }

  return prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    await lockPool(tx, normalized.poolKey);
    await tx.agentWorkerInstance.updateMany({
      where: {
        poolKey: normalized.poolKey,
        status: 'running',
        leaseExpiresAt: { lte: now },
      },
      data: {
        status: 'stale',
        leaseExpiresAt: null,
        stoppedAt: now,
      },
    });
    if (retentionMs > 0) {
      await tx.agentWorkerInstance.deleteMany({
        where: {
          poolKey: normalized.poolKey,
          status: { in: ['stopped', 'stale'] },
          stoppedAt: { lt: new Date(now.getTime() - retentionMs) },
        },
      });
    }
    const incompatible = await tx.agentWorkerInstance.findFirst({
      where: {
        id: { not: normalized.id },
        poolKey: normalized.poolKey,
        status: 'running',
        leaseExpiresAt: { gt: now },
        globalConcurrency: { not: normalized.globalConcurrency },
      },
      select: {
        id: true,
        hostname: true,
        processId: true,
        globalConcurrency: true,
      },
    });
    if (incompatible) {
      throw new MoAgentWorkerRegistryError(
        'WORKER_POOL_CONFIG_MISMATCH',
        `Worker pool ${normalized.poolKey} already has a live instance configured for global concurrency ${incompatible.globalConcurrency} (${incompatible.hostname}:${incompatible.processId}); refusing ${normalized.globalConcurrency}.`,
      );
    }
    const leaseExpiresAt = new Date(now.getTime() + normalized.leaseTtlMs);
    const worker = await tx.agentWorkerInstance.upsert({
      where: { id: normalized.id },
      create: {
        id: normalized.id,
        poolKey: normalized.poolKey,
        hostname: normalized.hostname,
        processId: normalized.processId,
        processConcurrency: normalized.processConcurrency,
        globalConcurrency: normalized.globalConcurrency,
        status: 'running',
        leaseExpiresAt,
        lastHeartbeatAt: now,
        startedAt: now,
      },
      update: {
        poolKey: normalized.poolKey,
        hostname: normalized.hostname,
        processId: normalized.processId,
        processConcurrency: normalized.processConcurrency,
        globalConcurrency: normalized.globalConcurrency,
        status: 'running',
        leaseExpiresAt,
        lastHeartbeatAt: now,
        startedAt: now,
        stoppedAt: null,
      },
    });
    return {
      id: worker.id,
      poolKey: worker.poolKey,
      hostname: worker.hostname,
      processId: worker.processId,
      processConcurrency: worker.processConcurrency,
      globalConcurrency: worker.globalConcurrency,
      leaseExpiresAt: leaseExpiresAt.toISOString(),
      lastHeartbeatAt: now.toISOString(),
      startedAt: now.toISOString(),
    };
  });
}

export async function heartbeatMoAgentWorkerInstance(input: {
  claim: MoAgentWorkerInstanceClaim;
  leaseTtlMs: number;
}): Promise<{ leaseExpiresAt: string }> {
  assertInput({
    ...input.claim,
    leaseTtlMs: input.leaseTtlMs,
  });
  return prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    const leaseExpiresAt = new Date(now.getTime() + input.leaseTtlMs);
    const changed = await tx.agentWorkerInstance.updateMany({
      where: {
        id: input.claim.id,
        poolKey: input.claim.poolKey,
        status: 'running',
        processConcurrency: input.claim.processConcurrency,
        globalConcurrency: input.claim.globalConcurrency,
        leaseExpiresAt: { gt: now },
      },
      data: {
        leaseExpiresAt,
        lastHeartbeatAt: now,
      },
    });
    if (changed.count !== 1) {
      throw new MoAgentWorkerRegistryError(
        'WORKER_INSTANCE_LEASE_LOST',
        'Worker process registration lease was lost.',
      );
    }
    return { leaseExpiresAt: leaseExpiresAt.toISOString() };
  });
}

export async function stopMoAgentWorkerInstance(
  claim: MoAgentWorkerInstanceClaim,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    await tx.agentWorkerInstance.updateMany({
      where: {
        id: claim.id,
        poolKey: claim.poolKey,
        status: 'running',
      },
      data: {
        status: 'stopped',
        leaseExpiresAt: null,
        stoppedAt: now,
      },
    });
  });
}

export class MoAgentWorkerRegistrySession {
  private timer: ReturnType<typeof setInterval> | null = null;
  private fatalError: Error | null = null;

  private constructor(
    readonly claim: MoAgentWorkerInstanceClaim,
    private readonly leaseTtlMs: number,
    heartbeatIntervalMs: number,
  ) {
    this.timer = setInterval(() => {
      if (this.fatalError) return;
      void heartbeatMoAgentWorkerInstance({
        claim: this.claim,
        leaseTtlMs: this.leaseTtlMs,
      }).catch((error) => {
        this.fatalError = error instanceof Error ? error : new Error(String(error));
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
      });
    }, heartbeatIntervalMs);
    this.timer.unref?.();
  }

  static async start(input: {
    poolKey?: string;
    processConcurrency: number;
    globalConcurrency: number;
    leaseTtlMs: number;
    heartbeatIntervalMs: number;
  }): Promise<MoAgentWorkerRegistrySession> {
    if (input.heartbeatIntervalMs >= input.leaseTtlMs) {
      throw new MoAgentWorkerRegistryError(
        'WORKER_REGISTRY_INVALID',
        'Worker instance heartbeat interval must be smaller than its lease TTL.',
      );
    }
    const claim = await registerMoAgentWorkerInstance(input);
    return new MoAgentWorkerRegistrySession(
      claim,
      input.leaseTtlMs,
      input.heartbeatIntervalMs,
    );
  }

  get leaseOwner(): string {
    return `worker-instance:${this.claim.id}`;
  }

  assertHealthy(): void {
    if (this.fatalError) throw this.fatalError;
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await stopMoAgentWorkerInstance(this.claim);
  }
}
