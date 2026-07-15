import { createHash } from 'node:crypto';

import { createMoAgentOperationId } from '../core/operation-id';
import type {
  MoAgentEvent,
  MoAgentTokenUsage,
  MoAgentToolCall,
  MoAgentToolEffect,
  MoAgentToolIdempotency,
  MoAgentToolResult,
} from '../types';
import { clonePublicRuntimeJson } from './policy';
import type { RuntimeJsonObject } from './types';

const EVENT_PROJECTION_VERSION = 1;
const MAX_AUDIT_DEPTH = 24;
const MAX_AUDIT_NODES = 50_000;
const SAFE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:-]*$/;
const FRAMEWORK_OPERATION_ID_PATTERN = /^op_[a-f0-9]{64}$/;
const TARGET_KEYS = [
  'path',
  'filePath',
  'target',
  'query',
  'symbol',
  'url',
  'artifact',
] as const;

export interface Utf8Audit extends RuntimeJsonObject {
  utf8Bytes: number;
  sha256: string;
}

interface UnknownValueAudit extends Utf8Audit {
  kind: string;
  nodes: number;
  objectKeys: number;
  arrayItems: number;
  truncated: boolean;
}

/** Exact SHA-256 digest for strings (UTF-8 encoded) or bytes. */
export function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Audit a string without retaining any portion of its contents. The byte count
 * makes empty/missing values and encoding changes observable without disclosure.
 */
export function auditUtf8(value: string): Utf8Audit {
  return {
    utf8Bytes: Buffer.byteLength(value, 'utf8'),
    sha256: sha256(value),
  };
}

function rootKind(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (value instanceof Uint8Array) return 'bytes';
  if (value instanceof Date) return 'date';
  return typeof value;
}

/**
 * Produce a bounded, deterministic structural digest without calling getters,
 * `toJSON`, or otherwise copying unrestricted tool output into a durable value.
 */
function auditUnknown(value: unknown): UnknownValueAudit {
  const digest = createHash('sha256');
  const seen = new WeakSet<object>();
  let nodes = 0;
  let utf8Bytes = 0;
  let objectKeys = 0;
  let arrayItems = 0;
  let truncated = false;

  const writeString = (candidate: string): void => {
    const bytes = Buffer.byteLength(candidate, 'utf8');
    utf8Bytes += bytes;
    digest.update(String(bytes)).update(':').update(candidate);
  };

  const visit = (candidate: unknown, depth: number): void => {
    if (depth > MAX_AUDIT_DEPTH || nodes >= MAX_AUDIT_NODES) {
      truncated = true;
      digest.update('!truncated;');
      return;
    }
    nodes += 1;

    if (candidate === null) {
      digest.update('null;');
      return;
    }

    switch (typeof candidate) {
      case 'string':
        digest.update('string:');
        writeString(candidate);
        digest.update(';');
        return;
      case 'boolean':
        digest.update(candidate ? 'boolean:true;' : 'boolean:false;');
        return;
      case 'number':
        digest.update(`number:${Number.isNaN(candidate) ? 'NaN' : String(candidate)};`);
        return;
      case 'bigint':
        digest.update(`bigint:${candidate.toString()};`);
        return;
      case 'undefined':
        digest.update('undefined;');
        return;
      case 'symbol':
        digest.update('symbol:');
        writeString(candidate.description ?? '');
        digest.update(';');
        return;
      case 'function':
        digest.update('function;');
        return;
      case 'object':
        break;
    }

    if (seen.has(candidate)) {
      digest.update('reference;');
      return;
    }
    seen.add(candidate);

    if (candidate instanceof Uint8Array) {
      digest.update(`bytes:${candidate.byteLength}:`).update(candidate).update(';');
      return;
    }

    if (candidate instanceof Date) {
      const time = candidate.getTime();
      digest.update(`date:${Number.isNaN(time) ? 'invalid' : candidate.toISOString()};`);
      return;
    }

    if (Array.isArray(candidate)) {
      arrayItems += candidate.length;
      digest.update(`array:${candidate.length}:[`);
      for (const item of candidate) visit(item, depth + 1);
      digest.update('];');
      return;
    }

    const descriptors = Object.getOwnPropertyDescriptors(candidate);
    const keys = Object.keys(descriptors).sort();
    objectKeys += keys.length;
    digest.update(`object:${keys.length}:{`);
    for (const key of keys) {
      digest.update('key:');
      writeString(key);
      const descriptor = descriptors[key];
      if (descriptor && 'value' in descriptor) {
        digest.update('=');
        visit(descriptor.value, depth + 1);
      } else {
        // Accessors are deliberately never invoked by the durable projector.
        digest.update('=accessor;');
      }
    }
    digest.update('};');
  };

  visit(value, 0);
  return {
    kind: rootKind(value),
    utf8Bytes,
    sha256: digest.digest('hex'),
    nodes,
    objectKeys,
    arrayItems,
    truncated,
  };
}

