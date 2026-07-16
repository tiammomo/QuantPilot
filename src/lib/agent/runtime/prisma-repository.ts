import type {
  AgentCheckpoint as PrismaAgentCheckpoint,
  AgentEvent as PrismaAgentEvent,
  AgentRun as PrismaAgentRun,
  AgentToolExecution as PrismaAgentToolExecution,
  AgentWorkspaceLease as PrismaAgentWorkspaceLease,
  PrismaClient,
} from '@prisma/client';
import { Prisma } from '@prisma/client';
import { AgentRuntimeRepositoryError } from './errors';
import {
  assertBoundedIdentifier,
  assertFutureDate,
  assertHash,
  assertNonNegativeInteger,
  assertOpaqueCheckpointState,
  assertPositiveInteger,
  assertUuid,
  assertValidDate,
  clonePublicRuntimeJson,
  isAgentRunStatus,
  isCheckpointBoundary,
  isToolEffect,
  isToolExecutionStatus,
  isToolIdempotency,
} from './policy';
import type { AgentRuntimeRepository } from './repository';
import type {
  AgentCheckpointRecord,
  AgentEventRecord,
  AgentReconciliationCandidate,
  AgentRunRecord,
  AgentToolExecutionRecord,
  AgentWorkspaceLeaseRecord,
  AgentTokenUsage,
  AgentWriteFence,
  AppendAgentEventInput,
  AppendAgentEventResult,
  ClaimAgentRunLeaseInput,
  CompleteAgentRunInput,
  CompleteAgentToolExecutionInput,
  CompleteAgentToolExecutionResult,
  CommitAgentWorkspaceMutationInput,
  CreateAgentRunInput,
  HeartbeatAgentRunInput,
  PrepareAgentToolExecutionInput,
  PrepareAgentToolExecutionResult,
  ReconciliationQuery,
  RuntimeJson,
  RuntimeJsonObject,
  SaveAgentCheckpointInput,
  SaveAgentCheckpointResult,
} from './types';

const ACTIVE_STATUSES = ['pending', 'running', 'reconciling', 'waiting'] as const;
const TERMINAL_STATUSES = [
  'candidate_complete',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'interrupted',
];
const UNRESOLVED_TOOL_STATUSES = ['prepared', 'commit_authorized', 'uncertain'];
const WORKSPACE_LEASE_STATUSES = ['free', 'held', 'reconciling'] as const;

type RuntimeTransactionClient = Prisma.TransactionClient;

function isUniqueConflict(error: unknown): error is Prisma.PrismaClientKnownRequestError {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
  );
}

function jsonInput(value: RuntimeJsonObject): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

function canonicalJson(value: RuntimeJson): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function mapRun(record: PrismaAgentRun): AgentRunRecord {
  if (!isAgentRunStatus(record.status)) {
    throw new AgentRuntimeRepositoryError(
      'INVALID_STATE',
      `Database contains unknown agent run status ${record.status}.`
    );
  }
  return { ...record, status: record.status };
}

function mapEvent(record: PrismaAgentEvent): AgentEventRecord {
  return {
    ...record,
    payload: clonePublicRuntimeJson(
      record.payload as unknown as RuntimeJsonObject,
      'agent event payload'
    ),
  };
}

function mapCheckpoint(record: PrismaAgentCheckpoint): AgentCheckpointRecord {
  if (!isCheckpointBoundary(record.boundary) || record.recoveryMode !== 'replan_required') {
    throw new AgentRuntimeRepositoryError(
      'INVALID_STATE',
      'Database contains an unsupported checkpoint boundary or recovery mode.'
    );
  }
  if (
    record.opaqueCodec !== null &&
    record.opaqueCodec !== 'reference-v1' &&
    record.opaqueCodec !== 'sealed-v1'
  ) {
    throw new AgentRuntimeRepositoryError(
      'INVALID_STATE',
      'Database contains an unsupported checkpoint opaque codec.'
    );
  }
  return {
    ...record,
    boundary: record.boundary,
    recoveryMode: 'replan_required',
    publicState: clonePublicRuntimeJson(
      record.publicState as unknown as RuntimeJsonObject,
      'checkpoint public state'
    ),
    opaqueCodec: record.opaqueCodec,
  };
}

function mapToolExecution(record: PrismaAgentToolExecution): AgentToolExecutionRecord {
  if (
    !isToolEffect(record.effect) ||
    !isToolIdempotency(record.idempotency) ||
    !isToolExecutionStatus(record.status)
  ) {
    throw new AgentRuntimeRepositoryError(
      'INVALID_STATE',
      'Database contains an unsupported tool execution policy or status.'
    );
  }
  return {
    ...record,
    effect: record.effect,
    idempotency: record.idempotency,
    status: record.status,
    resultReceipt: record.resultReceipt
      ? clonePublicRuntimeJson(
          record.resultReceipt as unknown as RuntimeJsonObject,
          'tool result receipt'
        )
      : null,
  };
}

function mapWorkspaceLease(record: PrismaAgentWorkspaceLease): AgentWorkspaceLeaseRecord {
  if (!(WORKSPACE_LEASE_STATUSES as readonly string[]).includes(record.status)) {
    throw new AgentRuntimeRepositoryError(
      'INVALID_STATE',
      `Database contains unknown workspace lease status ${record.status}.`
    );
  }
  return {
    ...record,
    status: record.status as AgentWorkspaceLeaseRecord['status'],
  };
}

function assertUsage(usage: AgentTokenUsage): void {
  assertNonNegativeInteger(usage.inputTokens, 'usage.inputTokens');
  assertNonNegativeInteger(usage.outputTokens, 'usage.outputTokens');
  assertNonNegativeInteger(usage.totalTokens, 'usage.totalTokens');
  assertNonNegativeInteger(usage.cachedInputTokens, 'usage.cachedInputTokens');
  assertNonNegativeInteger(usage.cacheMissInputTokens, 'usage.cacheMissInputTokens');
  assertNonNegativeInteger(usage.reasoningTokens, 'usage.reasoningTokens');
  if (usage.totalTokens < usage.inputTokens || usage.totalTokens < usage.outputTokens) {
    throw new AgentRuntimeRepositoryError(
      'INVALID_STATE',
      'usage.totalTokens cannot be smaller than inputTokens or outputTokens.'
    );
  }
}

function leaseDurationMs(expiresAt: Date, now: Date, label: string): number {
  assertFutureDate(expiresAt, now, label);
  const duration = expiresAt.getTime() - now.getTime();
  if (!Number.isSafeInteger(duration) || duration <= 0) {
    throw new AgentRuntimeRepositoryError('INVALID_STATE', `${label} duration is invalid.`);
  }
  return duration;
}

