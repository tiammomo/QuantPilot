/**
 * Durable-runtime contracts for MoAgent.
 *
 * These records intentionally contain provenance, counters, public lifecycle
 * data, and opaque recovery handles only. Model reasoning, full prompts, raw
 * provider payloads, and unrestricted tool input/output do not belong here.
 */

export type RuntimeJsonPrimitive = string | number | boolean | null;
export type RuntimeJson =
  | RuntimeJsonPrimitive
  | RuntimeJson[]
  | { [key: string]: RuntimeJson };
export type RuntimeJsonObject = { [key: string]: RuntimeJson };

export const AGENT_RUN_STATUSES = [
  'pending',
  'running',
  'reconciling',
  'waiting',
  'candidate_complete',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'interrupted',
] as const;

export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];
export type ActiveAgentRunStatus = Extract<
  AgentRunStatus,
  'pending' | 'running' | 'reconciling' | 'waiting'
>;
export type TerminalAgentRunStatus = Exclude<AgentRunStatus, ActiveAgentRunStatus>;

export const CHECKPOINT_BOUNDARIES = [
  'run_started',
  'model_turn_completed',
  'tools_completed',
  'waiting_for_external_input',
] as const;

export type AgentCheckpointBoundary = (typeof CHECKPOINT_BOUNDARIES)[number];

export const TOOL_EFFECTS = ['pure', 'read', 'workspace_write', 'external_write'] as const;
export type AgentToolEffect = (typeof TOOL_EFFECTS)[number];

export const TOOL_IDEMPOTENCY_MODES = [
  'intrinsic',
  'operation_key',
  'reconcile_required',
] as const;
export type AgentToolIdempotency = (typeof TOOL_IDEMPOTENCY_MODES)[number];

export const TOOL_EXECUTION_STATUSES = [
  'prepared',
  'commit_authorized',
  'succeeded',
  'failed',
  'uncertain',
] as const;
export type AgentToolExecutionStatus = (typeof TOOL_EXECUTION_STATUSES)[number];
export type TerminalAgentToolExecutionStatus = Extract<
  AgentToolExecutionStatus,
  'succeeded' | 'failed' | 'uncertain'
>;

export interface AgentTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
  cacheMissInputTokens: number;
  reasoningTokens: number;
}

export interface AgentRunProvenance {
  provider: string;
  model: string;
  frameworkVersion: string;
  profileHash: string;
  promptHash: string;
  toolHash: string;
  skillHash: string;
  workspaceHash: string;
}

