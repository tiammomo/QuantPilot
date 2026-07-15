import { createHash } from 'node:crypto';

import type {
  MoAgentAssistantMessage,
  MoAgentMessage,
  MoAgentToolDefinition,
  MoAgentToolMessage,
} from '../types';
import {
  assertTrustedContextCapsule,
  isTrustedContextCapsuleMessage,
  MoAgentContextCapsuleError,
  MoAgentContextCapsuleSession,
  type MoAgentTrustedContextCapsuleCheckpoint,
  type MoAgentTrustedContextCapsuleTelemetry,
} from './trusted-context-capsule';

const SUMMARY_VERSION = 1 as const;
const TOOL_RESULT_PREVIEW_MAX_BYTES = 512;
const TOKEN_ESTIMATE_SAFETY_FACTOR = 1.1;

export type MoAgentTokenEstimator = (
  messages: readonly MoAgentMessage[],
  tools: readonly MoAgentToolDefinition[]
) => number;

export interface MoAgentContextManagerOptions {
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
  tokenEstimator?: MoAgentTokenEstimator;
  /** Hard UTF-8 budget for the deterministic, framework-owned phase capsule. */
  contextCapsuleMaxUtf8Bytes?: number;
}

export interface MoAgentContextEstimate {
  contextWindowTokens: number;
  reservedOutputTokens: number;
  maxInputTokens: number;
  inputBudgetTokens: number;
  originalInputTokens: number;
  preparedInputTokens: number;
}

export interface MoAgentRemovedReasoningMetadata {
  messageIndex: number;
  originalUtf8Bytes: number;
}

export interface MoAgentSummarizedToolResultMetadata {
  messageIndex: number;
  toolCallId: string;
  sha256: string;
  originalUtf8Bytes: number;
  summaryUtf8Bytes: number;
  retainedPreviewUtf8Bytes: number;
}

export interface MoAgentDroppedContextGroupMetadata {
  kind: 'message' | 'tool_call_cluster';
  messageIndexes: number[];
  roles: MoAgentMessage['role'][];
}

export interface MoAgentContextCompactionMetadata {
  applied: boolean;
  removedReasoning: MoAgentRemovedReasoningMetadata[];
  summarizedToolResults: MoAgentSummarizedToolResultMetadata[];
  droppedGroups: MoAgentDroppedContextGroupMetadata[];
  protectedContext: {
    systemMessageIndexes: number[];
    latestUserMessageIndex?: number;
    activeToolClusterMessageIndexes: number[];
  };
  contextCapsule?: MoAgentTrustedContextCapsuleTelemetry;
}

export interface MoAgentContextPreparationOptions {
  contextCapsule?: MoAgentTrustedContextCapsuleCheckpoint | null;
}

export interface MoAgentPreparedContext {
  messages: MoAgentMessage[];
  estimate: MoAgentContextEstimate;
  compaction: MoAgentContextCompactionMetadata;
}

export type MoAgentContextErrorCode =
  | 'CONTEXT_BUDGET_EXCEEDED'
  | 'CONTEXT_CAPSULE_BUDGET_EXCEEDED'
  | 'INVALID_CONTEXT_CONFIGURATION'
  | 'INVALID_CONTEXT_CAPSULE'
  | 'INVALID_CONTEXT_HISTORY'
  | 'TOKEN_ESTIMATION_FAILED';

export class MoAgentContextError extends Error {
  readonly code: MoAgentContextErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: MoAgentContextErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {}
  ) {
    super(message);
    this.name = 'MoAgentContextError';
    this.code = code;
    this.details = details;
  }
}

interface ContextEntry {
  originalIndex: number;
  message: MoAgentMessage;
}

interface ContextGroup {
  kind: 'message' | 'tool_call_cluster';
  entries: ContextEntry[];
  protected: boolean;
  activeToolCluster: boolean;
}

