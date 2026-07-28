import { createHash } from 'node:crypto';

import type {
  PiAgentAssistantMessage,
  PiAgentMessage,
  PiAgentToolDefinition,
  PiAgentToolMessage,
} from '../types';
import {
  assertTrustedContextCapsule,
  isTrustedContextCapsuleMessage,
  PiAgentContextCapsuleError,
  PiAgentContextCapsuleSession,
  type PiAgentTrustedContextCapsuleCheckpoint,
  type PiAgentTrustedContextCapsuleTelemetry,
} from './trusted-context-capsule';

const SUMMARY_VERSION = 1 as const;
const TOOL_RESULT_PREVIEW_MAX_BYTES = 512;
const TOKEN_ESTIMATE_SAFETY_FACTOR = 1.1;

export type PiAgentTokenEstimator = (
  messages: readonly PiAgentMessage[],
  tools: readonly PiAgentToolDefinition[]
) => number;

export interface PiAgentContextManagerOptions {
  /** Total input and output context capacity advertised by the model. */
  contextWindowTokens: number;
  /** Capacity kept unavailable to input so the model can finish its response. */
  reservedOutputTokens: number;
  /** Product-level cap for messages plus tool definitions. */
  maxInputTokens: number;
  /**
   * Provider-specific tokenizers can be injected here. The default uses a
   * conservative multilingual heuristic when the provider tokenizer is not
   * available.
   */
  tokenEstimator?: PiAgentTokenEstimator;
  /** Hard UTF-8 budget for the deterministic, framework-owned phase capsule. */
  contextCapsuleMaxUtf8Bytes?: number;
}

export interface PiAgentContextEstimate {
  contextWindowTokens: number;
  reservedOutputTokens: number;
  maxInputTokens: number;
  inputBudgetTokens: number;
  originalInputTokens: number;
  preparedInputTokens: number;
}

export interface PiAgentRemovedReasoningMetadata {
  messageIndex: number;
  originalUtf8Bytes: number;
}

export interface PiAgentSummarizedToolResultMetadata {
  messageIndex: number;
  toolCallId: string;
  sha256: string;
  originalUtf8Bytes: number;
  summaryUtf8Bytes: number;
  retainedPreviewUtf8Bytes: number;
}

export interface PiAgentDroppedContextGroupMetadata {
  kind: 'message' | 'tool_call_cluster';
  messageIndexes: number[];
  roles: PiAgentMessage['role'][];
}

export interface PiAgentContextCompactionMetadata {
  applied: boolean;
  removedReasoning: PiAgentRemovedReasoningMetadata[];
  summarizedToolResults: PiAgentSummarizedToolResultMetadata[];
  droppedGroups: PiAgentDroppedContextGroupMetadata[];
  protectedContext: {
    systemMessageIndexes: number[];
    latestUserMessageIndex?: number;
    activeToolClusterMessageIndexes: number[];
  };
  contextCapsule?: PiAgentTrustedContextCapsuleTelemetry;
}

export interface PiAgentContextPreparationOptions {
  contextCapsule?: PiAgentTrustedContextCapsuleCheckpoint | null;
  /**
   * Exact framework-owned suffix messages for this provider request. They are
   * included in token accounting and never persisted in canonical history.
   */
  requestLocalMessages?: readonly PiAgentMessage[];
  /** Suppress the capsule's legacy standalone suffix when it is already wrapped. */
  emitContextCapsuleRequestLocalMessage?: boolean;
  /** Optional per-turn tightening of the manager's configured input budget. */
  inputBudgetTokens?: number;
}

export interface PiAgentPreparedContext {
  /**
   * Canonical history that may be retained by the run engine. Framework-owned
   * request-local controls deliberately stay outside this array so changing a
   * checkpoint never mutates the provider's stable system prefix.
   */
  messages: PiAgentMessage[];
  /** Framework-generated suffixes to append only to the current provider request. */
  requestLocalMessages: PiAgentMessage[];
  estimate: PiAgentContextEstimate;
  compaction: PiAgentContextCompactionMetadata;
}

