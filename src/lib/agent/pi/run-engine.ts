import { createHash, randomUUID } from 'node:crypto';

import type {
  AfterToolCallResult,
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  BeforeToolCallResult,
  StreamFn,
} from '@earendil-works/pi-agent-core';
import type {
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Message,
  Model,
  TSchema,
  ThinkingLevel,
  ToolCall,
} from '@earendil-works/pi-ai';

import type {
  PiAgentContextManager,
} from '../context';
import { createPiAgentOperationId } from '../core/operation-id';
import {
  createProgressOracleState,
  ProgressOracle,
} from '../core/progress-oracle';
import {
  assertPiAgentToolApprovalPolicy,
  resolvePiAgentToolApproval,
} from '../core/tool-approval';
import {
  executePiAgentTool,
  type PiAgentToolExecution,
} from '../core/tool-executor';
import { mutationOutcomeRequiresReconciliation } from '../core/tool-outcome';
import type {
  PiAgentAssistantMessage,
  PiAgentEvent,
  PiAgentEventHandler,
  PiAgentFinishReason,
  PiAgentMessage,
  PiAgentModelEvent,
  PiAgentModelRequest,
  PiAgentProgressOracleEventDecision,
  PiAgentRunError,
  PiAgentRunEventHandlers,
  PiAgentRunLimits,
  PiAgentRunRequest,
  PiAgentRunResult,
  PiAgentRunStatus,
  PiAgentTokenUsage,
  PiAgentTool,
  PiAgentToolCall,
  PiAgentToolEffect,
  PiAgentToolIdempotency,
  PiAgentToolResult,
} from '../types';
import type { PiAgentRunEngineOptions } from './options';
import type { PiAgentContextSnapshot } from '../context/usage-snapshot';
import { EMPTY_USAGE, EMPTY_PI_USAGE, addUsage, usageFromPi, usageToPi, estimateUnreportedUsage } from './token-usage';
export {
  PI_AGENT_CORE_PACKAGE,
  PI_AGENT_FRAMEWORK_VERSION,
  PI_AGENT_VERSION,
} from './identity';

const DEFAULT_MAX_TURNS = 48;
const DEFAULT_MAX_TOKENS = 12_000;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1_000;
const DEFAULT_MAX_TOTAL_TOOL_CALLS = 64;
const DEFAULT_MAX_TOOL_CALLS_PER_TURN = 16;
const DEFAULT_MAX_TEXT_CHARS_PER_TURN = 128_000;
const DEFAULT_MAX_REASONING_CHARS_PER_TURN = 256_000;
const DEFAULT_MAX_TOOL_ARGUMENT_CHARS = 64_000;
const DEFAULT_PRE_WRITE_READ_ONLY_TURNS = 6;
const DEFAULT_POST_WRITE_READ_ONLY_TURNS = 3;
const MAX_TOOL_NAME_CHARS = 256;
const MAX_TOOL_CALL_ID_CHARS = 512;
const MAX_RUN_ID_CHARS = 256;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

type PiAgentCoreRuntime = Pick<
  typeof import('@earendil-works/pi-agent-core'),
  'runAgentLoopContinue'
>;
type PiAiRuntime = Pick<
  typeof import('@earendil-works/pi-ai'),
  'createAssistantMessageEventStream' | 'validateToolArguments'
>;

let upstreamRuntimePromise:
  | Promise<PiAgentCoreRuntime & PiAiRuntime>
  | undefined;

/**
 * The PI packages are ESM-only. QuantPilot's standalone Worker entry is
 * intentionally CommonJS-compatible, so runtime values must cross the native
 * dynamic-import boundary instead of being transpiled into `require()`.
 */
function loadUpstreamPiRuntime(): Promise<PiAgentCoreRuntime & PiAiRuntime> {
  upstreamRuntimePromise ??= Promise.all([
    import('@earendil-works/pi-agent-core'),
    import('@earendil-works/pi-ai'),
  ]).then(([core, ai]) => ({
    runAgentLoopContinue: core.runAgentLoopContinue,
    createAssistantMessageEventStream: ai.createAssistantMessageEventStream,
    validateToolArguments: ai.validateToolArguments,
  }));
  return upstreamRuntimePromise;
}

type EventDetails = PiAgentEvent extends infer Event
  ? Event extends PiAgentEvent
    ? Omit<Event, 'runId' | 'sequence' | 'eventId' | 'timestamp'>
    : never
  : never;

interface ToolPolicy {
  effect: PiAgentToolEffect;
  idempotency: PiAgentToolIdempotency;
}

interface PiHostToolDetails {
  hostResult: PiAgentToolResult;
  hostExecution: PiAgentToolExecution | null;
  approvalRejected: boolean;
}

interface PreparedPiToolCall {
  tool: PiAgentTool;
  piTool: AgentTool<TSchema, PiHostToolDetails>;
  policy: ToolPolicy;
  originalToolCall: PiAgentToolCall;
  effectiveToolCall: PiAgentToolCall;
  approvalRejected: boolean;
}

interface MutableProviderToolCall {
  id?: string;
  name: string;
  arguments: string;
}

interface ProviderTurnState {
  text: string;
  reasoning: string;
  usage: PiAgentTokenUsage;
  usageReceived: boolean;
  responseId?: string;
  responseModel?: string;
  finishReason?: PiAgentFinishReason;
  toolCalls: Map<number, MutableProviderToolCall>;
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(`${name} must be a positive safe integer.`);
  }
  return resolved;
}

function validateRunId(value: string): string {
  const candidate = value.trim();
  if (
    !candidate ||
    candidate.length > MAX_RUN_ID_CHARS ||
    !RUN_ID_PATTERN.test(candidate)
  ) {
    throw new Error(
      `runId must be 1-${MAX_RUN_ID_CHARS} ASCII identifier characters.`,
    );
  }
  return candidate;
}

function validToolName(value: string): boolean {
  return Boolean(value.trim()) &&
    value === value.trim() &&
    value.length <= MAX_TOOL_NAME_CHARS &&
    !/[\0-\x1f\x7f]/.test(value);
}

function validToolCallId(value: string): boolean {
  return Boolean(value.trim()) &&
    value === value.trim() &&
    value.length <= MAX_TOOL_CALL_ID_CHARS &&
    !/[\0-\x1f\x7f]/.test(value);
}

function toolPolicy(tool: PiAgentTool | undefined): ToolPolicy {
  const effect: PiAgentToolEffect = tool?.effect ?? 'external_write';
  const idempotency: PiAgentToolIdempotency = tool?.idempotency ??
    (effect === 'pure' || effect === 'read'
      ? 'intrinsic'
      : 'reconcile_required');
  return { effect, idempotency };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error('PI Agent tool arguments must contain finite numbers.');
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  throw new Error('PI Agent tool arguments must be JSON-serializable.');
}

