import { createHash } from 'node:crypto';

import { Prisma, type PrismaClient } from '@prisma/client';

import { prisma } from '@/lib/db/client';

const DEFAULT_LEASE_SECONDS = 6 * 60 * 60;
const DEFAULT_RETENTION_SECONDS = 7 * 24 * 60 * 60;
const MAX_RESPONSE_BYTES = 512 * 1024;

type IdempotencyClient = Pick<PrismaClient, '$transaction'>;
type IdempotencyTransaction = Prisma.TransactionClient;

export interface ApiOperationHandle {
  id: string;
  attempt: number;
  payloadHash: string;
}

export interface ApiOperationQuotaSettlement {
  reservationId: string;
  actorUserId: string;
  projectId?: string | null;
  metric: string;
  actualQuantity: bigint | number | string;
  sourceType: string;
  sourceId?: string | null;
  usageEventIdempotencyKey: string;
  occurredAt?: Date;
  metadata?: unknown;
  additionalUsage?: ApiOperationAdditionalUsage[];
}

export interface ApiOperationAdditionalUsage {
  actorUserId: string;
  projectId?: string | null;
  metric: string;
  quantity: bigint | number | string;
  idempotencyKey: string;
  sourceType: string;
  sourceId?: string | null;
  occurredAt?: Date;
  metadata?: unknown;
}

export type ApiOperationClaim =
  | { state: 'acquired'; handle: ApiOperationHandle }
  | {
      state: 'completed';
      handle: ApiOperationHandle;
      responseStatus: number;
      responseBody: Prisma.JsonValue | null;
      responseAvailable: boolean;
    }
  | { state: 'in_progress'; retryAfterSeconds: number };

export class ApiIdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_PAYLOAD_CONFLICT';
  readonly status = 409;

  constructor() {
    super('该幂等键已绑定到不同的请求参数，请为新请求使用新的幂等键。');
    this.name = 'ApiIdempotencyConflictError';
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalize(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('Idempotency payload cannot contain non-finite numbers.');
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => [key, canonicalize(record[key])]),
    );
  }
  throw new TypeError(`Unsupported idempotency payload value: ${typeof value}`);
}

function jsonDocument(value: unknown): { value: Prisma.InputJsonValue; bytes: number } {
  const serialized = JSON.stringify(canonicalize(value));
  if (serialized === undefined) throw new TypeError('Idempotency response must be JSON serializable.');
  return {
    value: JSON.parse(serialized) as Prisma.InputJsonValue,
    bytes: Buffer.byteLength(serialized, 'utf8'),
  };
}

function operationIdentity(scope: string, actorKey: string, idempotencyKey: string) {
  const normalizedScope = scope.trim();
  const normalizedActor = actorKey.trim();
  const normalizedKey = idempotencyKey.trim();
  if (!normalizedScope || normalizedScope.length > 120) throw new TypeError('Invalid idempotency scope.');
  if (!normalizedActor || normalizedActor.length > 160) throw new TypeError('Invalid idempotency actor key.');
  if (!normalizedKey || normalizedKey.length > 512) throw new TypeError('Invalid idempotency key.');
  return {
    scope: normalizedScope,
    actorKey: normalizedActor,
    idempotencyKeyHash: sha256(normalizedKey),
  };
}

async function lockIdentity(
  transaction: IdempotencyTransaction,
  identity: ReturnType<typeof operationIdentity>,
) {
  // PostgreSQL text values cannot contain NUL bytes. Unit Separator keeps the
  // lock domain unambiguous without producing an invalid UTF-8 text value.
  const lockKey = `${identity.scope}\u001f${identity.actorKey}\u001f${identity.idempotencyKeyHash}`;
  await transaction.$queryRaw<Array<{ acquired: number }>>(Prisma.sql`
    SELECT 1::integer AS "acquired"
    FROM (
      SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
    ) AS "api_operation_lock"
  `);
}