export type PiAgentContextErrorCode =
  | 'CONTEXT_BUDGET_EXCEEDED'
  | 'CONTEXT_CAPSULE_BUDGET_EXCEEDED'
  | 'INVALID_CONTEXT_CONFIGURATION'
  | 'INVALID_CONTEXT_CAPSULE'
  | 'INVALID_CONTEXT_HISTORY'
  | 'TOKEN_ESTIMATION_FAILED';

export class PiAgentContextError extends Error {
  readonly code: PiAgentContextErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: PiAgentContextErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {}
  ) {
    super(message);
    this.name = 'PiAgentContextError';
    this.code = code;
    this.details = details;
  }
}

interface ContextEntry {
  originalIndex: number;
  message: PiAgentMessage;
}

interface ContextGroup {
  kind: 'message' | 'tool_call_cluster';
  entries: ContextEntry[];
  protected: boolean;
  activeToolCluster: boolean;
}

interface ToolResultSummaryPayload {
  $piAgent: {
    kind: 'tool_result_truncation';
    version: typeof SUMMARY_VERSION;
    generatedBy: 'PiAgentContextManager';
    toolCallId: string;
    toolName?: string;
    digest: {
      algorithm: 'SHA-256';
      hex: string;
    };
    originalUtf8Bytes: number;
    retainedPreviewUtf8Bytes: number;
    truncated: true;
    previewTrust: 'untrusted_tool_output';
    preview: string;
  };
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function cloneMessage(message: PiAgentMessage): PiAgentMessage {
  switch (message.role) {
    case 'system':
      return { role: 'system', content: message.content };
    case 'user':
      return { role: 'user', content: message.content };
    case 'assistant':
      return {
        role: 'assistant',
        content: message.content,
        ...(message.reasoningContent !== undefined
          ? { reasoningContent: message.reasoningContent }
          : {}),
        ...(message.toolCalls
          ? { toolCalls: message.toolCalls.map((toolCall) => ({ ...toolCall })) }
          : {}),
      };
    case 'tool':
      return {
        role: 'tool',
        toolCallId: message.toolCallId,
        content: message.content,
        ...(message.name !== undefined ? { name: message.name } : {}),
      };
  }
}

function cloneMessages(messages: readonly PiAgentMessage[]): PiAgentMessage[] {
  return messages.map(cloneMessage);
}

function estimatedSerializedTokens(value: string): number {
  let estimate = 0;
  let asciiWordRun = 0;

  const flushAsciiWordRun = () => {
    if (asciiWordRun === 0) return;
    // Ordinary Latin words and numbers are commonly encoded at roughly
    // 3-4 characters/token. Long uninterrupted runs are more likely to be
    // hashes, identifiers, minified data, or other high-entropy text, so they
    // receive a substantially higher charge.
    estimate += asciiWordRun >= 32
      ? Math.ceil(asciiWordRun * 0.75)
      : Math.ceil(asciiWordRun / 3);
    asciiWordRun = 0;
  };

  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint < 128 &&
      ((codePoint >= 48 && codePoint <= 57) ||
        (codePoint >= 65 && codePoint <= 90) ||
        (codePoint >= 97 && codePoint <= 122) ||
        character === '_')
    ) {
      asciiWordRun += 1;
      continue;
    }

    flushAsciiWordRun();
    if (codePoint < 128) {
      // JSON punctuation is often merged, but charging half a token each is a
      // useful safety margin. Whitespace is encoded more efficiently.
      estimate += /\s/.test(character) ? 0.25 : 0.5;
    } else {
      // CJK text is commonly close to one token/code point. UTF-8 bytes / 2
      // charges 1-2 tokens for multilingual scalars and remains conservative
      // for emoji and uncommon characters.
      estimate += utf8Bytes(character) / 2;
    }
  }
  flushAsciiWordRun();
  return estimate;
}

/**
 * Conservative fallback for DeepSeek-compatible chat inputs when an exact
 * provider tokenizer is unavailable. It accounts for multilingual text,
 * high-entropy runs, JSON framing, and provider-side message/tool envelopes
 * without treating each UTF-8 byte as a complete token.
 */
