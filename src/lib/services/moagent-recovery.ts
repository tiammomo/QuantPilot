import { randomUUID } from 'node:crypto';

import { prisma } from '@/lib/db/client';
import {
  AgentRuntimeRepositoryError,
  PrismaAgentRuntimeRepository,
  type AgentReconciliationCandidate,
  type AgentRuntimeRepository,
} from '@/lib/agent/runtime';

const DEFAULT_RECONCILIATION_LEASE_MS = 60_000;

export interface MoAgentRecoveryAuditResult {
  interruptedRunIds: string[];
  blocked: Array<{
    runId: string;
    operationIds: string[];
  }>;
  racedRunIds: string[];
}

export class MoAgentReconciliationRequiredError extends Error {
  constructor(readonly blockedRunIds: readonly string[]) {
    super('MoAgent workspace has unresolved mutating operations that require reconciliation.');
    this.name = 'MoAgentReconciliationRequiredError';
  }
}

function hasUnresolvedMutation(candidate: AgentReconciliationCandidate): boolean {
  return candidate.unresolvedToolExecutions.some((execution) =>
    execution.effect === 'workspace_write' || execution.effect === 'external_write'
  );
}

export async function reconcileExpiredMoAgentRuns(options: {
  repository: AgentRuntimeRepository;
  projectId: string;
  now?: Date;
  ownerId?: string;
  leaseMs?: number;
  limit?: number;
}): Promise<MoAgentRecoveryAuditResult> {
  const now = options.now ?? new Date();
  const leaseMs = options.leaseMs ?? DEFAULT_RECONCILIATION_LEASE_MS;
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw new Error('MoAgent reconciliation leaseMs must be a positive safe integer.');
  }
  const ownerId = options.ownerId ?? `reconciler:${process.pid}:${randomUUID()}`;
  const candidates = await options.repository.listReconciliationCandidates({
    projectId: options.projectId,
    now,
    limit: options.limit ?? 100,
  });
  const result: MoAgentRecoveryAuditResult = {
    interruptedRunIds: [],
    blocked: [],
    racedRunIds: [],
  };

  for (const candidate of candidates) {
    if (hasUnresolvedMutation(candidate)) {
      result.blocked.push({
        runId: candidate.run.id,
        operationIds: candidate.unresolvedToolExecutions
          .filter((execution) =>
            execution.effect === 'workspace_write' || execution.effect === 'external_write'
          )
          .map((execution) => execution.operationId),
      });
      continue;
    }

    try {
      const claimed = await options.repository.claimLease({
        runId: candidate.run.id,
        expectedVersion: candidate.run.version,
        leaseOwner: ownerId,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
        now,
      });
      await options.repository.completeRun({
        runId: claimed.id,
        expectedVersion: claimed.version,
        leaseOwner: ownerId,
        fencingToken: claimed.fencingToken,
        workspaceFencingToken: claimed.workspaceFencingToken,
        now,
        status: 'interrupted',
        turnCount: claimed.turnCount,
        usage: {
          inputTokens: claimed.inputTokens,
          outputTokens: claimed.outputTokens,
          totalTokens: claimed.totalTokens,
          cachedInputTokens: claimed.cachedInputTokens,
          cacheMissInputTokens: claimed.cacheMissInputTokens,
          reasoningTokens: claimed.reasoningTokens,
        },
        finishedAt: now,
        error: {
          code: 'LEASE_EXPIRED_REPLAN_REQUIRED',
          message: 'Expired MoAgent attempt was closed; recovery requires a new replan run.',
        },
      });
      result.interruptedRunIds.push(claimed.id);
    } catch (error) {
      if (
        error instanceof AgentRuntimeRepositoryError &&
        (error.code === 'CONFLICT' || error.code === 'LEASE_LOST' || error.code === 'INVALID_STATE')
      ) {
        result.racedRunIds.push(candidate.run.id);
        continue;
      }
      throw error;
    }
  }

  return result;
}

export async function auditPrismaMoAgentRecovery(projectId: string): Promise<MoAgentRecoveryAuditResult> {
  const clock = () => new Date();
  return reconcileExpiredMoAgentRuns({
    repository: new PrismaAgentRuntimeRepository(prisma, clock),
    projectId,
    now: clock(),
  });
}
