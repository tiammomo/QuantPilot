import { createHash } from 'node:crypto';

import type { Prisma } from '@prisma/client';

import {
  clonePublicRuntimeJson,
  type RuntimeJsonObject,
} from '@/lib/agent/runtime';
import type {
  MoAgentToolApprovalDecision,
  MoAgentToolApprovalHandler,
  MoAgentToolApprovalRequest,
  MoAgentToolApprovalResolution,
} from '@/lib/agent/types';
import { prisma } from '@/lib/db/client';

const DEFAULT_POLL_INTERVAL_MS = 500;
const MAX_APPROVAL_LIST_LIMIT = 200;
const APPROVAL_ID_PATTERN = /^approval_[A-Za-z0-9_-]{12,128}$/;
const ACTOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/@=-]{0,255}$/;

type ApprovalStatus = 'pending' | 'approved' | 'edited' | 'rejected' | 'expired';

export class MoAgentToolApprovalStoreError extends Error {
  constructor(
    readonly code:
      | 'INVALID_APPROVAL'
      | 'APPROVAL_NOT_FOUND'
      | 'APPROVAL_CONFLICT'
      | 'APPROVAL_EXPIRED',
    message: string,
  ) {
    super(message);
    this.name = 'MoAgentToolApprovalStoreError';
  }
}

