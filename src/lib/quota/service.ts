import {
  Prisma,
  type PrismaClient,
  type QuotaReservation,
  type UsageBucket,
  type UsageEvent,
} from "@prisma/client";
import { randomUUID } from "node:crypto";

import { isPlatformAdmin } from "@/lib/auth/authorization";
import { prisma } from "@/lib/db/client";

import { getBuiltinQuotaRule } from "./defaults";
import {
  acquireQuotaAdvisoryLock,
  acquireQuotaBucketLock,
  tryAcquireQuotaAdvisoryLock,
} from "./locking";
import {
  assertQuotaMetric,
  evaluateQuotaAttempt,
  quotaEnforcement,
  quotaQuantity,
  quotaSignedQuantity,
} from "./policy";
import type {
  QuotaCounterSnapshot,
  QuotaReservationView,
  QuotaReserveResult,
  QuotaWindowType,
  RecordUsageInput,
  ReleaseQuotaInput,
  RenewQuotaInput,
  ReserveQuotaInput,
  ResolvedQuotaPolicy,
  SettleQuotaInput,
  UsageSettlementResult,
} from "./types";
import { QUOTA_WINDOW_TYPES } from "./types";
import { calculateQuotaWindow } from "./window";

type QuotaClient = Pick<PrismaClient, "$transaction" | "quotaReservation">;
type QuotaTransaction = Prisma.TransactionClient;
type BucketCounters = Pick<UsageBucket, "used" | "reserved">;
type DeferredQuotaFailure = { deferredQuotaError: QuotaError };

const DEFAULT_RESERVATION_TTL_SECONDS = 900;
const DEFAULT_WINDOW_TYPE: QuotaWindowType = "month";

export class QuotaError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: 409 | 429 | 500 = 500,
  ) {
    super(message);
    this.name = "QuotaError";
  }
}

export class QuotaExceededError extends QuotaError {
  constructor(public readonly decision: QuotaReserveResult) {
    super(
      "QUOTA_EXCEEDED",
      "The requested operation exceeds the available quota.",
      429,
    );
    this.name = "QuotaExceededError";
  }

  get resetAt(): Date {
    return this.decision.window.end;
  }
}

export class QuotaIdempotencyConflictError extends QuotaError {
  constructor(
    message = "The idempotency key was already used for a different quota operation.",
  ) {
    super("QUOTA_IDEMPOTENCY_CONFLICT", message, 409);
    this.name = "QuotaIdempotencyConflictError";
  }
}

function deferredQuotaFailure(error: QuotaError): DeferredQuotaFailure {
  return { deferredQuotaError: error };
}

function isDeferredQuotaFailure(value: unknown): value is DeferredQuotaFailure {
  return Boolean(
    value && typeof value === "object" && "deferredQuotaError" in value,
  );
}

function quotaWindowType(value: string): QuotaWindowType {
  if ((QUOTA_WINDOW_TYPES as readonly string[]).includes(value)) {
    return value as QuotaWindowType;
  }
  throw new QuotaError(
    "INVALID_QUOTA_POLICY",
    `Unsupported quota window type: ${value}`,
  );
}

function assertIdentifier(value: string, label: string, maximum: number): void {
  if (!value || value.length > maximum) {
    throw new TypeError(
      `${label} must contain between 1 and ${maximum} characters.`,
    );
  }
}

function normalizedProjectId(value: string | null | undefined): string | null {
  return value || null;
}

function remaining(
  limit: bigint | null,
  used: bigint,
  reserved: bigint,
): bigint | null {
  if (limit === null) return null;
  const available = limit - used - reserved;
  return available > 0n ? available : 0n;
}

async function lockReservation(
  tx: QuotaTransaction,
  selector: { id?: string; idempotencyKey?: string },
): Promise<QuotaReservation | null> {
  if (!selector.id && !selector.idempotencyKey) {
    throw new TypeError(
      "A reservation id or reservation idempotency key is required.",
    );
  }
  const preview = await tx.quotaReservation.findUnique({
    where: selector.id
      ? { id: selector.id }
      : { idempotencyKey: selector.idempotencyKey! },
    include: { bucket: true },
  });
  if (!preview) return null;
  await acquireQuotaBucketLock(tx, {
    actorUserId: preview.actorUserId,
    metric: preview.metric,
    windowStart: preview.bucket.windowStart,
    windowEnd: preview.bucket.windowEnd,
  });
  await tx.$queryRaw`
    SELECT "id" FROM "quota_reservations" WHERE "id" = ${preview.id} FOR UPDATE
  `;
  return tx.quotaReservation.findUnique({ where: { id: preview.id } });
}