function databaseLeaseExpiry(now: Date, durationMs: number): Date {
  return new Date(now.getTime() + durationMs);
}

function assertToolIdentity(
  existing: AgentToolExecutionRecord,
  input: PrepareAgentToolExecutionInput
): void {
  if (
    existing.runId !== input.runId ||
    existing.toolCallId !== input.toolCallId ||
    existing.toolName !== input.toolName ||
    existing.inputHash !== input.inputHash ||
    existing.effect !== input.effect ||
    existing.idempotency !== input.idempotency ||
    existing.idempotencyKey !== (input.idempotencyKey ?? null) ||
    (input.preStateHash !== undefined && existing.preStateHash !== input.preStateHash)
  ) {
    throw new AgentRuntimeRepositoryError(
      'OPERATION_CONFLICT',
      `operationId ${input.operationId} is already bound to a different tool operation.`
    );
  }
}

function fenceWhere(input: AgentWriteFence, now: Date): Prisma.AgentRunWhereInput {
  return {
    id: input.runId,
    version: input.expectedVersion,
    leaseOwner: input.leaseOwner,
    fencingToken: input.fencingToken,
    workspaceFencingToken: input.workspaceFencingToken,
    leaseExpiresAt: { gt: now },
    status: { in: [...ACTIVE_STATUSES] },
    project: {
      agentWorkspaceLease: {
        is: {
          status: 'held',
          activeRunId: input.runId,
          leaseOwner: input.leaseOwner,
          fencingToken: input.workspaceFencingToken,
          leaseExpiresAt: { gt: now },
        },
      },
    },
  };
}

async function requireWorkspaceFence(
  client: RuntimeTransactionClient | PrismaClient,
  run: PrismaAgentRun,
  input: AgentWriteFence,
  now: Date
): Promise<PrismaAgentWorkspaceLease> {
  const lease = await client.agentWorkspaceLease.findUnique({
    where: { projectId: run.projectId },
  });
  if (
    !lease ||
    lease.status !== 'held' ||
    lease.workspaceKey !== run.workspaceKey ||
    lease.activeRunId !== run.id ||
    lease.leaseOwner !== input.leaseOwner ||
    lease.fencingToken !== input.workspaceFencingToken ||
    run.workspaceFencingToken !== input.workspaceFencingToken ||
    !lease.leaseExpiresAt ||
    lease.leaseExpiresAt <= now
  ) {
    throw new AgentRuntimeRepositoryError('LEASE_LOST', 'Workspace lease was lost.');
  }
  return lease;
}

async function diagnoseFence(
  client: RuntimeTransactionClient | PrismaClient,
  input: AgentWriteFence,
  now: Date
): Promise<never> {
  const run = await client.agentRun.findUnique({ where: { id: input.runId } });
  if (!run) {
    throw new AgentRuntimeRepositoryError('NOT_FOUND', 'Agent run was not found.');
  }
  if (run.version !== input.expectedVersion) {
    throw new AgentRuntimeRepositoryError('CONFLICT', 'Agent run version changed.');
  }
  if (
    run.leaseOwner !== input.leaseOwner ||
    run.fencingToken !== input.fencingToken ||
    !run.leaseExpiresAt ||
    run.leaseExpiresAt <= now
  ) {
    throw new AgentRuntimeRepositoryError('LEASE_LOST', 'Agent run lease was lost.');
  }
  await requireWorkspaceFence(client, run, input, now);
  if (!(ACTIVE_STATUSES as readonly string[]).includes(run.status)) {
    throw new AgentRuntimeRepositoryError('INVALID_STATE', 'Agent run is terminal.');
  }
  throw new AgentRuntimeRepositoryError('CONFLICT', 'Agent run state changed.');
}

async function assertReplayLease(
  client: RuntimeTransactionClient | PrismaClient,
  input: AgentWriteFence,
  now: Date
): Promise<PrismaAgentRun> {
  const run = await client.agentRun.findUnique({ where: { id: input.runId } });
  if (!run) {
    throw new AgentRuntimeRepositoryError('NOT_FOUND', 'Agent run was not found.');
  }
  if (input.expectedVersion > run.version) {
    throw new AgentRuntimeRepositoryError('CONFLICT', 'Agent run version is ahead of storage.');
  }
  if (
    run.leaseOwner !== input.leaseOwner ||
    run.fencingToken !== input.fencingToken ||
    !run.leaseExpiresAt ||
    run.leaseExpiresAt <= now
  ) {
    throw new AgentRuntimeRepositoryError('LEASE_LOST', 'Agent run lease was lost.');
  }
  await requireWorkspaceFence(client, run, input, now);
  if (!(ACTIVE_STATUSES as readonly string[]).includes(run.status)) {
    throw new AgentRuntimeRepositoryError('INVALID_STATE', 'Agent run is terminal.');
  }
  return run;
}

async function lockWorkspaceLease(
  tx: RuntimeTransactionClient,
  projectId: string
): Promise<PrismaAgentWorkspaceLease> {
  const rows = await tx.$queryRaw<PrismaAgentWorkspaceLease[]>(Prisma.sql`
    SELECT
      project_id AS "projectId",
      workspace_key AS "workspaceKey",
      status,
      active_run_id AS "activeRunId",
      lease_owner AS "leaseOwner",
      lease_expires_at AS "leaseExpiresAt",
      last_heartbeat_at AS "lastHeartbeatAt",
      fencing_token AS "fencingToken",
      version,
      acquired_at AS "acquiredAt",
      released_at AS "releasedAt",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM agent_workspace_leases
    WHERE project_id = ${projectId}
    FOR UPDATE
  `);
  const lease = rows[0];
  if (!lease) {
    throw new AgentRuntimeRepositoryError('NOT_FOUND', 'Workspace lease was not found.');
  }
  return lease;
}

async function databaseNow(
  client: RuntimeTransactionClient | PrismaClient
): Promise<Date> {
  const rows = await client.$queryRaw<Array<{ databaseNow: Date }>>(Prisma.sql`
    SELECT clock_timestamp() AS "databaseNow"
  `);
  const value = rows[0]?.databaseNow;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new AgentRuntimeRepositoryError('INVALID_STATE', 'Database clock is unavailable.');
  }
  return value;
}

