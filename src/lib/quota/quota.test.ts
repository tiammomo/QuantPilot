import { describe, expect, it, vi } from "vitest";

import {
  assertStructuralQuotaCapacity,
  calculateQuotaWindow,
  cleanupExpiredQuotaReservations,
  createQuotaService,
  evaluateQuotaAttempt,
  quotaQuantity,
  quotaSignedQuantity,
} from ".";

describe("quota windows", () => {
  const now = new Date("2026-07-16T13:45:37.456Z");

  it("uses deterministic UTC calendar boundaries", () => {
    expect(calculateQuotaWindow("minute", now)).toEqual({
      start: new Date("2026-07-16T13:45:00.000Z"),
      end: new Date("2026-07-16T13:46:00.000Z"),
    });
    expect(calculateQuotaWindow("day", now)).toEqual({
      start: new Date("2026-07-16T00:00:00.000Z"),
      end: new Date("2026-07-17T00:00:00.000Z"),
    });
    expect(calculateQuotaWindow("month", now)).toEqual({
      start: new Date("2026-07-01T00:00:00.000Z"),
      end: new Date("2026-08-01T00:00:00.000Z"),
    });
  });

  it("anchors fixed windows to the Unix epoch", () => {
    expect(calculateQuotaWindow("fixed", now, 900)).toEqual({
      start: new Date("2026-07-16T13:45:00.000Z"),
      end: new Date("2026-07-16T14:00:00.000Z"),
    });
  });
});

describe("quota arithmetic", () => {
  it("keeps quantities in bigint without accepting unsafe numbers", () => {
    expect(quotaQuantity("9007199254740993")).toBe(9_007_199_254_740_993n);
    expect(quotaSignedQuantity("-3")).toBe(-3n);
    expect(() => quotaQuantity(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      "safe integer",
    );
    expect(() => quotaQuantity(0)).toThrow("greater than zero");
  });

  it("blocks only hard policies while observe and warn expose overage", () => {
    for (const enforcement of ["observe", "warn"] as const) {
      expect(
        evaluateQuotaAttempt(
          { unlimited: false, limit: 10n, enforcement },
          8n,
          1n,
          2n,
        ),
      ).toMatchObject({
        allowed: true,
        counter: { exceeded: true, remaining: 0n },
      });
    }
    expect(
      evaluateQuotaAttempt(
        { unlimited: false, limit: 10n, enforcement: "hard" },
        8n,
        1n,
        2n,
      ),
    ).toMatchObject({ allowed: false, counter: { exceeded: true } });
  });

  it("treats an unlimited policy as truly unbounded", () => {
    expect(
      evaluateQuotaAttempt(
        { unlimited: true, limit: null, enforcement: "hard" },
        10n ** 30n,
        10n ** 30n,
        10n ** 30n,
      ),
    ).toMatchObject({
      allowed: true,
      counter: { limit: null, remaining: null, exceeded: false },
    });
  });
});

function transactionClient(overrides: Record<string, unknown> = {}) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    $executeRaw: vi.fn().mockResolvedValue(1),
    authUser: { findUnique: vi.fn() },
    quotaProfile: { findFirst: vi.fn().mockResolvedValue(null) },
    quotaReservation: {
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    usageBucket: {
      upsert: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findFirstOrThrow: vi.fn(),
    },
    usageEvent: { findUnique: vi.fn(), create: vi.fn() },
    ...overrides,
  };
}

function quotaClient(tx: ReturnType<typeof transactionClient>) {
  return {
    $transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) =>
      callback(tx),
    ),
    quotaReservation: { findMany: vi.fn() },
  };
}

