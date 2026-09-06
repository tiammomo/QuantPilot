/**
 * Provider-neutral contracts for the PI Agent runtime.
 *
 * Provider-specific wire formats belong in provider adapters. The run engine,
 * tools, and product code should only exchange the types in this module.
 */

import type { PiAgentContextSnapshot } from './context/usage-snapshot';

export type Awaitable<T> = T | Promise<T>;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface PiAgentToolCall {
  id: string;
  name: string;
  /** The model-produced JSON string. Parsing is deliberately owned by the engine. */
  arguments: string;
}

export interface PiAgentSystemMessage {
  role: 'system';
  content: string;
}

export interface PiAgentUserMessage {
  role: 'user';
  content: string;
}

export interface PiAgentAssistantMessage {
  role: 'assistant';
  content: string | null;
  /**
   * Kept in history because DeepSeek thinking-mode tool turns require it to be
   * replayed. Product surfaces should treat this field as private runtime data.
   */
  reasoningContent?: string;
  toolCalls?: PiAgentToolCall[];
}

export interface PiAgentToolMessage {
  role: 'tool';
  toolCallId: string;
  content: string;
  name?: string;
}

export type PiAgentMessage =
  | PiAgentSystemMessage
  | PiAgentUserMessage
  | PiAgentAssistantMessage
  | PiAgentToolMessage;

export interface PiAgentToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface PiAgentTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  cacheMissInputTokens?: number;
  reasoningTokens?: number;
  /** Present when usage is estimated, combines sources, or is incomplete. */
  usageSource?: 'estimated' | 'cache_estimated' | 'mixed' | 'partial';
}

export type PiAgentFinishReason =
  | 'stop'
  | 'tool_calls'
  | 'length'
  | 'content_filter'
  | 'resource_exhausted'
  | 'other';

export type PiAgentToolChoice = 'auto' | 'none' | 'required' | { name: string };

export interface PiAgentReasoningOptions {
  enabled: boolean;
  effort?: 'low' | 'medium' | 'high' | 'max';
}

export interface PiAgentModelRequest {
  model: string;
  messages: readonly PiAgentMessage[];
  tools?: readonly PiAgentToolDefinition[];
  toolChoice?: PiAgentToolChoice;
  maxTokens?: number;
  temperature?: number;
  reasoning?: PiAgentReasoningOptions;
  signal?: AbortSignal;
  metadata?: Readonly<Record<string, unknown>>;
}

export type PiAgentModelEvent =
  | {
      /** A retryable transport failure occurred before any response stream started. */
      type: 'provider_retry';
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      code: string;
      status?: number;
    }
  | {
      type: 'response_start';
      responseId: string;
      model: string;
    }
  | {
      type: 'text_delta';
      delta: string;
    }
  | {
      type: 'reasoning_delta';
      delta: string;
    }
  | {
      type: 'tool_call_delta';
      index: number;
      id?: string;
      nameDelta?: string;
      argumentsDelta?: string;
    }
  | {
      type: 'usage';
      usage: PiAgentTokenUsage;
    }
  | {
      type: 'finish';
      reason: PiAgentFinishReason;
      rawReason?: string;
    };

export interface PiAgentModelProvider {
  readonly name: string;
  complete(request: PiAgentModelRequest): AsyncIterable<PiAgentModelEvent>;
}

export interface PiAgentToolContext {
  runId: string;
  turn: number;
  toolCallId: string;
  /** Framework-derived identity; model-selected IDs are never used as ledger keys. */
  operationId: string;
  signal: AbortSignal;
  /**
   * Required by trusted workspace-write tools. The callback runs only after the
   * durable repository consumes a valid prepared operation as a one-shot commit
   * authorization; the tool keeps the workspace resource lock for the whole call.
   */
  commitWorkspaceMutation?<T>(commit: () => Promise<T>): Promise<T>;
}

export type PiAgentToolEffect = 'pure' | 'read' | 'workspace_write' | 'external_write';

export type PiAgentToolIdempotency =
  | 'intrinsic'
  | 'operation_key'
  | 'reconcile_required';

/**
 * A read observation can be reused only while the workspace generation is
 * unchanged. Network/live-data readers deliberately leave this unset.
 */
export type PiAgentObservationCachePolicy = 'workspace_generation';

export const PI_AGENT_TOOL_APPROVAL_DECISIONS = [
  'approve',
  'edit',
  'reject',
] as const;