function safeName(value: string, fallbackPrefix: string): string {
  if (value.length <= 96 && SAFE_NAME_PATTERN.test(value)) return value;
  return `${fallbackPrefix}_${sha256(value).slice(0, 24)}`;
}

function safeOperationId(event: {
  runId: string;
  turn: number;
  operationId: string;
  toolCall: Pick<MoAgentToolCall, 'id' | 'name'>;
}): string {
  return FRAMEWORK_OPERATION_ID_PATTERN.test(event.operationId)
    ? event.operationId
    : createMoAgentOperationId(event.runId, event.turn, event.toolCall);
}

function auditToolIdentity(toolCall: MoAgentToolCall): RuntimeJsonObject {
  return {
    id: auditUtf8(toolCall.id),
    name: auditUtf8(toolCall.name),
  };
}

function parseInputShape(argumentsJson: string): {
  validJson: boolean;
  topLevelKind: string;
  topLevelKeyCount: number;
  value?: unknown;
} {
  try {
    const value: unknown = JSON.parse(argumentsJson);
    const isPlainObject =
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype;
    return {
      validJson: true,
      topLevelKind: rootKind(value),
      topLevelKeyCount: isPlainObject ? Object.keys(value).length : 0,
      value,
    };
  } catch {
    return { validJson: false, topLevelKind: 'invalid_json', topLevelKeyCount: 0 };
  }
}

function auditToolInput(argumentsJson: string): RuntimeJsonObject {
  const shape = parseInputShape(argumentsJson);
  return {
    ...auditUtf8(argumentsJson),
    validJson: shape.validJson,
    topLevelKind: shape.topLevelKind,
    topLevelKeyCount: shape.topLevelKeyCount,
  };
}

function auditToolTarget(argumentsJson: string): RuntimeJsonObject | null {
  const shape = parseInputShape(argumentsJson);
  if (
    !shape.validJson ||
    shape.value === null ||
    typeof shape.value !== 'object' ||
    Array.isArray(shape.value)
  ) {
    return null;
  }

  const value = shape.value as Record<string, unknown>;
  for (const key of TARGET_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const target = value[key];
    const audit = typeof target === 'string' ? auditUtf8(target) : auditUnknown(target);
    return { field: key, valueAudit: audit };
  }
  return null;
}

function projectUsage(usage: MoAgentTokenUsage): RuntimeJsonObject {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.totalTokens,
    ...(usage.cachedInputTokens === undefined
      ? {}
      : { cachedInputTokens: usage.cachedInputTokens }),
    ...(usage.cacheMissInputTokens === undefined
      ? {}
      : { cacheMissInputTokens: usage.cacheMissInputTokens }),
    ...(usage.reasoningTokens === undefined
      ? {}
      : { reasoningTokens: usage.reasoningTokens }),
    ...(usage.usageSource === undefined
      ? {}
      : { usageSource: usage.usageSource }),
  };
}