export async function resolveQuotaPolicyInTransaction(
  tx: QuotaTransaction,
  actorUserId: string,
  metric: string,
  now: Date,
): Promise<ResolvedQuotaPolicy> {
  const user = await tx.authUser.findUnique({
    where: { id: actorUserId },
    select: {
      id: true,
      role: true,
      quotaProfileId: true,
      quotaProfile: {
        select: {
          rules: { where: { metric }, take: 1 },
        },
      },
      quotaOverrides: {
        where: {
          metric,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        take: 1,
      },
    },
  });
  if (!user)
    throw new QuotaError(
      "QUOTA_ACTOR_NOT_FOUND",
      "Quota actor does not exist.",
      409,
    );

  const override = user.quotaOverrides[0];
  let rule = user.quotaProfile?.rules[0];
  if (!rule) {
    const defaultProfile = await tx.quotaProfile.findFirst({
      where: { isDefault: true },
      select: { rules: { where: { metric }, take: 1 } },
    });
    rule = defaultProfile?.rules[0];
  }

  const builtinRule = getBuiltinQuotaRule(metric);
  const base = override ?? rule ?? builtinRule;
  const windowType = base
    ? quotaWindowType(base.windowType)
    : DEFAULT_WINDOW_TYPE;
  const windowSeconds = base?.windowSeconds ?? null;
  const reservationTtlSeconds =
    base?.reservationTtlSeconds ?? DEFAULT_RESERVATION_TTL_SECONDS;

  if (isPlatformAdmin(user)) {
    return {
      actorUserId,
      metric,
      source: "administrator",
      unlimited: true,
      limit: null,
      enforcement: "observe",
      windowType,
      windowSeconds,
      reservationTtlSeconds,
      enforcementExempt: true,
    };
  }

  if (override) {
    if (!override.isUnlimited && override.limit === null) {
      throw new QuotaError(
        "INVALID_QUOTA_POLICY",
        "A metered quota override has no limit.",
      );
    }
    return {
      actorUserId,
      metric,
      source: "user-override",
      unlimited: override.isUnlimited,
      limit: override.isUnlimited ? null : override.limit,
      enforcement: quotaEnforcement(override.enforcement),
      windowType,
      windowSeconds,
      reservationTtlSeconds,
      enforcementExempt: override.isUnlimited,
    };
  }

  if (rule) {
    return {
      actorUserId,
      metric,
      source: "profile",
      unlimited: false,
      limit: rule.limit,
      enforcement: quotaEnforcement(rule.enforcement),
      windowType,
      windowSeconds,
      reservationTtlSeconds,
      enforcementExempt: false,
    };
  }

  if (builtinRule) {
    return {
      actorUserId,
      metric,
      source: "builtin-default",
      unlimited: false,
      limit: builtinRule.limit,
      enforcement: builtinRule.enforcement,
      windowType: builtinRule.windowType,
      windowSeconds: builtinRule.windowSeconds,
      reservationTtlSeconds: builtinRule.reservationTtlSeconds,
      enforcementExempt: false,
    };
  }

  // An unconfigured metric remains observable and available. Known hard limits
  // are seeded in the default profile; this fallback keeps new metrics from
  // causing a platform outage while still writing their actual usage.
  return {
    actorUserId,
    metric,
    source: "unconfigured",
    unlimited: true,
    limit: null,
    enforcement: "observe",
    windowType,
    windowSeconds,
    reservationTtlSeconds,
    enforcementExempt: true,
  };
}

export async function assertStructuralQuotaCapacity(
  tx: QuotaTransaction,
  input: {
    actorUserId: string;
    metric: string;
    current: bigint | number;
    requested?: bigint | number;
    now?: Date;
  },
): Promise<ResolvedQuotaPolicy> {
  const now = input.now ?? new Date();
  const current = typeof input.current === 'bigint'
    ? input.current
    : BigInt(input.current);
  const requested = input.requested === undefined
    ? 1n
    : typeof input.requested === 'bigint'
      ? input.requested
      : BigInt(input.requested);
  const policy = await resolveQuotaPolicyInTransaction(
    tx,
    input.actorUserId,
    input.metric,
    now,
  );
  const decision = evaluateQuotaAttempt(policy, 0n, current, requested);
  if (!decision.allowed) {
    throw new QuotaExceededError({
      allowed: false,
      mode: 'metered',
      policy,
      counter: decision.counter,
      window: calculateQuotaWindow(
        policy.windowType,
        now,
        policy.windowSeconds,
      ),
      reservation: null,
    });
  }
  return policy;
}

async function getOrCreateBucket(
  tx: QuotaTransaction,
  actorUserId: string,
  metric: string,
  window: { start: Date; end: Date },
): Promise<UsageBucket> {
  const rows = await tx.$queryRaw<UsageBucket[]>`
    INSERT INTO "usage_buckets" (
      "id", "actor_user_id", "metric", "window_start", "window_end",
      "used", "reserved", "version", "created_at", "updated_at"
    ) VALUES (
      ${randomUUID()}, ${actorUserId}, ${metric}, ${window.start}, ${window.end},
      0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
    ON CONFLICT ("actor_user_id", "metric", "window_start", "window_end")
    DO UPDATE SET "metric" = EXCLUDED."metric"
    RETURNING
      "id",
      "actor_user_id" AS "actorUserId",
      "metric",
      "window_start" AS "windowStart",
      "window_end" AS "windowEnd",
      "used",
      "reserved",
      "version",
      "created_at" AS "createdAt",
      "updated_at" AS "updatedAt"
  `;
  if (rows.length !== 1) {
    throw new QuotaError(
      "QUOTA_BUCKET_NOT_CREATED",
      "Quota usage bucket could not be created.",
    );
  }
  return rows[0];
}

async function reclaimExpiredReservations(
  tx: QuotaTransaction,
  bucketId: string,
  now: Date,
): Promise<BucketCounters> {
  const updated = await tx.$queryRaw<BucketCounters[]>`
    WITH expired AS (
      UPDATE "quota_reservations"
      SET
        "status" = 'expired',
        "released_at" = ${now},
        "updated_at" = ${now}
      WHERE "bucket_id" = ${bucketId}
        AND "status" = 'active'
        AND "expires_at" <= ${now}
      RETURNING "reserved_quantity"
    ), released AS (
      SELECT COALESCE(SUM("reserved_quantity"), 0)::bigint AS "quantity"
      FROM expired
    )
    UPDATE "usage_buckets"
    SET
      "reserved" = GREATEST(0::bigint, "reserved" - released."quantity"),
      "version" = "version" + 1,
      "updated_at" = ${now}
    FROM released
    WHERE "usage_buckets"."id" = ${bucketId}
      AND released."quantity" > 0
    RETURNING "usage_buckets"."used", "usage_buckets"."reserved"
  `;
  if (updated[0]) return updated[0];
  return tx.usageBucket.findUniqueOrThrow({
    where: { id: bucketId },
    select: { used: true, reserved: true },
  });
}

function policyFromReservation(row: QuotaReservation): ResolvedQuotaPolicy {
  return {
    actorUserId: row.actorUserId,
    metric: row.metric,
    source: row.enforcementExempt ? "administrator" : "profile",
    unlimited: row.policyLimit === null,
    limit: row.policyLimit,
    enforcement: quotaEnforcement(row.policyEnforcement),
    windowType: quotaWindowType(row.policyWindowType),
    windowSeconds: null,
    reservationTtlSeconds: Math.max(
      1,
      Math.ceil((row.expiresAt.getTime() - row.createdAt.getTime()) / 1_000),
    ),
    enforcementExempt: row.enforcementExempt,
  };
}

function assertSameReservation(
  row: QuotaReservation,
  input: ReserveQuotaInput,
  quantity: bigint,
): void {
  if (
    row.actorUserId !== input.actorUserId ||
    row.metric !== input.metric ||
    row.projectId !== normalizedProjectId(input.projectId) ||
    row.reservedQuantity !== quantity
  ) {
    throw new QuotaIdempotencyConflictError();
  }
}

function reservationView(
  row: QuotaReservation,
  bucket: Pick<UsageBucket, "used" | "reserved" | "windowStart" | "windowEnd">,
  idempotent: boolean,
): QuotaReservationView {
  const limit = row.policyLimit;
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    actorUserId: row.actorUserId,
    projectId: row.projectId,
    metric: row.metric,
    status: row.status as QuotaReservationView["status"],
    committedQuantity: row.committedQuantity,
    enforcement: quotaEnforcement(row.policyEnforcement),
    enforcementExempt: row.enforcementExempt,
    used: bucket.used,
    reserved: bucket.reserved,
    requested: row.reservedQuantity,
    limit,
    remaining: remaining(limit, bucket.used, bucket.reserved),
    exceeded: limit !== null && bucket.used + bucket.reserved > limit,
    windowStart: bucket.windowStart,
    windowEnd: bucket.windowEnd,
    expiresAt: row.expiresAt,
    idempotent,
  };
}

