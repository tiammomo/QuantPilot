import type {
  AgentCheckpointRecord,
  AgentEventRecord,
  AgentReconciliationCandidate,
  AgentRunRecord,
  AgentToolExecutionRecord,
  AgentWorkspaceLeaseRecord,
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
  SaveAgentCheckpointInput,
  SaveAgentCheckpointResult,
} from './types';

/**
 * Storage boundary for restart-safe MoAgent execution.
 *
 * Every mutating operation after creation is either fenced or idempotently
 * keyed. Callers must carry the returned `version` forward; a stale worker is
 * rejected instead of silently overwriting a newer run instance.
 */
export interface AgentRuntimeRepository {
  createRun(input: CreateAgentRunInput): Promise<AgentRunRecord>;
  getRun(runId: string): Promise<AgentRunRecord | null>;
  getWorkspaceLease(projectId: string): Promise<AgentWorkspaceLeaseRecord | null>;
  assertWorkspaceLease(input: AgentWriteFence): Promise<void>;

  /**
   * Claims an unleased pending run or takes reconciliation ownership after
   * expiry. An expired run becomes `reconciling`; it must end as `interrupted`,
   * never continue a provider turn.
   */
  claimLease(input: ClaimAgentRunLeaseInput): Promise<AgentRunRecord>;
  heartbeat(input: HeartbeatAgentRunInput): Promise<AgentRunRecord>;

  appendEvent(input: AppendAgentEventInput): Promise<AppendAgentEventResult>;
  listEventsAfter(runId: string, sequence: number, limit?: number): Promise<AgentEventRecord[]>;

  saveCheckpoint(input: SaveAgentCheckpointInput): Promise<SaveAgentCheckpointResult>;
  getLatestCheckpoint(runId: string): Promise<AgentCheckpointRecord | null>;

  prepareToolExecution(
    input: PrepareAgentToolExecutionInput
  ): Promise<PrepareAgentToolExecutionResult>;
  completeToolExecution(
    input: CompleteAgentToolExecutionInput
  ): Promise<CompleteAgentToolExecutionResult>;
  getToolExecution(operationId: string): Promise<AgentToolExecutionRecord | null>;

  /**
   * Consumes the prepared ledger entry as a one-shot commit authorization before
   * running the physical commit. Callers must hold the workspace resource lock
   * across this call. A crash leaves the ledger unresolved; workspace writes
   * are reconciled from the framework-owned pre-image journal and are never
   * replayed blindly.
   */
  commitWorkspaceMutation<T>(
    input: CommitAgentWorkspaceMutationInput,
    commit: () => Promise<T>
  ): Promise<T>;

  completeRun(input: CompleteAgentRunInput): Promise<AgentRunRecord>;
  listReconciliationCandidates(
    query?: ReconciliationQuery
  ): Promise<AgentReconciliationCandidate[]>;
}