export const conservativePiAgentTokenEstimator: PiAgentTokenEstimator = (messages, tools) => {
  const serialized = JSON.stringify({ messages, tools });
  const toolCallCount = messages.reduce(
    (count, message) => count + (message.role === 'assistant' ? (message.toolCalls?.length ?? 0) : 0),
    0
  );
  return Math.ceil(
    (
      estimatedSerializedTokens(serialized) +
        64 +
        messages.length * 8 +
        tools.length * 12 +
        toolCallCount * 12
    ) * TOKEN_ESTIMATE_SAFETY_FACTOR
  );
};

function requireInteger(
  name: keyof Pick<
    PiAgentContextManagerOptions,
    'contextWindowTokens' | 'reservedOutputTokens' | 'maxInputTokens'
  >,
  value: number,
  minimum: number
): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new PiAgentContextError(
      'INVALID_CONTEXT_CONFIGURATION',
      `${name} must be a safe integer greater than or equal to ${minimum}`,
      { field: name, value, minimum }
    );
  }
}

function buildGroups(messages: readonly PiAgentMessage[]): ContextGroup[] {
  const groups: ContextGroup[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === 'tool') {
      throw new PiAgentContextError(
        'INVALID_CONTEXT_HISTORY',
        `Tool result at message ${index} is not adjacent to an assistant tool-call message`,
        { messageIndex: index, toolCallId: message.toolCallId, reason: 'orphan_tool_result' }
      );
    }

    if (message.role !== 'assistant' || !message.toolCalls?.length) {
      groups.push({
        kind: 'message',
        entries: [{ originalIndex: index, message: cloneMessage(message) }],
        protected: false,
        activeToolCluster: false,
      });
      continue;
    }

    const callIds = new Set<string>();
    for (const toolCall of message.toolCalls) {
      if (!toolCall.id || callIds.has(toolCall.id)) {
        throw new PiAgentContextError(
          'INVALID_CONTEXT_HISTORY',
          `Assistant tool-call cluster at message ${index} contains an empty or duplicate call ID`,
          { messageIndex: index, toolCallId: toolCall.id, reason: 'invalid_tool_call_id' }
        );
      }
      callIds.add(toolCall.id);
    }

    const entries: ContextEntry[] = [{ originalIndex: index, message: cloneMessage(message) }];
    const resultIds = new Set<string>();
    while (index + 1 < messages.length && messages[index + 1].role === 'tool') {
      index += 1;
      const toolMessage = messages[index] as PiAgentToolMessage;
      if (!callIds.has(toolMessage.toolCallId) || resultIds.has(toolMessage.toolCallId)) {
        throw new PiAgentContextError(
          'INVALID_CONTEXT_HISTORY',
          `Tool result at message ${index} does not uniquely match the preceding assistant cluster`,
          {
            messageIndex: index,
            toolCallId: toolMessage.toolCallId,
            reason: callIds.has(toolMessage.toolCallId)
              ? 'duplicate_tool_result'
              : 'unknown_tool_call_id',
          }
        );
      }
      resultIds.add(toolMessage.toolCallId);
      entries.push({ originalIndex: index, message: cloneMessage(toolMessage) });
    }

    const missingResultIds = [...callIds].filter((callId) => !resultIds.has(callId));
    if (missingResultIds.length > 0) {
      throw new PiAgentContextError(
        'INVALID_CONTEXT_HISTORY',
        `Assistant tool-call cluster at message ${entries[0].originalIndex} is missing tool results`,
        {
          messageIndex: entries[0].originalIndex,
          missingToolCallIds: missingResultIds,
          reason: 'missing_tool_results',
        }
      );
    }

    groups.push({
      kind: 'tool_call_cluster',
      entries,
      protected: false,
      activeToolCluster: false,
    });
  }

  return groups;
}

function flattenGroups(groups: readonly ContextGroup[]): PiAgentMessage[] {
  return groups.flatMap((group) => group.entries.map((entry) => entry.message));
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength <= maxBytes) return value;

  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (let end = maxBytes; end >= Math.max(0, maxBytes - 3); end -= 1) {
    try {
      return decoder.decode(encoded.slice(0, end));
    } catch {
      // A UTF-8 scalar can span at most four bytes; try the previous boundary.
    }
  }
  return '';
}

