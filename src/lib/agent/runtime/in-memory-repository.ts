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
  isCheckpointBoundary,
  isToolEffect,
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
  SaveAgentCheckpointInput,
  SaveAgentCheckpointResult,
} from './types';

const ACTIVE_STATUSES = new Set(['pending', 'running', 'reconciling', 'waiting']);
const TERMINAL_STATUSES = new Set([
  'candidate_complete',
  'completed',
  'failed',
  'cancelled',
  'timed_out',
  'interrupted',
]);
const UNRESOLVED_TOOL_STATUSES = new Set(['prepared', 'commit_authorized', 'uncertain']);

export interface InMemoryAgentRuntimeRepositoryOptions {
  now?: () => Date;
  uuid?: () => string;
}

function cloneDate(value: Date | null): Date | null {
  return value ? new Date(value) : null;
}

function cloneRun(run: AgentRunRecord): AgentRunRecord {
  return {
    ...run,
    leaseExpiresAt: cloneDate(run.leaseExpiresAt),
    lastHeartbeatAt: cloneDate(run.lastHeartbeatAt),
    startedAt: cloneDate(run.startedAt),
    finishedAt: cloneDate(run.finishedAt),
    createdAt: new Date(run.createdAt),
    updatedAt: new Date(run.updatedAt),
  };
}

function cloneEvent(event: AgentEventRecord): AgentEventRecord {
  return {
    ...event,
    payload: clonePublicRuntimeJson(event.payload, 'agent event payload'),
    occurredAt: new Date(event.occurredAt),
    createdAt: new Date(event.createdAt),
  };
}

function cloneCheckpoint(checkpoint: AgentCheckpointRecord): AgentCheckpointRecord {
  return {
    ...checkpoint,
    publicState: clonePublicRuntimeJson(checkpoint.publicState, 'checkpoint public state'),
    createdAt: new Date(checkpoint.createdAt),
  };
}

function cloneToolExecution(execution: AgentToolExecutionRecord): AgentToolExecutionRecord {
  return {
    ...execution,
    resultReceipt: execution.resultReceipt
      ? clonePublicRuntimeJson(execution.resultReceipt, 'tool result receipt')
      : null,
    preparedAt: new Date(execution.preparedAt),
    completedAt: cloneDate(execution.completedAt),
    updatedAt: new Date(execution.updatedAt),
  };
}

function cloneWorkspaceLease(lease: AgentWorkspaceLeaseRecord): AgentWorkspaceLeaseRecord {
  return {
    ...lease,
    leaseExpiresAt: cloneDate(lease.leaseExpiresAt),
    lastHeartbeatAt: cloneDate(lease.lastHeartbeatAt),
    acquiredAt: cloneDate(lease.acquiredAt),
    releasedAt: cloneDate(lease.releasedAt),
    createdAt: new Date(lease.createdAt),
    updatedAt: new Date(lease.updatedAt),
  };
}

function canonicalJson(value: RuntimeJson): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
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

export class InMemoryAgentRuntimeRepository implements AgentRuntimeRepository {
  private readonly runs = new Map<string, AgentRunRecord>();
  private readonly runInstanceIds = new Set<string>();
  private readonly events = new Map<string, AgentEventRecord[]>();
  private readonly eventIds = new Set<string>();
  private readonly checkpoints = new Map<string, AgentCheckpointRecord[]>();
  private readonly toolExecutions = new Map<string, AgentToolExecutionRecord>();
  private readonly workspaceLeases = new Map<string, AgentWorkspaceLeaseRecord>();
  private readonly workspaceCommitLocks = new Set<string>();
  private readonly clock: () => Date;
  private readonly uuid: () => string;

  constructor(options: InMemoryAgentRuntimeRepositoryOptions = {}) {
    this.clock = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? (() => globalThis.crypto.randomUUID());
  }

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