async function lockAgentRun(
  tx: RuntimeTransactionClient,
  runId: string
): Promise<PrismaAgentRun> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM agent_runs
    WHERE id = ${runId}
    FOR UPDATE
  `);
  if (!rows[0]) {
    throw new AgentRuntimeRepositoryError('NOT_FOUND', 'Agent run was not found.');
  }
  return tx.agentRun.findUniqueOrThrow({ where: { id: runId } });
}

async function lockToolExecution(
  tx: RuntimeTransactionClient,
  operationId: string
): Promise<PrismaAgentToolExecution> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT id
    FROM agent_tool_executions
    WHERE operation_id = ${operationId}
    FOR UPDATE
  `);
  if (!rows[0]) {
    throw new AgentRuntimeRepositoryError(
      'OPERATION_CONFLICT',
      'Workspace mutation is not backed by a prepared operation ledger entry.'
    );
  }
  return tx.agentToolExecution.findUniqueOrThrow({ where: { operationId } });
}

async function acquireWorkspaceLease(
  tx: RuntimeTransactionClient,
  input: {
    projectId: string;
    workspaceKey: string;
    runId: string;
    leaseOwner: string;
    leaseTtlMs: number;
    blockUnresolvedMutations: boolean;
  }
): Promise<PrismaAgentWorkspaceLease> {
  // Prisma's generated upsert can race on the first lease row and surface a
  // project_id P2002 before either transaction reaches the row lock. Native
  // ON CONFLICT makes creation idempotent; the locked read below remains the
  // single authority for busy/binding decisions across processes. Suppressing
  // either unique conflict also lets us map workspace aliases deliberately.
  await tx.$executeRaw(Prisma.sql`
    INSERT INTO agent_workspace_leases (
      project_id,
      workspace_key,
      status,
      fencing_token,
      version,
      created_at,
      updated_at
    ) VALUES (
      ${input.projectId},
      ${input.workspaceKey},
      'free',
      0,
      0,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )
    ON CONFLICT DO NOTHING
  `);
  let current: PrismaAgentWorkspaceLease;
  try {
    current = await lockWorkspaceLease(tx, input.projectId);
  } catch (error) {
    // A conflict on workspace_key suppresses the insert but cannot create a
    // row for this project. Treat that state as an explicit canonical binding
    // conflict instead of leaking a raw SQL/Prisma error.
    if (error instanceof AgentRuntimeRepositoryError && error.code === 'NOT_FOUND') {
      throw new AgentRuntimeRepositoryError(
        'WORKSPACE_BINDING_CONFLICT',
        'Canonical workspace is already bound to another project.'
      );
    }
    throw error;
  }
  const now = await databaseNow(tx);
  const leaseExpiresAt = databaseLeaseExpiry(now, input.leaseTtlMs);
  if (current.workspaceKey !== input.workspaceKey) {
    throw new AgentRuntimeRepositoryError(
      'WORKSPACE_BINDING_CONFLICT',
      'Project is already bound to a different canonical workspace.'
    );
  }
  if (
    current.status === 'held' &&
    current.leaseOwner &&
    current.leaseExpiresAt &&
    current.leaseExpiresAt > now
  ) {
    throw new AgentRuntimeRepositoryError('WORKSPACE_BUSY', 'Workspace lease is still active.');
  }

  if (input.blockUnresolvedMutations) {
    const unresolved = await tx.agentToolExecution.findFirst({
      where: {
        run: { projectId: input.projectId },
        status: { in: UNRESOLVED_TOOL_STATUSES },
        effect: { in: ['workspace_write', 'external_write'] },
      },
      select: { operationId: true },
    });
    if (unresolved) {
      throw new AgentRuntimeRepositoryError(
        'RECONCILIATION_REQUIRED',
        'Workspace has unresolved mutating operations.'
      );
    }
  }

  if (current.activeRunId && current.activeRunId !== input.runId) {
    await tx.agentRun.updateMany({
      where: {
        id: current.activeRunId,
        status: { in: [...ACTIVE_STATUSES] },
      },
      data: {
        status: 'interrupted',
        errorCode: 'WORKSPACE_LEASE_EXPIRED_REPLAN_REQUIRED',
        errorMessage: 'Expired workspace owner was fenced by a new replan run.',
        finishedAt: now,
        leaseOwner: null,
        leaseExpiresAt: null,
        version: { increment: 1 },
      },
    });
  }

  return tx.agentWorkspaceLease.update({
    where: { projectId: input.projectId },
    data: {
      status: 'held',
      activeRunId: input.runId,
      leaseOwner: input.leaseOwner,
      leaseExpiresAt,
      lastHeartbeatAt: now,
      fencingToken: { increment: 1 },
      version: { increment: 1 },
      acquiredAt: now,
      releasedAt: null,
    },
  });
}

export class PrismaAgentRuntimeRepository implements AgentRuntimeRepository {
  constructor(
    private readonly client: PrismaClient,
    private readonly clock: () => Date = () => new Date()
  ) {}

