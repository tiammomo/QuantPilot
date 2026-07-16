import { randomUUID } from 'node:crypto';

import { prisma } from '@/lib/db/client';
import {
  PrismaAgentRuntimeRepository,
  projectMoAgentEvent,
  sha256,
} from '@/lib/agent/runtime';
import { mutationOutcomeRequiresReconciliation } from '@/lib/agent/core/tool-outcome';
import { recordQuotaUsage } from '@/lib/quota';
import { runIndependentTerminalCallbacks } from './terminal-callbacks';
import type {
  AgentRunProvenance,
  AgentRunRecord,
  AgentRuntimeRepository,
  AgentTokenUsage,
  AgentWriteFence,
  RuntimeJson,
  RuntimeJsonObject,
  TerminalAgentRunStatus,
} from '@/lib/agent/runtime';
import type {
  Awaitable,
  MoAgentEvent,
  MoAgentRunStatus,
  MoAgentTokenUsage,
} from '@/lib/agent/types';

const DEFAULT_LEASE_TTL_MS = 60_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const CHECKPOINT_STATE_VERSION = 1;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/i;
const SAFE_ERROR_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]{0,95}$/;

const ZERO_USAGE: AgentTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cachedInputTokens: 0,
  cacheMissInputTokens: 0,
  reasoningTokens: 0,
};