    const now = this.clock();
    const runInstanceId = input.runInstanceId ?? this.uuid();
    assertUuid(runInstanceId, 'run.runInstanceId');
    if (this.runs.has(input.id) || this.runInstanceIds.has(runInstanceId)) {
      throw new AgentRuntimeRepositoryError('CONFLICT', 'Agent run already exists.');
    }

    const hasLeaseOwner = input.leaseOwner !== undefined;
    const hasLeaseExpiry = input.leaseExpiresAt !== undefined;
    if (hasLeaseOwner !== hasLeaseExpiry) {
      throw new AgentRuntimeRepositoryError(
        'INVALID_STATE',
        'leaseOwner and leaseExpiresAt must be supplied together.'
      );
    }
    if (input.leaseOwner !== undefined) {
      assertBoundedIdentifier(input.leaseOwner, 'run.leaseOwner');
      assertFutureDate(input.leaseExpiresAt!, now, 'run.leaseExpiresAt');
    }
    if (input.status !== undefined && !ACTIVE_STATUSES.has(input.status)) {
      throw new AgentRuntimeRepositoryError('INVALID_STATE', 'Initial run status must be active.');
    }
    if (input.startedAt) assertValidDate(input.startedAt, 'run.startedAt');

    const workspaceLease = hasLeaseOwner
      ? this.acquireWorkspaceLease({
          projectId: input.projectId,
          workspaceKey: input.workspaceKey,
          runId: input.id,
          leaseOwner: input.leaseOwner!,
          leaseExpiresAt: input.leaseExpiresAt!,
          now,
          blockUnresolvedMutations: true,
        })
      : null;

    const run: AgentRunRecord = {
      id: input.id,
      runInstanceId,
      projectId: input.projectId,
      requestId: input.requestId ?? null,
      workspaceKey: input.workspaceKey,
      status: input.status ?? (hasLeaseOwner ? 'running' : 'pending'),
      leaseOwner: input.leaseOwner ?? null,
      leaseExpiresAt: input.leaseExpiresAt ? new Date(input.leaseExpiresAt) : null,
      lastHeartbeatAt: hasLeaseOwner ? new Date(now) : null,
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
      turnCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cachedInputTokens: 0,
      cacheMissInputTokens: 0,
      reasoningTokens: 0,
      version: 0,
      lastEventSequence: 0,
      latestCheckpointSequence: null,
      errorCode: null,
      errorMessage: null,
      startedAt: input.startedAt
        ? new Date(input.startedAt)
        : hasLeaseOwner
          ? new Date(now)
          : null,
      finishedAt: null,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    };