  async createRun(input: CreateAgentRunInput): Promise<AgentRunRecord> {
    assertBoundedIdentifier(input.id, 'run.id');
    assertBoundedIdentifier(input.projectId, 'run.projectId');
    assertHash(input.workspaceKey, 'run.workspaceKey');
    if (input.requestId !== undefined) {
      assertBoundedIdentifier(input.requestId, 'run.requestId');
    }
    assertBoundedIdentifier(input.provider, 'run.provider');
    assertBoundedIdentifier(input.model, 'run.model');
    assertBoundedIdentifier(input.frameworkVersion, 'run.frameworkVersion');
    assertBoundedIdentifier(input.buildRevision, 'run.buildRevision');
    assertHash(input.profileHash, 'run.profileHash');
    assertHash(input.promptHash, 'run.promptHash');
    assertHash(input.toolHash, 'run.toolHash');
    assertHash(input.skillHash, 'run.skillHash');
    assertHash(input.workspaceHash, 'run.workspaceHash');
    if (input.runInstanceId !== undefined) {
      assertUuid(input.runInstanceId, 'run.runInstanceId');
    }

    const callerNow = this.clock();
    const hasLeaseOwner = input.leaseOwner !== undefined;
    const hasLeaseExpiry = input.leaseExpiresAt !== undefined;
    if (hasLeaseOwner !== hasLeaseExpiry) {
      throw new AgentRuntimeRepositoryError(
        'INVALID_STATE',
        'leaseOwner and leaseExpiresAt must be supplied together.'
      );
    }
    const leaseTtlMs = input.leaseExpiresAt
      ? leaseDurationMs(input.leaseExpiresAt, callerNow, 'run.leaseExpiresAt')
      : null;
    if (input.leaseOwner !== undefined) {
      assertBoundedIdentifier(input.leaseOwner, 'run.leaseOwner');
    }
    if (
      input.status !== undefined &&
      !(ACTIVE_STATUSES as readonly string[]).includes(input.status)
    ) {
      throw new AgentRuntimeRepositoryError('INVALID_STATE', 'Initial run status must be active.');
    }
    if (input.startedAt) assertValidDate(input.startedAt, 'run.startedAt');

    try {
      const record = await this.client.$transaction(async (tx) => {
        let actorUserId: string | null = null;
        if (input.requestId !== undefined) {
          const request = await tx.userRequest.findUnique({
            where: { id: input.requestId },
            select: { projectId: true, actorUserId: true },
          });
          if (!request || request.projectId !== input.projectId) {
            throw new AgentRuntimeRepositoryError(
              'INVALID_STATE',
              'Agent run requestId is not bound to the same project.'
            );
          }
          actorUserId = request.actorUserId;
        }
        const workspaceLease = hasLeaseOwner
          ? await acquireWorkspaceLease(tx, {
              projectId: input.projectId,
              workspaceKey: input.workspaceKey,
              runId: input.id,
              leaseOwner: input.leaseOwner!,
              leaseTtlMs: leaseTtlMs!,
              blockUnresolvedMutations: true,
            })
          : null;
        return tx.agentRun.create({
          data: {
            id: input.id,
            ...(input.runInstanceId !== undefined
              ? { runInstanceId: input.runInstanceId }
              : {}),
            projectId: input.projectId,
            requestId: input.requestId ?? null,
            actorUserId,
            workspaceKey: input.workspaceKey,
            status: input.status ?? (hasLeaseOwner ? 'running' : 'pending'),
            leaseOwner: input.leaseOwner ?? null,
            leaseExpiresAt: workspaceLease?.leaseExpiresAt ?? null,
            lastHeartbeatAt: workspaceLease?.lastHeartbeatAt ?? null,
            fencingToken: hasLeaseOwner ? 1 : 0,
            workspaceFencingToken: workspaceLease?.fencingToken ?? 0,
            provider: input.provider,
            model: input.model,
            frameworkVersion: input.frameworkVersion,
            buildRevision: input.buildRevision,
            profileHash: input.profileHash,
            promptHash: input.promptHash,
            toolHash: input.toolHash,
            skillHash: input.skillHash,
            workspaceHash: input.workspaceHash,
            startedAt: input.startedAt ?? workspaceLease?.lastHeartbeatAt ?? null,
          },
        });
      });
      return mapRun(record);
    } catch (error) {
      if (isUniqueConflict(error)) {
        const target = JSON.stringify(error.meta?.target ?? '');
        if (target.includes('workspace_key')) {
          throw new AgentRuntimeRepositoryError(
            'WORKSPACE_BINDING_CONFLICT',
            'Canonical workspace is already bound to another project.'
          );
        }
        throw new AgentRuntimeRepositoryError('CONFLICT', 'Agent run already exists.');
      }
      throw error;
    }
  }

  async getRun(runId: string): Promise<AgentRunRecord | null> {
    const record = await this.client.agentRun.findUnique({ where: { id: runId } });
    return record ? mapRun(record) : null;
  }

  async getWorkspaceLease(projectId: string): Promise<AgentWorkspaceLeaseRecord | null> {
    const record = await this.client.agentWorkspaceLease.findUnique({ where: { projectId } });
    return record ? mapWorkspaceLease(record) : null;
  }

  async assertWorkspaceLease(input: AgentWriteFence): Promise<void> {
    const now = await databaseNow(this.client);
    const run = await this.client.agentRun.findFirst({ where: fenceWhere(input, now) });
    if (!run) await diagnoseFence(this.client, input, now);
  }

  async claimLease(input: ClaimAgentRunLeaseInput): Promise<AgentRunRecord> {
    const callerNow = input.now ?? this.clock();
    assertBoundedIdentifier(input.leaseOwner, 'leaseOwner');
    assertNonNegativeInteger(input.expectedVersion, 'expectedVersion');
    const leaseTtlMs = leaseDurationMs(input.leaseExpiresAt, callerNow, 'leaseExpiresAt');

    return this.client.$transaction(async (tx) => {
      const current = await tx.agentRun.findUnique({ where: { id: input.runId } });
      if (!current) {
        throw new AgentRuntimeRepositoryError('NOT_FOUND', 'Agent run was not found.');
      }
      if (current.version !== input.expectedVersion) {
        throw new AgentRuntimeRepositoryError('CONFLICT', 'Agent run version changed.');
      }
      const currentIsActive = (ACTIVE_STATUSES as readonly string[]).includes(current.status);
      const terminalReconciliationAllowed = input.allowTerminalReconciliation === true &&
        !currentIsActive &&
        await tx.agentToolExecution.findFirst({
          where: {
            runId: current.id,
            status: { in: UNRESOLVED_TOOL_STATUSES },
            effect: { in: ['workspace_write', 'external_write'] },
          },
          select: { id: true },
        }) !== null;
      if (!currentIsActive && !terminalReconciliationAllowed) {
        throw new AgentRuntimeRepositoryError('INVALID_STATE', 'Terminal run cannot be leased.');
      }
      const workspaceLease = await acquireWorkspaceLease(tx, {
        projectId: current.projectId,
        workspaceKey: current.workspaceKey,
        runId: current.id,
        leaseOwner: input.leaseOwner,
        leaseTtlMs,
        blockUnresolvedMutations: false,
      });
      const now = workspaceLease.lastHeartbeatAt!;
      const leaseExpiresAt = workspaceLease.leaseExpiresAt!;
      if (current.leaseExpiresAt && current.leaseExpiresAt > now) {
        throw new AgentRuntimeRepositoryError('LEASE_LOST', 'Agent run lease is still active.');
      }
      const result = await tx.agentRun.updateMany({
        where: {
          id: input.runId,
          version: input.expectedVersion,
          status: terminalReconciliationAllowed
            ? current.status
            : { in: [...ACTIVE_STATUSES] },
          OR: [
            { leaseOwner: null },
            { leaseExpiresAt: null },
            { leaseExpiresAt: { lte: now } },
          ],
        },
        data: {
          leaseOwner: input.leaseOwner,
          leaseExpiresAt,
          lastHeartbeatAt: now,
          fencingToken: { increment: 1 },
          workspaceFencingToken: workspaceLease.fencingToken,
          version: { increment: 1 },
          status: current.status === 'pending' ? 'running' : 'reconciling',
          startedAt: current.startedAt ?? now,
          ...(terminalReconciliationAllowed
            ? { finishedAt: null, errorCode: null, errorMessage: null }
            : {}),
        },
      });
      if (result.count !== 1) {
        const latest = await tx.agentRun.findUnique({ where: { id: input.runId } });
        if (!latest) {
          throw new AgentRuntimeRepositoryError('NOT_FOUND', 'Agent run was not found.');
        }
        if (latest.version !== input.expectedVersion) {
          throw new AgentRuntimeRepositoryError('CONFLICT', 'Agent run version changed.');
        }
        if (
          !(ACTIVE_STATUSES as readonly string[]).includes(latest.status) &&
          !(terminalReconciliationAllowed && latest.status === current.status)
        ) {
          throw new AgentRuntimeRepositoryError('INVALID_STATE', 'Terminal run cannot be leased.');
        }
        throw new AgentRuntimeRepositoryError('LEASE_LOST', 'Agent run lease is still active.');
      }
      return mapRun(
        await tx.agentRun.findUniqueOrThrow({ where: { id: input.runId } })
      );
    });
  }