async function tryReserveWithClient(
  client: QuotaClient,
  input: ReserveQuotaInput,
): Promise<QuotaReserveResult> {
  assertIdentifier(input.actorUserId, "actorUserId", 191);
  assertIdentifier(input.idempotencyKey, "idempotencyKey", 240);
  assertQuotaMetric(input.metric);
  const quantity = quotaQuantity(input.quantity);
  const now = input.now ?? new Date();

  const outcome: QuotaReserveResult | DeferredQuotaFailure =
    await client.$transaction(
      async (tx): Promise<QuotaReserveResult | DeferredQuotaFailure> => {
        await acquireQuotaAdvisoryLock(
          tx,
          "quota-reserve",
          input.idempotencyKey,
        );
        const existing = await tx.quotaReservation.findUnique({
          where: { idempotencyKey: input.idempotencyKey },
          include: { bucket: true },
        });
        if (existing) {
          assertSameReservation(existing, input, quantity);
          if (existing.status === "active" && existing.expiresAt <= now) {
            await acquireQuotaBucketLock(tx, {
              actorUserId: existing.actorUserId,
              metric: existing.metric,
              windowStart: existing.bucket.windowStart,
              windowEnd: existing.bucket.windowEnd,
            });
            await reclaimExpiredReservations(tx, existing.bucketId, now);
            return deferredQuotaFailure(
              new QuotaError(
                "QUOTA_RESERVATION_EXPIRED",
                "The idempotent quota reservation expired; use a new operation key.",
                409,
              ),
            );
          }
          if (existing.status === "released" || existing.status === "expired") {
            throw new QuotaIdempotencyConflictError(
              "The idempotency key belongs to a finalized quota reservation.",
            );
          }
          const policy = policyFromReservation(existing);
          const view = reservationView(existing, existing.bucket, true);
          return {
            allowed: true,
            mode: policy.unlimited ? "unlimited" : "metered",
            policy,
            counter: {
              used: view.used,
              reserved: view.reserved,
              requested: view.requested,
              limit: view.limit,
              remaining: view.remaining,
              exceeded: view.exceeded,
            },
            window: { start: view.windowStart, end: view.windowEnd },
            reservation: view,
          };
        }

        const policy = await resolveQuotaPolicyInTransaction(
          tx,
          input.actorUserId,
          input.metric,
          now,
        );
        const window = calculateQuotaWindow(
          policy.windowType,
          now,
          policy.windowSeconds,
        );
        await acquireQuotaBucketLock(tx, {
          actorUserId: input.actorUserId,
          metric: input.metric,
          windowStart: window.start,
          windowEnd: window.end,
        });
        const bucket = await getOrCreateBucket(
          tx,
          input.actorUserId,
          input.metric,
          window,
        );
        const current = await reclaimExpiredReservations(tx, bucket.id, now);
        const preflight = evaluateQuotaAttempt(
          policy,
          current.used,
          current.reserved,
          quantity,
        );
        if (!preflight.allowed) {
          return {
            allowed: false,
            mode: "metered",
            policy,
            counter: preflight.counter,
            window,
            reservation: null,
          };
        }

        let updated: BucketCounters[];
        if (
          policy.enforcement === "hard" &&
          policy.limit !== null &&
          !policy.unlimited
        ) {
          updated = await tx.$queryRaw<BucketCounters[]>`
        UPDATE "usage_buckets"
        SET
          "reserved" = "reserved" + ${quantity},
          "version" = "version" + 1,
          "updated_at" = ${now}
        WHERE "id" = ${bucket.id}
          AND "used" + "reserved" + ${quantity} <= ${policy.limit}
        RETURNING "used", "reserved"
      `;
          if (updated.length === 0) {
            const current = await tx.usageBucket.findUniqueOrThrow({
              where: { id: bucket.id },
            });
            const decision = evaluateQuotaAttempt(
              policy,
              current.used,
              current.reserved,
              quantity,
            );
            return {
              allowed: false,
              mode: "metered",
              policy,
              counter: decision.counter,
              window,
              reservation: null,
            };
          }
        } else {
          updated = await tx.$queryRaw<BucketCounters[]>`
        UPDATE "usage_buckets"
        SET
          "reserved" = "reserved" + ${quantity},
          "version" = "version" + 1,
          "updated_at" = ${now}
        WHERE "id" = ${bucket.id}
        RETURNING "used", "reserved"
      `;
        }

        const ttl =
          input.reservationTtlSeconds === undefined
            ? policy.reservationTtlSeconds
            : Math.min(
                policy.reservationTtlSeconds,
                input.reservationTtlSeconds,
              );
        if (!Number.isSafeInteger(ttl) || ttl <= 0) {
          throw new TypeError(
            "reservationTtlSeconds must be a positive safe integer.",
          );
        }
        const reservation = await tx.quotaReservation.create({
          data: {
            idempotencyKey: input.idempotencyKey,
            actorUserId: input.actorUserId,
            projectId: normalizedProjectId(input.projectId),
            bucketId: bucket.id,
            metric: input.metric,
            reservedQuantity: quantity,
            policyLimit: policy.limit,
            policyEnforcement: policy.enforcement,
            policyWindowType: policy.windowType,
            enforcementExempt: policy.enforcementExempt,
            expiresAt: new Date(now.getTime() + ttl * 1_000),
          },
        });
        const counters = updated[0];
        const view = reservationView(
          reservation,
          {
            ...counters,
            windowStart: window.start,
            windowEnd: window.end,
          },
          false,
        );
        return {
          allowed: true,
          mode: policy.unlimited ? "unlimited" : "metered",
          policy,
          counter: {
            used: view.used,
            reserved: view.reserved,
            requested: view.requested,
            limit: view.limit,
            remaining: view.remaining,
            exceeded: view.exceeded,
          },
          window,
          reservation: view,
        };
      },
    );
  if (isDeferredQuotaFailure(outcome)) throw outcome.deferredQuotaError;
  return outcome;
}