export async function claimApiOperation(input: {
  scope: string;
  actorKey: string;
  idempotencyKey: string;
  payload: unknown;
  leaseSeconds?: number;
  retentionSeconds?: number;
  now?: Date;
  client?: IdempotencyClient;
}): Promise<ApiOperationClaim> {
  const client = input.client ?? prisma;
  const now = input.now ?? new Date();
  const leaseSeconds = Math.max(60, Math.min(24 * 60 * 60, input.leaseSeconds ?? DEFAULT_LEASE_SECONDS));
  const retentionSeconds = Math.max(
    60 * 60,
    Math.min(30 * 24 * 60 * 60, input.retentionSeconds ?? DEFAULT_RETENTION_SECONDS),
  );
  const identity = operationIdentity(input.scope, input.actorKey, input.idempotencyKey);
  const payloadHash = sha256(JSON.stringify(canonicalize(input.payload)));
  const leaseExpiresAt = new Date(now.getTime() + leaseSeconds * 1_000);
  const retentionExpiresAt = new Date(now.getTime() + retentionSeconds * 1_000);

  return client.$transaction(async (transaction) => {
    await lockIdentity(transaction, identity);
    const existing = await transaction.apiIdempotencyOperation.findUnique({
      where: { scope_actorKey_idempotencyKeyHash: identity },
    });
    if (!existing) {
      const created = await transaction.apiIdempotencyOperation.create({
        data: {
          ...identity,
          payloadHash,
          leaseExpiresAt,
          retentionExpiresAt,
        },
      });
      return {
        state: 'acquired' as const,
        handle: { id: created.id, attempt: created.attempt, payloadHash },
      };
    }
    if (existing.payloadHash !== payloadHash) throw new ApiIdempotencyConflictError();

    const handle = { id: existing.id, attempt: existing.attempt, payloadHash };
    const pendingQuotaAccounting =
      existing.status === 'completed' &&
      existing.quotaSettlement !== null &&
      existing.quotaAccountedAt === null;
    if (
      existing.status === 'completed' &&
      (existing.retentionExpiresAt > now || pendingQuotaAccounting)
    ) {
      return {
        state: 'completed' as const,
        handle,
        responseStatus: existing.responseStatus ?? 200,
        responseBody: existing.responseBody,
        responseAvailable: existing.responseBody !== null,
      };
    }
    if (existing.status === 'running' && existing.leaseExpiresAt > now) {
      return {
        state: 'in_progress' as const,
        retryAfterSeconds: Math.max(1, Math.ceil((existing.leaseExpiresAt.getTime() - now.getTime()) / 1_000)),
      };
    }

    const updated = await transaction.apiIdempotencyOperation.update({
      where: { id: existing.id },
      data: {
        status: 'running',
        attempt: { increment: 1 },
        leaseExpiresAt,
        retentionExpiresAt,
        responseStatus: null,
        responseBody: Prisma.DbNull,
        responseBytes: null,
        quotaReservationId: null,
        quotaSettlement: Prisma.DbNull,
        quotaAccountedAt: null,
        errorCode: null,
        errorMessage: null,
        completedAt: null,
      },
    });
    return {
      state: 'acquired' as const,
      handle: { id: updated.id, attempt: updated.attempt, payloadHash },
    };
  });
}

export async function completeApiOperation(input: {
  handle: ApiOperationHandle;
  responseStatus: number;
  responseBody: unknown;
  cacheResponse?: boolean;
  quotaSettlement?: ApiOperationQuotaSettlement;
  retentionSeconds?: number;
  now?: Date;
  client?: IdempotencyClient;
}): Promise<{ responseAvailable: boolean; responseBytes: number }> {
  const client = input.client ?? prisma;
  const now = input.now ?? new Date();
  const retentionSeconds = Math.max(
    60 * 60,
    Math.min(30 * 24 * 60 * 60, input.retentionSeconds ?? DEFAULT_RETENTION_SECONDS),
  );
  const response = jsonDocument(input.responseBody);
  const responseAvailable = input.cacheResponse !== false && response.bytes <= MAX_RESPONSE_BYTES;
  const quotaSettlement = input.quotaSettlement
    ? jsonDocument({
        ...input.quotaSettlement,
        actualQuantity: String(input.quotaSettlement.actualQuantity),
        occurredAt: input.quotaSettlement.occurredAt?.toISOString(),
        additionalUsage: input.quotaSettlement.additionalUsage?.map((usage) => ({
          ...usage,
          quantity: String(usage.quantity),
          occurredAt: usage.occurredAt?.toISOString(),
        })),
      }).value
    : null;
  const updated = await client.$transaction((transaction) =>
    transaction.apiIdempotencyOperation.updateMany({
      where: {
        id: input.handle.id,
        attempt: input.handle.attempt,
        payloadHash: input.handle.payloadHash,
        status: 'running',
      },
      data: {
        status: 'completed',
        responseStatus: input.responseStatus,
        responseBody: responseAvailable ? response.value : Prisma.DbNull,
        responseBytes: response.bytes,
        quotaReservationId: input.quotaSettlement?.reservationId ?? null,
        quotaSettlement: quotaSettlement ?? Prisma.DbNull,
        quotaAccountedAt: null,
        completedAt: now,
        leaseExpiresAt: now,
        retentionExpiresAt: new Date(now.getTime() + retentionSeconds * 1_000),
        errorCode: null,
        errorMessage: null,
      },
    }),
  );
  if (updated.count !== 1) throw new Error('API idempotency claim was lost before completion.');
  return { responseAvailable, responseBytes: response.bytes };
}