function isToolResultSummary(content: string): boolean {
  try {
    const candidate = JSON.parse(content) as Partial<ToolResultSummaryPayload>;
    return (
      candidate.$piAgent?.kind === 'tool_result_truncation' &&
      candidate.$piAgent.version === SUMMARY_VERSION &&
      candidate.$piAgent.generatedBy === 'PiAgentContextManager'
    );
  } catch {
    return false;
  }
}

function summarizeToolResult(message: PiAgentToolMessage): {
  message: PiAgentToolMessage;
  metadata: Omit<PiAgentSummarizedToolResultMetadata, 'messageIndex'>;
} {
  const originalUtf8Bytes = utf8Bytes(message.content);
  const preview = truncateUtf8(message.content, TOOL_RESULT_PREVIEW_MAX_BYTES);
  const retainedPreviewUtf8Bytes = utf8Bytes(preview);
  const sha256 = createHash('sha256').update(message.content, 'utf8').digest('hex');
  const payload: ToolResultSummaryPayload = {
    $piAgent: {
      kind: 'tool_result_truncation',
      version: SUMMARY_VERSION,
      generatedBy: 'PiAgentContextManager',
      toolCallId: message.toolCallId,
      ...(message.name !== undefined ? { toolName: message.name } : {}),
      digest: { algorithm: 'SHA-256', hex: sha256 },
      originalUtf8Bytes,
      retainedPreviewUtf8Bytes,
      truncated: true,
      previewTrust: 'untrusted_tool_output',
      preview,
    },
  };
  const content = JSON.stringify(payload);

  return {
    message: { ...message, content },
    metadata: {
      toolCallId: message.toolCallId,
      sha256,
      originalUtf8Bytes,
      summaryUtf8Bytes: utf8Bytes(content),
      retainedPreviewUtf8Bytes,
    },
  };
}

function originalIndexes(group: ContextGroup): number[] {
  return group.entries.map((entry) => entry.originalIndex);
}

function contextCapsuleGroup(group: ContextGroup): boolean {
  return group.kind === 'message' && group.entries.length === 1 &&
    group.entries[0].message.role === 'system' &&
    isTrustedContextCapsuleMessage(group.entries[0].message.content);
}

function toolCallIds(group: ContextGroup): string[] {
  if (group.kind !== 'tool_call_cluster') return [];
  const assistant = group.entries[0]?.message;
  return assistant?.role === 'assistant'
    ? (assistant.toolCalls ?? []).map((toolCall) => toolCall.id)
    : [];
}

function applyTrustedContextCapsule(
  groups: ContextGroup[],
  checkpoint: PiAgentTrustedContextCapsuleCheckpoint,
): {
  groups: ContextGroup[];
  requestLocalMessage: PiAgentMessage;
  telemetry?: PiAgentTrustedContextCapsuleTelemetry;
  replacedGroups: ContextGroup[];
} {
  try {
    assertTrustedContextCapsule(checkpoint);
  } catch (error) {
    if (error instanceof PiAgentContextCapsuleError) {
      throw new PiAgentContextError(error.code, error.message, error.details);
    }
    throw error;
  }
  const activeToolGroup = [...groups]
    .reverse()
    .find((group) => group.kind === 'tool_call_cluster');
  const coveredToolCallIds = new Set(checkpoint.coveredToolCallIds);
  const previousCapsules = groups.filter(contextCapsuleGroup);
  const replaceableToolGroups = groups.filter((group) => {
    if (group === activeToolGroup || group.kind !== 'tool_call_cluster') return false;
    const callIds = toolCallIds(group);
    return callIds.length > 0 && callIds.every((callId) => coveredToolCallIds.has(callId));
  });
  // Historical v1 runs persisted the capsule as a leading system message.
  // Remove that legacy representation while preserving its telemetry. New
  // checkpoints are request-local suffixes and are never retained in canonical
  // history, so a changing checkpoint cannot invalidate the system prefix.
  const removed = new Set([...previousCapsules, ...replaceableToolGroups]);
  const retained = groups.filter((group) => !removed.has(group));
  const replacedMessages = [...previousCapsules, ...replaceableToolGroups]
    .reduce((count, group) => count + group.entries.length, 0);

  return {
    groups: retained,
    requestLocalMessage: { role: 'user', content: checkpoint.content },
    replacedGroups: replaceableToolGroups,
    telemetry: {
      applied: true,
      ...checkpoint.telemetry,
      replacedToolCallClusters: replaceableToolGroups.length,
      replacedMessages,
      replacedPreviousCapsule: previousCapsules.length > 0,
    },
  };
}

