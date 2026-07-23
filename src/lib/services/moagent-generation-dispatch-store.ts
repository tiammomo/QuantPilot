import { createHash, randomUUID } from "node:crypto";
import {
  Prisma,
  type AgentGenerationJob,
  type AgentGenerationOutboxEvent,
} from "@prisma/client";

import { prisma } from "@/lib/db/client";
import { assertStructuralQuotaCapacity } from "@/lib/quota";

const MAX_IDENTIFIER_BYTES = 256;
const MAX_LEASE_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_ENVELOPE_MAX_BYTES = 256 * 1_024;
const DEFAULT_PENDING_ORPHAN_GRACE_MS = 120_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 5_000;
const TERMINAL_STATUSES = new Set<MoAgentGenerationDispatchStatus>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
const FORBIDDEN_ENVELOPE_KEY =
  /(?:^|_)(?:api_?key|authorization|cookie|password|secret|token)(?:$|_)/i;

export const MOAGENT_GENERATION_DISPATCH_STATUSES = [
  "pending",
  "running",
  "retry_wait",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const;

export type MoAgentGenerationDispatchStatus =
  (typeof MOAGENT_GENERATION_DISPATCH_STATUSES)[number];

export type MoAgentGenerationDispatchTerminalStatus = Extract<
  MoAgentGenerationDispatchStatus,
  "completed" | "failed" | "cancelled" | "interrupted"
>;

export interface MoAgentGenerationDispatchFence {
  jobId: string;
  projectId: string;
  requestId: string;
  leaseOwner: string;
  fencingToken: number;
}

export interface MoAgentGenerationDispatchClaim extends MoAgentGenerationDispatchFence {
  attemptCount: number;
  leaseExpiresAt: string;
}

type DispatchTransaction = Prisma.TransactionClient;

export class MoAgentGenerationDispatchError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly projectId?: string,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "MoAgentGenerationDispatchError";
  }
}

function assertIdentifier(value: string, label: string): void {
  if (
    !value ||
    Buffer.byteLength(value, "utf8") > MAX_IDENTIFIER_BYTES ||
    /[\r\n]/.test(value)
  ) {
    throw new MoAgentGenerationDispatchError(
      "GENERATION_DISPATCH_INVALID",
      `${label} must be a bounded single-line identifier.`,
    );
  }
}

function configuredEnvelopeMaxBytes(): number {
  const configured = Number.parseInt(
    process.env.MOAGENT_DISPATCH_ENVELOPE_MAX_BYTES ?? "",
    10,
  );
  if (!configured) return DEFAULT_ENVELOPE_MAX_BYTES;
  if (
    !Number.isSafeInteger(configured) ||
    configured < 1_024 ||
    configured > 4 * 1_024 * 1_024
  ) {
    throw new MoAgentGenerationDispatchError(
      "GENERATION_DISPATCH_INVALID",
      "MOAGENT_DISPATCH_ENVELOPE_MAX_BYTES must be between 1024 and 4194304.",
    );
  }
  return configured;
}

function assertNoCredentials(value: unknown, path = "$"): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      assertNoCredentials(entry, `${path}[${index}]`),
    );
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(
    value as Record<string, unknown>,
  )) {
    if (FORBIDDEN_ENVELOPE_KEY.test(key)) {
      throw new MoAgentGenerationDispatchError(
        "GENERATION_DISPATCH_SENSITIVE_ENVELOPE",
        `Execution envelope must not persist credential field ${path}.${key}.`,
      );
    }
    assertNoCredentials(nested, `${path}.${key}`);
  }
}