function usageResult(
  event: UsageEvent,
  counters: BucketCounters,
  limit: bigint | null,
  idempotent: boolean,
): UsageSettlementResult {
  return {
    eventId: event.id,
    reservationId: event.reservationId,
    actorUserId: event.actorUserId!,
    projectId: event.projectId,
    metric: event.metric,
    quantity: event.quantity,
    enforcementExempt: event.enforcementExempt,
    sourceType: event.sourceType,
    sourceId: event.sourceId,
    occurredAt: event.occurredAt,
    counter: {
      used: counters.used,
      reserved: counters.reserved,
      limit,
      remaining: remaining(limit, counters.used, counters.reserved),
      exceeded: limit !== null && counters.used + counters.reserved > limit,
    },
    idempotent,
  };
}

async function settleWithClient(
  client: QuotaClient,
  input: SettleQuotaInput,
): Promise<UsageSettlementResult> {
  const quantity = quotaQuantity(input.actualQuantity, { allowZero: true });
  assertIdentifier(input.sourceType, "sourceType", 100);
  const outcome: UsageSettlementResult | DeferredQuotaFailure =
    await client.$transaction(
      async (tx): Promise<UsageSettlementResult | DeferredQuotaFailure> => {
        if (!input.reservationId && !input.reservationIdempotencyKey) {
          throw new TypeError(
            "A reservation id or reservation idempotency key is required.",
          );
        }
        const preview = await tx.quotaReservation.findUnique({
          where: input.reservationId
            ? { id: input.reservationId }
            : { idempotencyKey: input.reservationIdempotencyKey! },
          select: { id: true },
        });
        if (!preview) {
          throw new QuotaError(
            "QUOTA_RESERVATION_NOT_FOUND",
            "Quota reservation was not found.",
            409,
          );
        }
        const eventKey =
          input.usageEventIdempotencyKey ?? `quota:settlement:${preview.id}`;
        assertIdentifier(eventKey, "usageEventIdempotencyKey", 240);
        // Usage recording always locks the event identity before the bucket. Keep
        // settlement on the same order to avoid a unique-index/bucket deadlock.
        await acquireQuotaAdvisoryLock(tx, "quota-event", eventKey);
        const reservation = await lockReservation(tx, {
          id: input.reservationId,
          idempotencyKey: input.reservationIdempotencyKey,
        });
        if (!reservation)
          throw new QuotaError(
            "QUOTA_RESERVATION_NOT_FOUND",
            "Quota reservation was not found.",
            409,
          );

        const existingEvent = await tx.usageEvent.findUnique({
          where: { reservationId: reservation.id },
        });
        if (existingEvent) {
          if (
            existingEvent.quantity !== quantity ||
            existingEvent.sourceType !== input.sourceType ||
            existingEvent.sourceId !== (input.sourceId ?? null)
          ) {
            throw new QuotaIdempotencyConflictError(
              "The reservation was already settled with different usage.",
            );
          }
          const bucket = await tx.usageBucket.findUniqueOrThrow({
            where: { id: reservation.bucketId },
          });
          return usageResult(
            existingEvent,
            bucket,
            reservation.policyLimit,
            true,
          );
        }

        const occurredAt = input.occurredAt ?? new Date();
        if (
          reservation.status === "active" &&
          reservation.expiresAt <= occurredAt
        ) {
          await reclaimExpiredReservations(
            tx,
            reservation.bucketId,
            occurredAt,
          );
          return deferredQuotaFailure(
            new QuotaError(
              "QUOTA_RESERVATION_EXPIRED",
              "Quota reservation expired before it could be settled.",
              409,
            ),
          );
        }
        if (reservation.status !== "active") {
          throw new QuotaError(
            "QUOTA_RESERVATION_INACTIVE",
            `Quota reservation is ${reservation.status} and cannot be settled.`,
            409,
          );
        }
        if (
          reservation.policyEnforcement === "hard" &&
          !reservation.enforcementExempt &&
          quantity > reservation.reservedQuantity
        ) {
          throw new QuotaError(
            "QUOTA_SETTLEMENT_EXCEEDS_RESERVATION",
            "A hard quota settlement cannot commit more than the reserved quantity.",
            409,
          );
        }

        const otherEvent = await tx.usageEvent.findUnique({
          where: { idempotencyKey: eventKey },
        });
        if (otherEvent) throw new QuotaIdempotencyConflictError();

        const reservedToRelease = reservation.reservedQuantity;
        const updated = await tx.$queryRaw<BucketCounters[]>`
      UPDATE "usage_buckets"
      SET
        "reserved" = GREATEST(0::bigint, "reserved" - ${reservedToRelease}),
        "used" = "used" + ${quantity},
        "version" = "version" + 1,
        "updated_at" = ${occurredAt}
      WHERE "id" = ${reservation.bucketId}
      RETURNING "used", "reserved"
    `;
        if (updated.length !== 1) {
          throw new QuotaError(
            "QUOTA_BUCKET_NOT_FOUND",
            "Quota usage bucket was not found.",
          );
        }
        await tx.quotaReservation.update({
          where: { id: reservation.id },
          data: {
            status: "settled",
            committedQuantity: quantity,
            settledAt: occurredAt,
          },
        });
        const event = await tx.usageEvent.create({
          data: {
            idempotencyKey: eventKey,
            actorUserId: reservation.actorUserId,
            projectId: reservation.projectId,
            reservationId: reservation.id,
            bucketId: reservation.bucketId,
            metric: reservation.metric,
            quantity,
            sourceType: input.sourceType,
            sourceId: input.sourceId ?? null,
            enforcementExempt: reservation.enforcementExempt,
            occurredAt,
            metadata: input.metadata ?? {},
          },
        });
        return usageResult(event, updated[0], reservation.policyLimit, false);
      },
    );
  if (isDeferredQuotaFailure(outcome)) throw outcome.deferredQuotaError;
  return outcome;
}

