/**
 * Provider-neutral contracts for the MoAgent runtime.
 *
 * Provider-specific wire formats belong in provider adapters. The run engine,
 * tools, and product code should only exchange the types in this module.
 */

export type Awaitable<T> = T | Promise<T>;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface MoAgentToolCall {
  id: string;
  name: string;
  /** The model-produced JSON string. Parsing is deliberately owned by the engine. */
  arguments: string;
}

export interface MoAgentSystemMessage {
  role: 'system';
  content: string;
}

export interface MoAgentUserMessage {
  role: 'user';
  content: string;
}

export interface MoAgentAssistantMessage {
  role: 'assistant';
  content: string | null;
  /**
   * Kept in history because DeepSeek thinking-mode tool turns require it to be
   * replayed. Product surfaces should treat this field as private runtime data.
   */
  reasoningContent?: string;
  toolCalls?: MoAgentToolCall[];
}

export interface MoAgentToolMessage {
  role: 'tool';
  toolCallId: string;
  content: string;
  name?: string;
}

export type MoAgentMessage =
  | MoAgentSystemMessage
  | MoAgentUserMessage
  | MoAgentAssistantMessage
  | MoAgentToolMessage;

export interface MoAgentToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MoAgentTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens?: number;
  cacheMissInputTokens?: number;
  reasoningTokens?: number;
  /** Present when at least part of the usage had to be estimated locally. */
  usageSource?: 'estimated' | 'cache_estimated' | 'mixed';
}

export type MoAgentFinishReason =
  | 'stop'
  | 'tool_calls'
  | 'length'
  | 'content_filter'
  | 'resource_exhausted'
  | 'other';

export type MoAgentToolChoice = 'auto' | 'none' | 'required' | { name: string };

export interface MoAgentReasoningOptions {
  enabled: boolean;
  effort?: 'low' | 'medium' | 'high' | 'max';
}

export interface MoAgentModelRequest {
  model: string;
  messages: readonly MoAgentMessage[];
  tools?: readonly MoAgentToolDefinition[];
  toolChoice?: MoAgentToolChoice;
  maxTokens?: number;
  temperature?: number;
  reasoning?: MoAgentReasoningOptions;
  signal?: AbortSignal;
  metadata?: Readonly<Record<string, unknown>>;
}

export type MoAgentModelEvent =
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
      usage: MoAgentTokenUsage;
    }
  | {
      type: 'finish';
      reason: MoAgentFinishReason;
      rawReason?: string;
    };

export interface MoAgentModelProvider {
  readonly name: string;
  complete(request: MoAgentModelRequest): AsyncIterable<MoAgentModelEvent>;
}