  async heartbeat(input: HeartbeatAgentRunInput): Promise<AgentRunRecord> {
    const callerNow = input.now ?? this.clock();
    const leaseTtlMs = leaseDurationMs(input.leaseExpiresAt, callerNow, 'leaseExpiresAt');
    return this.client.$transaction(async (tx) => {
      const binding = await tx.agentRun.findUnique({
        where: { id: input.runId },
        select: { projectId: true },
      });
      if (!binding) {
        throw new AgentRuntimeRepositoryError('NOT_FOUND', 'Agent run was not found.');
      }
      await lockWorkspaceLease(tx, binding.projectId);
      await lockAgentRun(tx, input.runId);
      const now = await databaseNow(tx);
      const leaseExpiresAt = databaseLeaseExpiry(now, leaseTtlMs);
      const workspaceUpdate = await tx.agentWorkspaceLease.updateMany({
        where: {
          activeRunId: input.runId,
          status: 'held',
          leaseOwner: input.leaseOwner,
          fencingToken: input.workspaceFencingToken,
          leaseExpiresAt: { gt: now },
        },
        data: {
          leaseExpiresAt,
          lastHeartbeatAt: now,
          version: { increment: 1 },
        },
      });
      if (workspaceUpdate.count !== 1) await diagnoseFence(tx, input, now);
      const result = await tx.agentRun.updateMany({
        where: fenceWhere(input, now),
        data: {
          leaseExpiresAt,
          lastHeartbeatAt: now,
          version: { increment: 1 },
        },
      });
      if (result.count !== 1) await diagnoseFence(tx, input, now);
      return mapRun(
        await tx.agentRun.findUniqueOrThrow({ where: { id: input.runId } })
      );
    });
  }

  async appendEvent(input: AppendAgentEventInput): Promise<AppendAgentEventResult> {
    assertPositiveInteger(input.sequence, 'event.sequence');
    assertBoundedIdentifier(input.eventId, 'event.eventId', 512);
    assertBoundedIdentifier(input.eventType, 'event.eventType');
    assertValidDate(input.occurredAt, 'event.occurredAt');
    const payload = clonePublicRuntimeJson(input.payload, 'agent event payload');
    if (input.cumulativeUsage) assertUsage(input.cumulativeUsage);
    const existing = await this.findEventCollision(input);
    if (existing) return this.resolveExistingEvent(input, payload, existing);

    try {
      return await this.client.$transaction(async (tx) => {
        const now = await databaseNow(tx);
        const result = await tx.agentRun.updateMany({
          where: {
            ...fenceWhere(input, now),
            lastEventSequence: { lt: input.sequence },
          },
          data: {
            lastEventSequence: input.sequence,
            ...(input.cumulativeUsage
              ? {
                  inputTokens: input.cumulativeUsage.inputTokens,
                  outputTokens: input.cumulativeUsage.outputTokens,
                  totalTokens: input.cumulativeUsage.totalTokens,
                  cachedInputTokens: input.cumulativeUsage.cachedInputTokens,
                  cacheMissInputTokens: input.cumulativeUsage.cacheMissInputTokens,
                  reasoningTokens: input.cumulativeUsage.reasoningTokens,
                }
              : {}),
            version: { increment: 1 },
          },
        });
        if (result.count !== 1) await diagnoseFence(tx, input, now);
        const event = await tx.agentEvent.create({
          data: {
            eventId: input.eventId,
            runId: input.runId,
            sequence: input.sequence,
            eventType: input.eventType,
            payload: jsonInput(payload),
            occurredAt: input.occurredAt,
          },
        });
        const run = await tx.agentRun.findUniqueOrThrow({ where: { id: input.runId } });
        return { run: mapRun(run), event: mapEvent(event) };
      });
    } catch (error) {
      if (isUniqueConflict(error)) {
        const collision = await this.findEventCollision(input);
        if (collision) return this.resolveExistingEvent(input, payload, collision);
        throw new AgentRuntimeRepositoryError('CONFLICT', 'Agent event already exists.');
      }
      if (error instanceof AgentRuntimeRepositoryError && error.code === 'CONFLICT') {
        const collision = await this.findEventCollision(input);
        if (collision) return this.resolveExistingEvent(input, payload, collision);
      }
      throw error;
    }
  }

  async listEventsAfter(
    runId: string,
    sequence: number,
    limit = 500
  ): Promise<AgentEventRecord[]> {
    assertNonNegativeInteger(sequence, 'sequence');
    assertPositiveInteger(limit, 'limit');
    const records = await this.client.agentEvent.findMany({
      where: { runId, sequence: { gt: sequence } },
      orderBy: { sequence: 'asc' },
      take: Math.min(limit, 1_000),
    });
    return records.map(mapEvent);
  }