function normalizeEnvelope(value: unknown): Prisma.InputJsonValue {
  assertNoCredentials(value);
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new MoAgentGenerationDispatchError(
      "GENERATION_DISPATCH_INVALID_ENVELOPE",
      `Execution envelope must be JSON serializable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    serialized === undefined ||
    Buffer.byteLength(serialized, "utf8") > configuredEnvelopeMaxBytes()
  ) {
    throw new MoAgentGenerationDispatchError(
      "GENERATION_DISPATCH_ENVELOPE_TOO_LARGE",
      "Execution envelope exceeds the configured durable dispatch limit.",
    );
  }
  return JSON.parse(serialized) as Prisma.InputJsonValue;
}

function instructionHash(instruction: string): string {
  return `sha256:${createHash("sha256").update(instruction).digest("hex")}`;
}

function previewInstruction(instruction: string): string {
  const normalized = instruction.replace(/\s+/g, " ").trim();
  return normalized.length > 180 ? `${normalized.slice(0, 179)}…` : normalized;
}

function assertLeaseTtl(leaseTtlMs: number): void {
  if (
    !Number.isSafeInteger(leaseTtlMs) ||
    leaseTtlMs <= 0 ||
    leaseTtlMs > MAX_LEASE_TTL_MS
  ) {
    throw new MoAgentGenerationDispatchError(
      "GENERATION_DISPATCH_INVALID",
      "leaseTtlMs must be a positive safe integer no greater than one day.",
    );
  }
}

function configuredPendingOrphanGraceMs(): number {
  const configured = Number.parseInt(
    process.env.MOAGENT_DISPATCH_PENDING_ORPHAN_GRACE_MS ?? "",
    10,
  );
  if (!configured) return DEFAULT_PENDING_ORPHAN_GRACE_MS;
  if (
    !Number.isSafeInteger(configured) ||
    configured < 1_000 ||
    configured > MAX_LEASE_TTL_MS
  ) {
    throw new MoAgentGenerationDispatchError(
      "GENERATION_DISPATCH_INVALID",
      "MOAGENT_DISPATCH_PENDING_ORPHAN_GRACE_MS must be between 1000 and 86400000.",
    );
  }
  return configured;
}

function retryDelayMs(attemptCount: number): number {
  const configured = Number.parseInt(
    process.env.MOAGENT_DISPATCH_RETRY_BASE_DELAY_MS ?? "",
    10,
  );
  const base = configured || DEFAULT_RETRY_BASE_DELAY_MS;
  if (!Number.isSafeInteger(base) || base < 100 || base > 60 * 60 * 1_000) {
    throw new MoAgentGenerationDispatchError(
      "GENERATION_DISPATCH_INVALID",
      "MOAGENT_DISPATCH_RETRY_BASE_DELAY_MS must be between 100 and 3600000.",
    );
  }
  return Math.min(60 * 60 * 1_000, base * (2 ** Math.max(0, attemptCount - 1)));
}

async function databaseNow(tx: DispatchTransaction): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ databaseNow: Date }>>(Prisma.sql`
    SELECT clock_timestamp() AS "databaseNow"
  `);
  const value = rows[0]?.databaseNow;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new MoAgentGenerationDispatchError(
      "GENERATION_DISPATCH_DATABASE_CLOCK_UNAVAILABLE",
      "Database clock is unavailable for dispatch fencing.",
    );
  }
  return value;
}

async function lockJob(
  tx: DispatchTransaction,
  projectId: string,
  requestId: string,
): Promise<AgentGenerationJob | null> {
  const rows = await tx.$queryRaw<AgentGenerationJob[]>(Prisma.sql`
    SELECT
      id,
      project_id AS "projectId",
      request_id AS "requestId",
      status,
      stage,
      execution_envelope AS "executionEnvelope",
      instruction_hash AS "instructionHash",
      instruction_preview AS "instructionPreview",
      cli_preference AS "cliPreference",
      selected_model AS "selectedModel",
      attempt_count AS "attemptCount",
      max_attempts AS "maxAttempts",
      available_at AS "availableAt",
      lease_owner AS "leaseOwner",
      lease_expires_at AS "leaseExpiresAt",
      last_heartbeat_at AS "lastHeartbeatAt",
      fencing_token AS "fencingToken",
      version,
      event_sequence AS "eventSequence",
      error_code AS "errorCode",
      error_message AS "errorMessage",
      queued_at AS "queuedAt",
      started_at AS "startedAt",
      completed_at AS "completedAt",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM agent_generation_jobs
    WHERE project_id = ${projectId} AND request_id = ${requestId}
    FOR UPDATE
  `);
  return rows[0] ?? null;
}

async function lockDispatchProject(
  tx: DispatchTransaction,
  projectId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM projects
    WHERE id = ${projectId}
    FOR UPDATE
  `);
  if (!rows[0]) {
    throw new MoAgentGenerationDispatchError(
      "GENERATION_DISPATCH_PROJECT_NOT_FOUND",
      "Generation project does not exist.",
      projectId,
    );
  }
}

