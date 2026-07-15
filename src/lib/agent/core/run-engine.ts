import { createHash } from 'node:crypto';

import type {
  MoAgentAssistantMessage,
  MoAgentConvergenceReason,
  MoAgentEvent,
  MoAgentEventHandler,
  MoAgentFinishReason,
  MoAgentMessage,
  MoAgentModelEvent,
  MoAgentModelProvider,
  MoAgentPromptPrefixChange,
  MoAgentRunError,
  MoAgentRunEventHandlers,
  MoAgentRunLimits,
  MoAgentRunRequest,
  MoAgentRunResult,
  MoAgentRunStatus,
  MoAgentTokenUsage,
  MoAgentTool,
  MoAgentToolCall,
  MoAgentToolEffect,
  MoAgentToolIdempotency,
  MoAgentToolResult,
} from '../types';
import { MoAgentContextError, type MoAgentContextManager } from '../context';
import { createMoAgentOperationId } from './operation-id';
import { parseMoAgentToolArguments } from './tool-arguments';
import { mutationOutcomeRequiresReconciliation } from './tool-outcome';

const DEFAULT_MAX_TURNS = 48;
const DEFAULT_MAX_TOKENS = 12_000;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1_000;
const DEFAULT_CRITICAL_DRAIN_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_TOOL_CALLS_PER_TURN = 16;
const DEFAULT_MAX_TOTAL_TOOL_CALLS = 64;
const DEFAULT_MAX_TEXT_CHARS_PER_TURN = 128_000;
const DEFAULT_MAX_REASONING_CHARS_PER_TURN = 256_000;
const DEFAULT_MAX_TOOL_ARGUMENT_CHARS = 64_000;
const PRE_WRITE_READ_ONLY_TURN_THRESHOLD = 6;
const POST_WRITE_READ_ONLY_TURN_THRESHOLD = 3;
const TURN_LIMIT_CONVERGENCE_WINDOW = 4;
const TOOL_LIMIT_CONVERGENCE_WINDOW = 8;
const MAX_CONVERGENCE_TOOL_POLICY_VIOLATION_TURNS = 2;
const WORKSPACE_WRITE_REQUIRED_MESSAGE =
  'This run must complete at least one successful workspace_write before using a terminal tool. Use an available workspace-write tool to make the smallest necessary change.';
const CONVERGENCE_DIRECTIVE_PREFIX =
  '[MoAgent Runtime Convergence Directive - HIGH PRIORITY]';
const CONVERGENCE_REASON_ORDER: readonly MoAgentConvergenceReason[] = [
  'repeated_read_observation',
  'exploration_read_loop',
  'post_write_read_loop',
  'tool_limit',
  'turn_limit',
];
const MAX_TOOL_NAME_CHARS = 256;
const MAX_RUN_ID_CHARS = 256;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

const EMPTY_USAGE: MoAgentTokenUsage = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
};

export interface MoAgentRunEngineOptions {
  provider: MoAgentModelProvider;
  model: string;
  tools?: readonly MoAgentTool[];
  maxTurns?: number;
  maxTokens?: number;
  /** Provider output cap for one turn; maxTokens remains the cumulative run cap. */
  maxTokensPerTurn?: number;
  /**
   * Optional cumulative provider-reported input-token budget. Because input
   * usage is known only after a provider response, crossing the budget prevents
   * the next model request rather than discarding the completed current turn.
   */
  maxRunInputTokens?: number;
  /**
   * Optional cumulative provider-reported cache-miss input-token budget.
   * Providers that do not report cache-miss usage do not consume this budget.
   */
  maxRunCacheMissInputTokens?: number;
  /**
   * Read-only turns allowed before the first successful workspace write.
   * When explicitly configured, reaching the threshold also hides read tools
   * until a workspace write succeeds or the run terminates.
   */
  preWriteReadOnlyTurnThreshold?: number;
  /** The equivalent explicit hard threshold after a successful workspace write. */
  postWriteReadOnlyTurnThreshold?: number;
  /**
   * Require this run to commit at least one successful workspace_write before
   * a terminal tool can complete. Defaults to false for generic compatibility.
   */
  requireWorkspaceWriteBeforeTerminal?: boolean;
  timeoutMs?: number;
  /** Hard protocol limits. They are enforced before any tool side effect. */
  maxToolCallsPerTurn?: number;
  maxTotalToolCalls?: number;
  maxTextCharsPerTurn?: number;
  maxReasoningCharsPerTurn?: number;
  maxToolArgumentChars?: number;
  /** Maximum time spent awaiting one event consumer; defaults to the run timeout. */
  eventHandlerTimeoutMs?: number;
  /**
   * Extra bounded window for persisting tool outcomes and the terminal event
   * after the run deadline or caller cancellation has fired.
   */
  criticalDrainTimeoutMs?: number;
  /** Per best-effort observer; defaults to five seconds. */
  observerTimeoutMs?: number;
  /** Optional deterministic context preparation before every provider request. */
  contextManager?: Pick<MoAgentContextManager, 'prepare'>;
  /** Defaults to true when at least one registered tool is terminal. */
  requireTerminalTool?: boolean;
  idFactory?: () => string;
  now?: () => number;
}

interface RunProtocolLimits {
  maxToolCallsPerTurn: number;
  maxTotalToolCalls: number;
  maxTextCharsPerTurn: number;
  maxReasoningCharsPerTurn: number;
  maxToolArgumentChars: number;
}

interface MutableToolCall {
  index: number;
  id?: string;
  name: string;
  arguments: string;
}

interface RunAbortState {
  signal: AbortSignal;
  didTimeout(): boolean;
  cleanup(): void;
}

interface ToolExecution {
  result: MoAgentToolResult;
  terminal: boolean;
  durationMs: number;
}

interface ToolExecutionPolicy {
  effect: MoAgentToolEffect;
  idempotency: MoAgentToolIdempotency;
}

interface ReadObservationRecord {
  toolCallId: string;
  turn: number;
  resultSha256: string;
}

interface PromptMessageFingerprint {
  sha256: string;
  utf8Bytes: number;
}

interface PromptPrefixSnapshot {
  messageFingerprints: PromptMessageFingerprint[];
  toolsSha256: string;
  systemSha256: string;
  requestLocalControlSuffix: boolean;
}

interface PromptPrefixReport extends PromptPrefixSnapshot {
  messagesSha256: string;
  messageCount: number;
  toolCount: number;
  requestUtf8Bytes: number;
  longestCommonPrefixMessages: number;
  longestCommonPrefixUtf8Bytes: number;
  change: MoAgentPromptPrefixChange;
  toolSetChanged: boolean;
}

type WithoutEventBase<T> = T extends unknown
  ? Omit<T, 'runId' | 'sequence' | 'eventId' | 'timestamp'>
  : never;
type MoAgentEventDetails = WithoutEventBase<MoAgentEvent>;

class MoAgentRunLimitError extends Error {
  constructor(
    readonly code: 'MAX_TOTAL_TOOL_CALLS',
    message: string
  ) {
    super(message);
    this.name = 'MoAgentRunLimitError';
  }
}

function validatePositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function defaultRunId(): string {
  return `run_${globalThis.crypto.randomUUID()}`;
}

function validateRunId(value: string): string {
  const candidate = value.trim();
  if (
    !candidate ||
    candidate.length > MAX_RUN_ID_CHARS ||
    !RUN_ID_PATTERN.test(candidate)
  ) {
    throw new Error(
      `runId must be 1-${MAX_RUN_ID_CHARS} ASCII identifier characters.`
    );
  }
  return candidate;
}

function cloneMessage(message: MoAgentMessage): MoAgentMessage {
  if (message.role !== 'assistant') {
    return { ...message };
  }
  return {
    ...message,
    ...(message.toolCalls
      ? { toolCalls: message.toolCalls.map((toolCall) => ({ ...toolCall })) }
      : {}),
  };
}

function orderedConvergenceReasons(
  reasons: ReadonlySet<MoAgentConvergenceReason>
): MoAgentConvergenceReason[] {
  return CONVERGENCE_REASON_ORDER.filter((reason) => reasons.has(reason));
}