function safeJson(value: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, candidate: unknown) => {
      if (typeof candidate === 'bigint') return candidate.toString();
      if (candidate && typeof candidate === 'object') {
        if (seen.has(candidate)) return '[Circular]';
        seen.add(candidate);
      }
      return candidate;
    }) ?? 'null';
  } catch {
    return JSON.stringify({
      ok: false,
      error: {
        code: 'SERIALIZATION_ERROR',
        message: 'Tool result could not be serialized.',
      },
    });
  }
}

function serializeToolResult(result: PiAgentToolResult): string {
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

function toolFailure(
  code: string,
  message: string,
  details?: unknown,
): Extract<PiAgentToolResult, { ok: false }> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };
}

function parseProviderToolArguments(value: string): Record<string, unknown> {
  const parsed: unknown = value.trim() ? JSON.parse(value) : {};
  if (!isRecord(parsed)) {
    throw new Error('PI Agent tool arguments must be a JSON object.');
  }
  return parsed;
}

function piStopReason(reason: PiAgentFinishReason): AssistantMessage['stopReason'] {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'tool_calls':
      return 'toolUse';
    case 'length':
      return 'length';
    default:
      return 'error';
  }
}

function finishReasonFromPi(message: AssistantMessage): PiAgentFinishReason {
  switch (message.stopReason) {
    case 'stop':
      return 'stop';
    case 'toolUse':
      return 'tool_calls';
    case 'length':
      return 'length';
    default:
      return 'other';
  }
}

function textFromContent(
  content: unknown,
): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((item): item is { type: 'text'; text: string } =>
      isRecord(item) && item.type === 'text' && typeof item.text === 'string')
    .map((item) => item.text)
    .join('');
}

function toPiConversation(messages: readonly PiAgentMessage[]): {
  systemPrompt: string;
  messages: AgentMessage[];
} {
  const systemPrompt = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const conversation: AgentMessage[] = [];
  const timestamp = Date.now();

  messages.forEach((message, index) => {
    const messageTimestamp = timestamp + index;
    switch (message.role) {
      case 'system':
        break;
      case 'user':
        conversation.push({
          role: 'user',
          content: message.content,
          timestamp: messageTimestamp,
        });
        break;
      case 'assistant': {
        const content: AssistantMessage['content'] = [];
        if (message.reasoningContent) {
          content.push({
            type: 'thinking',
            thinking: message.reasoningContent,
          });
        }
        if (message.content) {
          content.push({ type: 'text', text: message.content });
        }
        for (const toolCall of message.toolCalls ?? []) {
          content.push({
            type: 'toolCall',
            id: toolCall.id,
            name: toolCall.name,
            arguments: parseProviderToolArguments(toolCall.arguments),
          });
        }
        conversation.push({
          role: 'assistant',
          content,
          api: 'quantpilot-provider',
          provider: 'quantpilot-history',
          model: 'history',
          usage: { ...EMPTY_PI_USAGE, cost: { ...EMPTY_PI_USAGE.cost } },
          stopReason: message.toolCalls?.length ? 'toolUse' : 'stop',
          timestamp: messageTimestamp,
        });
        break;
      }
      case 'tool':
        conversation.push({
          role: 'toolResult',
          toolCallId: message.toolCallId,
          toolName: message.name ?? 'unknown',
          content: [{ type: 'text', text: message.content }],
          isError: false,
          timestamp: messageTimestamp,
        });
        break;
    }
  });
  return { systemPrompt, messages: conversation };
}

function toPiAgentMessages(context: Context): PiAgentMessage[] {
  const messages: PiAgentMessage[] = [];
  if (context.systemPrompt?.trim()) {
    messages.push({ role: 'system', content: context.systemPrompt });
  }
  for (const message of context.messages) {
    switch (message.role) {
      case 'user':
        messages.push({
          role: 'user',
          content: textFromContent(message.content),
        });
        break;
      case 'assistant': {
        const content = message.content
          .filter((item) => item.type === 'text')
          .map((item) => item.text)
          .join('');
        const reasoningContent = message.content
          .filter((item) => item.type === 'thinking')
          .map((item) => item.thinking)
          .join('');
        const toolCalls = message.content
          .filter((item): item is ToolCall => item.type === 'toolCall')
          .map((toolCall) => ({
            id: toolCall.id,
            name: toolCall.name,
            arguments: canonicalJson(toolCall.arguments),
          }));
        messages.push({
          role: 'assistant',
          content: content || null,
          ...(reasoningContent ? { reasoningContent } : {}),
          ...(toolCalls.length ? { toolCalls } : {}),
        });
        break;
      }
      case 'toolResult':
        messages.push({
          role: 'tool',
          toolCallId: message.toolCallId,
          name: message.toolName,
          content: textFromContent(message.content),
        });
        break;
    }
  }
  return messages;
}

function modelForPi(
  model: string,
  provider: string,
  maxTokens: number,
  reasoning: boolean,
): Model<string> {
  return {
    id: model,
    name: model,
    api: 'quantpilot-provider',
    provider,
    baseUrl: '',
    reasoning,
    input: ['text'],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 128_000,
    maxTokens,
  };
}

function thinkingLevel(
  request: PiAgentRunRequest,
): ThinkingLevel | undefined {
  if (request.reasoning?.enabled !== true) return undefined;
  return request.reasoning.effort ?? 'medium';
}

function isLlmMessage(message: AgentMessage): message is Message {
  return message.role === 'user' ||
    message.role === 'assistant' ||
    message.role === 'toolResult';
}

function assistantProjection(message: AssistantMessage): {
  message: PiAgentAssistantMessage;
  finishReason: PiAgentFinishReason;
} {
  const content = message.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('');
  const reasoningContent = message.content
    .filter((item) => item.type === 'thinking')
    .map((item) => item.thinking)
    .join('');
  const toolCalls = message.content
    .filter((item): item is ToolCall => item.type === 'toolCall')
    .map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
      arguments: canonicalJson(toolCall.arguments),
    }));
  return {
    message: {
      role: 'assistant',
      content: content || null,
      ...(reasoningContent ? { reasoningContent } : {}),
      ...(toolCalls.length ? { toolCalls } : {}),
    },
    finishReason: finishReasonFromPi(message),
  };
}

function runError(code: string, message: string, cause?: unknown): PiAgentRunError {
  return {
    code,
    message,
    ...(cause === undefined ? {} : { cause }),
  };
}

