import { Prisma, type AgentGenerationLease } from '@prisma/client';
import { prisma } from '@/lib/db/client';

const MAX_LEASE_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_IDENTIFIER_BYTES = 256;

export const MOAGENT_GENERATION_STAGES = [
  'planning_data_prefetch',
  'agent_execution',
  'manual_validation',
] as const;

export type MoAgentGenerationStage = (typeof MOAGENT_GENERATION_STAGES)[number];

export interface MoAgentGenerationLeaseFence {
  projectId: string;
  operationId: string;
  leaseOwner: string;
  fencingToken: number;
}

export interface MoAgentGenerationLeaseClaim extends MoAgentGenerationLeaseFence {
  requestId: string | null;
  stage: MoAgentGenerationStage;
  leaseExpiresAt: string;
}

type GenerationTransaction = Prisma.TransactionClient;

export class MoAgentGenerationLeaseError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly activeRequestId: string | null = null,
    readonly activeStage: string | null = null
  ) {
    super(message);
    this.name = 'MoAgentGenerationLeaseError';
  }
}

function assertIdentifier(value: string, label: string): void {
  if (!value || Buffer.byteLength(value, 'utf8') > MAX_IDENTIFIER_BYTES || /[\r\n]/.test(value)) {
    throw new MoAgentGenerationLeaseError(
      'GENERATION_LEASE_INVALID',
      `${label} must be a bounded single-line identifier.`
    );
  }
}

function assertLeaseInput(input: {
  projectId: string;
  operationId: string;
  requestId?: string | null;
  stage: MoAgentGenerationStage;
  leaseOwner: string;
  leaseTtlMs: number;
}): void {
  assertIdentifier(input.projectId, 'projectId');
  assertIdentifier(input.operationId, 'operationId');
  assertIdentifier(input.leaseOwner, 'leaseOwner');
  if (input.requestId) assertIdentifier(input.requestId, 'requestId');
  if (!MOAGENT_GENERATION_STAGES.includes(input.stage)) {
    throw new MoAgentGenerationLeaseError(
      'GENERATION_LEASE_INVALID',
      `Unsupported generation stage: ${input.stage}`
    );
  }
  if (
    !Number.isSafeInteger(input.leaseTtlMs) ||
    input.leaseTtlMs <= 0 ||
    input.leaseTtlMs > MAX_LEASE_TTL_MS
  ) {
    throw new MoAgentGenerationLeaseError(
      'GENERATION_LEASE_INVALID',
      'leaseTtlMs must be a positive safe integer no greater than one day.'
    );
  }
}

async function databaseNow(tx: GenerationTransaction): Promise<Date> {
  const rows = await tx.$queryRaw<Array<{ databaseNow: Date }>>(Prisma.sql`
    SELECT clock_timestamp() AS "databaseNow"
  `);
  const value = rows[0]?.databaseNow;
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new MoAgentGenerationLeaseError(
      'GENERATION_DATABASE_CLOCK_UNAVAILABLE',
      'Database clock is unavailable for generation lease fencing.'
    );
  }
  return value;
}

async function lockGenerationLease(
  tx: GenerationTransaction,
  projectId: string
): Promise<AgentGenerationLease> {
  const rows = await tx.$queryRaw<AgentGenerationLease[]>(Prisma.sql`
    SELECT
      project_id AS "projectId",
      active_request_id AS "activeRequestId",
      operation_id AS "operationId",
      stage,
      status,
      lease_owner AS "leaseOwner",
      lease_expires_at AS "leaseExpiresAt",
      last_heartbeat_at AS "lastHeartbeatAt",
      fencing_token AS "fencingToken",
      version,
      acquired_at AS "acquiredAt",
      released_at AS "releasedAt",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM agent_generation_leases
    WHERE project_id = ${projectId}
    FOR UPDATE
  `);
  const lease = rows[0];
  if (!lease) {
    throw new MoAgentGenerationLeaseError(
      'GENERATION_PROJECT_NOT_FOUND',
      'Generation project does not exist or could not initialize its lease.'
    );
  }
  return lease;
}