function assertApprovalId(value: string): string {
  if (!APPROVAL_ID_PATTERN.test(value)) {
    throw new MoAgentToolApprovalStoreError(
      'INVALID_APPROVAL',
      'Approval ID is invalid.',
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) =>
      `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`
    )
    .join(',')}}`;
}

function publicInput(value: unknown, label: string): RuntimeJsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MoAgentToolApprovalStoreError(
      'INVALID_APPROVAL',
      `${label} must be a JSON object.`,
    );
  }
  return clonePublicRuntimeJson(value as RuntimeJsonObject, label);
}

function abortError(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

async function waitForPoll(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) throw abortError(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reject(abortError(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function assertRequestIdentity(
  request: MoAgentToolApprovalRequest,
  record: {
    runId: string;
    turn: number;
    toolCallIdHash: string;
    toolName: string;
    effect: string;
    idempotency: string;
    inputHash: string;
    publicInput: Prisma.JsonValue;
    reason: string;
    allowedDecisions: string[];
    requestedAt: Date;
    expiresAt: Date;
  },
): void {
  const expectedToolCallIdHash = `sha256:${createHash('sha256')
    .update(request.toolCallId, 'utf8')
    .digest('hex')}`;
  if (
    record.runId !== request.runId ||
    record.turn !== request.turn ||
    record.toolCallIdHash !== expectedToolCallIdHash ||
    record.toolName !== request.toolName ||
    record.effect !== request.effect ||
    record.idempotency !== request.idempotency ||
    record.inputHash !== `sha256:${request.inputSha256}` ||
    canonicalJson(record.publicInput) !== canonicalJson(request.publicInput) ||
    record.reason !== request.reason ||
    canonicalJson(record.allowedDecisions) !==
      canonicalJson(request.allowedDecisions) ||
    record.requestedAt.getTime() !== request.requestedAt ||
    record.expiresAt.getTime() !== request.expiresAt
  ) {
    throw new MoAgentToolApprovalStoreError(
      'APPROVAL_CONFLICT',
      `Approval ${request.approvalId} is already bound to a different request.`,
    );
  }
}

async function createApproval(request: MoAgentToolApprovalRequest): Promise<void> {
  assertApprovalId(request.approvalId);
  const projectedInput = publicInput(
    request.publicInput,
    'MoAgent approval public input',
  );
  const toolCallIdHash = `sha256:${createHash('sha256')
    .update(request.toolCallId, 'utf8')
    .digest('hex')}`;
  const record = await prisma.agentToolApproval.upsert({
    where: { id: request.approvalId },
    update: {},
    create: {
      id: request.approvalId,
      runId: request.runId,
      turn: request.turn,
      toolCallIdHash,
      toolName: request.toolName,
      effect: request.effect,
      idempotency: request.idempotency,
      inputHash: `sha256:${request.inputSha256}`,
      publicInput: projectedInput as Prisma.InputJsonValue,
      reason: request.reason,
      allowedDecisions: [...request.allowedDecisions],
      requestedAt: new Date(request.requestedAt),
      expiresAt: new Date(request.expiresAt),
    },
  });
  assertRequestIdentity(request, record);
}

async function expireApproval(approvalId: string): Promise<void> {
  await prisma.$executeRaw`
    UPDATE "agent_tool_approvals" AS "approval"
    SET
      "status" = 'expired',
      "resolved_at" = CURRENT_TIMESTAMP,
      "updated_at" = CURRENT_TIMESTAMP
    FROM "agent_runs" AS "run"
    WHERE
      "approval"."id" = ${approvalId}
      AND "approval"."run_id" = "run"."id"
      AND "approval"."status" = 'pending'
      AND (
        "approval"."expires_at" <= CURRENT_TIMESTAMP
        OR "run"."status" <> 'waiting'
      )
  `;
}

function storedResolution(record: {
  status: string;
  editedInput: Prisma.JsonValue | null;
  resolvedByActorId: string | null;
}): MoAgentToolApprovalResolution | null {
  const status = record.status as ApprovalStatus;
  if (status === 'pending') return null;
  if (status === 'expired') {
    return { decision: 'reject', resolvedBy: 'expired' };
  }
  if (!record.resolvedByActorId) {
    throw new MoAgentToolApprovalStoreError(
      'APPROVAL_CONFLICT',
      'Resolved approval is missing its actor principal.',
    );
  }
  if (status === 'approved') {
    return {
      decision: 'approve',
      resolvedBy: record.resolvedByActorId,
    };
  }
  if (status === 'rejected') {
    return {
      decision: 'reject',
      resolvedBy: record.resolvedByActorId,
    };
  }
  if (status === 'edited' && record.editedInput) {
    return {
      decision: 'edit',
      editedInput: publicInput(
        record.editedInput,
        'MoAgent stored edited approval input',
      ),
      resolvedBy: record.resolvedByActorId,
    };
  }
  throw new MoAgentToolApprovalStoreError(
    'APPROVAL_CONFLICT',
    'Approval has an invalid durable resolution state.',
  );
}

export function createPrismaMoAgentToolApprovalHandler(
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
): MoAgentToolApprovalHandler {
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0 || pollIntervalMs > 10_000) {
    throw new Error('MoAgent approval poll interval must be between 1 and 10000 ms.');
  }
  return async (
    request: MoAgentToolApprovalRequest,
    context: { signal: AbortSignal },
  ): Promise<MoAgentToolApprovalResolution> => {
    await createApproval(request);
    while (true) {
      if (context.signal.aborted) throw abortError(context.signal);
      await expireApproval(request.approvalId);
      const record = await prisma.agentToolApproval.findUnique({
        where: { id: request.approvalId },
        select: {
          status: true,
          editedInput: true,
          resolvedByActorId: true,
        },
      });
      if (!record) {
        throw new MoAgentToolApprovalStoreError(
          'APPROVAL_NOT_FOUND',
          'Approval disappeared while the Worker was waiting.',
        );
      }
      const resolution = storedResolution(record);
      if (resolution) return resolution;
      await waitForPoll(context.signal, pollIntervalMs);
    }
  };
}

export async function resolveMoAgentToolApproval(input: {
  projectId: string;
  approvalId: string;
  actorId: string;
  actorUserId?: string;
  decision: MoAgentToolApprovalDecision;
  editedInput?: unknown;
}): Promise<{
  approvalId: string;
  status: ApprovalStatus;
  decision: MoAgentToolApprovalDecision;
  resolvedAt: Date;
}> {
  const approvalId = assertApprovalId(input.approvalId);
  if (
    !ACTOR_ID_PATTERN.test(input.actorId) ||
    (input.actorUserId !== undefined && input.actorUserId !== input.actorId)
  ) {
    throw new MoAgentToolApprovalStoreError(
      'INVALID_APPROVAL',
      'Approval actor identity is invalid.',
    );
  }
  const editedInput = input.decision === 'edit'
    ? publicInput(input.editedInput, 'MoAgent approval edited input')
    : undefined;
  if (input.decision !== 'edit' && input.editedInput !== undefined) {
    throw new MoAgentToolApprovalStoreError(
      'INVALID_APPROVAL',
      'editedInput is allowed only for an edit decision.',
    );
  }

  const outcome = await prisma.$transaction(async (tx) => {
    const existing = await tx.agentToolApproval.findUnique({
      where: { id: approvalId },
      include: { run: { select: { projectId: true, status: true } } },
    });
    if (!existing || existing.run.projectId !== input.projectId) {
      throw new MoAgentToolApprovalStoreError(
        'APPROVAL_NOT_FOUND',
        'Approval was not found for this project.',
      );
    }
    if (
      !existing.allowedDecisions.includes(input.decision) ||
      (input.decision === 'edit' && !editedInput)
    ) {
      throw new MoAgentToolApprovalStoreError(
        'INVALID_APPROVAL',
        `Decision "${input.decision}" is not allowed for this approval.`,
      );
    }
    const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT CURRENT_TIMESTAMP AS "now"
    `;
    if (!now) throw new Error('Database clock query returned no value.');
    if (existing.status !== 'pending') {
      throw new MoAgentToolApprovalStoreError(
        'APPROVAL_CONFLICT',
        `Approval is already ${existing.status}.`,
      );
    }
    if (existing.expiresAt <= now || existing.run.status !== 'waiting') {
      await tx.agentToolApproval.update({
        where: { id: approvalId },
        data: { status: 'expired', resolvedAt: now },
      });
      return { expired: true as const };
    }

    const status: ApprovalStatus =
      input.decision === 'approve'
        ? 'approved'
        : input.decision === 'edit'
          ? 'edited'
          : 'rejected';
    const updated = await tx.agentToolApproval.updateMany({
      where: {
        id: approvalId,
        status: 'pending',
        expiresAt: { gt: now },
      },
      data: {
        status,
        decision: input.decision,
        ...(editedInput
          ? { editedInput: editedInput as Prisma.InputJsonValue }
          : {}),
        resolvedByActorId: input.actorId,
        resolvedByUserId: input.actorUserId ?? null,
        resolvedAt: now,
      },
    });
    if (updated.count !== 1) {
      throw new MoAgentToolApprovalStoreError(
        'APPROVAL_CONFLICT',
        'Approval changed concurrently.',
      );
    }
    return {
      expired: false as const,
      result: {
        approvalId,
        status,
        decision: input.decision,
        resolvedAt: now,
      },
    };
  });
  if (outcome.expired) {
    throw new MoAgentToolApprovalStoreError(
      'APPROVAL_EXPIRED',
      'Approval has expired.',
    );
  }
  return outcome.result;
}