export interface MoAgentToolContext {
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

export type MoAgentToolEffect = 'pure' | 'read' | 'workspace_write' | 'external_write';

export type MoAgentToolIdempotency =
  | 'intrinsic'
  | 'operation_key'
  | 'reconcile_required';

/**
 * A read observation can be reused only while the workspace generation is
 * unchanged. Network/live-data readers deliberately leave this unset.
 */
export type MoAgentObservationCachePolicy = 'workspace_generation';

export interface MoAgentToolFailure {
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
export interface MoAgentToolContextReceipt {
  targetReferences: readonly string[];
  artifactSha256?: string;
  bytes?: number;
}

export type MoAgentToolResult<T = unknown> =
  | {
      ok: true;
      data: T;
      /** Optional concise representation; the structured envelope is still preserved. */
      content?: string;
      metadata?: Record<string, unknown>;
    }
  | {
      ok: false;
      error: MoAgentToolFailure;
      content?: string;
      metadata?: Record<string, unknown>;
    };

export interface MoAgentTool<TInput = unknown, TOutput = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Defaults conservatively to external_write when omitted. */
  effect?: MoAgentToolEffect;
  /** Defaults to reconcile_required for mutating/unknown tools. */
  idempotency?: MoAgentToolIdempotency;
  /** Optional deterministic same-run read de-duplication policy. */
  observationCache?: MoAgentObservationCachePolicy;
  /**
   * Framework-owned, per-tool projector for bounded context receipts.
   * Additional tools have this capability stripped by createMoAgentTools.
   */
  projectContextReceipt?(
    input: TInput,
    result: MoAgentToolResult<TOutput>
  ): MoAgentToolContextReceipt | null;
  /** A successful call ends the run without another model request. */
  terminal?: boolean;
  /** Optional runtime validation/coercion after the engine parses JSON. */
  parseInput?: (value: unknown) => TInput;
  execute(
    input: TInput,
    context: MoAgentToolContext
  ): Awaitable<MoAgentToolResult<TOutput>>;
}

export interface MoAgentRunLimits {
  maxTurns: number;
  /** Cumulative output-token budget across all model turns. */
  maxTokens: number;
  timeoutMs: number;
}

export interface MoAgentRunRequest {
  messages: readonly MoAgentMessage[];
  runId?: string;
  signal?: AbortSignal;
  maxTurns?: number;
  maxTokens?: number;
  timeoutMs?: number;
  reasoning?: MoAgentReasoningOptions;
  temperature?: number;
  metadata?: Readonly<Record<string, unknown>>;
  commitWorkspaceMutation?<T>(
    operationId: string,
    commit: () => Promise<T>
  ): Promise<T>;
}

export type MoAgentRunStatus =
  | 'completed'
  | 'stopped'
  | 'max_turns'
  | 'max_tokens'
  | 'timeout'
  | 'cancelled'
  | 'failed';

export interface MoAgentRunError {
  code: string;
  message: string;
  cause?: unknown;
}

export interface MoAgentRunResult {
  runId: string;
  status: MoAgentRunStatus;
  messages: MoAgentMessage[];
  output: string;
  turns: number;
  usage: MoAgentTokenUsage;
  startedAt: number;
  finishedAt: number;
  terminalToolCall?: MoAgentToolCall;
  terminalResult?: MoAgentToolResult;
  error?: MoAgentRunError;
}

/**
 * Safe lifecycle projection for event consumers. The complete in-memory result
 * deliberately remains separate because it can contain system prompts, raw
 * tool data, provider causes, and reasoning needed only by the active loop.
 */
export interface MoAgentRunEventResult {
  status: MoAgentRunStatus;
  turns: number;
  usage: MoAgentTokenUsage;
  startedAt: number;
  finishedAt: number;
  error?: Pick<MoAgentRunError, 'code' | 'message'>;
}

/**
 * Serializable, provider-neutral ProgressOracle state exposed only at a safe
 * end-of-turn boundary. Fingerprints are framework-generated content hashes;
 * prompts, tool output and reasoning never belong in this state.
 */
export interface MoAgentProgressOracleEventState {
  version: number;
  turnsObserved: number;
  consecutiveNoProgressTurns: number;
  seenTrustedFactFingerprints: readonly string[];
  seenWorkspaceFingerprints: readonly string[];
  lastWorkspaceFingerprint: string | null;
  lastFailedCheckCount: number | null;
  seenToolObservationFingerprints: readonly string[];
}

export interface MoAgentProgressOracleEventDecision {
  progressed: boolean;
  stalled: boolean;
  consecutiveNoProgressTurns: number;
  progressSignals: readonly string[];
  stallSignals: readonly string[];
}

/** Deterministic control-plane reasons for asking a long-running agent to converge. */
export type MoAgentConvergenceReason =
  | 'repeated_read_observation'
  | 'progress_stalled'
  | 'exploration_read_loop'
  | 'post_write_read_loop'
  | 'tool_limit'
  | 'turn_limit';

export type MoAgentPromptPrefixChange =
  | 'first_request'
  | 'append_only'
  | 'request_local_suffix_rotated'
  | 'context_compaction'
  | 'system_prefix_changed'
  | 'history_prefix_changed';

/** Public assistant projection. Hidden reasoning never crosses the event boundary. */
export interface MoAgentAssistantEventMessage {
  role: 'assistant';
  content: string | null;
  toolCalls?: MoAgentToolCall[];
}

interface MoAgentEventBase {
  runId: string;
  /** Monotonic within one run; use this instead of wall-clock time for ordering. */
  sequence: number;
  /** Unique within a run instance; durable replay additionally requires a run ledger. */
  eventId: string;
  timestamp: number;
}

interface MoAgentTurnEventBase extends MoAgentEventBase {
  turn: number;
}

export type MoAgentEvent =
  | (MoAgentEventBase & {
      type: 'run_started';
      model: string;
      provider: string;
      limits: MoAgentRunLimits;
    })
  | (MoAgentTurnEventBase & {
      type: 'turn_started';
    })
  | (MoAgentTurnEventBase & {
      type: 'provider_retry';
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      code: string;
      status?: number;
    })
  | (MoAgentTurnEventBase & {
      type: 'model_started';
      responseId: string;
      model: string;
    })
  | (MoAgentTurnEventBase & {
      type: 'text_delta';
      delta: string;
    })
  | (MoAgentTurnEventBase & {
      type: 'tool_call_delta';
      index: number;
      id?: string;
      nameDelta?: string;
      argumentsDelta?: string;
    })
  | (MoAgentTurnEventBase & {
      type: 'usage';
      usage: MoAgentTokenUsage;
      totalUsage: MoAgentTokenUsage;
    })
  | (MoAgentTurnEventBase & {
      type: 'assistant_message';
      message: MoAgentAssistantEventMessage;
      finishReason: MoAgentFinishReason;
    })
  | (MoAgentTurnEventBase & {
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
  | (MoAgentTurnEventBase & {
      type: 'prompt_prepared';
      /** Hashes are over canonical internal JSON; no prompt content is exposed. */
      systemSha256: string;
      messagesSha256: string;
      toolsSha256: string;
      messageCount: number;
      toolCount: number;
      requestUtf8Bytes: number;
      longestCommonPrefixMessages: number;
      longestCommonPrefixUtf8Bytes: number;
      change: MoAgentPromptPrefixChange;
      toolSetChanged: boolean;
      compactionApplied: boolean;
      requestLocalControlSuffix: boolean;
    })
  | (MoAgentTurnEventBase & {
      type: 'convergence_prompt';
      /** All active reasons, in deterministic priority order. */
      reasons: MoAgentConvergenceReason[];
      /** Provider turns left, including the turn receiving the prompt. */
      remainingTurns: number;
      /** Registered tool calls left before the hard run-level protocol limit. */
      remainingToolCalls: number;
      successfulWorkspaceWrites: number;
      consecutiveReadOnlyTurns: number;
    })
  | (MoAgentTurnEventBase & {
      /** Safe turn boundary emitted only after every tool outcome is durable. */
      type: 'progress_evaluated';
      progressOracle: MoAgentProgressOracleEventState;
      decision: MoAgentProgressOracleEventDecision;
    })
  | (MoAgentTurnEventBase & {
      type: 'tool_started';
      toolCall: MoAgentToolCall;
      operationId: string;
      effect: MoAgentToolEffect;
      idempotency: MoAgentToolIdempotency;
    })
  | (MoAgentTurnEventBase & {
      type: 'tool_completed';
      toolCall: MoAgentToolCall;
      operationId: string;
      effect: MoAgentToolEffect;
      idempotency: MoAgentToolIdempotency;
      result: Extract<MoAgentToolResult, { ok: true }>;
      terminal: boolean;
      durationMs: number;
    })
  | (MoAgentTurnEventBase & {
      type: 'tool_failed';
      toolCall: MoAgentToolCall;
      operationId: string;
      effect: MoAgentToolEffect;
      idempotency: MoAgentToolIdempotency;
      result: Extract<MoAgentToolResult, { ok: false }>;
      durationMs: number;
    })
  | (MoAgentEventBase & {
      type: 'run_finished';
      result: MoAgentRunEventResult;
    });

export type MoAgentEventHandler = (event: MoAgentEvent) => Awaitable<void>;

export interface MoAgentRunEventHandlers {
  /** Ordered, critical sink. Failure stops the run before the next action. */
  durableSink?: MoAgentEventHandler;
  /** Best-effort projections such as UI streaming and chat messages. */
  observers?: readonly MoAgentEventHandler[];
  onObserverError?: (error: unknown, event: MoAgentEvent) => Awaitable<void>;
}
