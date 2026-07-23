import { Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';

export type AgentWorkerRuntimeStatus = 'ok' | 'warning' | 'failed' | 'unavailable';

export interface AgentWorkerRuntimeDashboard {
  generatedAt: string;
  available: boolean;
  error: string | null;
  dispatchMode: string;
  poolKey: string;
  status: AgentWorkerRuntimeStatus;
  summary: {
    activeWorkers: number;
    staleWorkers: number;
    processCapacity: number;
    globalCapacity: number;
    heldSlots: number;
    availableSlots: number;
    expiredSlots: number;
    pendingJobs: number;
    retryWaitJobs: number;
    runningJobs: number;
    failedJobsLast24h: number;
    completedJobsLast24h: number;
    queuedActors: number;
    oldestQueueAgeSeconds: number | null;
    configurationConsistent: boolean;
  };
  workers: Array<{
    id: string;
    hostname: string;
    processId: number;
    processConcurrency: number;
    globalConcurrency: number;
    status: 'running' | 'stopped' | 'stale';
    startedAt: string;
    lastHeartbeatAt: string;
    leaseExpiresAt: string | null;
  }>;
  slots: Array<{
    slotNumber: number;
    status: 'free' | 'held' | 'expired';
    activeJobId: string | null;
    workerId: string | null;
    acquiredAt: string | null;
    lastHeartbeatAt: string | null;
    leaseExpiresAt: string | null;
  }>;
  alerts: Array<{
    id: string;
    severity: 'warning' | 'failed';
    summary: string;
  }>;
}

interface QueueAggregateRow {
  pendingJobs: bigint;
  retryWaitJobs: bigint;
  runningJobs: bigint;
  failedJobsLast24h: bigint;
  completedJobsLast24h: bigint;
  queuedActors: bigint;
  oldestQueuedAt: Date | null;
}

function integer(value: bigint | number | null | undefined): number {
  if (typeof value === 'bigint') return Number(value);
  return Number.isFinite(value) ? Number(value) : 0;
}

function dateIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function workerIdFromLeaseOwner(value: string | null): string | null {
  const prefix = 'worker-instance:';
  return value?.startsWith(prefix) ? value.slice(prefix.length) : null;
}

function unavailableDashboard(params: {
  poolKey: string;
  dispatchMode: string;
  generatedAt: string;
  error: unknown;
}): AgentWorkerRuntimeDashboard {
  return {
    generatedAt: params.generatedAt,
    available: false,
    error: params.error instanceof Error ? params.error.message : String(params.error),
    dispatchMode: params.dispatchMode,
    poolKey: params.poolKey,
    status: 'unavailable',
    summary: {
      activeWorkers: 0,
      staleWorkers: 0,
      processCapacity: 0,
      globalCapacity: 0,
      heldSlots: 0,
      availableSlots: 0,
      expiredSlots: 0,
      pendingJobs: 0,
      retryWaitJobs: 0,
      runningJobs: 0,
      failedJobsLast24h: 0,
      completedJobsLast24h: 0,
      queuedActors: 0,
      oldestQueueAgeSeconds: null,
      configurationConsistent: false,
    },
    workers: [],
    slots: [],
    alerts: [{
      id: 'worker-observability-unavailable',
      severity: 'failed',
      summary: '无法读取 Worker registry、全局槽位和 generation queue。',
    }],
  };
}

export async function getAgentWorkerRuntimeDashboard(params: {
  poolKey?: string;
  dispatchMode?: string;
} = {}): Promise<AgentWorkerRuntimeDashboard> {
  const poolKey = params.poolKey ?? 'generation.default';
  const dispatchMode = params.dispatchMode
    ?? process.env.MOAGENT_DISPATCH_MODE?.trim()
    ?? 'inline';
  const generatedAt = new Date().toISOString();
  try {
    const [clockRows, instances, slotRows, queueRows] = await Promise.all([
      prisma.$queryRaw<Array<{ databaseNow: Date }>>(Prisma.sql`
        SELECT clock_timestamp() AS "databaseNow"
      `),
      prisma.agentWorkerInstance.findMany({
        where: { poolKey },
        orderBy: [{ startedAt: 'desc' }],
        take: 50,
      }),
      prisma.agentWorkerSlot.findMany({
        where: { poolKey },
        orderBy: { slotNumber: 'asc' },
      }),
      prisma.$queryRaw<QueueAggregateRow[]>(Prisma.sql`
        SELECT
          COUNT(*) FILTER (WHERE "job"."status" = 'pending') AS "pendingJobs",
          COUNT(*) FILTER (WHERE "job"."status" = 'retry_wait') AS "retryWaitJobs",
          COUNT(*) FILTER (WHERE "job"."status" = 'running') AS "runningJobs",
          COUNT(*) FILTER (
            WHERE "job"."status" = 'failed'
              AND "job"."completed_at" >= clock_timestamp() - INTERVAL '24 hours'
          ) AS "failedJobsLast24h",
          COUNT(*) FILTER (
            WHERE "job"."status" = 'completed'
              AND "job"."completed_at" >= clock_timestamp() - INTERVAL '24 hours'
          ) AS "completedJobsLast24h",
          COUNT(DISTINCT "request"."actor_user_id") FILTER (
            WHERE "job"."status" IN ('pending', 'retry_wait')
          ) AS "queuedActors",
          MIN("job"."queued_at") FILTER (
            WHERE "job"."status" IN ('pending', 'retry_wait')
          ) AS "oldestQueuedAt"
        FROM "agent_generation_jobs" AS "job"
        JOIN "user_requests" AS "request"
          ON "request"."id" = "job"."request_id"
         AND "request"."project_id" = "job"."project_id"
      `),
    ]);
    const databaseNow = clockRows[0]?.databaseNow;
    if (!(databaseNow instanceof Date) || Number.isNaN(databaseNow.getTime())) {
      throw new Error('Database clock did not return a valid timestamp.');
    }
    const queue = queueRows[0] ?? {
      pendingJobs: 0n,
      retryWaitJobs: 0n,
      runningJobs: 0n,
      failedJobsLast24h: 0n,
      completedJobsLast24h: 0n,
      queuedActors: 0n,
      oldestQueuedAt: null,
    };
    const workers = instances.map((worker) => {
      const live = worker.status === 'running'
        && worker.leaseExpiresAt
        && worker.leaseExpiresAt > databaseNow;
      return {
        id: worker.id,
        hostname: worker.hostname,
        processId: worker.processId,
        processConcurrency: worker.processConcurrency,
        globalConcurrency: worker.globalConcurrency,
        status: (live ? 'running' : worker.status === 'stopped' ? 'stopped' : 'stale') as
          'running' | 'stopped' | 'stale',
        startedAt: worker.startedAt.toISOString(),
        lastHeartbeatAt: worker.lastHeartbeatAt.toISOString(),
        leaseExpiresAt: dateIso(worker.leaseExpiresAt),
      };
    });
    const activeWorkers = workers.filter((worker) => worker.status === 'running');
    const staleWorkers = workers.filter((worker) => worker.status === 'stale');
    const activeCapacities = new Set(
      activeWorkers.map((worker) => worker.globalConcurrency),
    );
    const configuredCapacity = activeWorkers[0]?.globalConcurrency
      ?? (
        Number.parseInt(process.env.MOAGENT_WORKER_GLOBAL_CONCURRENCY ?? '', 10)
        || slotRows.length
      );
    const slots = slotRows.map((slot) => {
      const expired = slot.status === 'held'
        && Boolean(slot.leaseExpiresAt && slot.leaseExpiresAt <= databaseNow);
      return {
        slotNumber: slot.slotNumber,
        status: (expired ? 'expired' : slot.status) as 'free' | 'held' | 'expired',
        activeJobId: slot.activeJobId,
        workerId: workerIdFromLeaseOwner(slot.leaseOwner),
        acquiredAt: dateIso(slot.acquiredAt),
        lastHeartbeatAt: dateIso(slot.lastHeartbeatAt),
        leaseExpiresAt: dateIso(slot.leaseExpiresAt),
      };
    });
    const heldSlots = slots.filter((slot) => slot.status === 'held').length;
    const expiredSlots = slots.filter((slot) => slot.status === 'expired').length;
    const pendingJobs = integer(queue.pendingJobs);
    const retryWaitJobs = integer(queue.retryWaitJobs);
    const runningJobs = integer(queue.runningJobs);
    const alerts: AgentWorkerRuntimeDashboard['alerts'] = [];
    if (dispatchMode === 'worker' && activeWorkers.length === 0) {
      alerts.push({
        id: 'worker-consumer-missing',
        severity: pendingJobs + retryWaitJobs > 0 ? 'failed' : 'warning',
        summary: pendingJobs + retryWaitJobs > 0
          ? 'generation queue 中存在待执行任务，但没有存活的 Worker。'
          : '当前使用 Worker 调度模式，但没有存活的 Worker 注册。',
      });
    }
    if (activeCapacities.size > 1) {
      alerts.push({
        id: 'worker-capacity-mismatch',
        severity: 'failed',
        summary: '存活 Worker 的全局容量配置不一致，新的 Worker 将被拒绝注册。',
      });
    }
    if (expiredSlots > 0) {
      alerts.push({
        id: 'worker-slot-expired',
        severity: 'warning',
        summary: `${expiredSlots} 个 Worker 槽位租约已过期，等待安全回收。`,
      });
    }
    if (runningJobs > heldSlots && dispatchMode === 'worker') {
      alerts.push({
        id: 'worker-job-slot-drift',
        severity: 'warning',
        summary: `${runningJobs} 个运行中 Job 仅对应 ${heldSlots} 个有效全局槽位。`,
      });
    }
    const status: AgentWorkerRuntimeStatus = alerts.some(
      (alert) => alert.severity === 'failed',
    )
      ? 'failed'
      : alerts.length > 0
        ? 'warning'
        : 'ok';
    return {
      generatedAt: databaseNow.toISOString(),
      available: true,
      error: null,
      dispatchMode,
      poolKey,
      status,
      summary: {
        activeWorkers: activeWorkers.length,
        staleWorkers: staleWorkers.length,
        processCapacity: activeWorkers.reduce(
          (total, worker) => total + worker.processConcurrency,
          0,
        ),
        globalCapacity: Math.max(0, configuredCapacity),
        heldSlots,
        availableSlots: Math.max(0, configuredCapacity - heldSlots),
        expiredSlots,
        pendingJobs,
        retryWaitJobs,
        runningJobs,
        failedJobsLast24h: integer(queue.failedJobsLast24h),
        completedJobsLast24h: integer(queue.completedJobsLast24h),
        queuedActors: integer(queue.queuedActors),
        oldestQueueAgeSeconds: queue.oldestQueuedAt
          ? Math.max(
              0,
              Math.floor((databaseNow.getTime() - queue.oldestQueuedAt.getTime()) / 1_000),
            )
          : null,
        configurationConsistent: activeCapacities.size <= 1,
      },
      workers,
      slots,
      alerts,
    };
  } catch (error) {
    return unavailableDashboard({
      poolKey,
      dispatchMode,
      generatedAt,
      error,
    });
  }
}