interface ToolResultSummaryPayload {
  $moagent: {
    kind: 'tool_result_truncation';
    version: typeof SUMMARY_VERSION;
    generatedBy: 'MoAgentContextManager';
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

function cloneMessage(message: MoAgentMessage): MoAgentMessage {
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

function cloneMessages(messages: readonly MoAgentMessage[]): MoAgentMessage[] {
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
export const conservativeMoAgentTokenEstimator: MoAgentTokenEstimator = (messages, tools) => {
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
    MoAgentContextManagerOptions,
    'contextWindowTokens' | 'reservedOutputTokens' | 'maxInputTokens'
  >,
  value: number,
  minimum: number
): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new MoAgentContextError(
      'INVALID_CONTEXT_CONFIGURATION',
      `${name} must be a safe integer greater than or equal to ${minimum}`,
      { field: name, value, minimum }
    );
  }
}

function buildGroups(messages: readonly MoAgentMessage[]): ContextGroup[] {
  const groups: ContextGroup[] = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === 'tool') {
      throw new MoAgentContextError(
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
        throw new MoAgentContextError(
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
      const toolMessage = messages[index] as MoAgentToolMessage;
      if (!callIds.has(toolMessage.toolCallId) || resultIds.has(toolMessage.toolCallId)) {
        throw new MoAgentContextError(
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
      throw new MoAgentContextError(
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

function flattenGroups(groups: readonly ContextGroup[]): MoAgentMessage[] {
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
      candidate.$moagent?.kind === 'tool_result_truncation' &&
      candidate.$moagent.version === SUMMARY_VERSION &&
      candidate.$moagent.generatedBy === 'MoAgentContextManager'
    );
  } catch {
    return false;
  }
}

function summarizeToolResult(message: MoAgentToolMessage): {
  message: MoAgentToolMessage;
  metadata: Omit<MoAgentSummarizedToolResultMetadata, 'messageIndex'>;
} {
  const originalUtf8Bytes = utf8Bytes(message.content);
  const preview = truncateUtf8(message.content, TOOL_RESULT_PREVIEW_MAX_BYTES);
  const retainedPreviewUtf8Bytes = utf8Bytes(preview);
  const sha256 = createHash('sha256').update(message.content, 'utf8').digest('hex');
  const payload: ToolResultSummaryPayload = {
    $moagent: {
      kind: 'tool_result_truncation',
      version: SUMMARY_VERSION,
      generatedBy: 'MoAgentContextManager',
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
  checkpoint: MoAgentTrustedContextCapsuleCheckpoint,
): {
  groups: ContextGroup[];
  telemetry?: MoAgentTrustedContextCapsuleTelemetry;
  replacedGroups: ContextGroup[];
} {
  try {
    assertTrustedContextCapsule(checkpoint);
  } catch (error) {
    if (error instanceof MoAgentContextCapsuleError) {
      throw new MoAgentContextError(error.code, error.message, error.details);
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
  const previousCapsuleAlreadyCurrent = previousCapsules.length === 1 &&
    previousCapsules[0].entries[0].message.role === 'system' &&
    previousCapsules[0].entries[0].message.content === checkpoint.content;
  if (replaceableToolGroups.length === 0 && previousCapsuleAlreadyCurrent) {
    return { groups, replacedGroups: [] };
  }
  // Even when only the active DeepSeek protocol atom is covered, install the
  // framework capsule without replacing that atom. This permits its untrusted
  // result body to be summarized under pressure while the trusted outcome fact
  // remains available.

  const removed = new Set([...previousCapsules, ...replaceableToolGroups]);
  const retained = groups.filter((group) => !removed.has(group));
  const capsuleGroup: ContextGroup = {
    kind: 'message',
    entries: [{
      originalIndex: Math.max(
        -1,
        ...groups.flatMap((group) => originalIndexes(group)),
      ) + 1,
      message: { role: 'system', content: checkpoint.content },
    }],
    protected: true,
    activeToolCluster: false,
  };
  const firstNonSystem = retained.findIndex((group) =>
    group.entries.some((entry) => entry.message.role !== 'system'));
  const insertionIndex = firstNonSystem < 0 ? retained.length : firstNonSystem;
  retained.splice(insertionIndex, 0, capsuleGroup);
  const replacedMessages = [...previousCapsules, ...replaceableToolGroups]
    .reduce((count, group) => count + group.entries.length, 0);

  return {
    groups: retained,
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

export class MoAgentContextManager {
  private readonly options: Readonly<MoAgentContextManagerOptions>;
  private readonly tokenEstimator: MoAgentTokenEstimator;
  private readonly inputBudgetTokens: number;

  constructor(options: MoAgentContextManagerOptions) {
    requireInteger('contextWindowTokens', options.contextWindowTokens, 1);
    requireInteger('reservedOutputTokens', options.reservedOutputTokens, 0);
    requireInteger('maxInputTokens', options.maxInputTokens, 1);
    if (
      options.contextCapsuleMaxUtf8Bytes !== undefined &&
      (!Number.isSafeInteger(options.contextCapsuleMaxUtf8Bytes) ||
        options.contextCapsuleMaxUtf8Bytes < 256)
    ) {
      throw new MoAgentContextError(
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
      throw new MoAgentContextError(
        'INVALID_CONTEXT_CONFIGURATION',
        'reservedOutputTokens must be smaller than contextWindowTokens',
        {
          contextWindowTokens: options.contextWindowTokens,
          reservedOutputTokens: options.reservedOutputTokens,
        }
      );
    }

    this.options = { ...options };
    this.tokenEstimator = options.tokenEstimator ?? conservativeMoAgentTokenEstimator;
    this.inputBudgetTokens = Math.min(
      options.maxInputTokens,
      options.contextWindowTokens - options.reservedOutputTokens
    );
  }

  createCapsuleSession(): MoAgentContextCapsuleSession {
    return new MoAgentContextCapsuleSession({
      maxUtf8Bytes: this.options.contextCapsuleMaxUtf8Bytes,
    });
  }

  prepare(
    messages: readonly MoAgentMessage[],
    tools: readonly MoAgentToolDefinition[] = [],
    preparation: MoAgentContextPreparationOptions = {},
  ): MoAgentPreparedContext {
    let groups = buildGroups(messages);
    const originalInputTokens = this.estimate(flattenGroups(groups), tools);
    let contextCapsuleTelemetry: MoAgentTrustedContextCapsuleTelemetry | undefined;
    const capsuleReplacedGroups: ContextGroup[] = [];
    if (preparation.contextCapsule) {
      const applied = applyTrustedContextCapsule(groups, preparation.contextCapsule);
      groups = applied.groups;
      contextCapsuleTelemetry = applied.telemetry;
      capsuleReplacedGroups.push(...applied.replacedGroups);
    }
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
    const removedReasoning: MoAgentRemovedReasoningMetadata[] = [];
    const summarizedToolResults: MoAgentSummarizedToolResultMetadata[] = [];
    const droppedGroups: MoAgentDroppedContextGroupMetadata[] = capsuleReplacedGroups.map(
      (group) => ({
        kind: group.kind,
        messageIndexes: originalIndexes(group),
        roles: group.entries.map((entry) => entry.message.role),
      }),
    );
    preparedInputTokens = this.estimate(flattenGroups(groups), tools);

    if (preparedInputTokens > this.inputBudgetTokens) {
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
          entry.message = withoutReasoning as MoAgentAssistantMessage;
          removedReasoning.push({ messageIndex: entry.originalIndex, originalUtf8Bytes });
          preparedInputTokens = this.estimate(flattenGroups(groups), tools);
          if (preparedInputTokens <= this.inputBudgetTokens) break reasoning;
        }
      }
    }

    if (preparedInputTokens > this.inputBudgetTokens) {
      outer: for (const group of groups) {
        if (group.protected || group.kind !== 'tool_call_cluster') continue;
        for (const entry of group.entries) {
          if (entry.message.role !== 'tool' || isToolResultSummary(entry.message.content)) continue;
          const originalMessage = entry.message;
          const summary = summarizeToolResult(originalMessage);
          entry.message = summary.message;
          const candidateTokens = this.estimate(flattenGroups(groups), tools);
          if (candidateTokens < preparedInputTokens) {
            preparedInputTokens = candidateTokens;
            summarizedToolResults.push({ messageIndex: entry.originalIndex, ...summary.metadata });
          } else {
            entry.message = originalMessage;
          }
          if (preparedInputTokens <= this.inputBudgetTokens) break outer;
        }
      }
    }

    if (preparedInputTokens > this.inputBudgetTokens) {
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
        preparedInputTokens = this.estimate(
          flattenGroups([...retained, ...groups.slice(groupIndex + 1)]),
          tools
        );
        if (preparedInputTokens <= this.inputBudgetTokens) {
          retained.push(...groups.slice(groupIndex + 1));
          groups = retained;
          resolved = true;
          break;
        }
      }
      if (!resolved) {
        groups = retained;
        preparedInputTokens = this.estimate(flattenGroups(groups), tools);
      }
    }

    if (preparedInputTokens > this.inputBudgetTokens && activeToolGroup) {
      // A provider requires one result for every call in a parallel tool-call
      // cluster. Keep the assistant call and every adjacent result message,
      // but allow the largest result bodies to become deterministic summaries
      // as a last resort. This preserves protocol atomicity while preventing a
      // single active fan-out from making all prior compaction ineffective.
      const activeResults = activeToolGroup.entries
        .filter(
          (entry): entry is ContextEntry & { message: MoAgentToolMessage } =>
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
        const candidateTokens = this.estimate(flattenGroups(groups), tools);
        if (candidateTokens < preparedInputTokens) {
          preparedInputTokens = candidateTokens;
          summarizedToolResults.push({ messageIndex: entry.originalIndex, ...summary.metadata });
        } else {
          entry.message = originalMessage;
        }
        if (preparedInputTokens <= this.inputBudgetTokens) break;
      }
    }

    const preparedMessages = flattenGroups(groups);
    preparedInputTokens = this.estimate(preparedMessages, tools);
    const compaction: MoAgentContextCompactionMetadata = {
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
    const estimate: MoAgentContextEstimate = {
      contextWindowTokens: this.options.contextWindowTokens,
      reservedOutputTokens: this.options.reservedOutputTokens,
      maxInputTokens: this.options.maxInputTokens,
      inputBudgetTokens: this.inputBudgetTokens,
      originalInputTokens,
      preparedInputTokens,
    };

    if (preparedInputTokens > this.inputBudgetTokens) {
      const protectedMessages = groups
        .filter((group) => group.protected)
        .flatMap((group) => group.entries.map((entry) => entry.message));
      throw new MoAgentContextError(
        'CONTEXT_BUDGET_EXCEEDED',
        `Prepared context requires ${preparedInputTokens} estimated tokens but the input budget is ${this.inputBudgetTokens}`,
        {
          ...estimate,
          requiredReductionTokens: preparedInputTokens - this.inputBudgetTokens,
          protectedInputTokens: this.estimate(protectedMessages, tools),
          compaction,
        }
      );
    }

    return { messages: cloneMessages(preparedMessages), estimate, compaction };
  }

  private estimate(
    messages: readonly MoAgentMessage[],
    tools: readonly MoAgentToolDefinition[]
  ): number {
    let estimate: number;
    try {
      estimate = this.tokenEstimator(messages, tools);
    } catch (error) {
      throw new MoAgentContextError(
        'TOKEN_ESTIMATION_FAILED',
        'MoAgent context token estimator failed',
        { cause: error instanceof Error ? error.message : String(error) }
      );
    }
    if (!Number.isFinite(estimate) || estimate < 0) {
      throw new MoAgentContextError(
        'TOKEN_ESTIMATION_FAILED',
        'MoAgent context token estimator must return a finite non-negative number',
        { estimate }
      );
    }
    return Math.ceil(estimate);
  }
}