function assertFence(
  lease: AgentGenerationLease,
  fence: MoAgentGenerationLeaseFence,
  now: Date
): void {
  if (
    lease.status !== 'held' ||
    lease.operationId !== fence.operationId ||
    lease.leaseOwner !== fence.leaseOwner ||
    lease.fencingToken !== fence.fencingToken
  ) {
    throw new MoAgentGenerationLeaseError(
      'GENERATION_LEASE_LOST',
      'The orchestrator no longer owns the current project generation fence.',
      lease.activeRequestId,
      lease.stage
    );
  }
  if (!lease.leaseExpiresAt || lease.leaseExpiresAt <= now) {
    throw new MoAgentGenerationLeaseError(
      'GENERATION_LEASE_EXPIRED',
      'The project generation lease expired before its durable write.',
      lease.activeRequestId,
      lease.stage
    );
  }
}

export async function claimMoAgentGenerationLease(input: {
  projectId: string;
  operationId: string;
  requestId?: string | null;
  stage: MoAgentGenerationStage;
  leaseOwner: string;
  leaseTtlMs: number;
}): Promise<MoAgentGenerationLeaseClaim> {
  assertLeaseInput(input);
  const requestId = input.requestId ?? null;
  return prisma.$transaction(async (tx) => {
    if (requestId) {
      const request = await tx.userRequest.findUnique({
        where: { id_projectId: { id: requestId, projectId: input.projectId } },
        select: { id: true },
      });
      if (!request) {
        throw new MoAgentGenerationLeaseError(
          'GENERATION_REQUEST_NOT_FOUND',
          'Generation request does not exist or belongs to another project.'
        );
      }
    }

    try {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO agent_generation_leases (
          project_id,
          status,
          fencing_token,
          version,
          created_at,
          updated_at
        ) VALUES (
          ${input.projectId},
          'free',
          0,
          0,
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        )
        ON CONFLICT DO NOTHING
      `);
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2010' &&
        error.meta?.code === '23503'
      ) {
        throw new MoAgentGenerationLeaseError(
          'GENERATION_PROJECT_NOT_FOUND',
          'Generation project does not exist or is no longer writable.'
        );
      }
      throw error;
    }
    const current = await lockGenerationLease(tx, input.projectId);
    const now = await databaseNow(tx);
    if (current.status === 'held' && current.leaseExpiresAt && current.leaseExpiresAt > now) {
      throw new MoAgentGenerationLeaseError(
        'GENERATION_PROJECT_BUSY',
        `Project orchestration is already running${current.stage ? ` stage ${current.stage}` : ''}.`,
        current.activeRequestId,
        current.stage
      );
    }
    if (current.status !== 'free' && current.status !== 'held') {
      throw new MoAgentGenerationLeaseError(
        'GENERATION_LEASE_INVALID_STATE',
        `Generation lease has unsupported status ${current.status}.`,
        current.activeRequestId,
        current.stage
      );
    }
    if (current.status === 'held' && !current.leaseExpiresAt) {
      throw new MoAgentGenerationLeaseError(
        'GENERATION_LEASE_INVALID_STATE',
        'Held generation lease has no expiry and requires operator reconciliation.',
        current.activeRequestId,
        current.stage
      );
    }

    const activeMission = await tx.agentMission.findFirst({
      where: { projectId: input.projectId, activeSlot: 1 },
      select: { requestId: true, status: true },
    });
    const manualRecoveryWithoutBinding = input.stage === 'manual_validation' && requestId === null;
    if (activeMission && activeMission.requestId !== requestId && !manualRecoveryWithoutBinding) {
      throw new MoAgentGenerationLeaseError(
        'GENERATION_MISSION_BUSY',
        `Project already has an active Mission in status ${activeMission.status}.`,
        activeMission.requestId,
        'mission'
      );
    }

    const leaseExpiresAt = new Date(now.getTime() + input.leaseTtlMs);
    const updated = await tx.agentGenerationLease.updateMany({
      where: {
        projectId: input.projectId,
        version: current.version,
        OR: [{ status: 'free' }, { status: 'held', leaseExpiresAt: { lte: now } }],
      },
      data: {
        activeRequestId: requestId,
        operationId: input.operationId,
        stage: input.stage,
        status: 'held',
        leaseOwner: input.leaseOwner,
        leaseExpiresAt,
        lastHeartbeatAt: now,
        fencingToken: { increment: 1 },
        version: { increment: 1 },
        acquiredAt: now,
        releasedAt: null,
      },
    });
    if (updated.count !== 1) {
      throw new MoAgentGenerationLeaseError(
        'GENERATION_LEASE_CONFLICT',
        'Project generation lease claim lost a concurrent write.'
      );
    }
    const claimed = await tx.agentGenerationLease.findUniqueOrThrow({
      where: { projectId: input.projectId },
    });
    if (
      claimed.operationId !== input.operationId ||
      claimed.leaseOwner !== input.leaseOwner ||
      claimed.fencingToken <= current.fencingToken
    ) {
      throw new MoAgentGenerationLeaseError(
        'GENERATION_LEASE_LOST',
        'Generation lease claim did not return the acquired fence.'
      );
    }
    return {
      projectId: input.projectId,
      operationId: input.operationId,
      requestId,
      stage: input.stage,
      leaseOwner: input.leaseOwner,
      fencingToken: claimed.fencingToken,
      leaseExpiresAt: leaseExpiresAt.toISOString(),
    };
  });
}

export async function heartbeatMoAgentGenerationLease(input: {
  fence: MoAgentGenerationLeaseFence;
  leaseTtlMs: number;
}): Promise<{ leaseExpiresAt: string }> {
  assertLeaseInput({
    ...input.fence,
    requestId: null,
    stage: 'agent_execution',
    leaseTtlMs: input.leaseTtlMs,
  });
  return prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    const leaseExpiresAt = new Date(now.getTime() + input.leaseTtlMs);
    const updated = await tx.agentGenerationLease.updateMany({
      where: {
        projectId: input.fence.projectId,
        operationId: input.fence.operationId,
        status: 'held',
        leaseOwner: input.fence.leaseOwner,
        fencingToken: input.fence.fencingToken,
        leaseExpiresAt: { gt: now },
      },
      data: {
        leaseExpiresAt,
        lastHeartbeatAt: now,
      },
    });
    if (updated.count !== 1) {
      assertFence(await lockGenerationLease(tx, input.fence.projectId), input.fence, now);
      throw new MoAgentGenerationLeaseError(
        'GENERATION_LEASE_CONFLICT',
        'Generation lease heartbeat lost a concurrent write.'
      );
    }
    return { leaseExpiresAt: leaseExpiresAt.toISOString() };
  });
}

export async function releaseMoAgentGenerationLease(input: {
  fence: MoAgentGenerationLeaseFence;
}): Promise<void> {
  return prisma.$transaction(async (tx) => {
    const now = await databaseNow(tx);
    const current = await lockGenerationLease(tx, input.fence.projectId);
    assertFence(current, input.fence, now);
    const updated = await tx.agentGenerationLease.updateMany({
      where: {
        projectId: input.fence.projectId,
        version: current.version,
        operationId: input.fence.operationId,
        status: 'held',
        leaseOwner: input.fence.leaseOwner,
        fencingToken: input.fence.fencingToken,
        leaseExpiresAt: { gt: now },
      },
      data: {
        activeRequestId: null,
        operationId: null,
        stage: null,
        status: 'free',
        leaseOwner: null,
        leaseExpiresAt: null,
        lastHeartbeatAt: null,
        version: { increment: 1 },
        releasedAt: now,
      },
    });
    if (updated.count !== 1) {
      throw new MoAgentGenerationLeaseError(
        'GENERATION_LEASE_LOST',
        'Generation lease release lost its fencing token.'
      );
    }
  });
}