  async saveCheckpoint(
    input: SaveAgentCheckpointInput
  ): Promise<SaveAgentCheckpointResult> {
    assertPositiveInteger(input.sequence, 'checkpoint.sequence');
    assertNonNegativeInteger(input.turn, 'checkpoint.turn');
    assertPositiveInteger(input.stateVersion, 'checkpoint.stateVersion');
    assertHash(input.stateHash, 'checkpoint.stateHash');
    if (!isCheckpointBoundary(input.boundary)) {
      throw new AgentRuntimeRepositoryError('INVALID_STATE', 'Unknown checkpoint boundary.');
    }
    assertOpaqueCheckpointState(input.opaque);
    const publicState = clonePublicRuntimeJson(
      input.publicState,
      'checkpoint public state'
    );
    return this.client.$transaction(async (tx) => {
      const now = await databaseNow(tx);
      const result = await tx.agentRun.updateMany({
        where: {
          ...fenceWhere(input, now),
          lastEventSequence: { gte: input.sequence },
          turnCount: { lte: input.turn },
          OR: [
            { latestCheckpointSequence: null },
            { latestCheckpointSequence: { lt: input.sequence } },
          ],
        },
        data: {
          latestCheckpointSequence: input.sequence,
          turnCount: input.turn,
          version: { increment: 1 },
        },
      });
      if (result.count !== 1) await diagnoseFence(tx, input, now);
      const checkpoint = await tx.agentCheckpoint.create({
        data: {
          runId: input.runId,
          sequence: input.sequence,
          turn: input.turn,
          boundary: input.boundary,
          recoveryMode: 'replan_required',
          publicState: jsonInput(publicState),
          opaqueState: input.opaque?.value ?? null,
          opaqueCodec: input.opaque?.codec ?? null,
          stateHash: input.stateHash,
          stateVersion: input.stateVersion,
          fencingToken: input.fencingToken,
        },
      });
      const run = await tx.agentRun.findUniqueOrThrow({ where: { id: input.runId } });
      return { run: mapRun(run), checkpoint: mapCheckpoint(checkpoint) };
    });
  }

  async getLatestCheckpoint(runId: string): Promise<AgentCheckpointRecord | null> {
    const record = await this.client.agentCheckpoint.findFirst({
      where: { runId },
      orderBy: { sequence: 'desc' },
    });
    return record ? mapCheckpoint(record) : null;
  }

  async prepareToolExecution(
    input: PrepareAgentToolExecutionInput
  ): Promise<PrepareAgentToolExecutionResult> {
    this.validateToolPreparation(input);
    const existing = await this.client.agentToolExecution.findUnique({
      where: { operationId: input.operationId },
    });
    if (existing) return this.resolveExistingPreparation(input, existing);

    try {
      return await this.client.$transaction(async (tx) => {
        let projectId: string | undefined;
        if (input.effect === 'workspace_write' || input.effect === 'external_write') {
          const binding = await tx.agentRun.findUnique({
            where: { id: input.runId },
            select: { projectId: true },
          });
          if (!binding) {
            throw new AgentRuntimeRepositoryError('NOT_FOUND', 'Agent run was not found.');
          }
          projectId = binding.projectId;
          // Mutating preparation and workspace takeover must contend on the
          // same row. If preparation wins, takeover observes the unresolved
          // ledger; if takeover wins, the stale fence below is rejected.
          await lockWorkspaceLease(tx, binding.projectId);
        }
        const now = await databaseNow(tx);
        const result = await tx.agentRun.updateMany({
          where: fenceWhere(input, now),
          data: { version: { increment: 1 } },
        });
        if (result.count !== 1) await diagnoseFence(tx, input, now);
        if (input.effect === 'workspace_write' || input.effect === 'external_write') {
          const unresolved = await tx.agentToolExecution.findFirst({
            where: {
              operationId: { not: input.operationId },
              run: { projectId: projectId! },
              status: { in: UNRESOLVED_TOOL_STATUSES },
              effect: { in: ['workspace_write', 'external_write'] },
            },
            select: { operationId: true },
          });
          if (unresolved) {
            throw new AgentRuntimeRepositoryError(
              'RECONCILIATION_REQUIRED',
              'Workspace has an unresolved mutating operation.'
            );
          }
        }
        const execution = await tx.agentToolExecution.create({
          data: {
            runId: input.runId,
            operationId: input.operationId,
            toolCallId: input.toolCallId,
            toolName: input.toolName,
            inputHash: input.inputHash,
            effect: input.effect,
            idempotency: input.idempotency,
            idempotencyKey: input.idempotencyKey ?? null,
            preStateHash: input.preStateHash ?? null,
            fencingToken: input.fencingToken,
            workspaceFencingToken: input.workspaceFencingToken,
          },
        });
        const run = await tx.agentRun.findUniqueOrThrow({ where: { id: input.runId } });
        return {
          run: mapRun(run),
          execution: mapToolExecution(execution),
          created: true,
        };
      });
    } catch (error) {
      if (isUniqueConflict(error)) {
        const collision = await this.client.agentToolExecution.findUnique({
          where: { operationId: input.operationId },
        });
        if (collision) return this.resolveExistingPreparation(input, collision);
        throw new AgentRuntimeRepositoryError('CONFLICT', 'Tool operation already exists.');
      }
      throw error;
    }
  }