function normalizeHandlers(
  handlers: PiAgentEventHandler | PiAgentRunEventHandlers | undefined,
): PiAgentRunEventHandlers {
  return typeof handlers === 'function'
    ? { durableSink: handlers }
    : handlers ?? {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hostToolDetails(value: unknown): PiHostToolDetails | null {
  if (!isRecord(value) || !('hostResult' in value)) return null;
  const candidate = value as unknown as PiHostToolDetails;
  return isRecord(candidate.hostResult) && typeof candidate.hostResult.ok === 'boolean'
    ? candidate
    : null;
}

function providerMessage(options: {
  request: PiAgentModelRequest;
  providerName: string;
  state: ProviderTurnState;
}): AssistantMessage {
  const { request, providerName, state } = options;
  if (!state.finishReason) {
    throw new Error('Provider stream ended without a finish reason.');
  }
  const content: AssistantMessage['content'] = [];
  if (state.reasoning) {
    content.push({ type: 'thinking', thinking: state.reasoning });
  }
  if (state.text) content.push({ type: 'text', text: state.text });
  for (const [index, toolCall] of [...state.toolCalls.entries()]
    .sort(([left], [right]) => left - right)) {
    content.push({
      type: 'toolCall',
      id: toolCall.id ?? `call_${index}`,
      name: toolCall.name,
      arguments: parseProviderToolArguments(toolCall.arguments),
    });
  }
  const stopReason = piStopReason(state.finishReason);
  return {
    role: 'assistant',
    content,
    api: 'quantpilot-provider',
    provider: providerName,
    model: request.model,
    ...(state.responseId ? { responseId: state.responseId } : {}),
    ...(state.responseModel ? { responseModel: state.responseModel } : {}),
    usage: usageToPi(state.usageReceived ? state.usage : { ...state.usage, usageSource: 'partial' }),
    stopReason,
    ...(stopReason === 'error'
      ? {
          errorMessage:
            `Provider ended the PI Agent turn with ${state.finishReason}.`,
        }
      : {}),
    timestamp: Date.now(),
  };
}

function providerErrorMessage(options: {
  request: PiAgentModelRequest;
  providerName: string;
  error: unknown;
  usage?: PiAgentTokenUsage;
}): AssistantMessage {
  const aborted = options.request.signal?.aborted === true;
  let errorUsage = { ...EMPTY_PI_USAGE, cost: { ...EMPTY_PI_USAGE.cost } };
  if (options.usage) {
    try {
      errorUsage = usageToPi(options.usage);
    } catch {
      errorUsage = usageToPi({ ...EMPTY_USAGE, usageSource: 'partial' });
    }
  }
  return {
    role: 'assistant',
    content: [],
    api: 'quantpilot-provider',
    provider: options.providerName,
    model: options.request.model,
    usage: errorUsage,
    stopReason: aborted ? 'aborted' : 'error',
    errorMessage: errorMessage(options.error),
    timestamp: Date.now(),
  };
}

export type { PiAgentRunEngineOptions } from './options';

/**
 * PI owns the complete multi-turn agent loop and calls the real QuantPilot
 * tools. QuantPilot remains the host governance layer for approval, durable
 * prepare-before-effect ledgers, fencing, budgets and Mission completion.
 */
export class PiAgentRunEngine {
  private readonly options: PiAgentRunEngineOptions;
  private readonly tools: readonly PiAgentTool[];
  private readonly toolsByName: ReadonlyMap<string, PiAgentTool>;

  constructor(options: PiAgentRunEngineOptions) {
    if (!options.model.trim()) throw new Error('PI Agent model cannot be empty.');
    const tools = [...(options.tools ?? [])];
    const toolsByName = new Map<string, PiAgentTool>();
    for (const tool of tools) {
      if (!validToolName(tool.name)) {
        throw new Error(
          `PI Agent tool names must be printable, trimmed, and at most ${MAX_TOOL_NAME_CHARS} characters.`,
        );
      }
      if (toolsByName.has(tool.name)) {
        throw new Error(`Duplicate PI Agent tool name: ${tool.name}`);
      }
      const policy = toolPolicy(tool);
      assertPiAgentToolApprovalPolicy(tool, policy.effect);
      toolsByName.set(tool.name, tool);
    }
    if (
      tools.some((tool) => tool.approval !== undefined) &&
      !options.toolApprovalHandler
    ) {
      throw new Error(
        'PI Agent tools with approval policies require toolApprovalHandler.',
      );
    }
    if (
      (options.requireTerminalTool ?? tools.some((tool) => tool.terminal === true)) &&
      !tools.some((tool) => tool.terminal === true)
    ) {
      throw new Error('PI Agent requires a terminal tool, but none is registered.');
    }
    this.options = options;
    this.tools = tools;
    this.toolsByName = toolsByName;
  }

  async run(
    request: PiAgentRunRequest,
    eventHandlers?: PiAgentEventHandler | PiAgentRunEventHandlers,
  ): Promise<PiAgentRunResult> {
    const runId = validateRunId(request.runId ?? randomUUID());
    const {
      createAssistantMessageEventStream,
      runAgentLoopContinue,
      validateToolArguments,
    } = await loadUpstreamPiRuntime();
    const startedAt = Date.now();
    const limits: PiAgentRunLimits = {
      maxTurns: positiveInteger(
        request.maxTurns ?? this.options.maxTurns,
        DEFAULT_MAX_TURNS,
        'maxTurns',
      ),
      maxTokens: positiveInteger(
        request.maxTokens ?? this.options.maxTokens,
        DEFAULT_MAX_TOKENS,
        'maxTokens',
      ),
      timeoutMs: positiveInteger(
        request.timeoutMs ?? this.options.timeoutMs,
        DEFAULT_TIMEOUT_MS,
        'timeoutMs',
      ),
    };
    const maxTokensPerTurn = positiveInteger(
      this.options.maxTokensPerTurn,
      limits.maxTokens,
      'maxTokensPerTurn',
    );
    const maxTotalToolCalls = positiveInteger(
      this.options.maxTotalToolCalls,
      DEFAULT_MAX_TOTAL_TOOL_CALLS,
      'maxTotalToolCalls',
    );
    const maxToolCallsPerTurn = positiveInteger(
      this.options.maxToolCallsPerTurn,
      DEFAULT_MAX_TOOL_CALLS_PER_TURN,
      'maxToolCallsPerTurn',
    );
    const maxTextCharsPerTurn = positiveInteger(
      this.options.maxTextCharsPerTurn,
      DEFAULT_MAX_TEXT_CHARS_PER_TURN,
      'maxTextCharsPerTurn',
    );
    const maxReasoningCharsPerTurn = positiveInteger(
      this.options.maxReasoningCharsPerTurn,
      DEFAULT_MAX_REASONING_CHARS_PER_TURN,
      'maxReasoningCharsPerTurn',
    );
    const maxToolArgumentChars = positiveInteger(
      this.options.maxToolArgumentChars,
      DEFAULT_MAX_TOOL_ARGUMENT_CHARS,
      'maxToolArgumentChars',
    );
    const preWriteReadOnlyTurnThreshold = positiveInteger(
      this.options.preWriteReadOnlyTurnThreshold,
      DEFAULT_PRE_WRITE_READ_ONLY_TURNS,
      'preWriteReadOnlyTurnThreshold',
    );
    const postWriteReadOnlyTurnThreshold = positiveInteger(
      this.options.postWriteReadOnlyTurnThreshold,
      DEFAULT_POST_WRITE_READ_ONLY_TURNS,
      'postWriteReadOnlyTurnThreshold',
    );
    const requireTerminalTool = this.options.requireTerminalTool ??
      this.tools.some((tool) => tool.terminal === true);
    const requireWorkspaceWriteBeforeTerminal =
      this.options.requireWorkspaceWriteBeforeTerminal ?? false;
    const handlers = normalizeHandlers(eventHandlers);
    const timeoutController = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      timeoutController.abort(
        new DOMException('PI Agent run timed out.', 'TimeoutError'),
      );
    }, limits.timeoutMs);
    timeout.unref?.();
    const signal = request.signal
      ? AbortSignal.any([request.signal, timeoutController.signal])
      : timeoutController.signal;

    let sequence = 0;
    let turn = 0;
    let totalToolCalls = 0;
    let toolCallsThisTurn = 0;
    let usage: PiAgentTokenUsage = { ...EMPTY_USAGE };
    let contextSnapshot: PiAgentContextSnapshot | undefined;
    let output = '';
    let successfulWorkspaceWrites = 0;
    let consecutiveReadOnlyTurns = 0;
    let readToolsDisabled = false;
    let stopStatus: PiAgentRunStatus | null = null;
    let stopError: PiAgentRunError | undefined;
    let terminalToolCall: PiAgentToolCall | undefined;
    let terminalResult: PiAgentToolResult | undefined;
    let finalMessages: AgentMessage[] = [];
    let preparedInputTokens = 0;
    let lastPromptHash: string | null = null;
    const progressOracle = new ProgressOracle({
      stallAfterConsecutiveNoProgressTurns:
        this.options.progressStallTurns ?? 2,
      initialState: createProgressOracleState(),
    });
    let turnEffects: PiAgentToolEffect[] = [];
    let turnProgressFingerprints: string[] = [];
    let successfulWorkspaceWritesThisTurn = 0;
    const abortRun = (
      status: PiAgentRunStatus,
      code: string,
      message: string,
      cause?: unknown,
    ): void => {
      stopStatus ??= status;
      stopError ??= runError(code, message, cause);
    };

    const emit = async (details: EventDetails): Promise<void> => {
      sequence += 1;
      const event = {
        ...details,
        runId,
        sequence,
        eventId: `${runId}:${sequence}`,
        timestamp: Date.now(),
      } as PiAgentEvent;
      if (handlers.durableSink) await handlers.durableSink(event);
      for (const observer of handlers.observers ?? []) {
        try {
          await observer(event);
        } catch (error) {
          try {
            await handlers.onObserverError?.(error, event);
          } catch {
            // Observer diagnostics cannot alter the governed run.
          }
        }
      }
    };

    const preparedCalls = new Map<string, PreparedPiToolCall>();
    const preparedCallKey = (toolCallId: string): string =>
      `${turn}\0${toolCallId}`;

    const piTools: AgentTool<TSchema, PiHostToolDetails>[] = this.tools.map(
      (tool): AgentTool<TSchema, PiHostToolDetails> => ({
        name: tool.name,
        label: tool.name,
        description: tool.description,
        parameters: structuredClone(tool.inputSchema) as TSchema,
        executionMode: 'sequential',
        execute: async (
          toolCallId,
          _params,
          toolSignal,
        ) => {
          const prepared = preparedCalls.get(preparedCallKey(toolCallId));
          if (!prepared || prepared.tool !== tool) {
            const error = new Error(
              `PI Agent tool "${tool.name}" reached execute without governed preparation.`,
            );
            abortRun(
              'failed',
              'TOOL_PREPARATION_MISSING',
              'PI Agent refused an unprepared tool execution.',
              error,
            );
            timeoutController.abort(error);
            throw error;
          }
          const {
            effectiveToolCall: toolCall,
            policy,
            approvalRejected,
          } = prepared;
          let durableStarted = false;
          try {
            if (approvalRejected) {
              const rejected = toolFailure(
                'TOOL_APPROVAL_REJECTED',
                `Execution of tool "${toolCall.name}" was rejected before the side effect started.`,
              );
              return {
                content: [{
                  type: 'text',
                  text: serializeToolResult(rejected),
                }],
                details: {
                  hostResult: rejected,
                  hostExecution: null,
                  approvalRejected: true,
                },
              };
            }

            const operationId = createPiAgentOperationId(runId, turn, toolCall);
            // This awaited durable boundary is the authorization for the
            // following side effect. No host tool code runs before it settles.
            await emit({
              type: 'tool_started',
              turn,
              toolCall,
              operationId,
              ...policy,
            });
            durableStarted = true;
            const execution = await executePiAgentTool({
              tool,
              toolCall,
              turn,
              runId,
              operationId,
              signal: toolSignal ?? signal,
              now: Date.now,
              commitWorkspaceMutation: request.commitWorkspaceMutation,
            });
            turnEffects.push(policy.effect);
            const fingerprint = createHash('sha256')
              .update(operationId)
              .update('\0')
              .update(serializeToolResult(execution.result))
              .digest('hex');
            turnProgressFingerprints.push(fingerprint);

            if (execution.result.ok) {
              if (policy.effect === 'workspace_write') {
                successfulWorkspaceWrites += 1;
                successfulWorkspaceWritesThisTurn += 1;
                readToolsDisabled = false;
                consecutiveReadOnlyTurns = 0;
              }
              await emit({
                type: 'tool_completed',
                turn,
                toolCall,
                operationId,
                ...policy,
                result: execution.result,
                terminal: execution.terminal,
                durationMs: execution.durationMs,
              });
              if (execution.terminal) {
                terminalToolCall = toolCall;
                terminalResult = execution.result;
              }
            } else {
              await emit({
                type: 'tool_failed',
                turn,
                toolCall,
                operationId,
                ...policy,
                result: execution.result,
                durationMs: execution.durationMs,
              });
              if (
                mutationOutcomeRequiresReconciliation(
                  policy.effect,
                  execution.result,
                )
              ) {
                const reconciliationError = new Error(
                  'A mutating PI Agent tool outcome requires reconciliation.',
                );
                abortRun(
                  timedOut ? 'timeout' : 'failed',
                  timedOut
                    ? 'TIMEOUT'
                    : 'MUTATION_RECONCILIATION_REQUIRED',
                  timedOut
                    ? 'PI Agent run timed out while a mutating tool outcome required reconciliation.'
                    : 'A mutating tool outcome is uncertain; PI Agent stopped before any further tool execution.',
                  reconciliationError,
                );
                timeoutController.abort(reconciliationError);
              }
            }
            return {
              content: [{
                type: 'text',
                text: serializeToolResult(execution.result),
              }],
              details: {
                hostResult: execution.result,
                hostExecution: execution,
                approvalRejected: false,
              },
              ...(execution.terminal ? { terminate: true } : {}),
            };
          } catch (error) {
            if (!stopStatus) {
              abortRun(
                'failed',
                durableStarted &&
                    policy.effect !== 'pure' &&
                    policy.effect !== 'read'
                  ? 'MUTATION_RECONCILIATION_REQUIRED'
                  : 'TOOL_PIPELINE_FAILED',
                durableStarted &&
                    policy.effect !== 'pure' &&
                    policy.effect !== 'read'
                  ? 'A mutating PI Agent tool started but its durable outcome could not be confirmed.'
                  : 'PI Agent tool preparation or durable event recording failed.',
                error,
              );
            }
            timeoutController.abort(error);
            throw error;
          }
        },
      }),
    );

    const providerStream: StreamFn = (
      _model,
      context,
      streamOptions,
    ): AssistantMessageEventStream => {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        let providerState: ProviderTurnState | undefined;
        try {
          let providerMessages = toPiAgentMessages(context);
          const toolDefinitions = (context.tools ?? []).map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: structuredClone(tool.parameters) as Record<string, unknown>,
          }));
          let preparedEstimate: number | undefined;
          let compactionApplied = false;
          const contextManager = this.options.contextManager as
            | Pick<PiAgentContextManager, 'prepare'>
            | undefined;
          if (contextManager) {
            const prepared = contextManager.prepare(
              providerMessages,
              toolDefinitions,
            );
            providerMessages = prepared.messages;
            preparedEstimate = prepared.estimate.preparedInputTokens;
            compactionApplied = prepared.compaction.applied;
            contextSnapshot = {
              schemaVersion: 1,
              runId,
              model: this.options.model,
              turn,
              observedAt: Date.now(),
              source: 'estimated',
              inputTokens: prepared.estimate.preparedInputTokens,
              inputBudgetTokens: prepared.estimate.inputBudgetTokens,
              contextWindowTokens: prepared.estimate.contextWindowTokens,
              reservedOutputTokens: prepared.estimate.reservedOutputTokens,
              compacted: compactionApplied,
            };
            if (prepared.compaction.applied) {
              await emit({
                type: 'context_compacted',
                turn,
                originalInputTokens: prepared.estimate.originalInputTokens,
                preparedInputTokens: prepared.estimate.preparedInputTokens,
                inputBudgetTokens: prepared.estimate.inputBudgetTokens,
                removedReasoningMessages:
                  prepared.compaction.removedReasoning.length,
                summarizedToolResults:
                  prepared.compaction.summarizedToolResults.length,
                droppedGroups: prepared.compaction.droppedGroups.length,
                ...(prepared.compaction.contextCapsule
                  ? {
                      contextCapsule:
                        prepared.compaction.contextCapsule,
                    }
                  : {}),
              });
            }
          }
          const serializedPrompt = JSON.stringify({
            messages: providerMessages,
            tools: toolDefinitions,
          });
          const promptHash = createHash('sha256')
            .update(serializedPrompt)
            .digest('hex');
          const toolHash = createHash('sha256')
            .update(JSON.stringify(toolDefinitions))
            .digest('hex');
          const systemHash = createHash('sha256')
            .update(
              providerMessages
                .filter((message) => message.role === 'system')
                .map((message) => message.content)
                .join('\n\n'),
            )
            .digest('hex');
          preparedEstimate ??= Math.max(
            1,
            Buffer.byteLength(serializedPrompt, 'utf8'),
          );
          preparedInputTokens += preparedEstimate;
          await emit({
            type: 'prompt_prepared',
            turn,
            ...(contextSnapshot ? { contextSnapshot } : {}),
            systemSha256: systemHash,
            messagesSha256: promptHash,
            toolsSha256: toolHash,
            messageCount: providerMessages.length,
            toolCount: toolDefinitions.length,
            requestUtf8Bytes: Buffer.byteLength(serializedPrompt, 'utf8'),
            longestCommonPrefixMessages: 0,
            longestCommonPrefixUtf8Bytes: 0,
            change: lastPromptHash === null
              ? 'first_request'
              : compactionApplied
                ? 'context_compaction'
                : 'append_only',
            toolSetChanged: false,
            compactionApplied,
            requestLocalControlSuffix: false,
          });
          lastPromptHash = promptHash;

          if (
            this.options.maxRunPreparedInputTokens !== undefined &&
            preparedInputTokens > this.options.maxRunPreparedInputTokens
          ) {
            abortRun(
              'max_tokens',
              'MAX_RUN_PREPARED_INPUT_TOKENS',
              'PI Agent exhausted the cumulative prepared-input budget.',
            );
            throw new Error(stopError?.message);
          }
          if (
            this.options.maxRunInputTokens !== undefined &&
            usage.inputTokens >= this.options.maxRunInputTokens
          ) {
            abortRun(
              'max_tokens',
              'MAX_RUN_INPUT_TOKENS',
              'PI Agent exhausted the cumulative input-token budget.',
            );
            throw new Error(stopError?.message);
          }
          if (
            this.options.maxRunCacheMissInputTokens !== undefined &&
            (usage.cacheMissInputTokens ?? usage.inputTokens) >=
              this.options.maxRunCacheMissInputTokens
          ) {
            abortRun(
              'max_tokens',
              'MAX_RUN_CACHE_MISS_INPUT_TOKENS',
              'PI Agent exhausted the cumulative cache-miss input-token budget.',
            );
            throw new Error(stopError?.message);
          }

          const combinedSignal = streamOptions?.signal
            ? AbortSignal.any([signal, streamOptions.signal])
            : signal;
          const providerRequest: PiAgentModelRequest = {
            model: this.options.model,
            messages: providerMessages,
            tools: toolDefinitions,
            toolChoice: request.reasoning?.enabled === true
              ? undefined
              : toolDefinitions.length
                ? 'auto'
                : undefined,
            maxTokens: Math.min(
              maxTokensPerTurn,
              Math.max(1, limits.maxTokens - usage.outputTokens),
            ),
            temperature: request.temperature,
            reasoning: request.reasoning,
            signal: combinedSignal,
            metadata: request.metadata,
          };
          const state: ProviderTurnState = {
            text: '',
            reasoning: '',
            usage: { ...EMPTY_USAGE },
            usageReceived: false,
            toolCalls: new Map(),
          };
          const partial: AssistantMessage = {
            role: 'assistant',
            content: [],
            api: 'quantpilot-provider',
            provider: this.options.provider.name,
            model: this.options.model,
            usage: { ...EMPTY_PI_USAGE, cost: { ...EMPTY_PI_USAGE.cost } },
            stopReason: 'stop',
            timestamp: Date.now(),
          };
          stream.push({ type: 'start', partial });
          providerState = state;

          for await (const modelEvent of this.options.provider.complete(
            providerRequest,
          )) {
            await this.consumeProviderEvent(modelEvent, turn, state, emit);
            if (modelEvent.type === 'text_delta') output += modelEvent.delta;
          }
          if (!state.usageReceived && state.finishReason) {
            state.usage = estimateUnreportedUsage(
              preparedEstimate,
              state.text,
              state.reasoning,
              state.toolCalls.size ? JSON.stringify([...state.toolCalls.values()]) : '',
            );
            state.usageReceived = true;
          }
          const message = providerMessage({
            request: providerRequest,
            providerName: this.options.provider.name,
            state,
          });
          if (
            message.stopReason === 'error' ||
            message.stopReason === 'aborted'
          ) {
            stream.push({
              type: 'error',
              reason: message.stopReason,
              error: message,
            });
          } else {
            stream.push({
              type: 'done',
              reason: message.stopReason,
              message,
            });
          }
        } catch (error) {
          const providerRequest: PiAgentModelRequest = {
            model: this.options.model,
            messages: toPiAgentMessages(context),
            signal,
          };
          const message = providerErrorMessage({
            request: providerRequest,
            providerName: this.options.provider.name,
            error,
            ...(providerState ? { usage: { ...providerState.usage, usageSource: 'partial' as const } } : {}),
          });
          stream.push({
            type: 'error',
            reason: message.stopReason === 'aborted' ? 'aborted' : 'error',
            error: message,
          });
        }
      })();
      return stream;
    };

    const piToolsByName = new Map(
      piTools.map((tool) => [tool.name, tool] as const),
    );

    const beforeToolCall = async (context: {
      assistantMessage: AssistantMessage;
      toolCall: ToolCall;
      args: unknown;
      context: AgentContext;
    }): Promise<BeforeToolCallResult | undefined> => {
      const tool = this.toolsByName.get(context.toolCall.name);
      const piTool = piToolsByName.get(context.toolCall.name);
      if (!tool || !piTool) {
        return {
          block: true,
          reason: `PI Agent tool "${context.toolCall.name}" is not registered.`,
        };
      }
      const policy = toolPolicy(tool);
      if (stopStatus) return { block: true, reason: stopError?.message };
      if (readToolsDisabled && policy.effect === 'read') {
        return {
          block: true,
          reason:
            'Read-only tools are disabled because the governed exploration budget is exhausted.',
        };
      }
      if (
        requireWorkspaceWriteBeforeTerminal &&
        successfulWorkspaceWrites === 0 &&
        tool?.terminal === true
      ) {
        abortRun(
          'failed',
          'WORKSPACE_WRITE_REQUIRED',
          'PI Agent must complete a governed workspace write before submit_result.',
        );
        return { block: true, reason: stopError?.message };
      }

      const approvalSignal = signal;
      try {
        if (!isRecord(context.args)) {
          throw new Error(
            `Validated arguments for PI Agent tool "${tool.name}" must be an object.`,
          );
        }
        const originalToolCall: PiAgentToolCall = {
          id: context.toolCall.id,
          name: context.toolCall.name,
          arguments: canonicalJson(context.args),
        };
        const approval = resolvePiAgentToolApproval({
          runId,
          turn,
          toolCall: originalToolCall,
          tool,
          effect: policy.effect,
          idempotency: policy.idempotency,
          handler: this.options.toolApprovalHandler!,
          signal: approvalSignal,
          now: Date.now,
        });
        let resolvedEvent: EventDetails | undefined;
        let approvalStep = await approval.next();
        while (!approvalStep.done) {
          if (approvalStep.value.type === 'tool_approval_resolved') {
            // The edited payload must pass the same PI schema before the
            // durable resolution boundary claims it is effective.
            resolvedEvent = approvalStep.value as EventDetails;
          } else {
            await emit(approvalStep.value as EventDetails);
          }
          approvalStep = await approval.next();
        }

        const approvalRejected = approvalStep.value.rejected;
        let effectiveToolCall = approvalStep.value.toolCall;
        if (!approvalRejected) {
          const editedArguments = parseProviderToolArguments(
            effectiveToolCall.arguments,
          );
          const validatedEffectiveArguments = validateToolArguments(
            piTool,
            {
              ...context.toolCall,
              arguments: editedArguments,
            },
          );
          if (!isRecord(validatedEffectiveArguments)) {
            throw new Error(
              `Approved arguments for PI Agent tool "${tool.name}" must be an object.`,
            );
          }
          effectiveToolCall = {
            ...effectiveToolCall,
            arguments: canonicalJson(validatedEffectiveArguments),
          };
        }
        if (resolvedEvent?.type === 'tool_approval_resolved') {
          await emit({
            ...resolvedEvent,
            effectiveInputSha256: createHash('sha256')
              .update(effectiveToolCall.arguments, 'utf8')
              .digest('hex'),
          } as EventDetails);
        }

        const key = preparedCallKey(context.toolCall.id);
        if (preparedCalls.has(key)) {
          throw new Error(
            `Duplicate PI Agent tool-call ID in turn ${turn}: ${context.toolCall.id}`,
          );
        }
        preparedCalls.set(key, {
          tool,
          piTool,
          policy,
          originalToolCall,
          effectiveToolCall,
          approvalRejected,
        });
        return undefined;
      } catch (error) {
        if (approvalSignal.aborted) {
          abortRun(
            timedOut ? 'timeout' : 'cancelled',
            timedOut ? 'TIMEOUT' : 'CANCELLED',
            timedOut
              ? 'PI Agent run timed out while awaiting tool approval.'
              : 'PI Agent run was cancelled while awaiting tool approval.',
            approvalSignal.reason,
          );
        } else {
          abortRun(
            'failed',
            'TOOL_APPROVAL_FAILED',
            'PI Agent tool approval or edited-input validation failed.',
            error,
          );
        }
        timeoutController.abort(error);
        return { block: true, reason: stopError?.message };
      }
    };

    const afterToolCall = async (context: {
      toolCall: ToolCall;
      result: { details: unknown; terminate?: boolean };
      isError: boolean;
    }): Promise<AfterToolCallResult | undefined> => {
      const details = hostToolDetails(context.result.details);
      preparedCalls.delete(preparedCallKey(context.toolCall.id));
      if (!details) return stopStatus ? { terminate: true } : undefined;
      return {
        isError: !details.hostResult.ok || details.approvalRejected,
        terminate:
          details.hostExecution?.terminal === true ||
          stopStatus !== null,
      };
    };

    const conversation = toPiConversation(request.messages);
    const context: AgentContext = {
      systemPrompt: conversation.systemPrompt,
      messages: conversation.messages,
      tools: piTools,
    };
    const config: AgentLoopConfig = {
      model: modelForPi(
        this.options.model,
        this.options.provider.name,
        maxTokensPerTurn,
        request.reasoning?.enabled === true,
      ),
      reasoning: thinkingLevel(request),
      convertToLlm: (messages) => messages.filter(isLlmMessage),
      toolExecution: 'sequential',
      beforeToolCall,
      afterToolCall,
      shouldStopAfterTurn: () => {
        if (terminalToolCall || stopStatus) return true;
        if (turn >= limits.maxTurns) {
          abortRun(
            'max_turns',
            'MAX_TURNS',
            `PI Agent reached its ${limits.maxTurns}-turn limit.`,
          );
          return true;
        }
        if (usage.outputTokens >= limits.maxTokens) {
          abortRun(
            'max_tokens',
            'MAX_TOKENS',
            'PI Agent exhausted the cumulative output-token budget.',
          );
          return true;
        }
        if (
          this.options.maxRunInputTokens !== undefined &&
          usage.inputTokens >= this.options.maxRunInputTokens
        ) {
          abortRun(
            'max_tokens',
            'MAX_RUN_INPUT_TOKENS',
            'PI Agent exhausted the cumulative input-token budget.',
          );
          return true;
        }
        if (
          this.options.maxRunCacheMissInputTokens !== undefined &&
          (usage.cacheMissInputTokens ?? usage.inputTokens) >=
            this.options.maxRunCacheMissInputTokens
        ) {
          abortRun(
            'max_tokens',
            'MAX_RUN_CACHE_MISS_INPUT_TOKENS',
            'PI Agent exhausted the cumulative cache-miss input-token budget.',
          );
          return true;
        }
        if (
          this.options.maxRunPreparedInputTokens !== undefined &&
          preparedInputTokens >= this.options.maxRunPreparedInputTokens
        ) {
          abortRun(
            'max_tokens',
            'MAX_RUN_PREPARED_INPUT_TOKENS',
            'PI Agent exhausted the cumulative prepared-input budget.',
          );
          return true;
        }
        return false;
      },
    };

    await emit({
      type: 'run_started',
      model: this.options.model,
      provider: `pi-agent/${this.options.provider.name}`,
      limits,
    });

    try {
      finalMessages = await runAgentLoopContinue(
        context,
        config,
        async (piEvent) => {
          switch (piEvent.type) {
            case 'turn_start':
              turn += 1;
              toolCallsThisTurn = 0;
              turnEffects = [];
              turnProgressFingerprints = [];
              successfulWorkspaceWritesThisTurn = 0;
              await emit({ type: 'turn_started', turn });
              break;
            case 'message_end':
              if (piEvent.message.role === 'assistant') {
                const projection = assistantProjection(piEvent.message);
                const turnUsage = usageFromPi(piEvent.message.usage);
                usage = addUsage(usage, turnUsage);
                await emit({
                  type: 'usage',
                  turn,
                  usage: turnUsage,
                  totalUsage: usage,
                  ...(contextSnapshot ? { contextSnapshot } : {}),
                });
                await emit({
                  type: 'assistant_message',
                  turn,
                  message: {
                    role: 'assistant',
                    content: projection.message.content,
                    ...(projection.message.toolCalls
                      ? { toolCalls: projection.message.toolCalls }
                      : {}),
                  },
                  finishReason: projection.finishReason,
                });
                const calls = piEvent.message.content.filter(
                  (item): item is ToolCall => item.type === 'toolCall',
                );
                toolCallsThisTurn = calls.length;
                totalToolCalls += calls.length;
                const textChars = piEvent.message.content
                  .filter((item) => item.type === 'text')
                  .reduce((total, item) => total + item.text.length, 0);
                const reasoningChars = piEvent.message.content
                  .filter((item) => item.type === 'thinking')
                  .reduce((total, item) => total + item.thinking.length, 0);
                const toolArgumentChars = calls.reduce(
                  (total, call) =>
                    total + canonicalJson(call.arguments).length,
                  0,
                );
                const uniqueToolCallIds = new Set(
                  calls.map((call) => call.id),
                );
                const terminalCalls = calls.filter(
                  (call) =>
                    this.toolsByName.get(call.name)?.terminal === true,
                );

                if (piEvent.message.stopReason === 'aborted') {
                  abortRun(
                    timedOut ? 'timeout' : 'cancelled',
                    timedOut ? 'TIMEOUT' : 'CANCELLED',
                    timedOut
                      ? 'PI Agent run timed out.'
                      : 'PI Agent run was cancelled.',
                    signal.reason,
                  );
                } else if (piEvent.message.stopReason === 'error') {
                  abortRun(
                    'failed',
                    'PROVIDER_ERROR',
                    piEvent.message.errorMessage ??
                      'PI Agent provider returned an error.',
                  );
                } else if (piEvent.message.stopReason === 'length') {
                  abortRun(
                    'max_tokens',
                    'MAX_TOKENS',
                    'PI Agent provider stopped at its output-token limit.',
                  );
                } else if (calls.length > 0 &&
                  piEvent.message.stopReason !== 'toolUse') {
                  abortRun(
                    'failed',
                    'UNEXPECTED_TOOL_CALLS',
                    `PI Agent received tool calls with stop reason "${piEvent.message.stopReason}".`,
                  );
                } else if (calls.length === 0 &&
                  piEvent.message.stopReason === 'toolUse') {
                  abortRun(
                    'failed',
                    'MISSING_TOOL_CALLS',
                    'PI Agent provider reported tool use without a tool call.',
                  );
                } else if (terminalCalls.length > 0 && calls.length !== 1) {
                  abortRun(
                    'failed',
                    'TERMINAL_TOOL_NOT_EXCLUSIVE',
                    'A terminal PI Agent tool call must be the only tool call in its turn.',
                  );
                } else if (calls.some((call) => !validToolCallId(call.id))) {
                  abortRun(
                    'failed',
                    'INVALID_TOOL_CALL_ID',
                    `PI Agent tool-call IDs must be printable, trimmed, and at most ${MAX_TOOL_CALL_ID_CHARS} characters.`,
                  );
                } else if (calls.some((call) => !validToolName(call.name))) {
                  abortRun(
                    'failed',
                    'INVALID_TOOL_NAME',
                    `PI Agent tool names must be printable, trimmed, and at most ${MAX_TOOL_NAME_CHARS} characters.`,
                  );
                } else if (uniqueToolCallIds.size !== calls.length) {
                  abortRun(
                    'failed',
                    'DUPLICATE_TOOL_CALL_ID',
                    'PI Agent received duplicate tool-call IDs in one turn.',
                  );
                } else if (toolCallsThisTurn > maxToolCallsPerTurn) {
                  abortRun(
                    'failed',
                    'MAX_TOOL_CALLS_PER_TURN',
                    `PI Agent exceeded the ${maxToolCallsPerTurn}-tool per-turn limit.`,
                  );
                } else if (totalToolCalls > maxTotalToolCalls) {
                  abortRun(
                    'failed',
                    'MAX_TOTAL_TOOL_CALLS',
                    `PI Agent exceeded the ${maxTotalToolCalls}-tool run limit.`,
                  );
                } else if (textChars > maxTextCharsPerTurn) {
                  abortRun(
                    'failed',
                    'MAX_TEXT_CHARS_PER_TURN',
                    `PI Agent exceeded the ${maxTextCharsPerTurn}-character text limit.`,
                  );
                } else if (reasoningChars > maxReasoningCharsPerTurn) {
                  abortRun(
                    'failed',
                    'MAX_REASONING_CHARS_PER_TURN',
                    `PI Agent exceeded the ${maxReasoningCharsPerTurn}-character reasoning limit.`,
                  );
                } else if (toolArgumentChars > maxToolArgumentChars) {
                  abortRun(
                    'failed',
                    'MAX_TOOL_ARGUMENT_CHARS',
                    `PI Agent exceeded the ${maxToolArgumentChars}-character tool-argument limit.`,
                  );
                } else if (usage.outputTokens >= limits.maxTokens) {
                  abortRun(
                    'max_tokens',
                    'MAX_TOKENS',
                    'PI Agent exhausted the output-token budget before tool execution.',
                  );
                }
              }
              break;
            case 'turn_end': {
              const readOnlyTurn =
                turnEffects.length > 0 &&
                turnEffects.every((effect) => effect === 'read');
              if (successfulWorkspaceWritesThisTurn > 0) {
                consecutiveReadOnlyTurns = 0;
              } else if (readOnlyTurn) {
                consecutiveReadOnlyTurns += 1;
              } else {
                consecutiveReadOnlyTurns = 0;
              }
              const threshold = successfulWorkspaceWrites === 0
                ? preWriteReadOnlyTurnThreshold
                : postWriteReadOnlyTurnThreshold;
              readToolsDisabled = consecutiveReadOnlyTurns >= threshold;
              const workspaceFingerprint = createHash('sha256')
                .update(String(successfulWorkspaceWrites))
                .update('\0')
                .update(turnProgressFingerprints.join(':'))
                .digest('hex');
              const decision = progressOracle.observe({
                trustedFactFingerprints: turnProgressFingerprints,
                workspaceFingerprint,
                toolObservationFingerprints: turnProgressFingerprints,
                successfulWorkspaceWrites:
                  successfulWorkspaceWritesThisTurn,
              });
              const safeDecision: PiAgentProgressOracleEventDecision = {
                progressed: decision.progressed,
                stalled: decision.stalled,
                consecutiveNoProgressTurns:
                  decision.consecutiveNoProgressTurns,
                progressSignals: [...decision.progressSignals],
                stallSignals: [...decision.stallSignals],
              };
              await emit({
                type: 'progress_evaluated',
                turn,
                progressOracle: progressOracle.snapshot(),
                decision: safeDecision,
              });
              break;
            }
            case 'agent_end':
              finalMessages = [...piEvent.messages];
              break;
            default:
              break;
          }
        },
        signal,
        providerStream,
      );
    } catch (error) {
      if (signal.aborted) {
        abortRun(
          timedOut ? 'timeout' : 'cancelled',
          timedOut ? 'TIMEOUT' : 'CANCELLED',
          timedOut
            ? 'PI Agent run timed out.'
            : 'PI Agent run was cancelled.',
          signal.reason,
        );
      } else if (!stopStatus) {
        abortRun(
          'failed',
          'RUN_FAILED',
          errorMessage(error),
          error,
        );
      }
    } finally {
      clearTimeout(timeout);
    }

    const status: PiAgentRunStatus = terminalToolCall
      ? 'completed'
      : stopStatus ??
        (requireTerminalTool ? 'stopped' : 'completed');
    const error = terminalToolCall
      ? undefined
      : stopError ??
        (requireTerminalTool
          ? runError(
              'TERMINAL_TOOL_REQUIRED',
              'PI Agent stopped without successfully calling the terminal tool.',
            )
          : undefined);
    const messages = toPiAgentMessages({
      systemPrompt: conversation.systemPrompt,
      messages: [
        ...conversation.messages,
        ...finalMessages,
      ].filter(isLlmMessage),
      tools: piTools,
    });
    const result: PiAgentRunResult = {
      runId,
      status,
      messages,
      output,
      turns: turn,
      usage,
      startedAt,
      ...(contextSnapshot ? { contextSnapshot } : {}),
      finishedAt: Date.now(),
      ...(terminalToolCall ? { terminalToolCall } : {}),
      ...(terminalResult ? { terminalResult } : {}),
      ...(error ? { error } : {}),
    };
    await emit({
      type: 'run_finished',
      result: {
        status: result.status,
        turns: result.turns,
        usage: result.usage,
        ...(result.contextSnapshot ? { contextSnapshot: result.contextSnapshot } : {}),
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
        ...(result.error
          ? {
              error: {
                code: result.error.code,
                message: `PI Agent run ended with ${result.error.code}.`,
              },
            }
          : {}),
      },
    });
    return result;
  }

  private async consumeProviderEvent(
    modelEvent: PiAgentModelEvent,
    turn: number,
    state: ProviderTurnState,
    emit: (details: EventDetails) => Promise<void>,
  ): Promise<void> {
    switch (modelEvent.type) {
      case 'provider_retry':
        await emit({
          type: 'provider_retry',
          turn,
          attempt: modelEvent.attempt,
          maxAttempts: modelEvent.maxAttempts,
          delayMs: modelEvent.delayMs,
          code: modelEvent.code,
          ...(modelEvent.status === undefined
            ? {}
            : { status: modelEvent.status }),
        });
        break;
      case 'response_start':
        state.responseId = modelEvent.responseId;
        state.responseModel = modelEvent.model;
        await emit({
          type: 'model_started',
          turn,
          responseId: modelEvent.responseId,
          model: modelEvent.model,
        });
        break;
      case 'text_delta':
        state.text += modelEvent.delta;
        await emit({
          type: 'text_delta',
          turn,
          delta: modelEvent.delta,
        });
        break;
      case 'reasoning_delta':
        state.reasoning += modelEvent.delta;
        break;
      case 'tool_call_delta': {
        const current = state.toolCalls.get(modelEvent.index) ?? {
          name: '',
          arguments: '',
        };
        if (modelEvent.id !== undefined) current.id = modelEvent.id;
        current.name += modelEvent.nameDelta ?? '';
        current.arguments += modelEvent.argumentsDelta ?? '';
        state.toolCalls.set(modelEvent.index, current);
        await emit({
          type: 'tool_call_delta',
          turn,
          index: modelEvent.index,
          ...(modelEvent.id === undefined ? {} : { id: modelEvent.id }),
          ...(modelEvent.nameDelta === undefined
            ? {}
            : { nameDelta: modelEvent.nameDelta }),
          ...(modelEvent.argumentsDelta === undefined
            ? {}
            : { argumentsDelta: modelEvent.argumentsDelta }),
        });
        break;
      }
      case 'usage':
        state.usage = modelEvent.usage;
        state.usageReceived = true;
        break;
      case 'finish':
        state.finishReason = modelEvent.reason;
        break;
    }
  }
}