async function releaseWithClient(
  client: QuotaClient,
  input: ReleaseQuotaInput,
): Promise<QuotaReservationView> {
  return client.$transaction(async (tx) => {
    const reservation = await lockReservation(tx, {
      id: input.reservationId,
      idempotencyKey: input.reservationIdempotencyKey,
    });
    if (!reservation)
      throw new QuotaError(
        "QUOTA_RESERVATION_NOT_FOUND",
        "Quota reservation was not found.",
        409,
      );
    let row = reservation;
    const now = input.now ?? new Date();
    if (reservation.status === "active") {
      await tx.$executeRaw`
        UPDATE "usage_buckets"
        SET
          "reserved" = GREATEST(0::bigint, "reserved" - ${reservation.reservedQuantity}),
          "version" = "version" + 1,
          "updated_at" = ${now}
        WHERE "id" = ${reservation.bucketId}
      `;
      row = await tx.quotaReservation.update({
        where: { id: reservation.id },
        data: { status: "released", releasedAt: now },
      });
    }
    const bucket = await tx.usageBucket.findUniqueOrThrow({
      where: { id: reservation.bucketId },
    });
    return reservationView(row, bucket, reservation.status !== "active");
  });
}

async function renewWithClient(
  client: QuotaClient,
  input: RenewQuotaInput,
): Promise<QuotaReservationView> {
  const outcome: QuotaReservationView | DeferredQuotaFailure =
    await client.$transaction(
      async (tx): Promise<QuotaReservationView | DeferredQuotaFailure> => {
        const reservation = await lockReservation(tx, {
          id: input.reservationId,
          idempotencyKey: input.reservationIdempotencyKey,
        });
        if (!reservation) {
          throw new QuotaError(
            "QUOTA_RESERVATION_NOT_FOUND",
            "Quota reservation was not found.",
            409,
          );
        }
        const now = input.now ?? new Date();
        if (reservation.status === "active" && reservation.expiresAt <= now) {
          await reclaimExpiredReservations(tx, reservation.bucketId, now);
          return deferredQuotaFailure(
            new QuotaError(
              "QUOTA_RESERVATION_INACTIVE",
              "Only an unexpired active reservation can be renewed.",
              409,
            ),
          );
        }
        if (reservation.status !== "active") {
          throw new QuotaError(
            "QUOTA_RESERVATION_INACTIVE",
            "Only an unexpired active reservation can be renewed.",
            409,
          );
        }
        const policy = await resolveQuotaPolicyInTransaction(
          tx,
          reservation.actorUserId,
          reservation.metric,
          now,
        );
        const requestedTtl =
          input.reservationTtlSeconds ?? policy.reservationTtlSeconds;
        if (!Number.isSafeInteger(requestedTtl) || requestedTtl <= 0) {
          throw new TypeError(
            "reservationTtlSeconds must be a positive safe integer.",
          );
        }
        const ttl = Math.min(requestedTtl, policy.reservationTtlSeconds);
        const row = await tx.quotaReservation.update({
          where: { id: reservation.id },
          data: { expiresAt: new Date(now.getTime() + ttl * 1_000) },
        });
        const bucket = await tx.usageBucket.findUniqueOrThrow({
          where: { id: reservation.bucketId },
        });
        return reservationView(row, bucket, false);
      },
    );
  if (isDeferredQuotaFailure(outcome)) throw outcome.deferredQuotaError;
  return outcome;
}

