import { randomUUID } from 'node:crypto';

import { prisma } from '@/lib/db/client';
import {
  AgentRuntimeRepositoryError,
  cleanupPiAgentWorkspaceMutationJournal,
  listPiAgentWorkspaceMutationJournals,
  PiAgentWorkspaceMutationRecoveryConflictError,
  PrismaAgentRuntimeRepository,
  rollbackPiAgentWorkspaceMutationJournal,
  type AgentReconciliationCandidate,
  type AgentRuntimeRepository,
  type AgentRunRecord,
  type AgentToolExecutionRecord,
  type PiAgentWorkspaceMutationJournal,
} from '@/lib/agent/runtime';
import { readPiAgentProgressOracleCheckpoint } from './pi-agent-checkpoint';

const DEFAULT_RECONCILIATION_LEASE_MS = 60_000;

export interface PiAgentRecoveryAuditResult {
  interruptedRunIds: string[];
  blocked: Array<{
    runId: string;
    operationIds: string[];
  }>;
  racedRunIds: string[];
}

export class PiAgentReconciliationRequiredError extends Error {
  constructor(readonly blockedRunIds: readonly string[]) {
    super('PI Agent workspace has unresolved mutating operations that require reconciliation.');
    this.name = 'PiAgentReconciliationRequiredError';
  }
}

function hasUnresolvedMutation(candidate: AgentReconciliationCandidate): boolean {
  return candidate.unresolvedToolExecutions.some((execution) =>
    execution.effect === 'workspace_write' || execution.effect === 'external_write'
  );
}

const RECOVERABLE_WORKSPACE_STATUSES = new Set(['prepared', 'commit_authorized']);

function mutationExecutions(candidate: AgentReconciliationCandidate): AgentToolExecutionRecord[] {
  return candidate.unresolvedToolExecutions.filter((execution) =>
    execution.effect === 'workspace_write' || execution.effect === 'external_write'
  );
}

function journalCanRecover(
  execution: AgentToolExecutionRecord,
  journal: PiAgentWorkspaceMutationJournal | undefined,
): boolean {
  if (execution.effect !== 'workspace_write' || !RECOVERABLE_WORKSPACE_STATUSES.has(execution.status)) {
    return false;
  }
  if (execution.status === 'commit_authorized' && !journal) return false;
  return !journal || (
    journal.manifest.runId === execution.runId &&
    journal.manifest.operationId === execution.operationId
  );
}

function fence(run: AgentRunRecord, leaseOwner: string, now: Date) {
  return {
    runId: run.id,
    expectedVersion: run.version,
    leaseOwner,
    fencingToken: run.fencingToken,
    workspaceFencingToken: run.workspaceFencingToken,
    now,
  };
}