    this.runs.set(run.id, run);
    this.runInstanceIds.add(runInstanceId);
    return cloneRun(run);
  }

  async getRun(runId: string): Promise<AgentRunRecord | null> {
    const run = this.runs.get(runId);
    return run ? cloneRun(run) : null;
  }

  async getWorkspaceLease(projectId: string): Promise<AgentWorkspaceLeaseRecord | null> {
    const lease = this.workspaceLeases.get(projectId);
    return lease ? cloneWorkspaceLease(lease) : null;
  }

  async assertWorkspaceLease(input: AgentWriteFence): Promise<void> {
    this.assertFence(input, input.now ?? this.clock());
  }

  async claimLease(input: ClaimAgentRunLeaseInput): Promise<AgentRunRecord> {
    const now = input.now ?? this.clock();
    assertBoundedIdentifier(input.leaseOwner, 'leaseOwner');
    assertNonNegativeInteger(input.expectedVersion, 'expectedVersion');
    assertFutureDate(input.leaseExpiresAt, now, 'leaseExpiresAt');
    const run = this.requireRun(input.runId);
    if (run.version !== input.expectedVersion) {
      throw new AgentRuntimeRepositoryError('CONFLICT', 'Agent run version changed.');
    }
    const terminalReconciliationAllowed = input.allowTerminalReconciliation === true &&
      !ACTIVE_STATUSES.has(run.status) &&
      [...this.toolExecutions.values()].some((execution) =>
        execution.runId === run.id &&
        UNRESOLVED_TOOL_STATUSES.has(execution.status) &&
        (execution.effect === 'workspace_write' || execution.effect === 'external_write')
      );
    if (!ACTIVE_STATUSES.has(run.status) && !terminalReconciliationAllowed) {
      throw new AgentRuntimeRepositoryError('INVALID_STATE', 'Terminal run cannot be leased.');
    }
    if (run.leaseExpiresAt && run.leaseExpiresAt > now) {
      throw new AgentRuntimeRepositoryError('LEASE_LOST', 'Agent run lease is still active.');
    }

    const workspaceLease = this.acquireWorkspaceLease({
      projectId: run.projectId,
      workspaceKey: run.workspaceKey,
      runId: run.id,
      leaseOwner: input.leaseOwner,
      leaseExpiresAt: input.leaseExpiresAt,
      now,
      blockUnresolvedMutations: false,
    });

    run.leaseOwner = input.leaseOwner;
    run.leaseExpiresAt = new Date(input.leaseExpiresAt);
    run.lastHeartbeatAt = new Date(now);
    run.fencingToken += 1;
    run.workspaceFencingToken = workspaceLease.fencingToken;
    run.status = run.status === 'pending' ? 'running' : 'reconciling';
    if (terminalReconciliationAllowed) {
      run.finishedAt = null;
      run.errorCode = null;
      run.errorMessage = null;
    }
    if (!run.startedAt) run.startedAt = new Date(now);
    this.bump(run, now);
    return cloneRun(run);
  }

  async heartbeat(input: HeartbeatAgentRunInput): Promise<AgentRunRecord> {
    const now = input.now ?? this.clock();
    assertFutureDate(input.leaseExpiresAt, now, 'leaseExpiresAt');
    const run = this.assertFence(input, now);
    const workspaceLease = this.requireWorkspaceLease(run.projectId);
    run.leaseExpiresAt = new Date(input.leaseExpiresAt);
    run.lastHeartbeatAt = new Date(now);
    workspaceLease.leaseExpiresAt = new Date(input.leaseExpiresAt);
    workspaceLease.lastHeartbeatAt = new Date(now);
    workspaceLease.version += 1;
    workspaceLease.updatedAt = new Date(now);
    this.bump(run, now);
    return cloneRun(run);
  }

  async appendEvent(input: AppendAgentEventInput): Promise<AppendAgentEventResult> {
    assertPositiveInteger(input.sequence, 'event.sequence');
    assertBoundedIdentifier(input.eventId, 'event.eventId', 512);
    assertBoundedIdentifier(input.eventType, 'event.eventType');
    assertValidDate(input.occurredAt, 'event.occurredAt');
    const payload = clonePublicRuntimeJson(input.payload, 'agent event payload');
    if (input.cumulativeUsage) assertUsage(input.cumulativeUsage);
    const now = input.now ?? this.clock();
    const run = this.requireRun(input.runId);
    const existingByEventId = (this.events.get(run.id) ?? []).find(
      (event) => event.eventId === input.eventId
    );
    const existingBySequence = (this.events.get(run.id) ?? []).find(
      (event) => event.sequence === input.sequence
    );
    const existing = existingByEventId ?? existingBySequence;
    if (existing) {
      if (
        existing.eventId === input.eventId &&
        existing.sequence === input.sequence &&
        existing.eventType === input.eventType &&
        existing.occurredAt.getTime() === input.occurredAt.getTime() &&
        canonicalJson(existing.payload) === canonicalJson(payload)
      ) {
        this.assertReplayLease(input, now);
        return { run: cloneRun(run), event: cloneEvent(existing) };
      }
      throw new AgentRuntimeRepositoryError(
        'CONFLICT',
        'Agent event ID or sequence is already bound to different content.'
      );
    }
    this.assertFence(input, now);
    if (input.sequence <= run.lastEventSequence) {
      throw new AgentRuntimeRepositoryError(
        'CONFLICT',
        `Event sequence must be greater than ${run.lastEventSequence}.`
      );
    }
    if (this.eventIds.has(input.eventId)) {
      throw new AgentRuntimeRepositoryError('CONFLICT', 'Agent event ID already exists.');
    }

    const event: AgentEventRecord = {
      id: `evt_${this.uuid()}`,
      eventId: input.eventId,
      runId: run.id,
      sequence: input.sequence,
      eventType: input.eventType,
      payload,
      occurredAt: new Date(input.occurredAt),
      createdAt: new Date(now),
    };
    run.lastEventSequence = input.sequence;
    if (input.cumulativeUsage) {
      run.inputTokens = input.cumulativeUsage.inputTokens;
      run.outputTokens = input.cumulativeUsage.outputTokens;
      run.totalTokens = input.cumulativeUsage.totalTokens;
      run.cachedInputTokens = input.cumulativeUsage.cachedInputTokens;
      run.cacheMissInputTokens = input.cumulativeUsage.cacheMissInputTokens;
      run.reasoningTokens = input.cumulativeUsage.reasoningTokens;
    }
    this.bump(run, now);
    this.events.set(run.id, [...(this.events.get(run.id) ?? []), event]);
    this.eventIds.add(input.eventId);
    return { run: cloneRun(run), event: cloneEvent(event) };
  }

  async listEventsAfter(
    runId: string,
    sequence: number,
    limit = 500
  ): Promise<AgentEventRecord[]> {
    assertNonNegativeInteger(sequence, 'sequence');
    assertPositiveInteger(limit, 'limit');
    return (this.events.get(runId) ?? [])
      .filter((event) => event.sequence > sequence)
      .slice(0, Math.min(limit, 1_000))
      .map(cloneEvent);
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
    const now = input.now ?? this.clock();
    const run = this.assertFence(input, now);
    if (input.sequence > run.lastEventSequence) {
      throw new AgentRuntimeRepositoryError(
        'INVALID_STATE',
        'Checkpoint cannot be ahead of the durable event stream.'
      );
    }
    if (
      run.latestCheckpointSequence !== null &&
      input.sequence <= run.latestCheckpointSequence
    ) {
      throw new AgentRuntimeRepositoryError(
        'CONFLICT',
        'Checkpoint sequence must advance monotonically.'
      );
    }

    const checkpoint: AgentCheckpointRecord = {
      id: `chk_${this.uuid()}`,
      runId: run.id,
      sequence: input.sequence,
      turn: input.turn,
      boundary: input.boundary,
      recoveryMode: 'replan_required',
      publicState,
      opaqueState: input.opaque?.value ?? null,
      opaqueCodec: input.opaque?.codec ?? null,
      stateHash: input.stateHash,
      stateVersion: input.stateVersion,
      fencingToken: run.fencingToken,
      createdAt: new Date(now),
    };
    run.latestCheckpointSequence = input.sequence;
    run.turnCount = Math.max(run.turnCount, input.turn);
    this.bump(run, now);
    this.checkpoints.set(run.id, [...(this.checkpoints.get(run.id) ?? []), checkpoint]);
    return { run: cloneRun(run), checkpoint: cloneCheckpoint(checkpoint) };
  }

  async getLatestCheckpoint(runId: string): Promise<AgentCheckpointRecord | null> {
    const checkpoints = this.checkpoints.get(runId) ?? [];
    const checkpoint = checkpoints.at(-1);
    return checkpoint ? cloneCheckpoint(checkpoint) : null;
  }

  async prepareToolExecution(
    input: PrepareAgentToolExecutionInput
  ): Promise<PrepareAgentToolExecutionResult> {
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

    const existing = this.toolExecutions.get(input.operationId);
    if (existing) {
      assertToolIdentity(existing, input);
      const run = this.assertReplayLease(input, input.now ?? this.clock());
      return {
        run: cloneRun(run),
        execution: cloneToolExecution(existing),
        created: false,
      };
    }

    const now = input.now ?? this.clock();
    const run = this.assertFence(input, now);
    if (input.effect === 'workspace_write' || input.effect === 'external_write') {
      const unresolved = [...this.toolExecutions.values()].find((candidate) => {
        const candidateRun = this.runs.get(candidate.runId);
        return candidate.operationId !== input.operationId &&
          candidateRun?.projectId === run.projectId &&
          UNRESOLVED_TOOL_STATUSES.has(candidate.status) &&
          (candidate.effect === 'workspace_write' || candidate.effect === 'external_write');
      });
      if (unresolved) {
        throw new AgentRuntimeRepositoryError(
          'RECONCILIATION_REQUIRED',
          'Workspace has an unresolved mutating operation.'
        );
      }
    }
    const execution: AgentToolExecutionRecord = {
      id: `tool_${this.uuid()}`,
      runId: run.id,
      operationId: input.operationId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      inputHash: input.inputHash,
      effect: input.effect,
      idempotency: input.idempotency,
      idempotencyKey: input.idempotencyKey ?? null,
      status: 'prepared',
      resultReceipt: null,
      preStateHash: input.preStateHash ?? null,
      postStateHash: null,
      errorCode: null,
      errorMessage: null,
      fencingToken: run.fencingToken,
      workspaceFencingToken: run.workspaceFencingToken,
      preparedAt: new Date(now),
      completedAt: null,
      updatedAt: new Date(now),
    };
    this.bump(run, now);
    this.toolExecutions.set(input.operationId, execution);
    return { run: cloneRun(run), execution: cloneToolExecution(execution), created: true };
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

    const execution = this.toolExecutions.get(input.operationId);
    if (!execution || execution.runId !== input.runId) {
      throw new AgentRuntimeRepositoryError('NOT_FOUND', 'Tool execution was not found.');
    }
    if (
      input.preStateHash !== undefined &&
      execution.preStateHash !== null &&
      execution.preStateHash !== input.preStateHash
    ) {
      throw new AgentRuntimeRepositoryError(
        'OPERATION_CONFLICT',
        'Tool operation pre-state hash cannot be overwritten.'
      );
    }
    if (execution.status !== 'prepared' && execution.status !== 'commit_authorized') {
      const sameReceipt = canonicalJson(execution.resultReceipt) === canonicalJson(receipt);
      if (
        execution.status === input.status &&
        (input.preStateHash === undefined ||
          execution.preStateHash === input.preStateHash) &&
        execution.postStateHash === (input.postStateHash ?? null) &&
        execution.errorCode === (input.error?.code ?? null) &&
        execution.errorMessage === (input.error?.message ?? null) &&
        sameReceipt
      ) {
        const run = this.assertReplayLease(input, input.now ?? this.clock());
        return {
          run: cloneRun(run),
          execution: cloneToolExecution(execution),
        };
      }
      throw new AgentRuntimeRepositoryError(
        'OPERATION_CONFLICT',
        'Tool operation has already reached a different terminal state.'
      );
    }

    const now = input.now ?? this.clock();
    const run = this.assertFence(input, now);
    if (
      input.status === 'succeeded' &&
      execution.effect === 'workspace_write' &&
      execution.status !== 'commit_authorized'
    ) {
      throw new AgentRuntimeRepositoryError(
        'OPERATION_CONFLICT',
        'Workspace mutation cannot succeed before its physical commit is authorized.'
      );
    }
    execution.status = input.status;
    execution.resultReceipt = receipt;
    execution.preStateHash = input.preStateHash ?? execution.preStateHash;
    execution.postStateHash = input.postStateHash ?? null;
    execution.errorCode = input.error?.code ?? null;
    execution.errorMessage = input.error?.message ?? null;
    execution.completedAt = new Date(now);
    execution.updatedAt = new Date(now);
    this.bump(run, now);
    return { run: cloneRun(run), execution: cloneToolExecution(execution) };
  }

  async getToolExecution(operationId: string): Promise<AgentToolExecutionRecord | null> {
    const execution = this.toolExecutions.get(operationId);
    return execution ? cloneToolExecution(execution) : null;
  }

  async commitWorkspaceMutation<T>(
    input: CommitAgentWorkspaceMutationInput,
    commit: () => Promise<T>
  ): Promise<T> {
    const now = input.now ?? this.clock();
    const run = this.assertFence(input, now);
    const execution = this.toolExecutions.get(input.operationId);
    if (
      !execution ||
      execution.runId !== run.id ||
      execution.status !== 'prepared' ||
      execution.effect !== 'workspace_write' ||
      execution.fencingToken !== input.fencingToken ||
      execution.workspaceFencingToken !== input.workspaceFencingToken ||
      run.status !== 'running'
    ) {
      throw new AgentRuntimeRepositoryError(
        'OPERATION_CONFLICT',
        'Workspace mutation is not backed by a prepared operation ledger entry.'
      );
    }
    if (this.workspaceCommitLocks.has(run.projectId)) {
      throw new AgentRuntimeRepositoryError('WORKSPACE_BUSY', 'Workspace commit is already locked.');
    }
    this.workspaceCommitLocks.add(run.projectId);
    try {
      this.assertFence(input, input.now ?? this.clock());
      execution.status = 'commit_authorized';
      execution.updatedAt = new Date(input.now ?? this.clock());
      return await commit();
    } finally {
      this.workspaceCommitLocks.delete(run.projectId);
    }
  }

  async completeRun(input: CompleteAgentRunInput): Promise<AgentRunRecord> {
    assertNonNegativeInteger(input.turnCount, 'run.turnCount');
    assertUsage(input.usage);
    if (!TERMINAL_STATUSES.has(input.status)) {
      throw new AgentRuntimeRepositoryError('INVALID_STATE', 'Run status is not terminal.');
    }
    if (input.status === 'failed' && !input.error) {
      throw new AgentRuntimeRepositoryError(
        'INVALID_STATE',
        'Failed run requires a public error code and message.'
      );
    }
    const now = input.now ?? this.clock();
    const finishedAt = input.finishedAt ?? now;
    assertValidDate(finishedAt, 'run.finishedAt');
    const run = this.assertFence(input, now);
    run.status = input.status;
    run.turnCount = input.turnCount;
    run.inputTokens = input.usage.inputTokens;
    run.outputTokens = input.usage.outputTokens;
    run.totalTokens = input.usage.totalTokens;
    run.cachedInputTokens = input.usage.cachedInputTokens;
    run.cacheMissInputTokens = input.usage.cacheMissInputTokens;
    run.reasoningTokens = input.usage.reasoningTokens;
    run.errorCode = input.error?.code ?? null;
    run.errorMessage = input.error?.message ?? null;
    run.finishedAt = new Date(finishedAt);
    run.leaseOwner = null;
    run.leaseExpiresAt = null;
    const workspaceLease = this.requireWorkspaceLease(run.projectId);
    workspaceLease.status = 'free';
    workspaceLease.activeRunId = null;
    workspaceLease.leaseOwner = null;
    workspaceLease.leaseExpiresAt = null;
    workspaceLease.lastHeartbeatAt = new Date(now);
    workspaceLease.releasedAt = new Date(now);
    workspaceLease.version += 1;
    workspaceLease.updatedAt = new Date(now);
    this.bump(run, now);
    return cloneRun(run);
  }

  async listReconciliationCandidates(
    query: ReconciliationQuery = {}
  ): Promise<AgentReconciliationCandidate[]> {
    const now = query.now ?? this.clock();
    const limit = Math.min(query.limit ?? 100, 1_000);
    assertPositiveInteger(limit, 'reconciliation limit');
    return [...this.runs.values()]
      .filter((run) => {
        if (query.projectId && run.projectId !== query.projectId) return false;
        const expiredActive =
          ACTIVE_STATUSES.has(run.status) &&
          (!run.leaseExpiresAt || run.leaseExpiresAt <= now);
        const unresolvedMutation = [...this.toolExecutions.values()].some(
          (execution) =>
            execution.runId === run.id &&
            UNRESOLVED_TOOL_STATUSES.has(execution.status) &&
            (execution.effect === 'workspace_write' || execution.effect === 'external_write')
        );
        return expiredActive || unresolvedMutation;
      })
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())
      .slice(0, limit)
      .map((run) => {
        const checkpoints = this.checkpoints.get(run.id) ?? [];
        const checkpoint = checkpoints.at(-1) ?? null;
        const unresolvedToolExecutions = [...this.toolExecutions.values()]
          .filter(
            (execution) =>
              execution.runId === run.id && UNRESOLVED_TOOL_STATUSES.has(execution.status)
          )
          .sort((left, right) => left.preparedAt.getTime() - right.preparedAt.getTime());
        return {
          run: cloneRun(run),
          checkpoint: checkpoint ? cloneCheckpoint(checkpoint) : null,
          unresolvedToolExecutions: unresolvedToolExecutions.map(cloneToolExecution),
        };
      });
  }

  private requireRun(runId: string): AgentRunRecord {
    const run = this.runs.get(runId);
    if (!run) {
      throw new AgentRuntimeRepositoryError('NOT_FOUND', 'Agent run was not found.');
    }
    return run;
  }

  private requireWorkspaceLease(projectId: string): AgentWorkspaceLeaseRecord {
    const lease = this.workspaceLeases.get(projectId);
    if (!lease) {
      throw new AgentRuntimeRepositoryError('LEASE_LOST', 'Workspace lease was not found.');
    }
    return lease;
  }

  private assertFence(input: AgentWriteFence, now: Date): AgentRunRecord {
    assertNonNegativeInteger(input.expectedVersion, 'expectedVersion');
    assertNonNegativeInteger(input.fencingToken, 'fencingToken');
    assertNonNegativeInteger(input.workspaceFencingToken, 'workspaceFencingToken');
    assertBoundedIdentifier(input.leaseOwner, 'leaseOwner');
    const run = this.requireRun(input.runId);
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
    if (!ACTIVE_STATUSES.has(run.status)) {
      throw new AgentRuntimeRepositoryError('INVALID_STATE', 'Agent run is terminal.');
    }
    this.assertWorkspaceFenceRecord(run, input, now);
    return run;
  }

  /**
   * A response-lost retry may carry an older CAS version, but it must still be
   * made by the current live lease/fencing owner. This path never authorizes a
   * second side effect; callers use it only to inspect an identical commit.
   */
  private assertReplayLease(input: AgentWriteFence, now: Date): AgentRunRecord {
    assertNonNegativeInteger(input.expectedVersion, 'expectedVersion');
    assertNonNegativeInteger(input.fencingToken, 'fencingToken');
    assertNonNegativeInteger(input.workspaceFencingToken, 'workspaceFencingToken');
    assertBoundedIdentifier(input.leaseOwner, 'leaseOwner');
    const run = this.requireRun(input.runId);
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
    if (!ACTIVE_STATUSES.has(run.status)) {
      throw new AgentRuntimeRepositoryError('INVALID_STATE', 'Agent run is terminal.');
    }
    this.assertWorkspaceFenceRecord(run, input, now);
    return run;
  }

  private assertWorkspaceFenceRecord(
    run: AgentRunRecord,
    input: AgentWriteFence,
    now: Date
  ): void {
    const lease = this.requireWorkspaceLease(run.projectId);
    if (
      lease.status !== 'held' ||
      lease.activeRunId !== run.id ||
      lease.workspaceKey !== run.workspaceKey ||
      lease.leaseOwner !== input.leaseOwner ||
      lease.fencingToken !== input.workspaceFencingToken ||
      run.workspaceFencingToken !== input.workspaceFencingToken ||
      !lease.leaseExpiresAt ||
      lease.leaseExpiresAt <= now
    ) {
      throw new AgentRuntimeRepositoryError('LEASE_LOST', 'Workspace lease was lost.');
    }
  }

  private acquireWorkspaceLease(input: {
    projectId: string;
    workspaceKey: string;
    runId: string;
    leaseOwner: string;
    leaseExpiresAt: Date;
    now: Date;
    blockUnresolvedMutations: boolean;
  }): AgentWorkspaceLeaseRecord {
    if (this.workspaceCommitLocks.has(input.projectId)) {
      throw new AgentRuntimeRepositoryError('WORKSPACE_BUSY', 'Workspace mutation commit is locked.');
    }
    const existing = this.workspaceLeases.get(input.projectId);
    if (existing && existing.workspaceKey !== input.workspaceKey) {
      throw new AgentRuntimeRepositoryError(
        'WORKSPACE_BINDING_CONFLICT',
        'Project is already bound to a different canonical workspace.'
      );
    }
    const keyOwner = [...this.workspaceLeases.values()].find(
      (lease) => lease.workspaceKey === input.workspaceKey && lease.projectId !== input.projectId
    );
    if (keyOwner) {
      throw new AgentRuntimeRepositoryError(
        'WORKSPACE_BINDING_CONFLICT',
        'Canonical workspace is already bound to another project.'
      );
    }
    if (
      existing?.status === 'held' &&
      existing.leaseOwner &&
      existing.leaseExpiresAt &&
      existing.leaseExpiresAt > input.now
    ) {
      throw new AgentRuntimeRepositoryError('WORKSPACE_BUSY', 'Workspace lease is still active.');
    }

    const unresolvedMutations = [...this.toolExecutions.values()].filter(
      (execution) => {
        const run = this.runs.get(execution.runId);
        return run?.projectId === input.projectId &&
          UNRESOLVED_TOOL_STATUSES.has(execution.status) &&
          (execution.effect === 'workspace_write' || execution.effect === 'external_write');
      }
    );
    if (input.blockUnresolvedMutations && unresolvedMutations.length > 0) {
      throw new AgentRuntimeRepositoryError(
        'RECONCILIATION_REQUIRED',
        'Workspace has unresolved mutating operations.'
      );
    }

    if (existing?.activeRunId && existing.activeRunId !== input.runId) {
      const staleRun = this.runs.get(existing.activeRunId);
      if (staleRun && ACTIVE_STATUSES.has(staleRun.status)) {
        staleRun.status = 'interrupted';
        staleRun.errorCode = 'WORKSPACE_LEASE_EXPIRED_REPLAN_REQUIRED';
        staleRun.errorMessage = 'Expired workspace owner was fenced by a new replan run.';
        staleRun.finishedAt = new Date(input.now);
        staleRun.leaseOwner = null;
        staleRun.leaseExpiresAt = null;
        this.bump(staleRun, input.now);
      }
    }

    const lease: AgentWorkspaceLeaseRecord = existing ?? {
      projectId: input.projectId,
      workspaceKey: input.workspaceKey,
      status: 'free',
      activeRunId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastHeartbeatAt: null,
      fencingToken: 0,
      version: 0,
      acquiredAt: null,
      releasedAt: null,
      createdAt: new Date(input.now),
      updatedAt: new Date(input.now),
    };
    lease.status = 'held';
    lease.activeRunId = input.runId;
    lease.leaseOwner = input.leaseOwner;
    lease.leaseExpiresAt = new Date(input.leaseExpiresAt);
    lease.lastHeartbeatAt = new Date(input.now);
    lease.fencingToken += 1;
    lease.version += 1;
    lease.acquiredAt = new Date(input.now);
    lease.releasedAt = null;
    lease.updatedAt = new Date(input.now);
    this.workspaceLeases.set(input.projectId, lease);
    return lease;
  }

  private bump(run: AgentRunRecord, now: Date): void {
    run.version += 1;
    run.updatedAt = new Date(now);
  }
}