async function recordWithClient(
  client: QuotaClient,
  input: RecordUsageInput,
): Promise<UsageSettlementResult> {
  assertIdentifier(input.actorUserId, "actorUserId", 191);
  assertIdentifier(input.idempotencyKey, "idempotencyKey", 240);
  assertIdentifier(input.sourceType, "sourceType", 100);
  assertQuotaMetric(input.metric);
  const quantity = quotaSignedQuantity(input.quantity);
  const occurredAt = input.occurredAt ?? new Date();

  return client.$transaction(async (tx) => {
    await acquireQuotaAdvisoryLock(tx, "quota-event", input.idempotencyKey);
    const existing = await tx.usageEvent.findUnique({
      where: { idempotencyKey: input.idempotencyKey },
    });
    if (existing) {
      if (
        existing.actorUserId !== input.actorUserId ||
        existing.projectId !== normalizedProjectId(input.projectId) ||
        existing.metric !== input.metric ||
        existing.quantity !== quantity ||
        existing.sourceType !== input.sourceType ||
        existing.sourceId !== (input.sourceId ?? null)
      ) {
        throw new QuotaIdempotencyConflictError();
      }
      const bucket = existing.bucketId
        ? await tx.usageBucket.findUniqueOrThrow({
            where: { id: existing.bucketId },
          })
        : await tx.usageBucket.findFirstOrThrow({
            where: {
              actorUserId: input.actorUserId,
              metric: input.metric,
              windowStart: { lte: existing.occurredAt },
              windowEnd: { gt: existing.occurredAt },
            },
          });
      const policy = await resolveQuotaPolicyInTransaction(
        tx,
        input.actorUserId,
        input.metric,
        existing.occurredAt,
      );
      return usageResult(existing, bucket, policy.limit, true);
    }

    const policy = await resolveQuotaPolicyInTransaction(
      tx,
      input.actorUserId,
      input.metric,
      occurredAt,
    );
    const window = calculateQuotaWindow(
      policy.windowType,
      occurredAt,
      policy.windowSeconds,
    );
    await acquireQuotaBucketLock(tx, {
      actorUserId: input.actorUserId,
      metric: input.metric,
      windowStart: window.start,
      windowEnd: window.end,
    });
    const bucket = await getOrCreateBucket(
      tx,
      input.actorUserId,
      input.metric,
      window,
    );
    const updated = await tx.$queryRaw<BucketCounters[]>`
      UPDATE "usage_buckets"
      SET
        "used" = "used" + ${quantity},
        "version" = "version" + 1,
        "updated_at" = ${occurredAt}
      WHERE "id" = ${bucket.id}
        AND "used" + ${quantity} >= 0
      RETURNING "used", "reserved"
    `;
    if (updated.length !== 1) {
      throw new QuotaError(
        "QUOTA_USAGE_UNDERFLOW",
        "A quota usage adjustment cannot reduce the bucket below zero.",
        409,
      );
    }
    const event = await tx.usageEvent.create({
      data: {
        idempotencyKey: input.idempotencyKey,
        actorUserId: input.actorUserId,
        projectId: normalizedProjectId(input.projectId),
        bucketId: bucket.id,
        metric: input.metric,
        quantity,
        sourceType: input.sourceType,
        sourceId: input.sourceId ?? null,
        enforcementExempt: policy.enforcementExempt,
        occurredAt,
        metadata: input.metadata ?? {},
      },
    });
    return usageResult(event, updated[0], policy.limit, false);
  });
}