export interface MoAgentRunStoreScheduler {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface MoAgentDurableRunInput extends AgentRunProvenance {
  runId: string;
  runInstanceId?: string;
  projectId: string;
  workspaceKey: string;
  requestId?: string;
  startedAt?: Date;
}

export interface CreateMoAgentDurableRunSessionOptions {
  repository: AgentRuntimeRepository;
  run: MoAgentDurableRunInput;
  leaseOwner?: string;
  leaseTtlMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatEnabled?: boolean;
  clock?: () => Date;
  scheduler?: MoAgentRunStoreScheduler;
  onFatal?: (error: unknown) => Awaitable<void>;
  onTerminalRun?: (run: AgentRunRecord) => Awaitable<void>;
}

export type CreatePrismaMoAgentDurableRunSessionOptions = Omit<
  CreateMoAgentDurableRunSessionOptions,
  'repository'
>;

export interface InterruptMoAgentDurableRunOptions {
  code?: string;
  turnCount?: number;
  usage?: MoAgentTokenUsage;
  finishedAt?: Date;
}

export class MoAgentToolReplayBlockedError extends Error {
  constructor(
    readonly operationId: string,
    readonly executionStatus: string
  ) {
    super(`MoAgent operation ${operationId} already exists in state ${executionStatus}; execution is blocked.`);
    this.name = 'MoAgentToolReplayBlockedError';
  }
}

const defaultScheduler: MoAgentRunStoreScheduler = {
  setInterval(callback, intervalMs) {
    const handle = globalThis.setInterval(callback, intervalMs);
    if (typeof handle === 'object' && handle && 'unref' in handle) {
      (handle as { unref(): void }).unref();
    }
    return handle;
  },
  clearInterval(handle) {
    globalThis.clearInterval(handle as ReturnType<typeof globalThis.setInterval>);
  },
};

function positiveSafeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer.`);
  }
  return value;
}

function cloneRun(run: AgentRunRecord): AgentRunRecord {
  return {
    ...run,
    leaseExpiresAt: run.leaseExpiresAt ? new Date(run.leaseExpiresAt) : null,
    lastHeartbeatAt: run.lastHeartbeatAt ? new Date(run.lastHeartbeatAt) : null,
    startedAt: run.startedAt ? new Date(run.startedAt) : null,
    finishedAt: run.finishedAt ? new Date(run.finishedAt) : null,
    createdAt: new Date(run.createdAt),
    updatedAt: new Date(run.updatedAt),
  };
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error('MoAgent durable store failed.');
}

function isRuntimeJsonObject(value: RuntimeJson | undefined): value is RuntimeJsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeUsage(usage: MoAgentTokenUsage): AgentTokenUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
    cacheMissInputTokens: usage.cacheMissInputTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
  };
}

function durableStatus(status: MoAgentRunStatus): TerminalAgentRunStatus {
  switch (status) {
    case 'completed':
      return 'candidate_complete';
    case 'timeout':
      return 'timed_out';
    case 'cancelled':
      return 'cancelled';
    case 'max_turns':
    case 'max_tokens':
    case 'stopped':
    case 'failed':
      return 'failed';
  }
}

function completionError(status: MoAgentRunStatus, projected: RuntimeJsonObject): {
  code: string;
  message: string;
} | undefined {
  if (status === 'completed') return undefined;
  const projectedCode =
    typeof projected.errorCode === 'string' ? projected.errorCode : undefined;
  const code = projectedCode ?? (() => {
    switch (status) {
      case 'max_turns':
        return 'MAX_TURNS_EXCEEDED';
      case 'max_tokens':
        return 'MAX_TOKENS_EXCEEDED';
      case 'timeout':
        return 'RUN_TIMEOUT';
      case 'cancelled':
        return 'RUN_CANCELLED';
      case 'failed':
        return 'RUN_FAILED';
      case 'stopped':
        return 'TERMINAL_TOOL_REQUIRED';
      default:
        return 'RUN_ENDED';
    }
  })();
  return { code, message: `MoAgent run ended with ${code}.` };
}

function safeErrorCode(value: string, fallback: string): string {
  return SAFE_ERROR_CODE_PATTERN.test(value)
    ? value
    : `${fallback}_${sha256(value).slice(0, 24)}`;
}

function projectedOperationId(projection: RuntimeJsonObject): string {
  if (typeof projection.operationId !== 'string') {
    throw new Error('Durable tool projection is missing its operation ID.');
  }
  return projection.operationId;
}

function normalizedStateHash(value: unknown): string | undefined {
  if (typeof value !== 'string' || !SHA256_HEX_PATTERN.test(value)) return undefined;
  return `sha256:${value.toLowerCase()}`;
}

/** Read exact data properties without invoking an untrusted getter. */
function resultStateHashes(event: Extract<MoAgentEvent, { type: 'tool_completed' }>): {
  preStateHash?: string;
  postStateHash?: string;
} {
  const data = event.result.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
  const before = Object.getOwnPropertyDescriptor(data, 'beforeSha256');
  const after = Object.getOwnPropertyDescriptor(data, 'afterSha256');
  const preStateHash = before && 'value' in before
    ? normalizedStateHash(before.value)
    : undefined;
  const postStateHash = after && 'value' in after
    ? normalizedStateHash(after.value)
    : undefined;
  return {
    ...(preStateHash ? { preStateHash } : {}),
    ...(postStateHash ? { postStateHash } : {}),
  };
}

function resultReceipt(projection: RuntimeJsonObject, uncertain: boolean): RuntimeJsonObject {
  const audit = projection.resultAudit;
  return {
    ...(isRuntimeJsonObject(audit) ? { resultAudit: audit } : {}),
    ...(uncertain ? { reconciliation: 'required' } : {}),
  };
}

function checkpointState(input: {
  stage: 'run_started' | 'tools_completed';
  turn: number;
  sourceSequence: number;
  completedOperationIds: readonly string[];
}): RuntimeJsonObject {
  return {
    recoveryMode: 'replan_required',
    stage: input.stage,
    turn: input.turn,
    sourceSequence: input.sourceSequence,
    completedOperationIds: [...input.completedOperationIds],
  };
}

/**
 * Product-layer durable sink for one physical MoAgent run.
 *
 * All repository writes, including heartbeats, share one queue so the CAS
 * version returned by one mutation is always carried into the next mutation.
 */
export class MoAgentDurableRunSession {
  private readonly repository: AgentRuntimeRepository;
  private readonly leaseOwner: string;
  private readonly leaseTtlMs: number;
  private readonly heartbeatIntervalMs: number;
  private readonly clock: () => Date;
  private readonly scheduler: MoAgentRunStoreScheduler;
  private readonly onFatal?: (error: unknown) => Awaitable<void>;
  private readonly onTerminalRun?: (run: AgentRunRecord) => Awaitable<void>;
  private currentRun: AgentRunRecord;
  private writeQueue: Promise<void> = Promise.resolve();
  private timerHandle: unknown;
  private fatalError: Error | null = null;
  private closed = false;
  private terminal = false;
  private lastTurn = 0;
  private lastUsage: AgentTokenUsage = { ...ZERO_USAGE };
  private readonly completedOperationIds: string[] = [];
  private readonly completedOperationIdSet = new Set<string>();

  private constructor(
    options: CreateMoAgentDurableRunSessionOptions,
    run: AgentRunRecord,
    leaseOwner: string,
    leaseTtlMs: number,
    heartbeatIntervalMs: number
  ) {
    this.repository = options.repository;
    this.currentRun = run;
    this.leaseOwner = leaseOwner;
    this.leaseTtlMs = leaseTtlMs;
    this.heartbeatIntervalMs = heartbeatIntervalMs;
    this.clock = options.clock ?? (() => new Date());
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.onFatal = options.onFatal;
    this.onTerminalRun = options.onTerminalRun;

    if (options.heartbeatEnabled !== false) this.startHeartbeat();
  }

  static async create(
    options: CreateMoAgentDurableRunSessionOptions
  ): Promise<MoAgentDurableRunSession> {
    const clock = options.clock ?? (() => new Date());
    const leaseTtlMs = positiveSafeInteger(
      options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
      'leaseTtlMs'
    );
    const heartbeatIntervalMs = positiveSafeInteger(
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      'heartbeatIntervalMs'
    );
    if (options.heartbeatEnabled !== false && heartbeatIntervalMs >= leaseTtlMs) {
      throw new Error('heartbeatIntervalMs must be smaller than leaseTtlMs.');
    }

    const now = clock();
    const leaseOwner = options.leaseOwner ?? `worker:${process.pid}:${randomUUID()}`;
    const run = await options.repository.createRun({
      id: options.run.runId,
      ...(options.run.runInstanceId ? { runInstanceId: options.run.runInstanceId } : {}),
      projectId: options.run.projectId,
      workspaceKey: options.run.workspaceKey,
      ...(options.run.requestId ? { requestId: options.run.requestId } : {}),
      provider: options.run.provider,
      model: options.run.model,
      frameworkVersion: options.run.frameworkVersion,
      buildRevision: options.run.buildRevision,
      profileHash: options.run.profileHash,
      promptHash: options.run.promptHash,
      toolHash: options.run.toolHash,
      skillHash: options.run.skillHash,
      workspaceHash: options.run.workspaceHash,
      status: 'running',
      leaseOwner,
      leaseExpiresAt: new Date(now.getTime() + leaseTtlMs),
      startedAt: options.run.startedAt ?? now,
    });

    return new MoAgentDurableRunSession(
      { ...options, clock },
      run,
      leaseOwner,
      leaseTtlMs,
      heartbeatIntervalMs
    );
  }

  get run(): AgentRunRecord {
    return cloneRun(this.currentRun);
  }

  get failure(): Error | null {
    return this.fatalError;
  }

  async record(event: MoAgentEvent): Promise<void> {
    if (this.closed) throw new Error('MoAgent durable run session is closed.');
    if (event.runId !== this.currentRun.id) {
      throw new Error('MoAgent event belongs to a different durable run.');
    }

    const projection = projectMoAgentEvent(event);
    if (projection === null) return;
    if (event.type === 'run_finished') this.stopHeartbeat();

    return this.serialize(async () => {
      if (this.terminal) return;
      this.observeCounters(event);

      if (event.type === 'tool_started') {
        await this.prepareTool(event, projection);
      } else if (event.type === 'tool_completed' || event.type === 'tool_failed') {
        await this.completeTool(event, projection);
      }

      await this.appendEvent(event, projection);

      if (event.type === 'run_started') {
        await this.saveCheckpoint('run_started', 0, event.sequence);
      } else if (event.type === 'tool_completed' || event.type === 'tool_failed') {
        await this.saveCheckpoint('tools_completed', event.turn, event.sequence);
      } else if (event.type === 'run_finished') {
        await this.completeRun(event, projection);
      }
    });
  }

  async interrupt(options: InterruptMoAgentDurableRunOptions = {}): Promise<void> {
    this.stopHeartbeat();
    return this.serialize(async () => {
      if (this.terminal) return;
      const code = safeErrorCode(options.code ?? 'REPLAN_REQUIRED', 'interrupt');
      const now = this.clock();
      this.currentRun = await this.repository.completeRun({
        ...this.fence(now),
        status: 'interrupted',
        turnCount: options.turnCount ?? this.lastTurn,
        usage: options.usage ? normalizeUsage(options.usage) : this.lastUsage,
        finishedAt: options.finishedAt ?? now,
        error: {
          code,
          message: `MoAgent run was interrupted with ${code}.`,
        },
      });
      await this.notifyTerminalRun();
      this.terminal = true;
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopHeartbeat();
    await this.writeQueue;
  }

  async assertWorkspaceFence(): Promise<void> {
    return this.serialize(async () => {
      await this.repository.assertWorkspaceLease(this.fence(this.clock()));
    });
  }

  async commitWorkspaceMutation<T>(
    operationId: string,
    commit: () => Promise<T>
  ): Promise<T> {
    let effectError: unknown;
    return this.serialize(
      () => this.repository.commitWorkspaceMutation(
        { ...this.fence(this.clock()), operationId },
        async () => {
          try {
            return await commit();
          } catch (error) {
            effectError = error;
            throw error;
          }
        }
      ),
      { captureFailure: (error) => error !== effectError }
    );
  }

  private startHeartbeat(): void {
    this.timerHandle = this.scheduler.setInterval(() => {
      if (this.closed || this.terminal || this.fatalError) return;
      void this.serialize(async () => {
        if (this.closed || this.terminal) return;
        const now = this.clock();
        this.currentRun = await this.repository.heartbeat({
          ...this.fence(now),
          leaseExpiresAt: new Date(now.getTime() + this.leaseTtlMs),
        });
      }).catch(() => undefined);
    }, this.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.timerHandle === undefined) return;
    this.scheduler.clearInterval(this.timerHandle);
    this.timerHandle = undefined;
  }

  private serialize<T>(
    operation: () => Promise<T>,
    options: { captureFailure?: (error: unknown) => boolean } = {}
  ): Promise<T> {
    const task = this.writeQueue.then(async () => {
      if (this.fatalError) throw this.fatalError;
      return operation();
    });
    this.writeQueue = task.then(
      () => undefined,
      (error: unknown) => {
        if (options.captureFailure?.(error) !== false) this.captureFatal(error);
      }
    );
    return task;
  }

  private captureFatal(error: unknown): void {
    if (this.fatalError) return;
    this.fatalError = asError(error);
    this.stopHeartbeat();
    if (this.onFatal) {
      void Promise.resolve(this.onFatal(error)).catch(() => undefined);
    }
  }

  private fence(now: Date): AgentWriteFence {
    if (
      this.currentRun.leaseOwner !== this.leaseOwner ||
      this.currentRun.fencingToken <= 0 ||
      this.currentRun.workspaceFencingToken <= 0
    ) {
      throw new Error('MoAgent durable run no longer owns its lease.');
    }
    return {
      runId: this.currentRun.id,
      expectedVersion: this.currentRun.version,
      leaseOwner: this.leaseOwner,
      fencingToken: this.currentRun.fencingToken,
      workspaceFencingToken: this.currentRun.workspaceFencingToken,
      now,
    };
  }

  private async prepareTool(
    event: Extract<MoAgentEvent, { type: 'tool_started' }>,
    projection: RuntimeJsonObject
  ): Promise<void> {
    const now = this.clock();
    const operationId = projectedOperationId(projection);
    const prepared = await this.repository.prepareToolExecution({
      ...this.fence(now),
      operationId,
      toolCallId: `sha256:${sha256(event.toolCall.id)}`,
      toolName:
        typeof projection.toolName === 'string' ? projection.toolName : 'tool_unknown',
      inputHash: `sha256:${sha256(event.toolCall.arguments)}`,
      effect: event.effect,
      idempotency: event.idempotency,
      ...(event.idempotency === 'operation_key'
        ? { idempotencyKey: operationId }
        : {}),
    });
    this.currentRun = prepared.run;
    if (!prepared.created) {
      throw new MoAgentToolReplayBlockedError(operationId, prepared.execution.status);
    }
  }

  private async completeTool(
    event: Extract<MoAgentEvent, { type: 'tool_completed' | 'tool_failed' }>,
    projection: RuntimeJsonObject
  ): Promise<void> {
    const uncertain = event.type === 'tool_failed' &&
      mutationOutcomeRequiresReconciliation(event.effect, event.result);
    const now = this.clock();
    const operationId = projectedOperationId(projection);
    const completed = await this.repository.completeToolExecution({
      ...this.fence(now),
      operationId,
      status: event.type === 'tool_completed' ? 'succeeded' : uncertain ? 'uncertain' : 'failed',
      resultReceipt: resultReceipt(projection, uncertain),
      ...(event.type === 'tool_completed' ? resultStateHashes(event) : {}),
      ...(event.type === 'tool_failed'
        ? {
            error: {
              code:
                typeof projection.errorCode === 'string'
                  ? projection.errorCode
                  : uncertain
                    ? 'EFFECT_OUTCOME_UNCERTAIN'
                    : 'TOOL_FAILED',
              message: uncertain
                ? 'Mutating tool outcome requires reconciliation.'
                : 'Tool execution failed.',
            },
          }
        : {}),
    });
    this.currentRun = completed.run;
    if (!this.completedOperationIdSet.has(operationId)) {
      this.completedOperationIdSet.add(operationId);
      this.completedOperationIds.push(operationId);
    }
  }

  private async appendEvent(
    event: MoAgentEvent,
    projection: RuntimeJsonObject
  ): Promise<void> {
    const occurredAt = new Date(event.timestamp);
    const cumulativeUsage = event.type === 'usage'
      ? normalizeUsage(event.totalUsage)
      : event.type === 'run_finished'
        ? normalizeUsage(event.result.usage)
        : undefined;
    const appended = await this.repository.appendEvent({
      ...this.fence(this.clock()),
      eventId: event.eventId,
      sequence: event.sequence,
      eventType: event.type,
      payload: projection,
      ...(cumulativeUsage ? { cumulativeUsage } : {}),
      occurredAt,
    });
    this.currentRun = appended.run;
  }

  private async saveCheckpoint(
    stage: 'run_started' | 'tools_completed',
    turn: number,
    sourceSequence: number
  ): Promise<void> {
    // appendEvent and tool ledger writes are idempotent. A redelivered event
    // must not fail on the checkpoint's (runId, sequence) uniqueness boundary.
    if (
      this.currentRun.latestCheckpointSequence !== null &&
      this.currentRun.latestCheckpointSequence >= sourceSequence
    ) {
      return;
    }
    const publicState = checkpointState({
      stage,
      turn,
      sourceSequence,
      completedOperationIds: this.completedOperationIds,
    });
    const stateHash = `sha256:${sha256(JSON.stringify(publicState))}`;
    const saved = await this.repository.saveCheckpoint({
      ...this.fence(this.clock()),
      sequence: sourceSequence,
      turn,
      boundary: stage,
      publicState,
      stateHash,
      stateVersion: CHECKPOINT_STATE_VERSION,
    });
    this.currentRun = saved.run;
  }

  private async completeRun(
    event: Extract<MoAgentEvent, { type: 'run_finished' }>,
    projection: RuntimeJsonObject
  ): Promise<void> {
    const status = durableStatus(event.result.status);
    const error = completionError(event.result.status, projection);
    const finishedAt = new Date(event.result.finishedAt);
    this.currentRun = await this.repository.completeRun({
      ...this.fence(this.clock()),
      status,
      turnCount: event.result.turns,
      usage: normalizeUsage(event.result.usage),
      finishedAt,
      ...(error ? { error } : {}),
    });
    await this.notifyTerminalRun();
    this.terminal = true;
  }

  private async notifyTerminalRun(): Promise<void> {
    if (!this.onTerminalRun) return;
    try {
      await this.onTerminalRun(cloneRun(this.currentRun));
    } catch (error) {
      // Terminal notifications happen after the durable state commit and must
      // never turn an already-terminal run into a failed run.
      console.error('[MoAgent] Terminal run notification failed:', error);
    }
  }

  private observeCounters(event: MoAgentEvent): void {
    if ('turn' in event) this.lastTurn = Math.max(this.lastTurn, event.turn);
    if (event.type === 'usage') this.lastUsage = normalizeUsage(event.totalUsage);
    if (event.type === 'run_finished') {
      this.lastTurn = event.result.turns;
      this.lastUsage = normalizeUsage(event.result.usage);
    }
  }
}

export async function createMoAgentDurableRunSession(
  options: CreateMoAgentDurableRunSessionOptions
): Promise<MoAgentDurableRunSession> {
  return MoAgentDurableRunSession.create(options);
}

export async function createPrismaMoAgentDurableRunSession(
  options: CreatePrismaMoAgentDurableRunSessionOptions
): Promise<MoAgentDurableRunSession> {
  const clock = options.clock ?? (() => new Date());
  return createMoAgentDurableRunSession({
    ...options,
    clock,
    repository: new PrismaAgentRuntimeRepository(prisma, clock),
    onTerminalRun: async (run) => runIndependentTerminalCallbacks([
      async () => {
        if (run.totalTokens <= 0) return;
        const binding = await prisma.agentRun.findUnique({
          where: { id: run.id },
          select: { actorUserId: true },
        });
        if (!binding?.actorUserId) return;
        await recordQuotaUsage({
          actorUserId: binding.actorUserId,
          projectId: run.projectId,
          metric: 'llm.total_tokens.monthly',
          quantity: run.totalTokens,
          idempotencyKey: `agent-run:${run.id}:total-tokens`,
          sourceType: 'agent_run',
          sourceId: run.id,
          occurredAt: run.finishedAt ?? clock(),
          metadata: {
            provider: run.provider,
            model: run.model,
            inputTokens: run.inputTokens,
            outputTokens: run.outputTokens,
          },
        });
      },
      ...(options.onTerminalRun
        ? [async () => options.onTerminalRun!(run)]
        : []),
    ]),
  });
}