export type PiAgentToolApprovalDecision =
  (typeof PI_AGENT_TOOL_APPROVAL_DECISIONS)[number];

/**
 * Explicit, application-owned human-approval policy for a mutating tool.
 *
 * `projectPublicInput` is a security boundary: it must return only bounded,
 * non-secret JSON suitable for durable events and an approval UI. Extension
 * tools cannot provide this projector through createPiAgentTools.
 */
export interface PiAgentToolApprovalPolicy<TInput = unknown> {
  reason: string;
  allowedDecisions?: readonly PiAgentToolApprovalDecision[];
  timeoutMs?: number;
  projectPublicInput(input: TInput): { [key: string]: JsonValue };
}

export interface PiAgentToolApprovalRequest {
  approvalId: string;
  runId: string;
  turn: number;
  toolCallId: string;
  toolName: string;
  effect: Extract<PiAgentToolEffect, 'workspace_write' | 'external_write'>;
  idempotency: PiAgentToolIdempotency;
  inputSha256: string;
  publicInput: { [key: string]: JsonValue };
  reason: string;
  allowedDecisions: readonly PiAgentToolApprovalDecision[];
  requestedAt: number;
  expiresAt: number;
}

export interface PiAgentToolApprovalResolution {
  decision: PiAgentToolApprovalDecision;
  /** Required only for `edit`; it is revalidated by the original tool parser. */
  editedInput?: { [key: string]: JsonValue };
  /** Public, bounded actor identifier or the framework value `expired`. */
  resolvedBy?: string;
}

export type PiAgentToolApprovalHandler = (
  request: PiAgentToolApprovalRequest,
  context: { signal: AbortSignal }
) => Awaitable<PiAgentToolApprovalResolution>;

export interface PiAgentToolFailure {
  code: string;
  message: string;
  details?: unknown;
}

/**
 * Bounded, canonical metadata a first-party tool may retain when its raw tool
 * exchange is compacted. This is deliberately much narrower than a tool
 * result: contents, summaries, queries, and arbitrary result fields are never
 * eligible for trusted context.
 */
export interface PiAgentToolContextReceipt {
  targetReferences: readonly string[];
  artifactSha256?: string;
  bytes?: number;
}

export type PiAgentToolResult<T = unknown> =
  | {
      ok: true;
      data: T;
      /** Optional concise representation; the structured envelope is still preserved. */
      content?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      ok: false;
      error: PiAgentToolFailure;
      content?: string;
      metadata?: Record<string, unknown>;
    };

export interface PiAgentTool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Defaults conservatively to external_write when omitted. */
  effect?: PiAgentToolEffect;
  /** Defaults to reconcile_required for mutating/unknown tools. */
  idempotency?: PiAgentToolIdempotency;
  /** Optional deterministic same-run read de-duplication policy. */
  observationCache?: PiAgentObservationCachePolicy;
  /**
   * Optional HITL gate for this mutating tool. The engine rejects approval
   * policies on pure/read tools and requires an approval handler at startup.
   */
  approval?: PiAgentToolApprovalPolicy<TInput>;
  /**
   * Framework-owned, per-tool projector for bounded context receipts.
   * Additional tools have this capability stripped by createPiAgentTools.
   */
  projectContextReceipt?(
    input: TInput,
    result: PiAgentToolResult<TOutput>
  ): PiAgentToolContextReceipt | null;
  /** A successful call ends the run without another model request. */
  terminal?: boolean;
  /** Optional runtime validation/coercion after the engine parses JSON. */
  parseInput?: (value: unknown) => TInput;
  execute(
    input: TInput,
    context: PiAgentToolContext
  ): Awaitable<PiAgentToolResult<TOutput>>;
}

export interface PiAgentRunLimits {
  maxTurns: number;
  /** Cumulative output-token budget across all model turns. */
  maxTokens: number;
  timeoutMs: number;
}

export interface PiAgentRunRequest {
  messages: readonly PiAgentMessage[];
  runId?: string;
  signal?: AbortSignal;
  maxTurns?: number;
  maxTokens?: number;
  timeoutMs?: number;
  reasoning?: PiAgentReasoningOptions;
  temperature?: number;
  metadata?: Readonly<Record<string, unknown>>;
  commitWorkspaceMutation?<T>(
    operationId: string,
    commit: () => Promise<T>
  ): Promise<T>;
}