export async function markApiOperationQuotaAccounted(input: {
  handle: ApiOperationHandle;
  reservationId: string;
  now?: Date;
  client?: IdempotencyClient;
}): Promise<boolean> {
  const client = input.client ?? prisma;
  const updated = await client.$transaction((transaction) =>
    transaction.apiIdempotencyOperation.updateMany({
      where: {
        id: input.handle.id,
        attempt: input.handle.attempt,
        payloadHash: input.handle.payloadHash,
        status: 'completed',
        quotaReservationId: input.reservationId,
        quotaAccountedAt: null,
      },
      data: { quotaAccountedAt: input.now ?? new Date() },
    }),
  );
  return updated.count === 1;
}

export async function failApiOperation(input: {
  handle: ApiOperationHandle;
  error: unknown;
  now?: Date;
  client?: IdempotencyClient;
}): Promise<boolean> {
  const client = input.client ?? prisma;
  const now = input.now ?? new Date();
  const errorCode =
    input.error && typeof input.error === 'object' && 'code' in input.error && typeof input.error.code === 'string'
      ? input.error.code.slice(0, 120)
      : null;
  const errorMessage = (input.error instanceof Error ? input.error.message : String(input.error)).slice(0, 500);
  const updated = await client.$transaction((transaction) =>
    transaction.apiIdempotencyOperation.updateMany({
      where: {
        id: input.handle.id,
        attempt: input.handle.attempt,
        payloadHash: input.handle.payloadHash,
        status: 'running',
      },
      data: {
        status: 'failed',
        leaseExpiresAt: now,
        errorCode,
        errorMessage,
      },
    }),
  );
  return updated.count === 1;
}

export async function cleanupExpiredApiOperations(input: {
  now?: Date;
  client?: Pick<PrismaClient, 'apiIdempotencyOperation'>;
} = {}): Promise<number> {
  const deleted = await (input.client ?? prisma).apiIdempotencyOperation.deleteMany({
    where: {
      OR: [
        {
          retentionExpiresAt: { lte: input.now ?? new Date() },
          status: 'failed',
        },
        {
          retentionExpiresAt: { lte: input.now ?? new Date() },
          status: 'completed',
          OR: [
            { quotaAccountedAt: { not: null } },
            { quotaSettlement: { equals: Prisma.DbNull } },
          ],
        },
        {
          retentionExpiresAt: { lte: input.now ?? new Date() },
          leaseExpiresAt: { lte: input.now ?? new Date() },
          status: 'running',
        },
      ],
    },
  });
  return deleted.count;
}

export function isExplicitIdempotencyKey(value: string | null | undefined): value is string {
  return Boolean(value?.trim());
}

export function normalizeIdempotencyKey(value: string): string {
  const candidate = value.trim();
  // Prefix both representations so a caller cannot choose a literal
  // `sha256:<digest>` key that aliases another caller's normalized long key.
  if (/^[A-Za-z0-9._:-]{1,120}$/.test(candidate)) return `raw:${candidate}`;
  return `sha256:${sha256(candidate)}`;
}