describe("quota policy and reservation service", () => {
  it("blocks structural running capacity from database state without a reservation", async () => {
    const tx = transactionClient();
    tx.authUser.findUnique.mockResolvedValue({
      id: "member-1",
      role: "member",
      quotaOverrides: [],
      quotaProfile: {
        rules: [{
          limit: 2n,
          enforcement: "hard",
          windowType: "lifetime",
          windowSeconds: null,
          reservationTtlSeconds: 3_600,
        }],
      },
    });

    await expect(assertStructuralQuotaCapacity(tx as never, {
      actorUserId: "member-1",
      metric: "agent.concurrent",
      current: 2,
      now: new Date("2026-07-23T00:00:00.000Z"),
    })).rejects.toMatchObject({
      code: "QUOTA_EXCEEDED",
      status: 429,
      decision: {
        counter: {
          used: 0n,
          reserved: 2n,
          requested: 1n,
          limit: 2n,
        },
      },
    });
    expect(tx.quotaReservation.create).not.toHaveBeenCalled();
  });

  it("allows a structural slot below the configured limit", async () => {
    const tx = transactionClient();
    tx.authUser.findUnique.mockResolvedValue({
      id: "member-1",
      role: "member",
      quotaOverrides: [],
      quotaProfile: {
        rules: [{
          limit: 4n,
          enforcement: "hard",
          windowType: "lifetime",
          windowSeconds: null,
          reservationTtlSeconds: 3_600,
        }],
      },
    });

    await expect(assertStructuralQuotaCapacity(tx as never, {
      actorUserId: "member-1",
      metric: "agent.pending",
      current: 3,
    })).resolves.toMatchObject({
      metric: "agent.pending",
      limit: 4n,
      enforcement: "hard",
    });
  });

  it("makes platform administrators unlimited while retaining the metric window", async () => {
    const tx = transactionClient();
    tx.authUser.findUnique.mockResolvedValue({
      id: "admin-1",
      role: "admin",
      quotaOverrides: [],
      quotaProfile: {
        rules: [
          {
            limit: 2n,
            enforcement: "hard",
            windowType: "day",
            windowSeconds: null,
            reservationTtlSeconds: 300,
          },
        ],
      },
    });
    const service = createQuotaService(quotaClient(tx) as never);

    await expect(
      service.resolvePolicy("admin-1", "agent.concurrent"),
    ).resolves.toMatchObject({
      source: "administrator",
      unlimited: true,
      limit: null,
      enforcement: "observe",
      enforcementExempt: true,
      windowType: "day",
    });
  });

  it("honors a non-expired per-user quota override before the profile rule", async () => {
    const tx = transactionClient();
    tx.authUser.findUnique.mockResolvedValue({
      id: "member-1",
      role: "member",
      quotaOverrides: [
        {
          isUnlimited: false,
          limit: 5n,
          enforcement: "warn",
          windowType: "hour",
          windowSeconds: null,
          reservationTtlSeconds: 60,
        },
      ],
      quotaProfile: { rules: [{ limit: 2n }] },
    });
    const service = createQuotaService(quotaClient(tx) as never);

    await expect(
      service.resolvePolicy("member-1", "agent.concurrent"),
    ).resolves.toMatchObject({
      source: "user-override",
      unlimited: false,
      limit: 5n,
      enforcement: "warn",
      windowType: "hour",
    });
  });

  it("uses the built-in policy when database seed data is temporarily absent", async () => {
    const tx = transactionClient();
    tx.authUser.findUnique.mockResolvedValue({
      id: "member-1",
      role: "member",
      quotaOverrides: [],
      quotaProfile: null,
    });
    const service = createQuotaService(quotaClient(tx) as never);

    await expect(
      service.resolvePolicy("member-1", "research.report_sends.daily"),
    ).resolves.toMatchObject({
      source: "builtin-default",
      unlimited: false,
      limit: 10n,
      enforcement: "hard",
      windowType: "day",
      reservationTtlSeconds: 3_600,
      enforcementExempt: false,
    });
  });

  it("keeps unknown metrics observable and unlimited", async () => {
    const tx = transactionClient();
    tx.authUser.findUnique.mockResolvedValue({
      id: "member-1",
      role: "member",
      quotaOverrides: [],
      quotaProfile: null,
    });
    const service = createQuotaService(quotaClient(tx) as never);

    await expect(
      service.resolvePolicy("member-1", "new.feature.units"),
    ).resolves.toMatchObject({
      source: "unconfigured",
      unlimited: true,
      limit: null,
      enforcement: "observe",
      enforcementExempt: true,
    });
  });

  it("rechecks a hard limit atomically when another request wins the last slot", async () => {
    const tx = transactionClient();
    tx.authUser.findUnique.mockResolvedValue({
      id: "member-1",
      role: "member",
      quotaOverrides: [],
      quotaProfile: {
        rules: [
          {
            limit: 10n,
            enforcement: "hard",
            windowType: "day",
            windowSeconds: null,
            reservationTtlSeconds: 60,
          },
        ],
      },
    });
    tx.usageBucket.findUniqueOrThrow
      .mockResolvedValueOnce({ id: "bucket-1", used: 8n, reserved: 1n })
      .mockResolvedValueOnce({ id: "bucket-1", used: 8n, reserved: 2n });
    // Both advisory locks succeed, the bucket is returned by its atomic
    // upsert, no expired lease is reclaimed, and then the conditional UPDATE
    // returns no row after another reservation consumes the final unit.
    tx.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: "bucket-1", used: 8n, reserved: 1n }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const service = createQuotaService(quotaClient(tx) as never);

    await expect(
      service.tryReserve({
        actorUserId: "member-1",
        metric: "agent.concurrent",
        quantity: 1,
        idempotencyKey: "run-atomic-race",
        now: new Date("2026-07-16T00:00:00.000Z"),
      }),
    ).resolves.toMatchObject({
      allowed: false,
      counter: { used: 8n, reserved: 2n, remaining: 0n, exceeded: true },
      reservation: null,
    });
    expect(tx.quotaReservation.create).not.toHaveBeenCalled();
  });

  it("atomically expires stale reservations and returns their reserved units", async () => {
    const now = new Date("2026-07-16T00:10:00.000Z");
    const tx = transactionClient();
    tx.quotaReservation.findUnique.mockResolvedValue({
      id: "reservation-expired",
      idempotencyKey: "expired-key",
      actorUserId: "member-1",
      projectId: null,
      bucketId: "bucket-1",
      metric: "agent.concurrent",
      reservedQuantity: 1n,
      committedQuantity: 0n,
      status: "active",
      policyLimit: 2n,
      policyEnforcement: "hard",
      policyWindowType: "lifetime",
      enforcementExempt: false,
      expiresAt: new Date("2026-07-16T00:05:00.000Z"),
      settledAt: null,
      releasedAt: null,
      createdAt: new Date("2026-07-16T00:00:00.000Z"),
      updatedAt: new Date("2026-07-16T00:00:00.000Z"),
      bucket: {
        windowStart: new Date("1970-01-01T00:00:00.000Z"),
        windowEnd: new Date("9999-12-31T23:59:59.999Z"),
      },
    });
    tx.quotaReservation.updateMany.mockResolvedValue({ count: 1 });
    const client = quotaClient(tx);
    tx.quotaReservation.findMany.mockResolvedValue([
      { id: "reservation-expired" },
    ]);
    tx.$queryRaw
      .mockResolvedValueOnce([{ acquired: true }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await expect(
      cleanupExpiredQuotaReservations({
        now,
        client: client as never,
      }),
    ).resolves.toEqual({ scanned: 1, expired: 1 });
    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    expect(tx.quotaReservation.updateMany).toHaveBeenCalledWith({
      where: {
        id: "reservation-expired",
        status: "active",
        expiresAt: { lte: now },
      },
      data: { status: "expired", releasedAt: now },
    });
  });

  it("lets only one maintenance worker claim an expiry batch", async () => {
    const tx = transactionClient();
    tx.$queryRaw.mockResolvedValueOnce([{ acquired: false }]);
    const client = quotaClient(tx);

    await expect(
      cleanupExpiredQuotaReservations({ client: client as never }),
    ).resolves.toEqual({ scanned: 0, expired: 0 });
    expect(tx.quotaReservation.findMany).not.toHaveBeenCalled();
  });

  it("commits an expired settlement reclaim before returning the expiry error", async () => {
    const now = new Date("2026-07-16T00:10:00.000Z");
    const reservation = {
      id: "reservation-expired-settle",
      idempotencyKey: "expired-settlement-key",
      actorUserId: "member-1",
      projectId: null,
      bucketId: "bucket-1",
      metric: "research.report_sends.daily",
      reservedQuantity: 1n,
      committedQuantity: 0n,
      status: "active",
      policyLimit: 10n,
      policyEnforcement: "hard",
      policyWindowType: "day",
      enforcementExempt: false,
      expiresAt: new Date("2026-07-16T00:05:00.000Z"),
      settledAt: null,
      releasedAt: null,
      createdAt: new Date("2026-07-16T00:00:00.000Z"),
      updatedAt: new Date("2026-07-16T00:00:00.000Z"),
      bucket: {
        windowStart: new Date("2026-07-16T00:00:00.000Z"),
        windowEnd: new Date("2026-07-17T00:00:00.000Z"),
      },
    };
    const tx = transactionClient();
    tx.quotaReservation.findUnique.mockResolvedValue(reservation);
    tx.usageEvent.findUnique.mockResolvedValue(null);
    tx.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ used: 0n, reserved: 0n }]);
    const service = createQuotaService(quotaClient(tx) as never);

    await expect(
      service.settle({
        reservationId: reservation.id,
        actualQuantity: 1,
        sourceType: "research_report_send",
        occurredAt: now,
      }),
    ).rejects.toMatchObject({ code: "QUOTA_RESERVATION_EXPIRED", status: 409 });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(4);
    expect(tx.usageEvent.create).not.toHaveBeenCalled();
  });

  it("does not allow a hard settlement to exceed its reserved quantity", async () => {
    const reservation = {
      id: "reservation-hard-limit",
      idempotencyKey: "hard-limit-key",
      actorUserId: "member-1",
      projectId: null,
      bucketId: "bucket-1",
      metric: "research.report_sends.daily",
      reservedQuantity: 1n,
      committedQuantity: 0n,
      status: "active",
      policyLimit: 10n,
      policyEnforcement: "hard",
      policyWindowType: "day",
      enforcementExempt: false,
      expiresAt: new Date("2026-07-16T01:00:00.000Z"),
      settledAt: null,
      releasedAt: null,
      createdAt: new Date("2026-07-16T00:00:00.000Z"),
      updatedAt: new Date("2026-07-16T00:00:00.000Z"),
      bucket: {
        windowStart: new Date("2026-07-16T00:00:00.000Z"),
        windowEnd: new Date("2026-07-17T00:00:00.000Z"),
      },
    };
    const tx = transactionClient();
    tx.quotaReservation.findUnique.mockResolvedValue(reservation);
    tx.usageEvent.findUnique.mockResolvedValue(null);
    tx.$queryRaw.mockResolvedValue([]);
    const service = createQuotaService(quotaClient(tx) as never);

    await expect(
      service.settle({
        reservationId: reservation.id,
        actualQuantity: 2,
        sourceType: "research_report_send",
        occurredAt: new Date("2026-07-16T00:10:00.000Z"),
      }),
    ).rejects.toMatchObject({
      code: "QUOTA_SETTLEMENT_EXCEEDS_RESERVATION",
      status: 409,
    });
    expect(tx.usageEvent.create).not.toHaveBeenCalled();
  });
});