async function appendOutboxEvent(
  tx: DispatchTransaction,
  job: Pick<
    AgentGenerationJob,
    "id" | "projectId" | "requestId" | "eventSequence"
  >,
  eventType: string,
  payload: Prisma.InputJsonValue,
  occurredAt: Date,
): Promise<void> {
  await tx.agentGenerationOutboxEvent.create({
    data: {
      id: randomUUID(),
      jobId: job.id,
      projectId: job.projectId,
      requestId: job.requestId,
      sequence: job.eventSequence + 1,
      eventType,
      payload,
      occurredAt,
    },
  });
}

function assertFence(
  job: AgentGenerationJob,
  fence: MoAgentGenerationDispatchFence,
  now: Date,
): void {
  if (
    job.id !== fence.jobId ||
    job.projectId !== fence.projectId ||
    job.requestId !== fence.requestId ||
    job.status !== "running" ||
    job.leaseOwner !== fence.leaseOwner ||
    job.fencingToken !== fence.fencingToken
  ) {
    throw new MoAgentGenerationDispatchError(
      "GENERATION_DISPATCH_LEASE_LOST",
      "The worker no longer owns the generation dispatch fence.",
      fence.projectId,
      fence.requestId,
    );
  }
  if (!job.leaseExpiresAt || job.leaseExpiresAt <= now) {
    throw new MoAgentGenerationDispatchError(
      "GENERATION_DISPATCH_LEASE_EXPIRED",
      "The generation dispatch lease expired before its durable write.",
      fence.projectId,
      fence.requestId,
    );
  }
}

export async function enqueueMoAgentGenerationJob(input: {
  projectId: string;
  requestId: string;
  instruction: string;
  cliPreference?: string | null;
  selectedModel?: string | null;
  executionEnvelope?: unknown;
  maxAttempts?: number;
}): Promise<AgentGenerationJob> {
  assertIdentifier(input.projectId, "projectId");
  assertIdentifier(input.requestId, "requestId");
  const envelope = normalizeEnvelope(
    input.executionEnvelope ?? {
      schemaVersion: 1,
      instruction: input.instruction,
    },
  );
  const hash = instructionHash(input.instruction);
  const maxAttempts = input.maxAttempts ?? 1;
  if (
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts <= 0 ||
    maxAttempts > 10
  ) {
    throw new MoAgentGenerationDispatchError(
      "GENERATION_DISPATCH_INVALID",
      "maxAttempts must be an integer between 1 and 10.",
    );
  }

  return prisma.$transaction(async (tx) => {
    const existing = await lockJob(tx, input.projectId, input.requestId);
    if (existing) {
      if (existing.instructionHash !== hash) {
        throw new MoAgentGenerationDispatchError(
          "GENERATION_DISPATCH_IDEMPOTENCY_CONFLICT",
          "The request ID is already bound to a different generation instruction.",
          input.projectId,
          input.requestId,
        );
      }
      return existing;
    }
    const now = await databaseNow(tx);
    const request = await tx.userRequest.findUnique({
      where: {
        id_projectId: { id: input.requestId, projectId: input.projectId },
      },
      select: { status: true, errorMessage: true },
    });
    if (!request) {
      throw new MoAgentGenerationDispatchError(
        "GENERATION_DISPATCH_REQUEST_NOT_FOUND",
        "Generation request does not exist or belongs to another project.",
        input.projectId,
        input.requestId,
      );
    }
    const cancelled = request.status === "cancelled";
    const created = await tx.agentGenerationJob.create({
      data: {
        id: randomUUID(),
        projectId: input.projectId,
        requestId: input.requestId,
        executionEnvelope: envelope,
        instructionHash: hash,
        instructionPreview: previewInstruction(input.instruction),
        cliPreference: input.cliPreference ?? null,
        selectedModel: input.selectedModel ?? null,
        maxAttempts,
        availableAt: now,
        queuedAt: now,
        status: cancelled ? "cancelled" : "pending",
        errorCode: cancelled ? "USER_CANCELLED" : null,
        errorMessage: cancelled
          ? (request.errorMessage ?? "用户暂停了当前任务")
          : null,
        completedAt: cancelled ? now : null,
        eventSequence: 1,
      },
    });
    await tx.agentGenerationOutboxEvent.create({
      data: {
        id: randomUUID(),
        jobId: created.id,
        projectId: created.projectId,
        requestId: created.requestId,
        sequence: 1,
        eventType: cancelled ? "generation_cancelled" : "generation_queued",
        payload: {
          status: cancelled ? "cancelled" : "pending",
          stage: created.stage,
          maxAttempts: created.maxAttempts,
        },
        occurredAt: now,
      },
    });
    return created;
  });
}

