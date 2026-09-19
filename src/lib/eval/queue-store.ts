import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { prisma } from '@/lib/db/client';
import { mapDbQueueItem } from './runtime-mappers';
import type { QuantEvalQueueItem } from './types';

export const EVAL_LEASE_MS = 60_000;
export interface EvalQueueClaim {
  item: QuantEvalQueueItem;
  leaseToken: string;
  attemptCount: number;
}

export function queueCreateData(item: QuantEvalQueueItem): Prisma.EvalQueueItemCreateInput {
  return {
    ...item,
    selectedCases: item.selectedCases,
    createdAt: new Date(item.createdAt),
    startedAt: item.startedAt ? new Date(item.startedAt) : null,
    finishedAt: item.finishedAt ? new Date(item.finishedAt) : null,
  };
}

async function databaseNow(tx: Prisma.TransactionClient): Promise<Date> {
  const [row] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  return row.now;
}

/** PostgreSQL owns queue state. Files are report artifacts, never queue replicas. */
export function createEvalQueueStore(client: PrismaClient) {
  return {
    async list(): Promise<QuantEvalQueueItem[]> {
      const rows = await client.evalQueueItem.findMany({ orderBy: { createdAt: 'desc' }, take: 80 });
      return rows.map(mapDbQueueItem);
    },
    async enqueue(item: QuantEvalQueueItem): Promise<QuantEvalQueueItem> {
      return mapDbQueueItem(await client.evalQueueItem.create({ data: queueCreateData(item) }));
    },
    async claim(): Promise<EvalQueueClaim | null> {
      return client.$transaction(async (tx) => {
        // Preserve the existing global limit of one benchmark, across processes.
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('quantpilot:eval-queue'))::text`;
        const now = await databaseNow(tx);
        await tx.evalQueueItem.updateMany({
          where: { status: 'running', OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] },
          data: {
            status: 'failed', finishedAt: now, pid: null, leaseToken: null, leaseExpiresAt: null,
            error: '评测 Worker 租约已失效；请检查日志后重新发起任务。',
          },
        });
        const active = await tx.evalQueueItem.findFirst({
          // Cancellation keeps capacity until the owning process has stopped.
          where: { leaseExpiresAt: { gt: now } }, select: { id: true },
        });
        if (active) return null;
        const next = await tx.evalQueueItem.findFirst({
          where: { status: 'queued' }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        });
        if (!next) return null;
        const leaseToken = randomUUID();
        const updated = await tx.evalQueueItem.updateMany({
          where: { id: next.id, status: 'queued' },
          data: {
            status: 'running', startedAt: now, finishedAt: null, error: null,
            leaseToken, leaseExpiresAt: new Date(now.getTime() + EVAL_LEASE_MS),
            attemptCount: { increment: 1 },
          },
        });
        if (!updated.count) return null; // A cancellation can win the claim race.
        return {
          item: mapDbQueueItem({ ...next, status: 'running', startedAt: now }),
          leaseToken, attemptCount: next.attemptCount + 1,
        };
      });
    },
    async heartbeat(claim: EvalQueueClaim): Promise<boolean> {
      const count = await client.$executeRaw`
        UPDATE eval_queue_items
        SET lease_expires_at = clock_timestamp() + interval '60 seconds', updated_at = clock_timestamp()
        WHERE id = ${claim.item.id} AND lease_token = ${claim.leaseToken}
          AND status = 'running' AND lease_expires_at > clock_timestamp()`;
      return count === 1;
    },
    async recordProcess(claim: EvalQueueClaim, pid: number | null, logPath: string): Promise<boolean> {
      const count = await client.$executeRaw`
        UPDATE eval_queue_items SET pid = ${pid}, log_path = ${logPath}, updated_at = clock_timestamp()
        WHERE id = ${claim.item.id} AND lease_token = ${claim.leaseToken}
          AND status = 'running' AND lease_expires_at > clock_timestamp()`;
      return count === 1;
    },
    async finish(claim: EvalQueueClaim, result: {
      status: 'passed' | 'failed'; exitCode: number | null; error: string | null;
      reportId?: string | null; reportPath?: string | null;
    }): Promise<boolean> {
      const count = await client.$executeRaw`
        UPDATE eval_queue_items
        SET status = ${result.status}, exit_code = ${result.exitCode}, error = ${result.error},
            report_id = ${result.reportId ?? null}, report_path = ${result.reportPath ?? null},
            finished_at = clock_timestamp(), updated_at = clock_timestamp(), pid = NULL,
            lease_token = NULL, lease_expires_at = NULL
        WHERE id = ${claim.item.id} AND lease_token = ${claim.leaseToken}
          AND status = 'running' AND lease_expires_at > clock_timestamp()`;
      return count === 1;
    },
    async releaseCancelled(claim: EvalQueueClaim): Promise<void> {
      await client.evalQueueItem.updateMany({
        where: { id: claim.item.id, leaseToken: claim.leaseToken, status: 'cancelled' },
        data: { leaseToken: null, leaseExpiresAt: null, pid: null },
      });
    },
    async cancel(id: string): Promise<QuantEvalQueueItem> {
      await client.evalQueueItem.updateMany({
        where: { id, status: { in: ['queued', 'running'] } },
        data: { status: 'cancelled', finishedAt: new Date(), error: '用户取消评测任务。' },
      });
      const item = await client.evalQueueItem.findUnique({ where: { id } });
      if (!item) throw new Error('未找到评测队列任务。');
      return mapDbQueueItem(item);
    },
    async withScheduleLock<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
      return client.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext('quantpilot:eval-schedule'))::text`;
        return work(tx);
      });
    },
  };
}

export const evalQueueStore = createEvalQueueStore(prisma);