export async function listMoAgentToolApprovals(input: {
  projectId: string;
  runId?: string;
  status?: ApprovalStatus;
  limit?: number;
}) {
  const limit = Math.min(
    Math.max(1, input.limit ?? 50),
    MAX_APPROVAL_LIST_LIMIT,
  );
  await prisma.$executeRaw`
    UPDATE "agent_tool_approvals" AS "approval"
    SET
      "status" = 'expired',
      "resolved_at" = CURRENT_TIMESTAMP,
      "updated_at" = CURRENT_TIMESTAMP
    FROM "agent_runs" AS "run"
    WHERE
      "approval"."run_id" = "run"."id"
      AND "run"."project_id" = ${input.projectId}
      AND "approval"."status" = 'pending'
      AND (
        "approval"."expires_at" <= CURRENT_TIMESTAMP
        OR "run"."status" <> 'waiting'
      )
  `;
  const scope = {
    run: { projectId: input.projectId },
    ...(input.runId ? { runId: input.runId } : {}),
  };
  const select = {
    id: true,
    runId: true,
    turn: true,
    toolName: true,
    effect: true,
    idempotency: true,
    inputHash: true,
    publicInput: true,
    reason: true,
    allowedDecisions: true,
    status: true,
    decision: true,
    resolvedByActorId: true,
    resolvedByUserId: true,
    requestedAt: true,
    expiresAt: true,
    resolvedAt: true,
  } as const;
  const pending = input.status === undefined || input.status === 'pending'
    ? await prisma.agentToolApproval.findMany({
        where: { ...scope, status: input.status ?? 'pending' },
        orderBy: { requestedAt: 'desc' },
        take: limit,
        select,
      })
    : [];
  const remaining = limit - pending.length;
  const resolved = remaining > 0 && input.status !== 'pending'
    ? await prisma.agentToolApproval.findMany({
        where: {
          ...scope,
          ...(input.status
            ? { status: input.status }
            : { status: { not: 'pending' } }),
        },
        orderBy: { requestedAt: 'desc' },
        take: remaining,
        select,
      })
    : [];
  const records = [...pending, ...resolved];
  const priority: Record<ApprovalStatus, number> = {
    pending: 0,
    edited: 1,
    approved: 2,
    rejected: 3,
    expired: 4,
  };
  return records
    .map((record) => ({
      ...record,
      status: record.status as ApprovalStatus,
      decision: record.decision as MoAgentToolApprovalDecision | null,
    }))
    .sort((left, right) =>
      priority[left.status] - priority[right.status] ||
      right.requestedAt.getTime() - left.requestedAt.getTime()
    );
}