export async function claimMoAgentGenerationJob(input: {
  projectId: string;
  requestId: string;
  leaseOwner: string;
  leaseTtlMs: number;
}): Promise<MoAgentGenerationDispatchClaim> {
  assertIdentifier(input.projectId, "projectId");
  assertIdentifier(input.requestId, "requestId");
  assertIdentifier(input.leaseOwner, "leaseOwner");
  assertLeaseTtl(input.leaseTtlMs);
  return prisma.$transaction(async (tx) => {
    // The partial unique index is the database backstop. Locking the parent
    // project also provides deterministic serialization in Prisma db-push test
    // schemas, and lets us return a stable domain error instead of SQL 23505.
    await lockDispatchProject(tx, input.projectId);
    const current = await lockJob(tx, input.projectId, input.requestId);
    if (!current) {
      throw new MoAgentGenerationDispatchError(
        "GENERATION_DISPATCH_NOT_FOUND",
        "Generation dispatch job does not exist.",
        input.projectId,
        input.requestId,
      );
    }
    const now = await databaseNow(tx);
    if (
      TERMINAL_STATUSES.has(current.status as MoAgentGenerationDispatchStatus)
    ) {
      throw new MoAgentGenerationDispatchError(
        current.status === "cancelled"
          ? "GENERATION_DISPATCH_CANCELLED"
          : "GENERATION_DISPATCH_TERMINAL",
        `Generation dispatch job is already ${current.status}.`,
        input.projectId,
        input.requestId,
      );
    }
    if (current.status === "running") {
      const expired = Boolean(
        current.leaseExpiresAt && current.leaseExpiresAt <= now,
      );
      throw new MoAgentGenerationDispatchError(
        expired
          ? "GENERATION_DISPATCH_REPLAN_REQUIRED"
          : "GENERATION_DISPATCH_BUSY",
        expired
          ? "The previous generation attempt expired and must be reconciled before replanning."
          : "Generation dispatch job is already claimed by another worker.",
        input.projectId,
        input.requestId,
      );
    }
    if (current.availableAt > now) {
      throw new MoAgentGenerationDispatchError(
        "GENERATION_DISPATCH_NOT_AVAILABLE",
        "Generation dispatch job is not available yet.",
        input.projectId,
        input.requestId,
      );
    }
    if (current.attemptCount >= current.maxAttempts) {
      throw new MoAgentGenerationDispatchError(
        "GENERATION_DISPATCH_ATTEMPTS_EXHAUSTED",
        "Generation dispatch attempt budget is exhausted.",
        input.projectId,
        input.requestId,
      );
    }
    const otherRunning = await tx.agentGenerationJob.findFirst({
      where: {
        projectId: input.projectId,
        status: "running",
        id: { not: current.id },
      },
      select: { requestId: true, leaseExpiresAt: true },
    });
    if (otherRunning) {
      throw new MoAgentGenerationDispatchError(
        otherRunning.leaseExpiresAt && otherRunning.leaseExpiresAt <= now
          ? "GENERATION_PROJECT_REPLAN_REQUIRED"
          : "GENERATION_PROJECT_BUSY",
        otherRunning.leaseExpiresAt && otherRunning.leaseExpiresAt <= now
          ? "Another generation attempt expired and must be reconciled before this project can run."
          : "Another generation job is already running for this project.",
        input.projectId,
        otherRunning.requestId,
      );
    }
    const request = await tx.userRequest.findUnique({
      where: {
        id_projectId: {
          id: current.requestId,
          projectId: current.projectId,
        },
      },
      select: { actorUserId: true },
    });
    if (!request) {
      throw new MoAgentGenerationDispatchError(
        "GENERATION_DISPATCH_REQUEST_NOT_FOUND",
        "Generation request does not exist or belongs to another project.",
        input.projectId,
        input.requestId,
      );
    }
    if (request.actorUserId) {
      const actors = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "auth_users"
        WHERE "id" = ${request.actorUserId}
        FOR UPDATE
      `);
      if (!actors[0]) {
        throw new MoAgentGenerationDispatchError(
          "GENERATION_DISPATCH_ACTOR_NOT_FOUND",
          "Generation request actor no longer exists.",
          input.projectId,
          input.requestId,
        );
      }
      const actorRunningJobs = await tx.agentGenerationJob.count({
        where: {
          id: { not: current.id },
          status: "running",
          request: { actorUserId: request.actorUserId },
        },
      });
      await assertStructuralQuotaCapacity(tx, {
        actorUserId: request.actorUserId,
        metric: "agent.concurrent",
        current: actorRunningJobs,
        now,
      });
    }
    const leaseExpiresAt = new Date(now.getTime() + input.leaseTtlMs);
    try {
      const updated = await tx.agentGenerationJob.updateMany({
        where: {
          id: current.id,
          version: current.version,
          status: { in: ["pending", "retry_wait"] },
        },
        data: {
          status: "running",
          leaseOwner: input.leaseOwner,
          leaseExpiresAt,
          lastHeartbeatAt: now,
          fencingToken: { increment: 1 },
          version: { increment: 1 },
          eventSequence: { increment: 1 },
          attemptCount: { increment: 1 },
          startedAt: current.startedAt ?? now,
          completedAt: null,
          errorCode: null,
          errorMessage: null,
        },
      });
      if (updated.count !== 1) {
        throw new MoAgentGenerationDispatchError(
          "GENERATION_DISPATCH_CONFLICT",
          "Generation dispatch claim lost a concurrent write.",
          input.projectId,
          input.requestId,
        );
      }
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002"
      ) {
        throw new MoAgentGenerationDispatchError(
          "GENERATION_PROJECT_BUSY",
          "Another generation job is already running for this project.",
          input.projectId,
          input.requestId,
        );
      }
      throw error;
    }
    await appendOutboxEvent(
      tx,
      current,
      "generation_claimed",
      {
        status: "running",
        attemptCount: current.attemptCount + 1,
        fencingToken: current.fencingToken + 1,
      },
      now,
    );
    return {
      jobId: current.id,
      projectId: current.projectId,
      requestId: current.requestId,
      leaseOwner: input.leaseOwner,
      fencingToken: current.fencingToken + 1,
      attemptCount: current.attemptCount + 1,
      leaseExpiresAt: leaseExpiresAt.toISOString(),
    };
  });
}

export async function heartbeatMoAgentGenerationJob(input: {
  fence: MoAgentGenerationDispatchFence;
  leaseTtlMs: number;
}): Promise<{ leaseExpiresAt: string }> {
  assertLeaseTtl(input.leaseTtlMs);
  return prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    const current = await lockJob(
      tx,
      input.fence.projectId,
      input.fence.requestId,
    );
    if (!current) {
      throw new MoAgentGenerationDispatchError(
        "GENERATION_DISPATCH_NOT_FOUND",
        "Generation dispatch job does not exist.",
      );
    }
    assertFence(current, input.fence, now);
    const leaseExpiresAt = new Date(now.getTime() + input.leaseTtlMs);
    const updated = await tx.agentGenerationJob.updateMany({
      where: {
        id: current.id,
        version: current.version,
        status: "running",
        leaseOwner: input.fence.leaseOwner,
        fencingToken: input.fence.fencingToken,
        leaseExpiresAt: { gt: now },
      },
      data: {
        leaseExpiresAt,
        lastHeartbeatAt: now,
        version: { increment: 1 },
      },
    });
    if (updated.count !== 1) {
      throw new MoAgentGenerationDispatchError(
        "GENERATION_DISPATCH_LEASE_LOST",
        "Generation dispatch heartbeat lost a concurrent write.",
        input.fence.projectId,
        input.fence.requestId,
      );
    }
    return { leaseExpiresAt: leaseExpiresAt.toISOString() };
  });
}

export async function finishMoAgentGenerationJob(input: {
  projectId: string;
  requestId: string;
  status: Exclude<MoAgentGenerationDispatchTerminalStatus, "cancelled">;
  errorCode?: string | null;
  errorMessage?: string | null;
  fence?: MoAgentGenerationDispatchFence;
}): Promise<AgentGenerationJob> {
  return prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    const current = await lockJob(tx, input.projectId, input.requestId);
    if (!current) {
      throw new MoAgentGenerationDispatchError(
        "GENERATION_DISPATCH_NOT_FOUND",
        "Generation dispatch job does not exist.",
        input.projectId,
        input.requestId,
      );
    }
    if (current.status === "cancelled") return current;
    if (
      TERMINAL_STATUSES.has(current.status as MoAgentGenerationDispatchStatus)
    ) {
      if (current.status === input.status) return current;
      throw new MoAgentGenerationDispatchError(
        "GENERATION_DISPATCH_TERMINAL_CONFLICT",
        `Generation dispatch job is already ${current.status}.`,
        input.projectId,
        input.requestId,
      );
    }
    if (!input.fence) {
      throw new MoAgentGenerationDispatchError(
        "GENERATION_DISPATCH_FENCE_REQUIRED",
        "A live dispatch fence is required for generation completion.",
        input.projectId,
        input.requestId,
      );
    }
    assertFence(current, input.fence, now);
    const updated = await tx.agentGenerationJob.updateMany({
      where: {
        id: current.id,
        version: current.version,
        status: "running",
        leaseOwner: input.fence.leaseOwner,
        fencingToken: input.fence.fencingToken,
        leaseExpiresAt: { gt: now },
      },
      data: {
        status: input.status,
        stage: input.status === "completed" ? "completed" : current.stage,
        leaseOwner: null,
        leaseExpiresAt: null,
        lastHeartbeatAt: null,
        version: { increment: 1 },
        eventSequence: { increment: 1 },
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
        completedAt: now,
      },
    });
    if (updated.count !== 1) {
      throw new MoAgentGenerationDispatchError(
        "GENERATION_DISPATCH_LEASE_LOST",
        "Generation dispatch completion lost its fencing token.",
        input.projectId,
        input.requestId,
      );
    }
    await appendOutboxEvent(
      tx,
      current,
      `generation_${input.status}`,
      {
        status: input.status,
        errorCode: input.errorCode ?? null,
        errorMessage: input.errorMessage ?? null,
      },
      now,
    );
    return tx.agentGenerationJob.findUniqueOrThrow({
      where: { id: current.id },
    });
  });
}

export async function cancelMoAgentGenerationJob(input: {
  projectId: string;
  requestId: string;
  reason?: string | null;
}): Promise<AgentGenerationJob | null> {
  return prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    const current = await lockJob(tx, input.projectId, input.requestId);
    if (!current) return null;
    if (current.status === "cancelled") return current;
    if (
      TERMINAL_STATUSES.has(current.status as MoAgentGenerationDispatchStatus)
    )
      return current;
    await tx.agentGenerationJob.update({
      where: { id: current.id },
      data: {
        status: "cancelled",
        leaseOwner: null,
        leaseExpiresAt: null,
        lastHeartbeatAt: null,
        fencingToken: { increment: 1 },
        version: { increment: 1 },
        eventSequence: { increment: 1 },
        errorCode: "USER_CANCELLED",
        errorMessage: input.reason ?? "用户暂停了当前任务",
        completedAt: now,
      },
    });
    await appendOutboxEvent(
      tx,
      current,
      "generation_cancelled",
      {
        status: "cancelled",
        reason: input.reason ?? "用户暂停了当前任务",
      },
      now,
    );
    return tx.agentGenerationJob.findUniqueOrThrow({
      where: { id: current.id },
    });
  });
}

export async function reconcileExpiredMoAgentGenerationJobs(
  input: {
    projectId?: string;
    limit?: number;
  } = {},
): Promise<AgentGenerationJob[]> {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > 1_000) {
    throw new MoAgentGenerationDispatchError(
      "GENERATION_DISPATCH_INVALID",
      "Reconciliation limit must be between 1 and 1000.",
    );
  }
  const pendingOrphanGraceMs = configuredPendingOrphanGraceMs();
  const projectFilter = input.projectId
    ? Prisma.sql`AND project_id = ${input.projectId}`
    : Prisma.empty;
  const candidates = await prisma.$queryRaw<
    Array<{ projectId: string; requestId: string }>
  >(Prisma.sql`
    SELECT
      project_id AS "projectId",
      request_id AS "requestId"
    FROM agent_generation_jobs
    WHERE (
      (status = 'running' AND lease_expires_at <= clock_timestamp())
      OR
      (
        status IN ('pending', 'retry_wait')
        AND available_at <= clock_timestamp() - (${pendingOrphanGraceMs} * INTERVAL '1 millisecond')
      )
    )
    ${projectFilter}
    ORDER BY COALESCE(lease_expires_at, available_at) ASC
    LIMIT ${limit}
  `);
  const interrupted: AgentGenerationJob[] = [];
  for (const candidate of candidates) {
    const result = await prisma.$transaction(async (tx) => {
      const now = await databaseNow(tx);
      const current = await lockJob(
        tx,
        candidate.projectId,
        candidate.requestId,
      );
      if (!current) {
        return null;
      }
      const expiredRunning =
        current.status === "running" &&
        Boolean(current.leaseExpiresAt && current.leaseExpiresAt <= now);
      const orphanedPending =
        (current.status === "pending" || current.status === "retry_wait") &&
        current.availableAt <= new Date(now.getTime() - pendingOrphanGraceMs);
      if (!expiredRunning && !orphanedPending) return null;
      const [liveGenerationLease, liveRun, mission] = await Promise.all([
        tx.agentGenerationLease.findFirst({
          where: {
            projectId: current.projectId,
            activeRequestId: current.requestId,
            status: "held",
            leaseExpiresAt: { gt: now },
          },
          select: { projectId: true },
        }),
        tx.agentRun.findFirst({
          where: {
            projectId: current.projectId,
            requestId: current.requestId,
            status: { in: ["pending", "running", "reconciling", "waiting"] },
            leaseExpiresAt: { gt: now },
          },
          select: { id: true },
        }),
        tx.agentMission.findUnique({
          where: {
            requestId_projectId: {
              requestId: current.requestId,
              projectId: current.projectId,
            },
          },
        }),
      ]);
      const liveVerification = Boolean(
        mission?.status === "verifying" &&
        mission.verificationLeaseExpiresAt &&
        mission.verificationLeaseExpiresAt > now,
      );
      if (liveGenerationLease || liveRun || liveVerification) {
        // An outer heartbeat can be delayed independently from AgentRun or
        // Mission verification. Never close business state while a finer-
        // grained authoritative lease still proves live ownership.
        return null;
      }
      if (
        process.env.MOAGENT_DISPATCH_MODE === "worker" &&
        current.attemptCount < current.maxAttempts
      ) {
        const availableAt = new Date(now.getTime() + retryDelayMs(current.attemptCount));
        await tx.agentGenerationJob.update({
          where: { id: current.id },
          data: {
            status: "retry_wait",
            availableAt,
            leaseOwner: null,
            leaseExpiresAt: null,
            lastHeartbeatAt: null,
            fencingToken: { increment: 1 },
            version: { increment: 1 },
            eventSequence: { increment: 1 },
            errorCode: expiredRunning
              ? "DISPATCH_LEASE_EXPIRED_RETRY_SCHEDULED"
              : "DISPATCH_PENDING_ORPHAN_RETRY_SCHEDULED",
            errorMessage: "Generation attempt lost its worker; a new attempt has been scheduled.",
            completedAt: null,
          },
        });
        await appendOutboxEvent(
          tx,
          current,
          "generation_retry_scheduled",
          {
            status: "retry_wait",
            attemptCount: current.attemptCount,
            maxAttempts: current.maxAttempts,
            availableAt: availableAt.toISOString(),
            recoveryMode: "replan_required",
          },
          now,
        );
        return tx.agentGenerationJob.findUniqueOrThrow({
          where: { id: current.id },
        });
      }
      const errorCode = expiredRunning
        ? "DISPATCH_LEASE_EXPIRED_REPLAN_REQUIRED"
        : "DISPATCH_PENDING_ORPHAN_REPLAN_REQUIRED";
      await tx.agentGenerationJob.update({
        where: { id: current.id },
        data: {
          status: "interrupted",
          leaseOwner: null,
          leaseExpiresAt: null,
          lastHeartbeatAt: null,
          fencingToken: { increment: 1 },
          version: { increment: 1 },
          eventSequence: { increment: 1 },
          errorCode,
          errorMessage: expiredRunning
            ? "Generation worker lease expired; a new request must replan from durable state."
            : "Generation job was persisted but never claimed; a new request must replan from durable state.",
          completedAt: now,
        },
      });
      await appendOutboxEvent(
        tx,
        current,
        "generation_interrupted",
        {
          status: "interrupted",
          code: errorCode,
          recoveryMode: "replan_required",
        },
        now,
      );
      await tx.userRequest.updateMany({
        where: {
          id: current.requestId,
          projectId: current.projectId,
          status: { in: ["pending", "processing", "active", "running"] },
        },
        data: {
          status: "failed",
          errorMessage:
            "生成 worker 中断；旧 attempt 已封存，请重新发起任务以基于持久化状态重规划。",
          completedAt: now,
        },
      });
      if (
        mission &&
        !["completed", "failed", "cancelled"].includes(mission.status)
      ) {
        const failedMission = await tx.agentMission.updateMany({
          where: {
            id: mission.id,
            version: mission.version,
            status: mission.status,
          },
          data: {
            status: "failed",
            activeSlot: null,
            version: { increment: 1 },
            errorCode,
            errorMessage:
              "Generation worker lease expired; the old Mission was closed before replanning.",
            verificationLeaseOwner: null,
            verificationLeaseExpiresAt: null,
            verificationLastHeartbeatAt: null,
            completedAt: now,
          },
        });
        if (failedMission.count !== 1) {
          throw new MoAgentGenerationDispatchError(
            "GENERATION_DISPATCH_RECONCILIATION_CONFLICT",
            "Mission changed while the expired dispatch was being reconciled.",
            current.projectId,
            current.requestId,
          );
        }
        await tx.agentMissionNode.updateMany({
          where: {
            missionId: mission.id,
            status: { in: ["pending", "running"] },
          },
          data: {
            status: "failed",
            version: { increment: 1 },
            finishedAt: now,
          },
        });
      }
      return tx.agentGenerationJob.findUniqueOrThrow({
        where: { id: current.id },
      });
    });
    if (result) interrupted.push(result);
  }
  return interrupted;
}

export async function listMoAgentGenerationJobs(
  projectId: string,
  limit = 50,
): Promise<AgentGenerationJob[]> {
  assertIdentifier(projectId, "projectId");
  return prisma.agentGenerationJob.findMany({
    where: { projectId },
    orderBy: [{ queuedAt: "desc" }, { id: "desc" }],
    take: Math.max(1, Math.min(limit, 200)),
  });
}

export async function getMoAgentGenerationJob(
  projectId: string,
  requestId: string,
): Promise<AgentGenerationJob | null> {
  assertIdentifier(projectId, "projectId");
  assertIdentifier(requestId, "requestId");
  return prisma.agentGenerationJob.findUnique({
    where: { requestId_projectId: { requestId, projectId } },
  });
}

export async function listClaimableMoAgentGenerationJobs(
  limit = 20,
): Promise<AgentGenerationJob[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new MoAgentGenerationDispatchError(
      "GENERATION_DISPATCH_INVALID",
      "Claimable generation job limit must be between 1 and 200.",
    );
  }
  const candidates = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    WITH ranked AS (
      SELECT
        "job"."id",
        "job"."available_at",
        "job"."queued_at",
        ROW_NUMBER() OVER (
          PARTITION BY COALESCE(
            "request"."actor_user_id",
            'workspace:' || "job"."project_id"
          )
          ORDER BY
            "job"."available_at" ASC,
            "job"."queued_at" ASC,
            "job"."id" ASC
        ) AS "actor_rank"
      FROM "agent_generation_jobs" AS "job"
      INNER JOIN "user_requests" AS "request"
        ON "request"."id" = "job"."request_id"
       AND "request"."project_id" = "job"."project_id"
      WHERE "job"."status" IN ('pending', 'retry_wait')
        AND "job"."available_at" <= clock_timestamp()
    )
    SELECT "id"
    FROM ranked
    ORDER BY
      "actor_rank" ASC,
      "available_at" ASC,
      "queued_at" ASC,
      "id" ASC
    LIMIT ${limit}
  `);
  if (candidates.length === 0) return [];
  const jobs = await prisma.agentGenerationJob.findMany({
    where: { id: { in: candidates.map((candidate) => candidate.id) } },
  });
  const jobsById = new Map(jobs.map((job) => [job.id, job]));
  return candidates.flatMap((candidate) => {
    const job = jobsById.get(candidate.id);
    return job ? [job] : [];
  });
}

export async function listPendingMoAgentGenerationOutboxEvents(
  projectId: string,
  limit = 200,
): Promise<AgentGenerationOutboxEvent[]> {
  assertIdentifier(projectId, "projectId");
  return prisma.agentGenerationOutboxEvent.findMany({
    where: { projectId, publishedAt: null },
    orderBy: [{ createdAt: "asc" }, { sequence: "asc" }],
    take: Math.max(1, Math.min(limit, 1_000)),
  });
}

export async function markMoAgentGenerationOutboxEventsPublished(
  eventIds: readonly string[],
): Promise<number> {
  if (eventIds.length === 0) return 0;
  const result = await prisma.agentGenerationOutboxEvent.updateMany({
    where: { id: { in: [...eventIds] }, publishedAt: null },
    data: { publishedAt: new Date() },
  });
  return result.count;
}