  async completeToolExecution(
    input: CompleteAgentToolExecutionInput
  ): Promise<CompleteAgentToolExecutionResult> {
    if (input.preStateHash !== undefined) {
      assertHash(input.preStateHash, 'tool.preStateHash');
    }
    if (input.postStateHash !== undefined) {
      assertHash(input.postStateHash, 'tool.postStateHash');
    }
    const receipt = input.resultReceipt
      ? clonePublicRuntimeJson(input.resultReceipt, 'tool result receipt')
      : null;
    if (input.status === 'succeeded' && input.error) {
      throw new AgentRuntimeRepositoryError(
        'INVALID_STATE',
        'Successful tool execution cannot contain an error.'
      );
    }
    if (input.status !== 'succeeded' && !input.error) {
      throw new AgentRuntimeRepositoryError(
        'INVALID_STATE',
        'Failed or uncertain tool execution requires a public error.'
      );
    }
    const existing = await this.client.agentToolExecution.findUnique({
      where: { operationId: input.operationId },
    });
    if (!existing || existing.runId !== input.runId) {
      throw new AgentRuntimeRepositoryError('NOT_FOUND', 'Tool execution was not found.');
    }
    if (
      input.preStateHash !== undefined &&
      existing.preStateHash !== null &&
      existing.preStateHash !== input.preStateHash
    ) {
      throw new AgentRuntimeRepositoryError(
        'OPERATION_CONFLICT',
        'Tool operation pre-state hash cannot be overwritten.'
      );
    }
    if (existing.status !== 'prepared' && existing.status !== 'commit_authorized') {
      return this.resolveExistingCompletion(input, receipt, existing);
    }
    if (
      input.status === 'succeeded' &&
      existing.effect === 'workspace_write' &&
      existing.status !== 'commit_authorized'
    ) {
      throw new AgentRuntimeRepositoryError(
        'OPERATION_CONFLICT',
        'Workspace mutation cannot succeed before its physical commit is authorized.'
      );
    }

    try {
      return await this.client.$transaction(async (tx) => {
        const now = await databaseNow(tx);
        const runUpdate = await tx.agentRun.updateMany({
          where: fenceWhere(input, now),
          data: { version: { increment: 1 } },
        });
        if (runUpdate.count !== 1) await diagnoseFence(tx, input, now);
        const executionUpdate = await tx.agentToolExecution.updateMany({
          where: {
            operationId: input.operationId,
            runId: input.runId,
            status: { in: ['prepared', 'commit_authorized'] },
          },
          data: {
            status: input.status,
            resultReceipt: receipt ? jsonInput(receipt) : Prisma.DbNull,
            preStateHash: input.preStateHash ?? existing.preStateHash,
            postStateHash: input.postStateHash ?? null,
            errorCode: input.error?.code ?? null,
            errorMessage: input.error?.message ?? null,
            completedAt: now,
          },
        });
        if (executionUpdate.count !== 1) {
          throw new AgentRuntimeRepositoryError(
            'OPERATION_CONFLICT',
            'Tool operation state changed while completing it.'
          );
        }
        const [run, execution] = await Promise.all([
          tx.agentRun.findUniqueOrThrow({ where: { id: input.runId } }),
          tx.agentToolExecution.findUniqueOrThrow({
            where: { operationId: input.operationId },
          }),
        ]);
        return { run: mapRun(run), execution: mapToolExecution(execution) };
      });
    } catch (error) {
      if (error instanceof AgentRuntimeRepositoryError) {
        const latest = await this.client.agentToolExecution.findUnique({
          where: { operationId: input.operationId },
        });
        if (
          latest &&
          latest.status !== 'prepared' &&
          latest.status !== 'commit_authorized'
        ) {
          return this.resolveExistingCompletion(input, receipt, latest);
        }
      }
      throw error;
    }
  }

  async getToolExecution(operationId: string): Promise<AgentToolExecutionRecord | null> {
    const record = await this.client.agentToolExecution.findUnique({ where: { operationId } });
    return record ? mapToolExecution(record) : null;
  }

  async commitWorkspaceMutation<T>(
    input: CommitAgentWorkspaceMutationInput,
    commit: () => Promise<T>
  ): Promise<T> {
    await this.client.$transaction(async (tx) => {
      const binding = await tx.agentRun.findUnique({
        where: { id: input.runId },
        select: { projectId: true },
      });
      if (!binding) {
        throw new AgentRuntimeRepositoryError('NOT_FOUND', 'Agent run was not found.');
      }
      const lease = await lockWorkspaceLease(tx, binding.projectId);
      const run = await lockAgentRun(tx, input.runId);
      const execution = await lockToolExecution(tx, input.operationId);
      const now = await databaseNow(tx);
      if (
        run.version !== input.expectedVersion ||
        run.status !== 'running'
      ) {
        throw new AgentRuntimeRepositoryError('CONFLICT', 'Agent run state changed before commit.');
      }
      if (
        run.leaseOwner !== input.leaseOwner ||
        run.fencingToken !== input.fencingToken ||
        run.workspaceFencingToken !== input.workspaceFencingToken ||
        !run.leaseExpiresAt ||
        run.leaseExpiresAt <= now ||
        lease.status !== 'held' ||
        lease.workspaceKey !== run.workspaceKey ||
        lease.activeRunId !== run.id ||
        lease.leaseOwner !== input.leaseOwner ||
        lease.fencingToken !== input.workspaceFencingToken ||
        !lease.leaseExpiresAt ||
        lease.leaseExpiresAt <= now
      ) {
        throw new AgentRuntimeRepositoryError('LEASE_LOST', 'Workspace mutation fence was lost.');
      }
      if (
        execution.runId !== run.id ||
        execution.status !== 'prepared' ||
        execution.effect !== 'workspace_write' ||
        execution.fencingToken !== input.fencingToken ||
        execution.workspaceFencingToken !== input.workspaceFencingToken
      ) {
        throw new AgentRuntimeRepositoryError(
          'OPERATION_CONFLICT',
          'Workspace mutation is not backed by a prepared operation ledger entry.'
        );
      }
      const authorized = await tx.agentToolExecution.updateMany({
        where: {
          operationId: input.operationId,
          runId: input.runId,
          status: 'prepared',
          fencingToken: input.fencingToken,
          workspaceFencingToken: input.workspaceFencingToken,
        },
        data: { status: 'commit_authorized' },
      });
      if (authorized.count !== 1) {
        throw new AgentRuntimeRepositoryError(
          'OPERATION_CONFLICT',
          'Workspace mutation commit authorization changed concurrently.'
        );
      }
    }, { maxWait: 5_000, timeout: 5_000 });

    // The physical callback runs outside the DB transaction while the caller
    // holds the shared-filesystem resource lock. A committed authorization is
    // intentionally one-shot: failures stay unresolved and cannot replay.
    return commit();
  }

  async completeRun(input: CompleteAgentRunInput): Promise<AgentRunRecord> {
    assertNonNegativeInteger(input.turnCount, 'run.turnCount');
    assertUsage(input.usage);
    if (!TERMINAL_STATUSES.includes(input.status)) {
      throw new AgentRuntimeRepositoryError('INVALID_STATE', 'Run status is not terminal.');
    }
    if (input.status === 'failed' && !input.error) {
      throw new AgentRuntimeRepositoryError(
        'INVALID_STATE',
        'Failed run requires a public error code and message.'
      );
    }
    if (input.finishedAt) assertValidDate(input.finishedAt, 'run.finishedAt');
    return this.client.$transaction(async (tx) => {
      const binding = await tx.agentRun.findUnique({
        where: { id: input.runId },
        select: { projectId: true },
      });
      if (!binding) {
        throw new AgentRuntimeRepositoryError('NOT_FOUND', 'Agent run was not found.');
      }
      // Keep lock order consistent with acquire/heartbeat/final commit:
      // workspace lease first, then the run row.
      await lockWorkspaceLease(tx, binding.projectId);
      await lockAgentRun(tx, input.runId);
      const now = await databaseNow(tx);
      const finishedAt = input.finishedAt ?? now;
      const result = await tx.agentRun.updateMany({
        where: fenceWhere(input, now),
        data: {
          status: input.status,
          turnCount: input.turnCount,
          inputTokens: input.usage.inputTokens,
          outputTokens: input.usage.outputTokens,
          totalTokens: input.usage.totalTokens,
          cachedInputTokens: input.usage.cachedInputTokens,
          cacheMissInputTokens: input.usage.cacheMissInputTokens,
          reasoningTokens: input.usage.reasoningTokens,
          errorCode: input.error?.code ?? null,
          errorMessage: input.error?.message ?? null,
          finishedAt,
          leaseOwner: null,
          leaseExpiresAt: null,
          version: { increment: 1 },
        },
      });
      if (result.count !== 1) await diagnoseFence(tx, input, now);
      const released = await tx.agentWorkspaceLease.updateMany({
        where: {
          activeRunId: input.runId,
          status: 'held',
          leaseOwner: input.leaseOwner,
          fencingToken: input.workspaceFencingToken,
        },
        data: {
          status: 'free',
          activeRunId: null,
          leaseOwner: null,
          leaseExpiresAt: null,
          lastHeartbeatAt: now,
          releasedAt: now,
          version: { increment: 1 },
        },
      });
      if (released.count !== 1) {
        throw new AgentRuntimeRepositoryError(
          'LEASE_LOST',
          'Workspace lease changed before terminal release.'
        );
      }
      return mapRun(
        await tx.agentRun.findUniqueOrThrow({ where: { id: input.runId } })
      );
    });
  }