export type PiAgentRunStatus =
  | 'completed'
  | 'stopped'
  | 'max_turns'
  | 'max_tokens'
  | 'timeout'
  | 'cancelled'
  | 'failed';

export interface PiAgentRunError {
  code: string;
  message: string;
  cause?: unknown;
}

export interface PiAgentRunResult {
  runId: string;
  status: PiAgentRunStatus;
  messages: PiAgentMessage[];
  output: string;
  turns: number;
  usage: PiAgentTokenUsage;
  contextSnapshot?: PiAgentContextSnapshot;
  startedAt: number;
  finishedAt: number;
  terminalToolCall?: PiAgentToolCall;
  terminalResult?: PiAgentToolResult;
  error?: PiAgentRunError;
}

/**
 * Safe lifecycle projection for event consumers. The complete in-memory result
 * deliberately remains separate because it can contain system prompts, raw
 * tool data, provider causes, and reasoning needed only by the active loop.
 */
export interface PiAgentRunEventResult {
  status: PiAgentRunStatus;
  turns: number;
  usage: PiAgentTokenUsage;
  contextSnapshot?: PiAgentContextSnapshot;
  startedAt: number;
  finishedAt: number;
  error?: Pick<PiAgentRunError, 'code' | 'message'>;
}

/**
 * Serializable, provider-neutral ProgressOracle state exposed only at a safe
 * end-of-turn boundary. Fingerprints are framework-generated content hashes;
 * prompts, tool output and reasoning never belong in this state.
 */
export interface PiAgentProgressOracleEventState {
  version: number;
  turnsObserved: number;
  consecutiveNoProgressTurns: number;
  seenTrustedFactFingerprints: readonly string[];
  seenWorkspaceFingerprints: readonly string[];
  lastWorkspaceFingerprint: string | null;
  lastFailedCheckCount: number | null;
  seenToolObservationFingerprints: readonly string[];
}

export interface PiAgentProgressOracleEventDecision {
  progressed: boolean;
  stalled: boolean;
  consecutiveNoProgressTurns: number;
  progressSignals: readonly string[];
  stallSignals: readonly string[];
}

/** Deterministic control-plane reasons for asking a long-running agent to converge. */
export type PiAgentConvergenceReason =
  | 'repeated_read_observation'
  | 'progress_stalled'
  | 'exploration_read_loop'
  | 'post_write_read_loop'
  | 'tool_limit'
  | 'turn_limit';

export type PiAgentPromptPrefixChange =
  | 'first_request'
  | 'append_only'
  | 'request_local_suffix_rotated'
  | 'context_compaction'
  | 'system_prefix_changed'
  | 'history_prefix_changed';

/** Public assistant projection. Hidden reasoning never crosses the event boundary. */
export interface PiAgentAssistantEventMessage {
  role: 'assistant';
  content: string | null;
  toolCalls?: PiAgentToolCall[];
}

interface PiAgentEventBase {
  runId: string;
  /** Monotonic within one run; use this instead of wall-clock time for ordering. */
  sequence: number;
  /** Unique within a run instance; durable replay additionally requires a run ledger. */
  eventId: string;
  timestamp: number;
}

interface PiAgentTurnEventBase extends PiAgentEventBase {
  turn: number;
}