export class PiAgentContextManager {
  private readonly options: Readonly<PiAgentContextManagerOptions>;
  private readonly tokenEstimator: PiAgentTokenEstimator;
  private readonly inputBudgetTokens: number;

  constructor(options: PiAgentContextManagerOptions) {
    requireInteger('contextWindowTokens', options.contextWindowTokens, 1);
    requireInteger('reservedOutputTokens', options.reservedOutputTokens, 0);
    requireInteger('maxInputTokens', options.maxInputTokens, 1);
    if (
      options.contextCapsuleMaxUtf8Bytes !== undefined &&
      (!Number.isSafeInteger(options.contextCapsuleMaxUtf8Bytes) ||
        options.contextCapsuleMaxUtf8Bytes < 256)
    ) {
      throw new PiAgentContextError(
        'INVALID_CONTEXT_CONFIGURATION',
        'contextCapsuleMaxUtf8Bytes must be a safe integer greater than or equal to 256',
        {
          field: 'contextCapsuleMaxUtf8Bytes',
          value: options.contextCapsuleMaxUtf8Bytes,
          minimum: 256,
        },
      );
    }
    if (options.reservedOutputTokens >= options.contextWindowTokens) {
      throw new PiAgentContextError(
        'INVALID_CONTEXT_CONFIGURATION',
        'reservedOutputTokens must be smaller than contextWindowTokens',
        {
          contextWindowTokens: options.contextWindowTokens,
          reservedOutputTokens: options.reservedOutputTokens,
        }
      );
    }

    this.options = { ...options };
    this.tokenEstimator = options.tokenEstimator ?? conservativePiAgentTokenEstimator;
    this.inputBudgetTokens = Math.min(
      options.maxInputTokens,
      options.contextWindowTokens - options.reservedOutputTokens
    );
  }

  createCapsuleSession(): PiAgentContextCapsuleSession {
    return new PiAgentContextCapsuleSession({
      maxUtf8Bytes: this.options.contextCapsuleMaxUtf8Bytes,
    });
  }