export function createQuotaService(client: QuotaClient = prisma) {
  return {
    resolvePolicy: (actorUserId: string, metric: string, now = new Date()) =>
      client.$transaction((tx) =>
        resolveQuotaPolicyInTransaction(tx, actorUserId, metric, now)),
    tryReserve: (input: ReserveQuotaInput) =>
      tryReserveWithClient(client, input),
    reserve: async (input: ReserveQuotaInput) => {
      const result = await tryReserveWithClient(client, input);
      if (!result.allowed) throw new QuotaExceededError(result);
      return result;
    },
    settle: (input: SettleQuotaInput) => settleWithClient(client, input),
    release: (input: ReleaseQuotaInput) => releaseWithClient(client, input),
    renew: (input: RenewQuotaInput) => renewWithClient(client, input),
    recordUsage: (input: RecordUsageInput) => recordWithClient(client, input),
    consume: async (
      input: ReserveQuotaInput & Omit<SettleQuotaInput, "actualQuantity">,
    ) => {
      const reservation = await tryReserveWithClient(client, input);
      if (!reservation.allowed || !reservation.reservation) {
        throw new QuotaExceededError(reservation);
      }
      return settleWithClient(client, {
        reservationId: reservation.reservation.id,
        actualQuantity: input.quantity,
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        usageEventIdempotencyKey: input.usageEventIdempotencyKey,
        occurredAt: input.occurredAt,
        metadata: input.metadata,
      });
    },
  };
}