export async function reconcileExpiredPiAgentRuns(options: {
  repository: AgentRuntimeRepository;
  projectId: string;
  now?: Date;
  ownerId?: string;
  leaseMs?: number;
  limit?: number;
  /** Canonical project workspace; required for automatic workspace-write rollback. */
  workspaceRoot?: string;
}): Promise<PiAgentRecoveryAuditResult> {
  const now = options.now ?? new Date();
  const leaseMs = options.leaseMs ?? DEFAULT_RECONCILIATION_LEASE_MS;
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw new Error('PI Agent reconciliation leaseMs must be a positive safe integer.');
  }
  const ownerId = options.ownerId ?? `reconciler:${process.pid}:${randomUUID()}`;
  const candidates = await options.repository.listReconciliationCandidates({
    projectId: options.projectId,
    now,
    limit: options.limit ?? 100,
  });
  const result: PiAgentRecoveryAuditResult = {
    interruptedRunIds: [],
    blocked: [],
    racedRunIds: [],
  };

  const journals = options.workspaceRoot
    ? await listPiAgentWorkspaceMutationJournals(options.workspaceRoot)
    : [];
  const journalsByOperation = new Map(
    journals.map((journal) => [journal.manifest.operationId, journal] as const),
  );

  // A normal tool completion intentionally leaves the filesystem receipt in
  // place until its terminal database row is observable. Startup can then
  // remove it without creating a crash window between the two durability
  // domains.
  for (const journal of journals) {
    const execution = await options.repository.getToolExecution(journal.manifest.operationId);
    if (!execution) {
      throw new Error(
        `PI Agent mutation journal ${journal.manifest.operationId} has no durable tool ledger entry.`,
      );
    }
    if (execution.runId !== journal.manifest.runId || execution.effect !== 'workspace_write') {
      throw new Error('PI Agent mutation journal does not match its durable workspace ledger entry.');
    }
    if (execution.status === 'succeeded') {
      if (journal.manifest.state !== 'applied') {
        throw new Error('A successful PI Agent workspace execution has a non-applied journal.');
      }
      await cleanupPiAgentWorkspaceMutationJournal(journal);
      journalsByOperation.delete(journal.manifest.operationId);
    } else if (execution.status === 'failed') {
      if (journal.manifest.state !== 'rolled_back') {
        throw new Error('A failed PI Agent workspace execution has a non-rolled-back journal.');
      }
      await cleanupPiAgentWorkspaceMutationJournal(journal);
      journalsByOperation.delete(journal.manifest.operationId);
    }
  }

  for (const candidate of candidates) {
    if (candidate.checkpoint) {
      // Version 2 records are canonical-hash verified before any reconciliation
      // side effect. A model-turn checkpoint additionally validates its bounded
      // ProgressOracle state, but replan recovery never treats it as history.
      readPiAgentProgressOracleCheckpoint(candidate.checkpoint);
    }
    const mutations = mutationExecutions(candidate);
    const cannotRecover = mutations.filter((execution) =>
      !options.workspaceRoot ||
      !journalCanRecover(execution, journalsByOperation.get(execution.operationId))
    );
    if (hasUnresolvedMutation(candidate) && cannotRecover.length > 0) {
      result.blocked.push({
        runId: candidate.run.id,
        operationIds: cannotRecover.map((execution) => execution.operationId),
      });
      continue;
    }

    try {
      let claimed = await options.repository.claimLease({
        runId: candidate.run.id,
        expectedVersion: candidate.run.version,
        leaseOwner: ownerId,
        leaseExpiresAt: new Date(now.getTime() + leaseMs),
        allowTerminalReconciliation: true,
        now,
      });

      for (const execution of mutations) {
        const journal = journalsByOperation.get(execution.operationId);
        if (journal) {
          await rollbackPiAgentWorkspaceMutationJournal(journal);
        }
        const completed = await options.repository.completeToolExecution({
          ...fence(claimed, ownerId, now),
          operationId: execution.operationId,
          status: 'failed',
          resultReceipt: {
            reconciliation: 'workspace_rolled_back',
            journal: journal ? journal.manifest.schemaVersion : 'no_physical_commit',
          },
          error: {
            code: 'WORKSPACE_MUTATION_ROLLED_BACK',
            message: 'Interrupted PI Agent workspace mutation was rolled back before replanning.',
          },
        });
        claimed = completed.run;
      }

      await options.repository.completeRun({
        ...fence(claimed, ownerId, now),
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
          message: 'Expired PI Agent attempt was closed; recovery requires a new replan run.',
        },
      });
      for (const execution of mutations) {
        const journal = journalsByOperation.get(execution.operationId);
        if (journal) {
          await cleanupPiAgentWorkspaceMutationJournal(journal);
          journalsByOperation.delete(execution.operationId);
        }
      }
      result.interruptedRunIds.push(claimed.id);
    } catch (error) {
      if (error instanceof PiAgentWorkspaceMutationRecoveryConflictError) {
        result.blocked.push({
          runId: candidate.run.id,
          operationIds: mutations.map((execution) => execution.operationId),
        });
        continue;
      }
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

export async function auditPrismaPiAgentRecovery(
  projectId: string,
  workspaceRoot?: string,
): Promise<PiAgentRecoveryAuditResult> {
  const clock = () => new Date();
  return reconcileExpiredPiAgentRuns({
    repository: new PrismaAgentRuntimeRepository(prisma, clock),
    projectId,
    workspaceRoot,
    now: clock(),
  });
}
