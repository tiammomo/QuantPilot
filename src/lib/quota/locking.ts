import { Prisma } from '@prisma/client';

type AdvisoryLockTransaction = Pick<Prisma.TransactionClient, '$queryRaw'>;

export interface QuotaBucketLockIdentity {
  actorUserId: string;
  metric: string;
  windowStart: Date;
  windowEnd: Date;
}

/**
 * Stable lock identity shared by quota reservations, settlements, usage
 * recording, and allocation reconciliation. Changing this format without a
 * coordinated migration would split one logical counter across two locks.
 */
export function quotaBucketLockKey(input: QuotaBucketLockIdentity): string {
  return [
    input.actorUserId,
    input.metric,
    input.windowStart.toISOString(),
    input.windowEnd.toISOString(),
  ].join(':');
}

export async function acquireQuotaAdvisoryLock(
  transaction: AdvisoryLockTransaction,
  namespace: string,
  key: string,
): Promise<void> {
  await transaction.$queryRaw<Array<{ acquired: number }>>(Prisma.sql`
    SELECT 1::integer AS "acquired"
    FROM (
      SELECT pg_advisory_xact_lock(hashtextextended(${`${namespace}:${key}`}, 0))
    ) AS "quota_lock"
  `);
}

export async function tryAcquireQuotaAdvisoryLock(
  transaction: AdvisoryLockTransaction,
  namespace: string,
  key: string,
): Promise<boolean> {
  const rows = await transaction.$queryRaw<Array<{ acquired: boolean }>>(Prisma.sql`
    SELECT pg_try_advisory_xact_lock(
      hashtextextended(${`${namespace}:${key}`}, 0)
    ) AS "acquired"
  `);
  return rows[0]?.acquired === true;
}

export async function acquireQuotaBucketLock(
  transaction: AdvisoryLockTransaction,
  input: QuotaBucketLockIdentity,
): Promise<void> {
  await acquireQuotaAdvisoryLock(transaction, 'quota-bucket', quotaBucketLockKey(input));
}