const quotaService = createQuotaService();

export const resolveQuotaPolicy = quotaService.resolvePolicy;
export const tryReserveQuota = quotaService.tryReserve;
export const reserveQuota = quotaService.reserve;
export const settleQuotaReservation = quotaService.settle;
export const releaseQuotaReservation = quotaService.release;
export const renewQuotaReservation = quotaService.renew;
export const recordQuotaUsage = quotaService.recordUsage;
export const consumeQuota = quotaService.consume;

export async function cleanupExpiredQuotaReservations(
  options: { now?: Date; batchSize?: number; client?: QuotaClient } = {},
): Promise<{ scanned: number; expired: number }> {
  const client = options.client ?? prisma;
  const now = options.now ?? new Date();
  const batchSize = Math.min(1_000, Math.max(1, options.batchSize ?? 200));
  return client.$transaction(async (tx) => {
    const isLeader = await tryAcquireQuotaAdvisoryLock(
      tx,
      "quota-maintenance",
      "expired-reservations",
    );
    if (!isLeader) return { scanned: 0, expired: 0 };

    const candidates = await tx.quotaReservation.findMany({
      where: { status: "active", expiresAt: { lte: now } },
      select: { id: true },
      orderBy: { expiresAt: "asc" },
      take: batchSize,
    });
    let expired = 0;
    for (const candidate of candidates) {
      const reservation = await lockReservation(tx, { id: candidate.id });
      if (
        !reservation ||
        reservation.status !== "active" ||
        reservation.expiresAt > now
      )
        continue;
      await tx.$executeRaw`
        UPDATE "usage_buckets"
        SET
          "reserved" = GREATEST(0::bigint, "reserved" - ${reservation.reservedQuantity}),
          "version" = "version" + 1,
          "updated_at" = ${now}
        WHERE "id" = ${reservation.bucketId}
      `;
      const changed = await tx.quotaReservation.updateMany({
        where: {
          id: reservation.id,
          status: "active",
          expiresAt: { lte: now },
        },
        data: { status: "expired", releasedAt: now },
      });
      expired += changed.count;
    }
    return { scanned: candidates.length, expired };
  });
}