function convergenceDirective(options: {
  reasons: readonly MoAgentConvergenceReason[];
  remainingTurns: number;
  remainingToolCalls: number;
  successfulWorkspaceWrites: number;
  consecutiveReadOnlyTurns: number;
  terminalToolNames: readonly string[];
  readToolsDisabled: boolean;
}): string {
  const reasonSummary = options.reasons.map((reason) => {
    if (reason === 'repeated_read_observation') {
      return 'an identical read was requested again without any intervening workspace change and produced no new evidence';
    }
    if (reason === 'exploration_read_loop') {
      return options.successfulWorkspaceWrites > 0
        ? 'an extended exploration-only loop occurred before the first workspace write'
        : `${options.consecutiveReadOnlyTurns} consecutive read-only turns occurred without a workspace write`;
    }
    if (reason === 'post_write_read_loop') {
      return `${options.consecutiveReadOnlyTurns} consecutive read-only turns followed successful workspace writes`;
    }
    if (reason === 'tool_limit') {
      return `only ${options.remainingToolCalls} registered tool calls remain before the hard run limit`;
    }
    return `only ${options.remainingTurns} provider turns remain, including this turn`;
  }).join('; ');
  const finishInstruction = options.terminalToolNames.length > 0
    ? `Finish through exactly one registered terminal tool (${options.terminalToolNames.join(', ')}).`
    : 'Finish with the final response expected by the task.';
  const repairReserve = options.remainingTurns >= 3
    ? 'Reserve at least one turn for a concrete repair if the targeted check fails and one final turn to finish.'
    : 'There is no budget for broad inspection; repair only a concrete known defect before finishing.';
  const hardToolPolicy = options.readToolsDisabled
    ? 'Hard runtime phase policy: read-only tools are unavailable for this request. Do not call hidden read tools. Use current evidence to make the smallest necessary workspace write, or finish through the terminal tool only when the requested contract is already satisfied.'
    : '';

  return `${CONVERGENCE_DIRECTIVE_PREFIX}
This is runtime control guidance. It does not assert that the workspace is correct and does not mark the run successful.
State: ${reasonSummary}. Successful workspace writes observed: ${options.successfulWorkspaceWrites}.
Stop broad or repeated inspection and do not reread unchanged ranges. Perform at most one targeted check against the requested contract and current tool evidence. If it exposes a concrete defect, make the smallest necessary repair and inspect only the changed or critical portion afterward.
File existence and successful writes alone are not validation. Submit only when current evidence supports completion; never claim success when known requirements remain unmet.
${hardToolPolicy}
${repairReserve}
${finishInstruction}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(String(value));
}

function readObservationFingerprint(
  toolCall: MoAgentToolCall,
  tool: MoAgentTool | undefined
): string | null {
  if (
    !tool ||
    tool.observationCache !== 'workspace_generation' ||
    toolExecutionPolicy(tool).effect !== 'read'
  ) {
    return null;
  }
  try {
    const parsed = parseMoAgentToolArguments(toolCall.arguments).value;
    if (!isRecord(parsed)) return null;
    return createHash('sha256')
      .update(tool.name, 'utf8')
      .update('\0')
      .update(canonicalJson(parsed), 'utf8')
      .digest('hex');
  } catch {
    return null;
  }
}

function observationResultIsVisible(
  messages: readonly MoAgentMessage[],
  record: ReadObservationRecord
): boolean {
  const message = messages.find(
    (candidate) => candidate.role === 'tool' && candidate.toolCallId === record.toolCallId
  );
  if (!message || message.role !== 'tool') return false;
  try {
    const parsed = JSON.parse(message.content) as {
      $moagent?: { kind?: unknown };
    };
    return parsed.$moagent?.kind !== 'tool_result_truncation';
  } catch {
    return true;
  }
}

function reusedReadObservation(record: ReadObservationRecord): ToolExecution {
  return {
    result: {
      ok: true,
      data: {
        $moagent: {
          kind: 'reused_read_observation',
          version: 1,
          originalToolCallId: record.toolCallId,
          originalTurn: record.turn,
          resultSha256: record.resultSha256,
          workspaceChangedSinceOriginal: false,
        },
      },
      content:
        'No new I/O was performed: this identical read result is already present in the conversation and the workspace has not changed.',
    },
    terminal: false,
    durationMs: 0,
  };
}

function promptPrefixReport(options: {
  messages: readonly MoAgentMessage[];
  tools: readonly { name: string; description: string; inputSchema: Record<string, unknown> }[];
  previous: PromptPrefixSnapshot | null;
  compactionApplied: boolean;
  requestLocalControlSuffix: boolean;
}): PromptPrefixReport {
  const messageFingerprints = options.messages.map((message) => {
    const serialized = canonicalJson(message);
    return {
      sha256: createHash('sha256').update(serialized, 'utf8').digest('hex'),
      utf8Bytes: utf8Bytes(serialized),
    };
  });
  const serializedTools = canonicalJson(options.tools);
  const toolsSha256 = createHash('sha256').update(serializedTools, 'utf8').digest('hex');
  const systemSha256 = createHash('sha256')
    .update(canonicalJson(options.messages.filter((message) => message.role === 'system')), 'utf8')
    .digest('hex');
  let longestCommonPrefixMessages = 0;
  if (options.previous) {
    const limit = Math.min(
      options.previous.messageFingerprints.length,
      messageFingerprints.length
    );
    while (
      longestCommonPrefixMessages < limit &&
      options.previous.messageFingerprints[longestCommonPrefixMessages].sha256 ===
        messageFingerprints[longestCommonPrefixMessages].sha256 &&
      options.previous.messageFingerprints[longestCommonPrefixMessages].utf8Bytes ===
        messageFingerprints[longestCommonPrefixMessages].utf8Bytes
    ) {
      longestCommonPrefixMessages += 1;
    }
  }
  const longestCommonPrefixUtf8Bytes = messageFingerprints
    .slice(0, longestCommonPrefixMessages)
    .reduce((total, message) => total + message.utf8Bytes, 0);
  const toolSetChanged = options.previous !== null && options.previous.toolsSha256 !== toolsSha256;
  let change: MoAgentPromptPrefixChange;
  if (!options.previous) {
    change = 'first_request';
  } else if (options.previous.systemSha256 !== systemSha256) {
    change = 'system_prefix_changed';
  } else if (options.compactionApplied) {
    change = 'context_compaction';
  } else {
    const previousAppendBoundary = options.previous.messageFingerprints.length;
    const previousStableBoundary = previousAppendBoundary -
      (options.previous.requestLocalControlSuffix ? 1 : 0);
    if (
      options.previous.requestLocalControlSuffix &&
      longestCommonPrefixMessages >= previousStableBoundary
    ) {
      change = 'request_local_suffix_rotated';
    } else if (longestCommonPrefixMessages === previousAppendBoundary) {
      change = 'append_only';
    } else {
      change = 'history_prefix_changed';
    }
  }

  return {
    messageFingerprints,
    toolsSha256,
    systemSha256,
    requestLocalControlSuffix: options.requestLocalControlSuffix,
    messagesSha256: createHash('sha256')
      .update(canonicalJson(options.messages), 'utf8')
      .digest('hex'),
    messageCount: options.messages.length,
    toolCount: options.tools.length,
    requestUtf8Bytes: utf8Bytes(JSON.stringify({
      messages: options.messages,
      tools: options.tools,
    })),
    longestCommonPrefixMessages,
    longestCommonPrefixUtf8Bytes,
    change,
    toolSetChanged,
  };
}

function appendEphemeralConvergenceDirective(
  messages: readonly MoAgentMessage[],
  content: string
): MoAgentMessage[] {
  const next = messages.map(cloneMessage);
  // This runtime control message is deliberately request-local and appended at
  // the tail as a user control message. DeepSeek treats a system message added
  // mid-conversation as a prompt-prefix change, even when earlier messages are
  // byte-for-byte stable. The hard tool gate enforces the phase policy; this
  // message supplies request-local guidance without polluting canonical history.
  next.push({ role: 'user', content });
  return next;
}

function addOptional(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}

function addUsage(a: MoAgentTokenUsage, b: MoAgentTokenUsage): MoAgentTokenUsage {
  const cachedInputTokens = addOptional(a.cachedInputTokens, b.cachedInputTokens);
  const cacheMissInputTokens = addOptional(a.cacheMissInputTokens, b.cacheMissInputTokens);
  const reasoningTokens = addOptional(a.reasoningTokens, b.reasoningTokens);
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(cacheMissInputTokens === undefined ? {} : { cacheMissInputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * Model tokens commonly cover multiple UTF-8 bytes. Charging one output token
 * per byte plus tool-envelope overhead therefore deliberately overestimates a
 * response when provider usage is unavailable.
 */
function estimateOutputTokens(
  text: string,
  reasoningContent: string,
  toolCalls: readonly MoAgentToolCall[]
): number {
  const contentBytes = utf8Bytes(text) + utf8Bytes(reasoningContent);
  const toolBytes = toolCalls.reduce(
    (total, toolCall) =>
      total +
      utf8Bytes(toolCall.id) +
      utf8Bytes(toolCall.name) +
      utf8Bytes(toolCall.arguments) +
      64,
    0
  );
  return Math.max(1, contentBytes + toolBytes);
}

function subtractUsage(a: MoAgentTokenUsage, b: MoAgentTokenUsage): MoAgentTokenUsage {
  const optionalDifference = (
    left: number | undefined,
    right: number | undefined
  ): number | undefined =>
    left === undefined && right === undefined ? undefined : (left ?? 0) - (right ?? 0);
  const cachedInputTokens = optionalDifference(a.cachedInputTokens, b.cachedInputTokens);
  const cacheMissInputTokens = optionalDifference(
    a.cacheMissInputTokens,
    b.cacheMissInputTokens
  );
  const reasoningTokens = optionalDifference(a.reasoningTokens, b.reasoningTokens);
  return {
    inputTokens: a.inputTokens - b.inputTokens,
    outputTokens: a.outputTokens - b.outputTokens,
    totalTokens: a.totalTokens - b.totalTokens,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(cacheMissInputTokens === undefined ? {} : { cacheMissInputTokens }),
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
  };
}

function createRunAbortState(signal: AbortSignal | undefined, timeoutMs: number): RunAbortState {
  const controller = new AbortController();
  let timedOut = false;

  const abortFromCaller = () => {
    controller.abort(
      signal?.reason ?? new DOMException('The MoAgent run was cancelled.', 'AbortError')
    );
  };

  if (signal?.aborted) {
    abortFromCaller();
  } else {
    signal?.addEventListener('abort', abortFromCaller, { once: true });
  }

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('The MoAgent run timed out.', 'TimeoutError'));
  }, timeoutMs);
  timeout.unref?.();

  return {
    signal: controller.signal,
    didTimeout: () => timedOut,
    cleanup: () => {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abortFromCaller);
    },
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw abortReason(signal);
  }
}

async function raceWithSignal<T>(operation: PromiseLike<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      }
    );
  });
}

async function raceWithDeadline<T>(
  operation: () => T | PromiseLike<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number
): Promise<T> {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
  }
  if (timeoutMs <= 0) {
    throw new DOMException('The MoAgent event handler timed out.', 'TimeoutError');
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = () => settle(() => reject(
      signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError')
    ));
    const timeout = setTimeout(() => settle(() => reject(
      new DOMException('The MoAgent event handler timed out.', 'TimeoutError')
    )), timeoutMs);
    timeout.unref?.();
    signal?.addEventListener('abort', onAbort, { once: true });
    // Close the check/listener race before invoking a handler. In particular,
    // never create a detached durable write after its budget or signal ended.
    if (signal?.aborted) {
      onAbort();
      return;
    }

    let candidate: T | PromiseLike<T>;
    try {
      candidate = operation();
    } catch (error) {
      settle(() => reject(error));
      return;
    }
    Promise.resolve(candidate).then(
      (value) => settle(() => resolve(value)),
      (error) => settle(() => reject(error))
    );
  });
}

async function* abortableEvents(
  source: AsyncIterable<MoAgentModelEvent>,
  signal: AbortSignal
): AsyncGenerator<MoAgentModelEvent> {
  const iterator = source[Symbol.asyncIterator]();
  let completed = false;
  try {
    while (true) {
      const step = await raceWithSignal(iterator.next(), signal);
      if (step.done) {
        completed = true;
        return;
      }
      yield step.value;
    }
  } finally {
    if (!completed && iterator.return) {
      const closing = Promise.resolve(iterator.return()).catch(() => undefined);
      if (!signal.aborted) {
        await closing;
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const TOOL_INPUT_ALIASES: Readonly<Record<string, readonly string[]>> = {
  path: ['file', 'filePath', 'file_path', 'target', 'targetPath', 'target_path', 'endpoint'],
  anchors: ['queries', 'query', 'searches'],
  pointers: ['pointer', 'jsonPointers', 'json_pointers'],
  oldText: ['old_text', 'before', 'search'],
  newText: ['new_text', 'after', 'replacement'],
  startLine: ['start_line', 'lineStart', 'line_start'],
  endLine: ['end_line', 'lineEnd', 'line_end'],
  maxMatchesPerAnchor: ['maxMatchesPerQuery', 'max_matches_per_anchor'],
  artifacts: ['files', 'changedFiles', 'changed_files'],
  summary: ['resultSummary', 'result_summary'],
};

function schemaProperties(tool: MoAgentTool | undefined): Set<string> {
  const properties = isRecord(tool?.inputSchema.properties)
    ? tool.inputSchema.properties
    : {};
  return new Set(Object.keys(properties));
}

function normalizeToolInputAliases(
  value: unknown,
  tool: MoAgentTool | undefined,
): unknown {
  if (!isRecord(value)) return value;
  const output = { ...value };
  const properties = schemaProperties(tool);
  for (const [canonical, aliases] of Object.entries(TOOL_INPUT_ALIASES)) {
    if (!properties.has(canonical) || output[canonical] !== undefined) continue;
    const alias = aliases.find((candidate) => output[candidate] !== undefined);
    if (!alias) continue;
    output[canonical] = output[alias];
    delete output[alias];
  }
  return output;
}

function canonicalRegisteredToolName(
  value: string,
  toolsByName: ReadonlyMap<string, MoAgentTool>,
): string {
  if (toolsByName.has(value)) return value;
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const matches = [...toolsByName.keys()].filter((name) =>
    name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') === normalized
  );
  return matches.length === 1 ? matches[0] : value;
}

function normalizedToolCallArguments(argumentsJson: string, tool: MoAgentTool | undefined): string {
  try {
    const parsed = parseMoAgentToolArguments(argumentsJson);
    return JSON.stringify(normalizeToolInputAliases(parsed.value, tool));
  } catch {
    return argumentsJson;
  }
}

function stringArray(value: unknown): string[] | null {
  if (typeof value === 'string') return [value];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return null;
  return value as string[];
}

/** Collapse duplicate reads and merge same-resource structured reads in one model turn. */
function coalesceReadToolCalls(
  toolCalls: readonly MoAgentToolCall[],
  toolsByName: ReadonlyMap<string, MoAgentTool>,
): MoAgentToolCall[] {
  const output: MoAgentToolCall[] = [];
  const exactReads = new Set<string>();
  const mergeBucketByKey = new Map<string, number>();

  for (const toolCall of toolCalls) {
    const name = canonicalRegisteredToolName(toolCall.name, toolsByName);
    const tool = toolsByName.get(name);
    const normalized = {
      ...toolCall,
      name,
      arguments: normalizedToolCallArguments(toolCall.arguments, tool),
    };
    if (toolExecutionPolicy(tool).effect !== 'read') {
      output.push(normalized);
      continue;
    }

    const exactKey = `${normalized.name}\0${normalized.arguments}`;
    if (exactReads.has(exactKey)) continue;
    exactReads.add(exactKey);

    if (normalized.name !== 'query_json' && normalized.name !== 'query_text_file') {
      output.push(normalized);
      continue;
    }

    let record: Record<string, unknown>;
    let canonicalRecord: Record<string, unknown>;
    try {
      const parsed = parseMoAgentToolArguments(normalized.arguments).value;
      if (!isRecord(parsed)) {
        output.push(normalized);
        continue;
      }
      record = parsed;
      const parsedInput = tool?.parseInput ? tool.parseInput(parsed) : parsed;
      canonicalRecord = isRecord(parsedInput) ? parsedInput : parsed;
      if (typeof canonicalRecord.path !== 'string') {
        output.push(normalized);
        continue;
      }
    } catch {
      output.push(normalized);
      continue;
    }

    const field = normalized.name === 'query_json' ? 'pointers' : 'anchors';
    const aliases = normalized.name === 'query_json'
      ? [canonicalRecord.pointers, canonicalRecord.pointer]
      : [canonicalRecord.anchors, canonicalRecord.queries, canonicalRecord.query];
    const values = aliases.map(stringArray).find((candidate) => candidate !== null) ?? null;
    if (!values?.length) {
      output.push(normalized);
      continue;
    }

    const bucketKey = `${normalized.name}\0${canonicalRecord.path}`;
    const existingIndex = mergeBucketByKey.get(bucketKey);
    if (existingIndex === undefined) {
      const canonical = { ...record, [field]: Array.from(new Set(values)) };
      delete canonical[normalized.name === 'query_json' ? 'pointer' : 'queries'];
      if (normalized.name === 'query_text_file') delete canonical.query;
      mergeBucketByKey.set(bucketKey, output.length);
      output.push({ ...normalized, arguments: JSON.stringify(canonical) });
      continue;
    }

    const existing = output[existingIndex];
    const existingRecord = parseMoAgentToolArguments(existing.arguments).value as Record<string, unknown>;
    const existingValues = stringArray(existingRecord[field]) ?? [];
    const mergedValues = Array.from(new Set([...existingValues, ...values]));
    if (mergedValues.length > 16) {
      output.push(normalized);
      continue;
    }
    output[existingIndex] = {
      ...existing,
      arguments: JSON.stringify({ ...existingRecord, [field]: mergedValues }),
    };
  }

  return output;
}

function toolFailure(code: string, message: string, details?: unknown): MoAgentToolResult {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };
}

function isToolResult(value: unknown): value is MoAgentToolResult {
  if (!isRecord(value) || typeof value.ok !== 'boolean') {
    return false;
  }
  if (value.ok) {
    return Object.prototype.hasOwnProperty.call(value, 'data');
  }
  return isRecord(value.error) && typeof value.error.code === 'string' && typeof value.error.message === 'string';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeJson(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    const serialized = JSON.stringify(value, (_key, candidate: unknown) => {
      if (typeof candidate === 'bigint') {
        return candidate.toString();
      }
      if (typeof candidate === 'object' && candidate !== null) {
        if (seen.has(candidate)) {
          return '[Circular]';
        }
        seen.add(candidate);
      }
      return candidate;
    });
    return serialized ?? 'null';
  } catch {
    return JSON.stringify({ ok: false, error: { code: 'SERIALIZATION_ERROR', message: 'Tool result could not be serialized.' } });
  }
}

function serializeToolResult(result: MoAgentToolResult): string {
  return result.ok
    ? safeJson({
        ok: true,
        data: result.data,
        ...(result.content === undefined ? {} : { content: result.content }),
      })
    : safeJson({
        ok: false,
        error: result.error,
        ...(result.content === undefined ? {} : { content: result.content }),
      });
}

function runError(code: string, message: string, cause?: unknown): MoAgentRunError {
  return { code, message, ...(cause === undefined ? {} : { cause }) };
}

function statusForFinishReason(reason: MoAgentFinishReason): {
  status: MoAgentRunStatus;
  error?: MoAgentRunError;
} {
  switch (reason) {
    case 'length':
      return {
        status: 'max_tokens',
        error: runError('MAX_TOKENS', 'The model reached its output-token limit.'),
      };
    case 'content_filter':
      return {
        status: 'failed',
        error: runError('CONTENT_FILTER', 'The model response was blocked by a content filter.'),
      };
    case 'resource_exhausted':
      return {
        status: 'failed',
        error: runError('PROVIDER_RESOURCE_EXHAUSTED', 'The model provider ran out of capacity.'),
      };
    case 'other':
      return {
        status: 'stopped',
        error: runError('UNEXPECTED_FINISH_REASON', 'The model stopped for an unknown reason.'),
      };
    case 'stop':
    case 'tool_calls':
      return { status: 'completed' };
  }
}

function toolExecutionPolicy(tool: MoAgentTool | undefined): ToolExecutionPolicy {
  const effect: MoAgentToolEffect = tool?.effect ?? (tool?.terminal ? 'pure' : 'external_write');
  const idempotency: MoAgentToolIdempotency =
    tool?.idempotency ??
    (effect === 'pure' || effect === 'read' ? 'intrinsic' : 'reconcile_required');
  return { effect, idempotency };
}

function normalizeEventHandlers(
  handlers: MoAgentEventHandler | MoAgentRunEventHandlers | undefined
): MoAgentRunEventHandlers {
  return typeof handlers === 'function' ? { durableSink: handlers } : (handlers ?? {});
}

function requiresCriticalDrain(
  event: MoAgentEvent,
  signal: AbortSignal | undefined,
  remainingMs: number
): boolean {
  if (event.type === 'run_finished') {
    return (
      event.result.status === 'timeout' ||
      event.result.status === 'cancelled' ||
      signal?.aborted === true ||
      remainingMs <= 0
    );
  }
  if (event.type === 'tool_failed' && event.result.error.code === 'TOOL_EXECUTION_ABORTED') {
    return true;
  }
  return (
    (event.type === 'tool_completed' || event.type === 'tool_failed') &&
    (signal?.aborted === true || remainingMs <= 0)
  );
}

export class MoAgentRunEngine {
  private readonly provider: MoAgentModelProvider;
  private readonly model: string;
  private readonly tools: readonly MoAgentTool[];
  private readonly toolsByName: ReadonlyMap<string, MoAgentTool>;
  private readonly defaults: MoAgentRunLimits;
  private readonly maxTokensPerTurn: number;
  private readonly maxRunInputTokens?: number;
  private readonly maxRunCacheMissInputTokens?: number;
  private readonly preWriteReadOnlyTurnThreshold: number;
  private readonly postWriteReadOnlyTurnThreshold: number;
  private readonly enforcePreWriteReadOnlyTurnLimit: boolean;
  private readonly enforcePostWriteReadOnlyTurnLimit: boolean;
  private readonly requireWorkspaceWriteBeforeTerminal: boolean;
  private readonly protocolLimits: RunProtocolLimits;
  private readonly eventHandlerTimeoutMs: number;
  private readonly criticalDrainTimeoutMs: number;
  private readonly observerTimeoutMs: number;
  private readonly contextManager?: Pick<MoAgentContextManager, 'prepare'>;
  private readonly requireTerminalTool: boolean;
  private readonly idFactory: () => string;
  private readonly now: () => number;

  constructor(options: MoAgentRunEngineOptions) {
    if (!options.model.trim()) {
      throw new Error('MoAgent model cannot be empty.');
    }
    this.provider = options.provider;
    this.model = options.model;
    this.tools = [...(options.tools ?? [])];
    const toolsByName = new Map<string, MoAgentTool>();
    for (const tool of this.tools) {
      if (!tool.name.trim()) {
        throw new Error('MoAgent tool names cannot be empty.');
      }
      if (toolsByName.has(tool.name)) {
        throw new Error(`Duplicate MoAgent tool name: ${tool.name}`);
      }
      toolsByName.set(tool.name, tool);
    }
    this.toolsByName = toolsByName;
    this.defaults = {
      maxTurns: validatePositiveInteger(options.maxTurns ?? DEFAULT_MAX_TURNS, 'maxTurns'),
      maxTokens: validatePositiveInteger(options.maxTokens ?? DEFAULT_MAX_TOKENS, 'maxTokens'),
      timeoutMs: validatePositiveInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 'timeoutMs'),
    };
    this.maxTokensPerTurn = validatePositiveInteger(
      options.maxTokensPerTurn ?? this.defaults.maxTokens,
      'maxTokensPerTurn'
    );
    this.maxRunInputTokens = options.maxRunInputTokens === undefined
      ? undefined
      : validatePositiveInteger(options.maxRunInputTokens, 'maxRunInputTokens');
    this.maxRunCacheMissInputTokens = options.maxRunCacheMissInputTokens === undefined
      ? undefined
      : validatePositiveInteger(
          options.maxRunCacheMissInputTokens,
          'maxRunCacheMissInputTokens'
        );
    this.enforcePreWriteReadOnlyTurnLimit =
      options.preWriteReadOnlyTurnThreshold !== undefined;
    this.enforcePostWriteReadOnlyTurnLimit =
      options.postWriteReadOnlyTurnThreshold !== undefined;
    this.preWriteReadOnlyTurnThreshold = validatePositiveInteger(
      options.preWriteReadOnlyTurnThreshold ?? PRE_WRITE_READ_ONLY_TURN_THRESHOLD,
      'preWriteReadOnlyTurnThreshold'
    );
    this.postWriteReadOnlyTurnThreshold = validatePositiveInteger(
      options.postWriteReadOnlyTurnThreshold ?? POST_WRITE_READ_ONLY_TURN_THRESHOLD,
      'postWriteReadOnlyTurnThreshold'
    );
    this.requireWorkspaceWriteBeforeTerminal =
      options.requireWorkspaceWriteBeforeTerminal ?? false;
    this.protocolLimits = {
      maxToolCallsPerTurn: validatePositiveInteger(
        options.maxToolCallsPerTurn ?? DEFAULT_MAX_TOOL_CALLS_PER_TURN,
        'maxToolCallsPerTurn'
      ),
      maxTotalToolCalls: validatePositiveInteger(
        options.maxTotalToolCalls ?? DEFAULT_MAX_TOTAL_TOOL_CALLS,
        'maxTotalToolCalls'
      ),
      maxTextCharsPerTurn: validatePositiveInteger(
        options.maxTextCharsPerTurn ?? DEFAULT_MAX_TEXT_CHARS_PER_TURN,
        'maxTextCharsPerTurn'
      ),
      maxReasoningCharsPerTurn: validatePositiveInteger(
        options.maxReasoningCharsPerTurn ?? DEFAULT_MAX_REASONING_CHARS_PER_TURN,
        'maxReasoningCharsPerTurn'
      ),
      maxToolArgumentChars: validatePositiveInteger(
        options.maxToolArgumentChars ?? DEFAULT_MAX_TOOL_ARGUMENT_CHARS,
        'maxToolArgumentChars'
      ),
    };
    this.eventHandlerTimeoutMs = validatePositiveInteger(
      options.eventHandlerTimeoutMs ?? this.defaults.timeoutMs,
      'eventHandlerTimeoutMs'
    );
    this.criticalDrainTimeoutMs = validatePositiveInteger(
      options.criticalDrainTimeoutMs ?? DEFAULT_CRITICAL_DRAIN_TIMEOUT_MS,
      'criticalDrainTimeoutMs'
    );
    this.observerTimeoutMs = validatePositiveInteger(
      options.observerTimeoutMs ?? 5_000,
      'observerTimeoutMs'
    );
    this.contextManager = options.contextManager;
    this.requireTerminalTool =
      options.requireTerminalTool ?? this.tools.some((tool) => tool.terminal === true);
    if (this.requireTerminalTool && !this.tools.some((tool) => tool.terminal === true)) {
      throw new Error('MoAgent requires a terminal tool, but none is registered.');
    }
    if (this.requireWorkspaceWriteBeforeTerminal) {
      if (!this.requireTerminalTool) {
        throw new Error(
          'requireWorkspaceWriteBeforeTerminal requires terminal-tool completion.'
        );
      }
      if (!this.tools.some(
        (tool) => toolExecutionPolicy(tool).effect === 'workspace_write'
      )) {
        throw new Error(
          'requireWorkspaceWriteBeforeTerminal requires a workspace_write tool.'
        );
      }
    }
    this.idFactory = options.idFactory ?? defaultRunId;
    this.now = options.now ?? Date.now;
  }

  async run(
    request: MoAgentRunRequest,
    eventHandlers?: MoAgentEventHandler | MoAgentRunEventHandlers
  ): Promise<MoAgentRunResult> {
    const events = this.stream(request);
    const handlers = normalizeEventHandlers(eventHandlers);
    const runTimeoutMs = validatePositiveInteger(
      request.timeoutMs ?? this.defaults.timeoutMs,
      'timeoutMs'
    );
    const eventDeadline = Date.now() + runTimeoutMs;
    // Preserve the structured cancelled result (and its lifecycle events) when
    // the run was already cancelled before it started. A cancellation that
    // arrives while an event consumer is hanging still interrupts that wait.
    const eventSignal = request.signal?.aborted ? undefined : request.signal;
    try {
      while (true) {
        const step = await events.next();
        if (step.done) {
          return step.value;
        }
        const remainingMs = eventDeadline - Date.now();
        if (handlers.durableSink) {
          const criticalDrain = requiresCriticalDrain(
            step.value,
            eventSignal,
            remainingMs
          );
          await raceWithDeadline(
            () => handlers.durableSink!(step.value),
            criticalDrain ? undefined : eventSignal,
            criticalDrain
              ? this.criticalDrainTimeoutMs
              : Math.min(this.eventHandlerTimeoutMs, remainingMs)
          );
        }
        for (const observer of handlers.observers ?? []) {
          try {
            await raceWithDeadline(
              () => observer(step.value),
              eventSignal,
              Math.min(this.observerTimeoutMs, eventDeadline - Date.now())
            );
          } catch (observerError) {
            if (handlers.onObserverError) {
              try {
                await raceWithDeadline(
                  () => handlers.onObserverError!(observerError, step.value),
                  eventSignal,
                  Math.min(this.observerTimeoutMs, eventDeadline - Date.now())
                );
              } catch {
                // Observer diagnostics are best-effort by design.
              }
            }
          }
        }
      }
    } catch (error) {
      const closing = events.return(undefined as never).catch(() => undefined);
      if (
        !(
          (error instanceof DOMException && error.name === 'TimeoutError') ||
          request.signal?.aborted
        )
      ) {
        await closing;
      }
      throw error;
    }
  }

  async *stream(
    request: MoAgentRunRequest
  ): AsyncGenerator<MoAgentEvent, MoAgentRunResult, void> {
    const runId = validateRunId(request.runId ?? this.idFactory());
    const startedAt = this.now();
    const limits: MoAgentRunLimits = {
      maxTurns: validatePositiveInteger(request.maxTurns ?? this.defaults.maxTurns, 'maxTurns'),
      maxTokens: validatePositiveInteger(request.maxTokens ?? this.defaults.maxTokens, 'maxTokens'),
      timeoutMs: validatePositiveInteger(request.timeoutMs ?? this.defaults.timeoutMs, 'timeoutMs'),
    };
    const abortState = createRunAbortState(request.signal, limits.timeoutMs);
    let messages = request.messages.map(cloneMessage);
    const allToolDefinitions = this.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
    let turns = 0;
    let totalToolCalls = 0;
    let output = '';
    let usage = { ...EMPTY_USAGE };
    let eventSequence = 0;
    let successfulWorkspaceWrites = 0;
    let consecutiveReadOnlyTurns = 0;
    let readToolsDisabled = false;
    let convergenceToolPolicyViolationTurns = 0;
    let workspaceWriteCorrectionPending = false;
    let repeatedReadObservationPending = false;
    const readObservations = new Map<string, ReadObservationRecord>();
    let previousPromptPrefix: PromptPrefixSnapshot | null = null;
    const activeConvergenceReasons = new Set<MoAgentConvergenceReason>();
    const terminalToolNames = this.tools
      .filter((tool) => tool.terminal === true)
      .map((tool) => tool.name);

    const event = <T extends MoAgentEventDetails>(
      details: T
    ): MoAgentEvent => {
      eventSequence += 1;
      return ({
        ...details,
        runId,
        sequence: eventSequence,
        eventId: `${runId}:${eventSequence}`,
        timestamp: this.now(),
      }) as unknown as MoAgentEvent;
    };

    const result = (
      status: MoAgentRunStatus,
      error?: MoAgentRunError,
      terminalToolCall?: MoAgentToolCall,
      terminalResult?: MoAgentToolResult
    ): MoAgentRunResult => ({
      runId,
      status,
      messages: messages.map(cloneMessage),
      output,
      turns,
      usage: { ...usage },
      startedAt,
      finishedAt: this.now(),
      ...(terminalToolCall ? { terminalToolCall: { ...terminalToolCall } } : {}),
      ...(terminalResult ? { terminalResult } : {}),
      ...(error ? { error } : {}),
    });

    const finish = async function* (
      finalResult: MoAgentRunResult
    ): AsyncGenerator<MoAgentEvent, MoAgentRunResult, void> {
      yield event({
        type: 'run_finished',
        result: {
          status: finalResult.status,
          turns: finalResult.turns,
          usage: { ...finalResult.usage },
          startedAt: finalResult.startedAt,
          finishedAt: finalResult.finishedAt,
          ...(finalResult.error
            ? {
                error: {
                  code: finalResult.error.code,
                  message: `MoAgent run ended with ${finalResult.error.code}.`,
                },
              }
            : {}),
        },
      });
      return finalResult;
    };

    try {
      yield event({
        type: 'run_started',
        model: this.model,
        provider: this.provider.name,
        limits,
      });
      throwIfAborted(abortState.signal);

      for (let turn = 1; turn <= limits.maxTurns; turn += 1) {
        if (usage.outputTokens >= limits.maxTokens) {
          return yield* finish(
            result(
              'max_tokens',
              runError('MAX_TOKENS', 'The MoAgent output-token budget was exhausted.')
            )
          );
        }
        if (
          this.maxRunInputTokens !== undefined &&
          usage.inputTokens >= this.maxRunInputTokens
        ) {
          return yield* finish(
            result(
              'max_tokens',
              runError(
                'MAX_RUN_INPUT_TOKENS',
                `The MoAgent cumulative input-token budget of ${this.maxRunInputTokens} was exhausted.`
              )
            )
          );
        }
        if (
          this.maxRunCacheMissInputTokens !== undefined &&
          usage.cacheMissInputTokens !== undefined &&
          usage.cacheMissInputTokens >= this.maxRunCacheMissInputTokens
        ) {
          return yield* finish(
            result(
              'max_tokens',
              runError(
                'MAX_RUN_CACHE_MISS_INPUT_TOKENS',
                `The MoAgent cumulative cache-miss input-token budget of ${this.maxRunCacheMissInputTokens} was exhausted.`
              )
            )
          );
        }

        throwIfAborted(abortState.signal);
        turns = turn;
        yield event({ type: 'turn_started', turn });

        const remainingTurns = limits.maxTurns - turn + 1;
        const remainingToolCalls = this.protocolLimits.maxTotalToolCalls - totalToolCalls;
        const previousReasonCount = activeConvergenceReasons.size;
        if (repeatedReadObservationPending) {
          readToolsDisabled = true;
          activeConvergenceReasons.add('repeated_read_observation');
        }
        const hardReadOnlyThresholdReached = successfulWorkspaceWrites === 0
          ? this.enforcePreWriteReadOnlyTurnLimit &&
            consecutiveReadOnlyTurns >= this.preWriteReadOnlyTurnThreshold
          : this.enforcePostWriteReadOnlyTurnLimit &&
            consecutiveReadOnlyTurns >= this.postWriteReadOnlyTurnThreshold;
        if (hardReadOnlyThresholdReached) readToolsDisabled = true;
        if (
          successfulWorkspaceWrites === 0 &&
          consecutiveReadOnlyTurns >= this.preWriteReadOnlyTurnThreshold
        ) {
          activeConvergenceReasons.add('exploration_read_loop');
        }
        if (
          successfulWorkspaceWrites > 0 &&
          consecutiveReadOnlyTurns >= this.postWriteReadOnlyTurnThreshold
        ) {
          activeConvergenceReasons.add('post_write_read_loop');
        }
        if (remainingTurns <= TURN_LIMIT_CONVERGENCE_WINDOW) {
          activeConvergenceReasons.add('turn_limit');
        }
        if (remainingToolCalls <= TOOL_LIMIT_CONVERGENCE_WINDOW) {
          activeConvergenceReasons.add('tool_limit');
        }
        let ephemeralConvergenceDirective: string | undefined;
        if (activeConvergenceReasons.size > 0) {
          const reasons = orderedConvergenceReasons(activeConvergenceReasons);
          ephemeralConvergenceDirective = convergenceDirective({
            reasons,
            remainingTurns,
            remainingToolCalls,
            successfulWorkspaceWrites,
            consecutiveReadOnlyTurns,
            terminalToolNames,
            readToolsDisabled,
          });
          if (activeConvergenceReasons.size > previousReasonCount) {
            yield event({
              type: 'convergence_prompt',
              turn,
              reasons,
              remainingTurns,
              remainingToolCalls,
              successfulWorkspaceWrites,
              consecutiveReadOnlyTurns,
            });
          }
        }

        let text = '';
        let reasoningContent = '';
        let finishReason: MoAgentFinishReason = 'other';
        let sawFinish = false;
        let sawUsage = false;
        let turnUsage = { ...EMPTY_USAGE };
        const toolCallsByIndex = new Map<number, MutableToolCall>();
        const remainingTokens = limits.maxTokens - usage.outputTokens;
        const turnOutputTokens = Math.min(remainingTokens, this.maxTokensPerTurn);
        const phaseToolDefinitions = workspaceWriteCorrectionPending
          ? allToolDefinitions.filter((definition) =>
              toolExecutionPolicy(this.toolsByName.get(definition.name)).effect ===
                'workspace_write'
            )
          : readToolsDisabled
            ? allToolDefinitions.filter((definition) =>
                toolExecutionPolicy(this.toolsByName.get(definition.name)).effect !== 'read'
              )
            : allToolDefinitions;
        // A terminal schema cannot be used successfully before the mandatory
        // workspace mutation. Keep it out of the model payload until it becomes
        // actionable; the runtime guard still rejects hallucinated hidden calls.
        const turnToolDefinitions =
          this.requireWorkspaceWriteBeforeTerminal && successfulWorkspaceWrites === 0
            ? phaseToolDefinitions.filter(
                (definition) => this.toolsByName.get(definition.name)?.terminal !== true
              )
            : phaseToolDefinitions;
        let providerMessages: readonly MoAgentMessage[] = messages;
        let contextCompactionApplied = false;

        if (this.contextManager) {
          // Prepare only canonical messages. If the request-local user control
          // were included here, it would become the "latest user" message and
          // could cause the actual user task to lose compaction protection.
          const prepared = this.contextManager.prepare(messages, turnToolDefinitions);
          providerMessages = prepared.messages;
          contextCompactionApplied = prepared.compaction.applied;
          if (prepared.compaction.applied) {
            messages = prepared.messages.map(cloneMessage);
            yield event({
              type: 'context_compacted',
              turn,
              originalInputTokens: prepared.estimate.originalInputTokens,
              preparedInputTokens: prepared.estimate.preparedInputTokens,
              inputBudgetTokens: prepared.estimate.inputBudgetTokens,
              removedReasoningMessages: prepared.compaction.removedReasoning.length,
              summarizedToolResults: prepared.compaction.summarizedToolResults.length,
              droppedGroups: prepared.compaction.droppedGroups.length,
            });
          }
        }
        if (ephemeralConvergenceDirective !== undefined) {
          providerMessages = appendEphemeralConvergenceDirective(
            providerMessages,
            ephemeralConvergenceDirective
          );
        }

        const prefixReport = promptPrefixReport({
          messages: providerMessages,
          tools: turnToolDefinitions,
          previous: previousPromptPrefix,
          compactionApplied: contextCompactionApplied,
          requestLocalControlSuffix: ephemeralConvergenceDirective !== undefined,
        });
        previousPromptPrefix = {
          messageFingerprints: prefixReport.messageFingerprints,
          toolsSha256: prefixReport.toolsSha256,
          systemSha256: prefixReport.systemSha256,
          requestLocalControlSuffix: prefixReport.requestLocalControlSuffix,
        };
        yield event({
          type: 'prompt_prepared',
          turn,
          systemSha256: prefixReport.systemSha256,
          messagesSha256: prefixReport.messagesSha256,
          toolsSha256: prefixReport.toolsSha256,
          messageCount: prefixReport.messageCount,
          toolCount: prefixReport.toolCount,
          requestUtf8Bytes: prefixReport.requestUtf8Bytes,
          longestCommonPrefixMessages: prefixReport.longestCommonPrefixMessages,
          longestCommonPrefixUtf8Bytes: prefixReport.longestCommonPrefixUtf8Bytes,
          change: prefixReport.change,
          toolSetChanged: prefixReport.toolSetChanged,
          compactionApplied: contextCompactionApplied,
          requestLocalControlSuffix: prefixReport.requestLocalControlSuffix,
        });

        const modelEvents = this.provider.complete({
          model: this.model,
          messages: providerMessages,
          tools: turnToolDefinitions,
          // DeepSeek thinking-mode tool calls are auto-selected without the
          // tool_choice field. Some compatible endpoints reject that field
          // while reasoning is enabled.
          toolChoice:
            request.reasoning?.enabled === true
              ? undefined
              : turnToolDefinitions.length
                ? 'auto'
                : undefined,
          maxTokens: turnOutputTokens,
          temperature: request.temperature,
          reasoning: request.reasoning,
          signal: abortState.signal,
          metadata: request.metadata,
        });

        for await (const modelEvent of abortableEvents(modelEvents, abortState.signal)) {
          if (sawFinish && modelEvent.type !== 'usage') {
            throw new Error(
              `The model emitted a ${modelEvent.type} event after its finish reason.`
            );
          }
          switch (modelEvent.type) {
            case 'provider_retry':
              yield event({
                type: 'provider_retry',
                turn,
                attempt: modelEvent.attempt,
                maxAttempts: modelEvent.maxAttempts,
                delayMs: modelEvent.delayMs,
                code: modelEvent.code,
                status: modelEvent.status,
              });
              break;
            case 'response_start':
              yield event({
                type: 'model_started',
                turn,
                responseId: modelEvent.responseId,
                model: modelEvent.model,
              });
              break;
            case 'text_delta':
              if (text.length + modelEvent.delta.length > this.protocolLimits.maxTextCharsPerTurn) {
                throw new Error(
                  `The model response exceeded the ${this.protocolLimits.maxTextCharsPerTurn}-character text limit.`
                );
              }
              text += modelEvent.delta;
              output += modelEvent.delta;
              yield event({ type: 'text_delta', turn, delta: modelEvent.delta });
              break;
            case 'reasoning_delta':
              if (
                reasoningContent.length + modelEvent.delta.length >
                this.protocolLimits.maxReasoningCharsPerTurn
              ) {
                throw new Error(
                  `The model response exceeded the ${this.protocolLimits.maxReasoningCharsPerTurn}-character reasoning limit.`
                );
              }
              reasoningContent += modelEvent.delta;
              break;
            case 'tool_call_delta': {
              if (!Number.isSafeInteger(modelEvent.index) || modelEvent.index < 0) {
                throw new Error('The model returned a tool call with an invalid index.');
              }
              let current = toolCallsByIndex.get(modelEvent.index);
              if (!current) {
                if (toolCallsByIndex.size >= this.protocolLimits.maxToolCallsPerTurn) {
                  throw new Error(
                    `The model exceeded the ${this.protocolLimits.maxToolCallsPerTurn}-tool per-turn limit.`
                  );
                }
                if (totalToolCalls + toolCallsByIndex.size >= this.protocolLimits.maxTotalToolCalls) {
                  throw new MoAgentRunLimitError(
                    'MAX_TOTAL_TOOL_CALLS',
                    `The model exceeded the ${this.protocolLimits.maxTotalToolCalls}-tool run limit.`
                  );
                }
                current = {
                  index: modelEvent.index,
                  name: '',
                  arguments: '',
                };
              }
              if (modelEvent.id !== undefined) {
                if (!modelEvent.id.trim()) {
                  throw new Error('The model returned an empty tool-call ID.');
                }
                if (current.id !== undefined && current.id !== modelEvent.id) {
                  throw new Error(
                    `The model changed the tool-call ID for index ${modelEvent.index}.`
                  );
                }
                current.id = modelEvent.id;
              }
              const nextName = current.name + (modelEvent.nameDelta ?? '');
              const nextArguments = current.arguments + (modelEvent.argumentsDelta ?? '');
              if (nextName.length > MAX_TOOL_NAME_CHARS) {
                throw new Error(
                  `The model returned a tool name longer than ${MAX_TOOL_NAME_CHARS} characters.`
                );
              }
              if (nextArguments.length > this.protocolLimits.maxToolArgumentChars) {
                throw new Error(
                  `The model exceeded the ${this.protocolLimits.maxToolArgumentChars}-character tool-argument limit.`
                );
              }
              current.name = nextName;
              current.arguments = nextArguments;
              toolCallsByIndex.set(modelEvent.index, current);
              yield event({
                type: 'tool_call_delta',
                turn,
                index: modelEvent.index,
                id: modelEvent.id,
                nameDelta: modelEvent.nameDelta,
                argumentsDelta: modelEvent.argumentsDelta,
              });
              break;
            }
            case 'usage':
              sawUsage = true;
              usage = addUsage(subtractUsage(usage, turnUsage), modelEvent.usage);
              turnUsage = { ...modelEvent.usage };
              yield event({
                type: 'usage',
                turn,
                usage: { ...modelEvent.usage },
                totalUsage: { ...usage },
              });
              break;
            case 'finish':
              sawFinish = true;
              finishReason = modelEvent.reason;
              break;
          }
        }

        if (!sawFinish) {
          return yield* finish(
            result(
              'failed',
              runError('MISSING_FINISH_REASON', 'The model stream ended without a finish reason.')
            )
          );
        }

        const rawToolCalls: MoAgentToolCall[] = [...toolCallsByIndex.values()]
          .sort((left, right) => left.index - right.index)
          .map((toolCall) => ({
            id: toolCall.id ?? `call_${turn}_${toolCall.index}`,
            name: toolCall.name,
            arguments: toolCall.arguments,
          }));
        const toolCallIds = new Set<string>();
        for (const toolCall of rawToolCalls) {
          if (toolCallIds.has(toolCall.id)) {
            throw new Error(`The model returned duplicate tool-call ID: ${toolCall.id}`);
          }
          toolCallIds.add(toolCall.id);
        }
        const toolCalls = coalesceReadToolCalls(rawToolCalls, this.toolsByName);
        if (!sawUsage) {
          const estimatedOutputTokens = estimateOutputTokens(text, reasoningContent, toolCalls);
          turnUsage = {
            inputTokens: 0,
            outputTokens: estimatedOutputTokens,
            totalTokens: estimatedOutputTokens,
          };
          usage = addUsage(usage, turnUsage);
          yield event({
            type: 'usage',
            turn,
            usage: { ...turnUsage },
            totalUsage: { ...usage },
          });
        }
        const assistantMessage: MoAgentAssistantMessage = {
          role: 'assistant',
          content: text,
          ...(toolCalls.length ? { reasoningContent, toolCalls } : {}),
        };
        messages.push(assistantMessage);
        yield event({
          type: 'assistant_message',
          turn,
          message: {
            role: 'assistant',
            content: assistantMessage.content,
            ...(assistantMessage.toolCalls
              ? { toolCalls: assistantMessage.toolCalls.map((toolCall) => ({ ...toolCall })) }
              : {}),
          },
          finishReason,
        });

        if (finishReason === 'tool_calls' && toolCalls.length === 0) {
          return yield* finish(
            result(
              'failed',
              workspaceWriteCorrectionPending
                ? runError(
                    'WORKSPACE_WRITE_REQUIRED',
                    WORKSPACE_WRITE_REQUIRED_MESSAGE
                  )
                : runError(
                    'MISSING_TOOL_CALLS',
                    'The model reported a tool-call finish without providing a tool call.'
                  )
            )
          );
        }

        if (toolCalls.length > 0 && finishReason !== 'tool_calls') {
          return yield* finish(
            result(
              'failed',
              runError(
                'UNEXPECTED_TOOL_CALLS',
                `The model emitted tool calls with finish reason "${finishReason}"; no tools were executed.`
              )
            )
          );
        }

        const terminalToolCalls = toolCalls.filter(
          (toolCall) => this.toolsByName.get(toolCall.name)?.terminal === true
        );
        if (terminalToolCalls.length > 0 && toolCalls.length !== 1) {
          return yield* finish(
            result(
              'failed',
              runError(
                'TERMINAL_TOOL_NOT_EXCLUSIVE',
                'A terminal tool call must be the only tool call in its model turn.'
              )
            )
          );
        }

        if (toolCalls.length) {
          totalToolCalls += toolCalls.length;
          if (usage.outputTokens >= limits.maxTokens || finishReason === 'length') {
            return yield* finish(
              result(
                'max_tokens',
                runError(
                  'MAX_TOKENS',
                  'The MoAgent output-token budget was exhausted before tool execution.'
                )
              )
            );
          }
          const readOnlyToolTurn = toolCalls.every(
            (toolCall) => toolExecutionPolicy(this.toolsByName.get(toolCall.name)).effect === 'read'
          );
          const convergencePolicyViolatedThisTurn = readToolsDisabled && toolCalls.some(
            (toolCall) => toolExecutionPolicy(this.toolsByName.get(toolCall.name)).effect === 'read'
          );
          if (convergencePolicyViolatedThisTurn) {
            convergenceToolPolicyViolationTurns += 1;
          }
          const workspaceWriteCorrectionWasPending = workspaceWriteCorrectionPending;
          let workspaceWriteGuardTriggeredThisTurn = false;
          let successfulWorkspaceWritesThisTurn = 0;
          let reusedReadObservationsThisTurn = 0;
          for (const toolCall of toolCalls) {
            throwIfAborted(abortState.signal);
            const operationId = createMoAgentOperationId(runId, turn, toolCall);
            const executionPolicy = toolExecutionPolicy(this.toolsByName.get(toolCall.name));
            const observationFingerprint = readObservationFingerprint(
              toolCall,
              this.toolsByName.get(toolCall.name)
            );
            const priorObservation = observationFingerprint
              ? readObservations.get(observationFingerprint)
              : undefined;
            const reusableObservation = priorObservation &&
              observationResultIsVisible(messages, priorObservation)
                ? priorObservation
                : undefined;
            yield event({
              type: 'tool_started',
              turn,
              toolCall: { ...toolCall },
              operationId,
              ...executionPolicy,
            });
            const terminalBlockedByWorkspaceWriteGuard =
              this.requireWorkspaceWriteBeforeTerminal &&
              successfulWorkspaceWrites === 0 &&
              this.toolsByName.get(toolCall.name)?.terminal === true;
            const disabledDuringWorkspaceWriteCorrection =
              workspaceWriteCorrectionWasPending &&
              executionPolicy.effect !== 'workspace_write';
            const blockedByWorkspaceWriteGuard =
              terminalBlockedByWorkspaceWriteGuard ||
              disabledDuringWorkspaceWriteCorrection;
            if (blockedByWorkspaceWriteGuard) {
              workspaceWriteGuardTriggeredThisTurn = true;
            }
            const execution: ToolExecution =
              blockedByWorkspaceWriteGuard
                ? {
                    result: toolFailure(
                      'WORKSPACE_WRITE_REQUIRED',
                      WORKSPACE_WRITE_REQUIRED_MESSAGE
                    ),
                    terminal: false,
                    durationMs: 0,
                  }
                : readToolsDisabled && executionPolicy.effect === 'read'
                ? {
                    result: toolFailure(
                      'TOOL_DISABLED_BY_CONVERGENCE',
                      `The read-only tool "${toolCall.name}" is disabled because the runtime exploration budget is exhausted. Use an available workspace-write tool for the smallest necessary change, or call a terminal tool only when current evidence supports completion.`
                    ),
                    terminal: false,
                    durationMs: 0,
                  }
                : reusableObservation
                ? reusedReadObservation(reusableObservation)
                : await this.executeTool(
                    toolCall,
                    turn,
                    runId,
                    operationId,
                    abortState.signal,
                    request.commitWorkspaceMutation
                  );
            messages.push({
              role: 'tool',
              toolCallId: toolCall.id,
              name: toolCall.name,
              content: serializeToolResult(execution.result),
            });

            if (execution.result.ok) {
              if (executionPolicy.effect === 'workspace_write') {
                successfulWorkspaceWritesThisTurn += 1;
                // Every workspace read is now from an older generation. Clear
                // eagerly so a later read in the same multi-call turn cannot
                // reuse pre-mutation evidence.
                readObservations.clear();
              } else if (observationFingerprint) {
                if (reusableObservation) {
                  reusedReadObservationsThisTurn += 1;
                } else {
                  readObservations.set(observationFingerprint, {
                    toolCallId: toolCall.id,
                    turn,
                    resultSha256: createHash('sha256')
                      .update(serializeToolResult(execution.result), 'utf8')
                      .digest('hex'),
                  });
                }
              }
              yield event({
                type: 'tool_completed',
                turn,
                toolCall: { ...toolCall },
                operationId,
                ...executionPolicy,
                result: execution.result,
                terminal: execution.terminal,
                durationMs: execution.durationMs,
              });
              if (execution.terminal) {
                return yield* finish(
                  result('completed', undefined, toolCall, execution.result)
                );
              }
            } else {
              yield event({
                type: 'tool_failed',
                turn,
                toolCall: { ...toolCall },
                operationId,
                ...executionPolicy,
                result: execution.result,
                durationMs: execution.durationMs,
              });
              // Do not let the model retry or issue another mutation after an
              // outcome that may already have crossed a side-effect boundary.
              // Cancellation/timeout keeps its more specific terminal status.
              throwIfAborted(abortState.signal);
              if (
                !blockedByWorkspaceWriteGuard &&
                mutationOutcomeRequiresReconciliation(
                  executionPolicy.effect,
                  execution.result
                )
              ) {
                return yield* finish(
                  result(
                    'failed',
                    runError(
                      'MUTATION_RECONCILIATION_REQUIRED',
                      'A mutating tool outcome is uncertain; this run was stopped before any further tool execution.'
                    )
                  )
                );
              }
            }
          }
          if (successfulWorkspaceWritesThisTurn > 0) {
            successfulWorkspaceWrites += successfulWorkspaceWritesThisTurn;
            consecutiveReadOnlyTurns = 0;
            readToolsDisabled = false;
            convergenceToolPolicyViolationTurns = 0;
            workspaceWriteCorrectionPending = false;
            repeatedReadObservationPending = false;
            activeConvergenceReasons.delete('repeated_read_observation');
          } else if (readOnlyToolTurn) {
            consecutiveReadOnlyTurns += 1;
          } else {
            consecutiveReadOnlyTurns = 0;
          }
          if (
            successfulWorkspaceWritesThisTurn === 0 &&
            reusedReadObservationsThisTurn > 0
          ) {
            repeatedReadObservationPending = true;
          }
          if (successfulWorkspaceWritesThisTurn === 0) {
            if (workspaceWriteCorrectionWasPending) {
              return yield* finish(
                result(
                  'failed',
                  runError(
                    'WORKSPACE_WRITE_REQUIRED',
                    WORKSPACE_WRITE_REQUIRED_MESSAGE
                  )
                )
              );
            }
            if (workspaceWriteGuardTriggeredThisTurn) {
              workspaceWriteCorrectionPending = true;
            }
          }
          if (
            convergencePolicyViolatedThisTurn &&
            successfulWorkspaceWritesThisTurn === 0 &&
            convergenceToolPolicyViolationTurns >=
              MAX_CONVERGENCE_TOOL_POLICY_VIOLATION_TURNS
          ) {
            return yield* finish(
              result(
                'failed',
                runError(
                  'CONVERGENCE_TOOL_POLICY_VIOLATION',
                  'The model repeatedly called read-only tools after the runtime disabled them for convergence.'
                )
              )
            );
          }
          continue;
        }

        if (workspaceWriteCorrectionPending) {
          return yield* finish(
            result(
              'failed',
              runError(
                'WORKSPACE_WRITE_REQUIRED',
                WORKSPACE_WRITE_REQUIRED_MESSAGE
              )
            )
          );
        }
        const finishState = statusForFinishReason(finishReason);
        if (finishState.status !== 'completed') {
          return yield* finish(result(finishState.status, finishState.error));
        }
        if (this.requireTerminalTool) {
          return yield* finish(
            result(
              'stopped',
              runError(
                'TERMINAL_TOOL_REQUIRED',
                'The model stopped without successfully calling the terminal tool.'
              )
            )
          );
        }
        return yield* finish(result('completed'));
      }

      return yield* finish(
        result(
          'max_turns',
          runError('MAX_TURNS', `The MoAgent run reached its ${limits.maxTurns}-turn limit.`)
        )
      );
    } catch (error) {
      if (abortState.signal.aborted) {
        const timedOut = abortState.didTimeout();
        return yield* finish(
          result(
            timedOut ? 'timeout' : 'cancelled',
            runError(
              timedOut ? 'TIMEOUT' : 'CANCELLED',
              timedOut ? 'The MoAgent run timed out.' : 'The MoAgent run was cancelled.',
              abortReason(abortState.signal)
            )
          )
        );
      }
      if (error instanceof MoAgentContextError) {
        return yield* finish(
          result('failed', runError(error.code, error.message, error))
        );
      }
      if (error instanceof MoAgentRunLimitError) {
        return yield* finish(
          result('failed', runError(error.code, error.message, error))
        );
      }
      return yield* finish(
        result('failed', runError('RUN_FAILED', errorMessage(error), error))
      );
    } finally {
      abortState.cleanup();
    }
  }

  private async executeTool(
    toolCall: MoAgentToolCall,
    turn: number,
    runId: string,
    operationId: string,
    signal: AbortSignal,
    commitWorkspaceMutation: MoAgentRunRequest['commitWorkspaceMutation']
  ): Promise<ToolExecution> {
    const startedAt = this.now();
    const tool = this.toolsByName.get(toolCall.name);
    if (!tool) {
      return {
        result: toolFailure(
          'UNKNOWN_TOOL',
          `The tool "${toolCall.name || '(empty name)'}" is not registered.`
        ),
        terminal: false,
        durationMs: this.now() - startedAt,
      };
    }

    let parsed: unknown;
    try {
      parsed = parseMoAgentToolArguments(toolCall.arguments).value;
    } catch (error) {
      return {
        result: toolFailure(
          'INVALID_TOOL_ARGUMENTS',
          'Tool arguments must be valid JSON.',
          { parseError: errorMessage(error) }
        ),
        terminal: false,
        durationMs: this.now() - startedAt,
      };
    }

    if (!isRecord(parsed)) {
      return {
        result: toolFailure(
          'INVALID_TOOL_ARGUMENTS',
          'Tool arguments must be a JSON object.'
        ),
        terminal: false,
        durationMs: this.now() - startedAt,
      };
    }

    let input: unknown = parsed;
    if (tool.parseInput) {
      try {
        input = tool.parseInput(parsed);
      } catch (error) {
        return {
          result: toolFailure('INVALID_TOOL_INPUT', errorMessage(error)),
          terminal: false,
          durationMs: this.now() - startedAt,
        };
      }
    }

    try {
      // A cancellation may arrive while the durable tool_started event is being
      // committed. Do not invoke the tool after that point, but still return a
      // terminal tool event so the prepared ledger can be reconciled.
      if (signal.aborted) {
        return {
          result: toolFailure(
            'TOOL_EXECUTION_ABORTED',
            'Tool execution was aborted before its outcome could be confirmed.'
          ),
          terminal: false,
          durationMs: this.now() - startedAt,
        };
      }
      const candidate = await raceWithSignal(
        Promise.resolve(
          tool.execute(input, {
            runId,
            turn,
            toolCallId: toolCall.id,
            operationId,
            signal,
            ...(commitWorkspaceMutation
              ? {
                  commitWorkspaceMutation: <T>(commit: () => Promise<T>) =>
                    commitWorkspaceMutation(operationId, commit),
                }
              : {}),
          })
        ),
        signal
      );
      if (!isToolResult(candidate)) {
        return {
          result: toolFailure(
            'INVALID_TOOL_RESULT',
            `Tool "${tool.name}" returned an invalid result envelope.`
          ),
          terminal: false,
          durationMs: this.now() - startedAt,
        };
      }
      return {
        result: candidate,
        terminal: candidate.ok && tool.terminal === true,
        durationMs: this.now() - startedAt,
      };
    } catch (error) {
      if (signal.aborted) {
        return {
          result: toolFailure(
            'TOOL_EXECUTION_ABORTED',
            'Tool execution was aborted before its outcome could be confirmed.'
          ),
          terminal: false,
          durationMs: this.now() - startedAt,
        };
      }
      return {
        result: toolFailure('TOOL_EXECUTION_FAILED', errorMessage(error)),
        terminal: false,
        durationMs: this.now() - startedAt,
      };
    }
  }
}