  async listReconciliationCandidates(
    query: ReconciliationQuery = {}
  ): Promise<AgentReconciliationCandidate[]> {
    const now = await databaseNow(this.client);
    const limit = Math.min(query.limit ?? 100, 1_000);
    assertPositiveInteger(limit, 'reconciliation limit');
    const records = await this.client.agentRun.findMany({
      where: {
        ...(query.projectId ? { projectId: query.projectId } : {}),
        OR: [
          {
            status: { in: [...ACTIVE_STATUSES] },
            OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }],
          },
          {
            toolExecutions: {
              some: {
                status: { in: UNRESOLVED_TOOL_STATUSES },
                effect: { in: ['workspace_write', 'external_write'] },
              },
            },
          },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      include: {
        checkpoints: { orderBy: { sequence: 'desc' }, take: 1 },
        toolExecutions: {
          where: { status: { in: UNRESOLVED_TOOL_STATUSES } },
          orderBy: { preparedAt: 'asc' },
        },
      },
    });
    return records.map((record) => ({
      run: mapRun(record),
      checkpoint: record.checkpoints[0] ? mapCheckpoint(record.checkpoints[0]) : null,
      // Prepared, commit-authorized, and uncertain effects are surfaced for
      // reconciliation, never automatically marked failed or replayed.
      unresolvedToolExecutions: record.toolExecutions.map(mapToolExecution),
    }));
  }

  private async findEventCollision(
    input: AppendAgentEventInput
  ): Promise<PrismaAgentEvent | null> {
    return this.client.agentEvent.findFirst({
      where: {
        OR: [
          { eventId: input.eventId },
          { runId: input.runId, sequence: input.sequence },
        ],
      },
    });
  }

  private async resolveExistingEvent(
    input: AppendAgentEventInput,
    payload: RuntimeJsonObject,
    existing: PrismaAgentEvent
  ): Promise<AppendAgentEventResult> {
    const mapped = mapEvent(existing);
    if (
      mapped.runId !== input.runId ||
      mapped.eventId !== input.eventId ||
      mapped.sequence !== input.sequence ||
      mapped.eventType !== input.eventType ||
      mapped.occurredAt.getTime() !== input.occurredAt.getTime() ||
      canonicalJson(mapped.payload) !== canonicalJson(payload)
    ) {
      throw new AgentRuntimeRepositoryError(
        'CONFLICT',
        'Agent event ID or sequence is already bound to different content.'
      );
    }
    const run = await assertReplayLease(this.client, input, await databaseNow(this.client));
    return { run: mapRun(run), event: mapped };
  }

  private validateToolPreparation(input: PrepareAgentToolExecutionInput): void {
    assertBoundedIdentifier(input.operationId, 'tool.operationId', 512);
    assertBoundedIdentifier(input.toolCallId, 'tool.toolCallId', 512);
    assertBoundedIdentifier(input.toolName, 'tool.toolName');
    assertHash(input.inputHash, 'tool.inputHash');
    if (input.preStateHash !== undefined) {
      assertHash(input.preStateHash, 'tool.preStateHash');
    }
    if (!isToolEffect(input.effect) || !isToolIdempotency(input.idempotency)) {
      throw new AgentRuntimeRepositoryError('INVALID_STATE', 'Invalid tool effect policy.');
    }
    if (input.idempotency === 'operation_key' && !input.idempotencyKey) {
      throw new AgentRuntimeRepositoryError(
        'INVALID_STATE',
        'operation_key tools require an idempotencyKey.'
      );
    }
    if (input.idempotencyKey !== undefined) {
      assertBoundedIdentifier(input.idempotencyKey, 'tool.idempotencyKey', 512);
    }
  }

  private async resolveExistingPreparation(
    input: PrepareAgentToolExecutionInput,
    existing: PrismaAgentToolExecution
  ): Promise<PrepareAgentToolExecutionResult> {
    const execution = mapToolExecution(existing);
    assertToolIdentity(execution, input);
    const run = await assertReplayLease(this.client, input, await databaseNow(this.client));
    return { run: mapRun(run), execution, created: false };
  }

  private async resolveExistingCompletion(
    input: CompleteAgentToolExecutionInput,
    receipt: RuntimeJsonObject | null,
    existing: PrismaAgentToolExecution
  ): Promise<CompleteAgentToolExecutionResult> {
    const execution = mapToolExecution(existing);
    const sameReceipt = canonicalJson(execution.resultReceipt) === canonicalJson(receipt);
    if (
      execution.runId !== input.runId ||
      execution.status !== input.status ||
      (input.preStateHash !== undefined &&
        execution.preStateHash !== input.preStateHash) ||
      execution.postStateHash !== (input.postStateHash ?? null) ||
      execution.errorCode !== (input.error?.code ?? null) ||
      execution.errorMessage !== (input.error?.message ?? null) ||
      !sameReceipt
    ) {
      throw new AgentRuntimeRepositoryError(
        'OPERATION_CONFLICT',
        'Tool operation has already reached a different terminal state.'
      );
    }
    const run = await assertReplayLease(this.client, input, await databaseNow(this.client));
    return { run: mapRun(run), execution };
  }
}