export interface AgentRunRecord extends AgentRunProvenance, AgentTokenUsage {
  /** Provider-neutral bounded runtime ID; its prefix is deliberately unspecified. */
  id: string;
  /** Immutable UUID identifying this physical execution instance. */
  runInstanceId: string;
  projectId: string;
  requestId: string | null;
  /** Stable hash of deployment namespace + canonical workspace realpath. */
  workspaceKey: string;
  status: AgentRunStatus;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  lastHeartbeatAt: Date | null;
  fencingToken: number;
  workspaceFencingToken: number;
  turnCount: number;
  version: number;
  lastEventSequence: number;
  latestCheckpointSequence: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentWorkspaceLeaseRecord {
  projectId: string;
  workspaceKey: string;
  status: 'free' | 'held' | 'reconciling';
  activeRunId: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  lastHeartbeatAt: Date | null;
  fencingToken: number;
  version: number;
  acquiredAt: Date | null;
  releasedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentEventRecord {
  id: string;
  eventId: string;
  runId: string;
  sequence: number;
  eventType: string;
  /** Public, policy-checked data only. */
  payload: RuntimeJsonObject;
  occurredAt: Date;
  createdAt: Date;
}

export interface AgentCheckpointRecord {
  id: string;
  runId: string;
  sequence: number;
  turn: number;
  boundary: AgentCheckpointBoundary;
  /** DeepSeek reasoning is not persisted, so recovery always starts a new replan. */
  recoveryMode: 'replan_required';
  publicState: RuntimeJsonObject;
  /** Opaque resume handle or sealed state; never model reasoning. */
  opaqueState: string | null;
  opaqueCodec: 'reference-v1' | 'sealed-v1' | null;
  stateHash: string;
  stateVersion: number;
  fencingToken: number;
  createdAt: Date;
}

export interface AgentToolExecutionRecord {
  id: string;
  runId: string;
  /** Framework-generated stable operation ID, never a model-selected identifier. */
  operationId: string;
  toolCallId: string;
  toolName: string;
  inputHash: string;
  effect: AgentToolEffect;
  idempotency: AgentToolIdempotency;
  idempotencyKey: string | null;
  status: AgentToolExecutionStatus;
  /** Public reconciliation receipt, not unrestricted tool output. */
  resultReceipt: RuntimeJsonObject | null;
  preStateHash: string | null;
  postStateHash: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  fencingToken: number;
  workspaceFencingToken: number;
  preparedAt: Date;
  completedAt: Date | null;
  updatedAt: Date;
}

export interface AgentWriteFence {
  runId: string;
  expectedVersion: number;
  leaseOwner: string;
  fencingToken: number;
  workspaceFencingToken: number;
  /**
   * Injectable for deterministic in-memory tests. The Prisma repository ignores
   * worker wall-clock values and obtains authoritative time from PostgreSQL.
   */
  now?: Date;
}

export interface CreateAgentRunInput extends AgentRunProvenance {
  id: string;
  runInstanceId?: string;
  projectId: string;
  workspaceKey: string;
  requestId?: string;
  status?: ActiveAgentRunStatus;
  leaseOwner?: string;
  leaseExpiresAt?: Date;
  startedAt?: Date;
}

export interface CommitAgentWorkspaceMutationInput extends AgentWriteFence {
  operationId: string;
}

export interface ClaimAgentRunLeaseInput {
  runId: string;
  expectedVersion: number;
  leaseOwner: string;
  leaseExpiresAt: Date;
  now?: Date;
}

export interface HeartbeatAgentRunInput extends AgentWriteFence {
  leaseExpiresAt: Date;
}

export interface AppendAgentEventInput extends AgentWriteFence {
  eventId: string;
  sequence: number;
  eventType: string;
  payload: RuntimeJsonObject;
  occurredAt: Date;
}

export interface AppendAgentEventResult {
  run: AgentRunRecord;
  event: AgentEventRecord;
}

export interface SaveAgentCheckpointInput extends AgentWriteFence {
  sequence: number;
  turn: number;
  boundary: AgentCheckpointBoundary;
  publicState: RuntimeJsonObject;
  opaque?: {
    codec: 'reference-v1' | 'sealed-v1';
    value: string;
  };
  stateHash: string;
  stateVersion: number;
}

export interface SaveAgentCheckpointResult {
  run: AgentRunRecord;
  checkpoint: AgentCheckpointRecord;
}

export interface PrepareAgentToolExecutionInput extends AgentWriteFence {
  operationId: string;
  toolCallId: string;
  toolName: string;
  inputHash: string;
  effect: AgentToolEffect;
  idempotency: AgentToolIdempotency;
  idempotencyKey?: string;
  preStateHash?: string;
}

export interface PrepareAgentToolExecutionResult {
  run: AgentRunRecord;
  execution: AgentToolExecutionRecord;
  /**
   * Only `true` authorizes the caller to execute the tool. `false` means this
   * operation identity was already committed to the ledger and must be reused
   * or reconciled, never executed again.
   */
  created: boolean;
}

export interface CompleteAgentToolExecutionInput extends AgentWriteFence {
  operationId: string;
  status: TerminalAgentToolExecutionStatus;
  resultReceipt?: RuntimeJsonObject;
  /** Actual pre-effect hash observed by the tool, if unavailable at prepare time. */
  preStateHash?: string;
  postStateHash?: string;
  error?: {
    code: string;
    message: string;
  };
}

export interface CompleteAgentToolExecutionResult {
  run: AgentRunRecord;
  execution: AgentToolExecutionRecord;
}

export interface CompleteAgentRunInput extends AgentWriteFence {
  status: TerminalAgentRunStatus;
  turnCount: number;
  usage: AgentTokenUsage;
  finishedAt?: Date;
  error?: {
    code: string;
    message: string;
  };
}

export interface ReconciliationQuery {
  now?: Date;
  projectId?: string;
  limit?: number;
}

export interface AgentReconciliationCandidate {
  run: AgentRunRecord;
  checkpoint: AgentCheckpointRecord | null;
  unresolvedToolExecutions: AgentToolExecutionRecord[];
}
