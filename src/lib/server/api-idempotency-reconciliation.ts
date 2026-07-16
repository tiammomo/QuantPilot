import { Prisma, type PrismaClient } from '@prisma/client';

import { createQuotaService } from '@/lib/quota/service';

function jsonRecord(value: Prisma.JsonValue | null): Record<string, Prisma.JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, Prisma.JsonValue>
    : {};
}

function requiredString(record: Record<string, Prisma.JsonValue>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || !value) {
    throw new Error(`Invalid API operation settlement field: ${key}`);
  }
  return value;
}

export async function reconcileApiOperationQuotaSettlements(input: {
  client: PrismaClient;
  now?: Date;
  batchSize?: number;
  onError?: (operationId: string, error: unknown) => void;
  quotaService?: Pick<ReturnType<typeof createQuotaService>, 'settle' | 'recordUsage'>;
}): Promise<{ scanned: number; reconciled: number; failed: number }> {
  const now = input.now ?? new Date();
  const quota = input.quotaService ?? createQuotaService(input.client);
  const operations = await input.client.apiIdempotencyOperation.findMany({
    where: {
      status: 'completed',
      quotaAccountedAt: null,
      quotaSettlement: { not: Prisma.DbNull },
    },
    orderBy: { completedAt: 'asc' },
    take: Math.max(1, Math.min(1_000, input.batchSize ?? 1_000)),
  });
  let reconciled = 0;
  let failed = 0;
  for (const operation of operations) {
    try {
      const plan = jsonRecord(operation.quotaSettlement);
      const reservationId = requiredString(plan, 'reservationId');
      const reservation = await input.client.quotaReservation.findUnique({
        where: { id: reservationId },
      });
      const actorUserId = requiredString(plan, 'actorUserId');
      const metric = requiredString(plan, 'metric');
      const projectId = typeof plan.projectId === 'string' ? plan.projectId : null;
      if (operation.actorKey !== actorUserId) {
        throw new Error('API operation actor does not match its quota settlement plan.');
      }
      if (
        reservation &&
        (
          reservation.actorUserId !== actorUserId ||
          reservation.metric !== metric ||
          reservation.projectId !== projectId
        )
      ) {
        throw new Error('Quota reservation identity does not match the persisted settlement plan.');
      }
      const quantity = BigInt(requiredString(plan, 'actualQuantity'));
      if (quantity < 0n) throw new Error('API operation settlement quantity cannot be negative.');
      const sourceType = requiredString(plan, 'sourceType');
      const usageEventIdempotencyKey = requiredString(plan, 'usageEventIdempotencyKey');
      const sourceId = typeof plan.sourceId === 'string' ? plan.sourceId : null;
      const occurredAt = typeof plan.occurredAt === 'string'
        ? new Date(plan.occurredAt)
        : operation.completedAt ?? operation.createdAt;
      const metadata = plan.metadata === undefined
        ? undefined
        : plan.metadata as Prisma.InputJsonValue;

      if (reservation?.status === 'active' && reservation.expiresAt > now) {
        await quota.settle({
          reservationId,
          actualQuantity: quantity,
          sourceType,
          sourceId,
          usageEventIdempotencyKey,
          occurredAt,
          metadata,
        });
      } else if (reservation?.status !== 'settled') {
        // The lease may expire before a repair worker runs. The completed
        // business operation remains billable, so append the same idempotent
        // usage event without reviving its reservation.
        await quota.recordUsage({
          actorUserId,
          projectId,
          metric,
          quantity,
          idempotencyKey: usageEventIdempotencyKey,
          sourceType,
          sourceId,
          occurredAt,
          metadata,
        });
      }

      const additionalUsage = Array.isArray(plan.additionalUsage) ? plan.additionalUsage : [];
      for (const rawUsage of additionalUsage) {
        const usage = jsonRecord(rawUsage);
        const usageActorUserId = requiredString(usage, 'actorUserId');
        if (usageActorUserId !== operation.actorKey) {
          throw new Error('Additional usage actor does not match the API operation actor.');
        }
        const usageQuantity = BigInt(requiredString(usage, 'quantity'));
        if (usageQuantity < 0n) throw new Error('Additional usage quantity cannot be negative.');
        const usageOccurredAt = typeof usage.occurredAt === 'string'
          ? new Date(usage.occurredAt)
          : occurredAt;
        await quota.recordUsage({
          actorUserId: usageActorUserId,
          projectId: typeof usage.projectId === 'string' ? usage.projectId : null,
          metric: requiredString(usage, 'metric'),
          quantity: usageQuantity,
          idempotencyKey: requiredString(usage, 'idempotencyKey'),
          sourceType: requiredString(usage, 'sourceType'),
          sourceId: typeof usage.sourceId === 'string' ? usage.sourceId : null,
          occurredAt: usageOccurredAt,
          metadata: usage.metadata === undefined
            ? undefined
            : usage.metadata as Prisma.InputJsonValue,
        });
      }
      const updated = await input.client.apiIdempotencyOperation.updateMany({
        where: { id: operation.id, quotaAccountedAt: null },
        data: { quotaAccountedAt: now },
      });
      reconciled += updated.count;
    } catch (error) {
      failed += 1;
      input.onError?.(operation.id, error);
    }
  }
  return { scanned: operations.length, reconciled, failed };
}