  prepare(
    messages: readonly PiAgentMessage[],
    tools: readonly PiAgentToolDefinition[] = [],
    preparation: PiAgentContextPreparationOptions = {},
  ): PiAgentPreparedContext {
    if (
      preparation.inputBudgetTokens !== undefined &&
      (!Number.isSafeInteger(preparation.inputBudgetTokens) || preparation.inputBudgetTokens <= 0)
    ) {
      throw new PiAgentContextError(
        'INVALID_CONTEXT_CONFIGURATION',
        'inputBudgetTokens must be a positive safe integer when provided',
        { field: 'inputBudgetTokens', value: preparation.inputBudgetTokens },
      );
    }
    const inputBudgetTokens = Math.min(
      this.inputBudgetTokens,
      preparation.inputBudgetTokens ?? this.inputBudgetTokens,
    );
    let groups = buildGroups(messages);
    const requestLocalMessages = cloneMessages(preparation.requestLocalMessages ?? []);
    let contextCapsuleTelemetry: PiAgentTrustedContextCapsuleTelemetry | undefined;
    const capsuleReplacedGroups: ContextGroup[] = [];
    if (preparation.contextCapsule) {
      const applied = applyTrustedContextCapsule(groups, preparation.contextCapsule);
      groups = applied.groups;
      if (preparation.emitContextCapsuleRequestLocalMessage !== false) {
        requestLocalMessages.push(applied.requestLocalMessage);
      }
      contextCapsuleTelemetry = applied.telemetry;
      capsuleReplacedGroups.push(...applied.replacedGroups);
    }
    const estimateGroups = (candidateGroups: readonly ContextGroup[]): number =>
      this.estimate([...flattenGroups(candidateGroups), ...requestLocalMessages], tools);
    const originalInputTokens = this.estimate(
      [...messages.map(cloneMessage), ...requestLocalMessages],
      tools,
    );
    const systemMessageIndexes = groups.flatMap((group) =>
      group.entries
        .filter((entry) => entry.message.role === 'system')
        .map((entry) => entry.originalIndex)
    );
    const latestUserMessageIndex = [...groups]
      .reverse()
      .flatMap((group) => [...group.entries].reverse())
      .find((entry) => entry.message.role === 'user')?.originalIndex;
    const activeToolGroup = [...groups]
      .reverse()
      .find((group) => group.kind === 'tool_call_cluster');
    for (const group of groups) {
      const containsSystem = group.entries.some((entry) => entry.message.role === 'system');
      const containsLatestUser = group.entries.some(
        (entry) => entry.originalIndex === latestUserMessageIndex
      );
      group.activeToolCluster = group === activeToolGroup;
      group.protected = containsSystem || containsLatestUser || group.activeToolCluster;
    }

    const activeToolClusterMessageIndexes = activeToolGroup ? originalIndexes(activeToolGroup) : [];
    let preparedInputTokens = originalInputTokens;
    const removedReasoning: PiAgentRemovedReasoningMetadata[] = [];
    const summarizedToolResults: PiAgentSummarizedToolResultMetadata[] = [];
    const droppedGroups: PiAgentDroppedContextGroupMetadata[] = capsuleReplacedGroups.map(
      (group) => ({
        kind: group.kind,
        messageIndexes: originalIndexes(group),
        roles: group.entries.map((entry) => entry.message.role),
      }),
    );
    preparedInputTokens = estimateGroups(groups);

    if (preparedInputTokens > inputBudgetTokens) {
      reasoning: for (const group of groups) {
        // DeepSeek thinking-mode replays reasoning_content with tool_calls.
        // Never split that provider protocol atom: retained tool clusters keep
        // their assistant reasoning, old or new.
        if (group.kind === 'tool_call_cluster') continue;
        for (const entry of group.entries) {
          if (entry.message.role !== 'assistant' || entry.message.reasoningContent === undefined) {
            continue;
          }
          const originalUtf8Bytes = utf8Bytes(entry.message.reasoningContent);
          const { reasoningContent: _removed, ...withoutReasoning } = entry.message;
          entry.message = withoutReasoning as PiAgentAssistantMessage;
          removedReasoning.push({ messageIndex: entry.originalIndex, originalUtf8Bytes });
          preparedInputTokens = estimateGroups(groups);
          if (preparedInputTokens <= inputBudgetTokens) break reasoning;
        }
      }
    }

    if (preparedInputTokens > inputBudgetTokens) {
      outer: for (const group of groups) {
        if (group.protected || group.kind !== 'tool_call_cluster') continue;
        for (const entry of group.entries) {
          if (entry.message.role !== 'tool' || isToolResultSummary(entry.message.content)) continue;
          const originalMessage = entry.message;
          const summary = summarizeToolResult(originalMessage);
          entry.message = summary.message;
          const candidateTokens = estimateGroups(groups);
          if (candidateTokens < preparedInputTokens) {
            preparedInputTokens = candidateTokens;
            summarizedToolResults.push({ messageIndex: entry.originalIndex, ...summary.metadata });
          } else {
            entry.message = originalMessage;
          }
          if (preparedInputTokens <= inputBudgetTokens) break outer;
        }
      }
    }

    if (preparedInputTokens > inputBudgetTokens) {
      const retained: ContextGroup[] = [];
      let resolved = false;
      for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
        const group = groups[groupIndex];
        if (group.protected) {
          retained.push(group);
          continue;
        }

        droppedGroups.push({
          kind: group.kind,
          messageIndexes: originalIndexes(group),
          roles: group.entries.map((entry) => entry.message.role),
        });
        preparedInputTokens = estimateGroups([
          ...retained,
          ...groups.slice(groupIndex + 1),
        ]);
        if (preparedInputTokens <= inputBudgetTokens) {
          retained.push(...groups.slice(groupIndex + 1));
          groups = retained;
          resolved = true;
          break;
        }
      }
      if (!resolved) {
        groups = retained;
        preparedInputTokens = estimateGroups(groups);
      }
    }