export async function readMoAgentRunTimeline(input: {
  projectId: string;
  runId: string;
  afterSequence?: number;
  limit?: number;
}) {
  const afterSequence = Math.max(0, input.afterSequence ?? 0);
  const limit = Math.min(Math.max(1, input.limit ?? 200), 1_000);
  await prisma.$executeRaw`
    UPDATE "agent_tool_approvals" AS "approval"
    SET
      "status" = 'expired',
      "resolved_at" = CURRENT_TIMESTAMP,
      "updated_at" = CURRENT_TIMESTAMP
    FROM "agent_runs" AS "run"
    WHERE
      "approval"."run_id" = "run"."id"
      AND "run"."project_id" = ${input.projectId}
      AND "run"."id" = ${input.runId}
      AND "approval"."status" = 'pending'
      AND (
        "approval"."expires_at" <= CURRENT_TIMESTAMP
        OR "run"."status" <> 'waiting'
      )
  `;
  const run = await prisma.agentRun.findFirst({
    where: { id: input.runId, projectId: input.projectId },
    select: {
      id: true,
      runInstanceId: true,
      requestId: true,
      status: true,
      provider: true,
      model: true,
      frameworkVersion: true,
      buildRevision: true,
      turnCount: true,
      inputTokens: true,
      outputTokens: true,
      totalTokens: true,
      cachedInputTokens: true,
      cacheMissInputTokens: true,
      reasoningTokens: true,
      lastEventSequence: true,
      latestCheckpointSequence: true,
      errorCode: true,
      startedAt: true,
      finishedAt: true,
      createdAt: true,
      updatedAt: true,
      events: {
        where: { sequence: { gt: afterSequence } },
        orderBy: { sequence: 'asc' },
        take: limit,
        select: {
          eventId: true,
          sequence: true,
          eventType: true,
          payload: true,
          occurredAt: true,
        },
      },
      checkpoints: {
        orderBy: { sequence: 'desc' },
        take: 1,
        select: {
          sequence: true,
          turn: true,
          boundary: true,
          recoveryMode: true,
          publicState: true,
          stateHash: true,
          stateVersion: true,
          createdAt: true,
        },
      },
      toolApprovals: {
        orderBy: { requestedAt: 'desc' },
        select: {
          id: true,
          turn: true,
          toolName: true,
          effect: true,
          inputHash: true,
          publicInput: true,
          reason: true,
          allowedDecisions: true,
          status: true,
          decision: true,
          resolvedByActorId: true,
          resolvedByUserId: true,
          requestedAt: true,
          expiresAt: true,
          resolvedAt: true,
        },
      },
    },
  });
  if (!run) return null;
  const [latestCheckpoint = null] = run.checkpoints;
  return {
    ...run,
    checkpoints: undefined,
    latestCheckpoint,
    hasMoreEvents:
      run.events.length === limit &&
      run.events[run.events.length - 1]!.sequence < run.lastEventSequence,
  };
}