export type PiAgentEvent =
  | (PiAgentEventBase & {
      type: 'run_started';
      model: string;
      provider: string;
      limits: PiAgentRunLimits;
    })
  | (PiAgentTurnEventBase & {
      type: 'turn_started';
    })
  | (PiAgentTurnEventBase & {
      type: 'provider_retry';
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      code: string;
      status?: number;
    })
  | (PiAgentTurnEventBase & {
      type: 'model_started';
      responseId: string;
      model: string;
    })
  | (PiAgentTurnEventBase & {
      type: 'text_delta';
      delta: string;
    })
  | (PiAgentTurnEventBase & {
      type: 'tool_call_delta';
      index: number;
      id?: string;
      nameDelta?: string;
      argumentsDelta?: string;
    })
  | (PiAgentTurnEventBase & {
      type: 'usage';
      usage: PiAgentTokenUsage;
      totalUsage: PiAgentTokenUsage;
      contextSnapshot?: PiAgentContextSnapshot;
    })
  | (PiAgentTurnEventBase & {
      type: 'assistant_message';
      message: PiAgentAssistantEventMessage;
      finishReason: PiAgentFinishReason;
    })
  | (PiAgentTurnEventBase & {
      type: 'context_compacted';
      originalInputTokens: number;
      preparedInputTokens: number;
      inputBudgetTokens: number;
      removedReasoningMessages: number;
      summarizedToolResults: number;
      droppedGroups: number;
      /** Safe framework telemetry only; capsule target references and contents are excluded. */
      contextCapsule?: {
        applied: boolean;
        version: number;
        phase: 'writing' | 'submission';
        sha256: string;
        serializedUtf8Bytes: number;
        coveredToolCalls: number;
        targetReferences: number;
        operationTombstones: number;
        rolledUpOperationTombstones: number;
        frameworkOutcomeTombstones: number;
        artifactReceipts: number;
        readReceipts: number;
        successfulWrites: number;
        remainingFailures: number;
        invalidatedReadReceipts: number;
        replacedToolCallClusters: number;
        replacedMessages: number;
        replacedPreviousCapsule: boolean;
      };
    })
  | (PiAgentTurnEventBase & {
      type: 'prompt_prepared';
      contextSnapshot?: PiAgentContextSnapshot;
      /** Hashes are over canonical internal JSON; no prompt content is exposed. */
      systemSha256: string;
      messagesSha256: string;
      toolsSha256: string;
      messageCount: number;
      toolCount: number;
      requestUtf8Bytes: number;
      longestCommonPrefixMessages: number;
      longestCommonPrefixUtf8Bytes: number;
      change: PiAgentPromptPrefixChange;
      toolSetChanged: boolean;
      compactionApplied: boolean;
      requestLocalControlSuffix: boolean;
    })
  | (PiAgentTurnEventBase & {
      type: 'convergence_prompt';
      /** All active reasons, in deterministic priority order. */
      reasons: PiAgentConvergenceReason[];
      /** Provider turns left, including the turn receiving the prompt. */
      remainingTurns: number;
      /** Registered tool calls left before the hard run-level protocol limit. */
      remainingToolCalls: number;
      successfulWorkspaceWrites: number;
      consecutiveReadOnlyTurns: number;
    })
  | (PiAgentTurnEventBase & {
      /** Safe turn boundary emitted only after every tool outcome is durable. */
      type: 'progress_evaluated';
      progressOracle: PiAgentProgressOracleEventState;
      decision: PiAgentProgressOracleEventDecision;
    })
  | (PiAgentTurnEventBase & {
      type: 'tool_approval_requested';
      request: PiAgentToolApprovalRequest;
    })
  | (PiAgentTurnEventBase & {
      type: 'tool_approval_resolved';
      approvalId: string;
      toolCallId: string;
      toolName: string;
      decision: PiAgentToolApprovalDecision;
      inputSha256: string;
      /** Hash after an approved edit; never the edited payload itself. */
      effectiveInputSha256: string;
      resolvedBy?: string;
    })
  | (PiAgentTurnEventBase & {
      type: 'tool_started';
      toolCall: PiAgentToolCall;
      operationId: string;
      effect: PiAgentToolEffect;
      idempotency: PiAgentToolIdempotency;
    })
  | (PiAgentTurnEventBase & {
      type: 'tool_completed';
      toolCall: PiAgentToolCall;
      operationId: string;
      effect: PiAgentToolEffect;
      idempotency: PiAgentToolIdempotency;
      result: Extract<PiAgentToolResult, { ok: true }>;
      terminal: boolean;
      durationMs: number;
    })
  | (PiAgentTurnEventBase & {
      type: 'tool_failed';
      toolCall: PiAgentToolCall;
      operationId: string;
      effect: PiAgentToolEffect;
      idempotency: PiAgentToolIdempotency;
      result: Extract<PiAgentToolResult, { ok: false }>;
      durationMs: number;
    })
  | (PiAgentEventBase & {
      type: 'run_finished';
      result: PiAgentRunEventResult;
    });

export type PiAgentEventHandler = (event: PiAgentEvent) => Awaitable<void>;

export interface PiAgentRunEventHandlers {
  /** Ordered, critical sink. Failure stops the run before the next action. */
  durableSink?: PiAgentEventHandler;
  /** Best-effort projections such as UI streaming and chat messages. */
  observers?: readonly PiAgentEventHandler[];
  onObserverError?: (error: unknown, event: PiAgentEvent) => Awaitable<void>;
}