    if (preparedInputTokens > inputBudgetTokens && activeToolGroup) {
      // A provider requires one result for every call in a parallel tool-call
      // cluster. Keep the assistant call and every adjacent result message,
      // but allow the largest result bodies to become deterministic summaries
      // as a last resort. This preserves protocol atomicity while preventing a
      // single active fan-out from making all prior compaction ineffective.
      const activeResults = activeToolGroup.entries
        .filter(
          (entry): entry is ContextEntry & { message: PiAgentToolMessage } =>
            entry.message.role === 'tool' &&
            !isToolResultSummary(entry.message.content)
        )
        .sort((left, right) => {
          const byteDifference = utf8Bytes(right.message.content) - utf8Bytes(left.message.content);
          return byteDifference || left.originalIndex - right.originalIndex;
        });

      for (const entry of activeResults) {
        const originalMessage = entry.message;
        const summary = summarizeToolResult(originalMessage);
        entry.message = summary.message;
        const candidateTokens = estimateGroups(groups);
        if (candidateTokens < preparedInputTokens) {
          preparedInputTokens = candidateTokens;
          summarizedToolResults.push({ messageIndex: entry.originalIndex, ...summary.metadata });
        } else {
          entry.message = originalMessage;
        }
        if (preparedInputTokens <= inputBudgetTokens) break;
      }
    }

    const preparedMessages = flattenGroups(groups);
    preparedInputTokens = this.estimate(
      [...preparedMessages, ...requestLocalMessages],
      tools,
    );
    const compaction: PiAgentContextCompactionMetadata = {
      applied:
        contextCapsuleTelemetry?.applied === true ||
        removedReasoning.length > 0 ||
        summarizedToolResults.length > 0 ||
        droppedGroups.length > 0,
      removedReasoning,
      summarizedToolResults,
      droppedGroups,
      protectedContext: {
        systemMessageIndexes,
        ...(latestUserMessageIndex !== undefined ? { latestUserMessageIndex } : {}),
        activeToolClusterMessageIndexes,
      },
      ...(contextCapsuleTelemetry ? { contextCapsule: contextCapsuleTelemetry } : {}),
    };
    const estimate: PiAgentContextEstimate = {
      contextWindowTokens: this.options.contextWindowTokens,
      reservedOutputTokens: this.options.reservedOutputTokens,
      maxInputTokens: this.options.maxInputTokens,
      inputBudgetTokens,
      originalInputTokens,
      preparedInputTokens,
    };

    if (preparedInputTokens > inputBudgetTokens) {
      const protectedMessages = groups
        .filter((group) => group.protected)
        .flatMap((group) => group.entries.map((entry) => entry.message));
      throw new PiAgentContextError(
        'CONTEXT_BUDGET_EXCEEDED',
        `Prepared context requires ${preparedInputTokens} estimated tokens but the input budget is ${inputBudgetTokens}`,
        {
          ...estimate,
          requiredReductionTokens: preparedInputTokens - inputBudgetTokens,
          protectedInputTokens: this.estimate(
            [...protectedMessages, ...requestLocalMessages],
            tools,
          ),
          compaction,
        }
      );
    }

    return {
      messages: cloneMessages(preparedMessages),
      requestLocalMessages: cloneMessages(requestLocalMessages),
      estimate,
      compaction,
    };
  }

  private estimate(
    messages: readonly PiAgentMessage[],
    tools: readonly PiAgentToolDefinition[]
  ): number {
    let estimate: number;
    try {
      estimate = this.tokenEstimator(messages, tools);
    } catch (error) {
      throw new PiAgentContextError(
        'TOKEN_ESTIMATION_FAILED',
        'PI Agent context token estimator failed',
        { cause: error instanceof Error ? error.message : String(error) }
      );
    }
    if (!Number.isFinite(estimate) || estimate < 0) {
      throw new PiAgentContextError(
        'TOKEN_ESTIMATION_FAILED',
        'PI Agent context token estimator must return a finite non-negative number',
        { estimate }
      );
    }
    return Math.ceil(estimate);
  }
}