function projectToolBase(event: {
  runId: string;
  turn: number;
  operationId: string;
  effect: MoAgentToolEffect;
  idempotency: MoAgentToolIdempotency;
  toolCall: MoAgentToolCall;
}): RuntimeJsonObject {
  const target = auditToolTarget(event.toolCall.arguments);
  return {
    schemaVersion: EVENT_PROJECTION_VERSION,
    turn: event.turn,
    operationId: safeOperationId(event),
    toolName: safeName(event.toolCall.name, 'tool'),
    toolNameAudit: auditUtf8(event.toolCall.name),
    effect: event.effect,
    idempotency: event.idempotency,
    inputAudit: auditToolInput(event.toolCall.arguments),
    ...(target === null ? {} : { target }),
  };
}

function projectSuccessResult(
  result: Extract<MoAgentToolResult, { ok: true }>
): RuntimeJsonObject {
  return {
    ok: true,
    dataAudit: auditUnknown(result.data),
    ...(result.content === undefined ? {} : { textAudit: auditUtf8(result.content) }),
    ...(result.metadata === undefined ? {} : { metadataAudit: auditUnknown(result.metadata) }),
  };
}

function safeErrorCode(value: string): string {
  return safeName(value, 'error');
}

function projectFailureResult(
  result: Extract<MoAgentToolResult, { ok: false }>
): RuntimeJsonObject {
  return {
    ok: false,
    errorCode: safeErrorCode(result.error.code),
    errorTextAudit: auditUtf8(result.error.message),
    ...(result.error.details === undefined
      ? {}
      : { detailsAudit: auditUnknown(result.error.details) }),
    ...(result.content === undefined ? {} : { textAudit: auditUtf8(result.content) }),
    ...(result.metadata === undefined ? {} : { metadataAudit: auditUnknown(result.metadata) }),
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled MoAgent event type: ${String((value as { type?: unknown }).type)}`);
}

/**
 * Convert an in-memory event to the only JSON shape allowed in the durable
 * event ledger. High-volume deltas are intentionally omitted; final text and
 * unrestricted tool values are represented by audit digests only.
 */
export function projectMoAgentEvent(event: MoAgentEvent): RuntimeJsonObject | null {
  let projected: RuntimeJsonObject;

  switch (event.type) {
    case 'text_delta':
    case 'tool_call_delta':
      return null;
    case 'run_started':
      projected = {
        schemaVersion: EVENT_PROJECTION_VERSION,
        provider: safeName(event.provider, 'provider'),
        model: safeName(event.model, 'model'),
        limits: {
          maxTurns: event.limits.maxTurns,
          maxTokens: event.limits.maxTokens,
          timeoutMs: event.limits.timeoutMs,
        },
      };
      break;
    case 'turn_started':
      projected = { schemaVersion: EVENT_PROJECTION_VERSION, turn: event.turn };
      break;
    case 'provider_retry':
      projected = {
        schemaVersion: EVENT_PROJECTION_VERSION,
        turn: event.turn,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        delayMs: event.delayMs,
        code: safeErrorCode(event.code),
        ...(event.status === undefined ? {} : { status: event.status }),
      };
      break;
    case 'model_started':
      projected = {
        schemaVersion: EVENT_PROJECTION_VERSION,
        turn: event.turn,
        responseIdAudit: auditUtf8(event.responseId),
        model: safeName(event.model, 'model'),
      };
      break;
    case 'usage':
      projected = {
        schemaVersion: EVENT_PROJECTION_VERSION,
        turn: event.turn,
        usage: projectUsage(event.usage),
        totalUsage: projectUsage(event.totalUsage),
      };
      break;
    case 'assistant_message': {
      const text = event.message.content ?? '';
      const toolCalls = event.message.toolCalls ?? [];
      projected = {
        schemaVersion: EVENT_PROJECTION_VERSION,
        turn: event.turn,
        finishReason: event.finishReason,
        hasText: event.message.content !== null,
        textAudit: auditUtf8(text),
        toolCallCount: toolCalls.length,
        toolCalls: toolCalls.map(auditToolIdentity),
      };
      break;
    }
    case 'context_compacted':
      projected = {
        schemaVersion: EVENT_PROJECTION_VERSION,
        turn: event.turn,
        originalInputTokens: event.originalInputTokens,
        preparedInputTokens: event.preparedInputTokens,
        inputBudgetTokens: event.inputBudgetTokens,
        removedReasoningMessages: event.removedReasoningMessages,
        summarizedToolResults: event.summarizedToolResults,
        droppedGroups: event.droppedGroups,
        ...(event.contextCapsule
          ? {
              contextCapsule: {
                applied: event.contextCapsule.applied,
                version: event.contextCapsule.version,
                phase: event.contextCapsule.phase,
                sha256: event.contextCapsule.sha256,
                serializedUtf8Bytes: event.contextCapsule.serializedUtf8Bytes,
                coveredToolCalls: event.contextCapsule.coveredToolCalls,
                targetReferences: event.contextCapsule.targetReferences,
                operationTombstones: event.contextCapsule.operationTombstones,
                rolledUpOperationTombstones:
                  event.contextCapsule.rolledUpOperationTombstones,
                frameworkOutcomeTombstones:
                  event.contextCapsule.frameworkOutcomeTombstones,
                artifactReceipts: event.contextCapsule.artifactReceipts,
                readReceipts: event.contextCapsule.readReceipts,
                successfulWrites: event.contextCapsule.successfulWrites,
                remainingFailures: event.contextCapsule.remainingFailures,
                invalidatedReadReceipts: event.contextCapsule.invalidatedReadReceipts,
                replacedToolCallClusters: event.contextCapsule.replacedToolCallClusters,
                replacedMessages: event.contextCapsule.replacedMessages,
                replacedPreviousCapsule: event.contextCapsule.replacedPreviousCapsule,
              },
            }
          : {}),
      };
      break;
    case 'prompt_prepared':
      projected = {
        schemaVersion: EVENT_PROJECTION_VERSION,
        turn: event.turn,
        systemSha256: event.systemSha256,
        messagesSha256: event.messagesSha256,
        toolsSha256: event.toolsSha256,
        messageCount: event.messageCount,
        toolCount: event.toolCount,
        requestUtf8Bytes: event.requestUtf8Bytes,
        longestCommonPrefixMessages: event.longestCommonPrefixMessages,
        longestCommonPrefixUtf8Bytes: event.longestCommonPrefixUtf8Bytes,
        change: event.change,
        toolSetChanged: event.toolSetChanged,
        compactionApplied: event.compactionApplied,
        requestLocalControlSuffix: event.requestLocalControlSuffix,
      };
      break;
    case 'convergence_prompt':
      projected = {
        schemaVersion: EVENT_PROJECTION_VERSION,
        turn: event.turn,
        reasons: [...event.reasons],
        remainingTurns: event.remainingTurns,
        remainingToolCalls: event.remainingToolCalls,
        successfulWorkspaceWrites: event.successfulWorkspaceWrites,
        consecutiveReadOnlyTurns: event.consecutiveReadOnlyTurns,
      };
      break;
    case 'tool_started':
      projected = projectToolBase(event);
      break;
    case 'tool_completed':
      projected = {
        ...projectToolBase(event),
        durationMs: event.durationMs,
        terminal: event.terminal,
        resultAudit: projectSuccessResult(event.result),
      };
      break;
    case 'tool_failed':
      projected = {
        ...projectToolBase(event),
        durationMs: event.durationMs,
        errorCode: safeErrorCode(event.result.error.code),
        resultAudit: projectFailureResult(event.result),
      };
      break;
    case 'run_finished':
      projected = {
        schemaVersion: EVENT_PROJECTION_VERSION,
        status: event.result.status,
        turns: event.result.turns,
        usage: projectUsage(event.result.usage),
        startedAt: event.result.startedAt,
        finishedAt: event.result.finishedAt,
        ...(event.result.error === undefined
          ? {}
          : { errorCode: safeErrorCode(event.result.error.code) }),
      };
      break;
    default:
      return assertNever(event);
  }

  return clonePublicRuntimeJson(projected, `MoAgent ${event.type} durable projection`);
}
