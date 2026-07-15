import { AgentRuntimeRepositoryError } from './errors';
import type {
  AgentCheckpointBoundary,
  AgentRunStatus,
  AgentToolEffect,
  AgentToolExecutionStatus,
  AgentToolIdempotency,
  RuntimeJson,
  RuntimeJsonObject,
} from './types';
import {
  AGENT_RUN_STATUSES,
  CHECKPOINT_BOUNDARIES,
  TOOL_EFFECTS,
  TOOL_EXECUTION_STATUSES,
  TOOL_IDEMPOTENCY_MODES,
} from './types';

const MAX_JSON_DEPTH = 24;
const MAX_JSON_NODES = 20_000;
const MAX_JSON_KEY_CHARS = 160;
const MAX_JSON_STRING_BYTES = 512 * 1024;
const MAX_OPAQUE_STATE_BYTES = 512 * 1024;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/@=-]*$/;

const FORBIDDEN_PUBLIC_KEYS = new Set([
  'reasoning',
  'reasoningcontent',
  'chainofthought',
  'internalthoughts',
  'systemprompt',
  'messages',
  'rawproviderresponse',
  'rawrequest',
  'rawresponse',
  'rawcause',
  'stack',
  'authorization',
  'cookie',
  'setcookie',
  'apikey',
  'secret',
  'accesstoken',
  'refreshtoken',
]);

const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function invalid(message: string): never {
  throw new AgentRuntimeRepositoryError('INVALID_STATE', message);
}

export function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalid(`${label} must be a non-negative safe integer.`);
  }
}

export function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    invalid(`${label} must be a positive safe integer.`);
  }
}

export function assertBoundedIdentifier(
  value: string,
  label: string,
  maxLength = 256
): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maxLength ||
    !SAFE_IDENTIFIER_PATTERN.test(value)
  ) {
    invalid(`${label} must be a non-empty bounded ASCII identifier.`);
  }
}

export function assertHash(value: string, label: string): void {
  assertBoundedIdentifier(value, label, 512);
}

export function assertUuid(value: string, label: string): void {
  if (!UUID_PATTERN.test(value)) {
    invalid(`${label} must be a UUID.`);
  }
}

export function assertFutureDate(value: Date, now: Date, label: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime()) || value <= now) {
    invalid(`${label} must be a valid date in the future.`);
  }
}

export function assertValidDate(value: Date, label: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    invalid(`${label} must be a valid date.`);
  }
}

function normalizePublicKey(value: string): string {
  return value.replace(/[_\-.\s]/g, '').toLowerCase();
}

/**
 * Validates and defensively clones JSON intended for a durable public record.
 * This is a deny-last-resort guard; callers must still project private runtime
 * objects into an explicit public event/receipt shape before persistence.
 */
export function clonePublicRuntimeJson(
  value: RuntimeJsonObject,
  label = 'public runtime JSON'
): RuntimeJsonObject {
  let nodes = 0;
  const ancestors = new WeakSet<object>();

  const visit = (candidate: unknown, path: string, depth: number): RuntimeJson => {
    nodes += 1;
    if (nodes > MAX_JSON_NODES) {
      invalid(`${label} exceeds the maximum JSON node count.`);
    }
    if (depth > MAX_JSON_DEPTH) {
      invalid(`${label} exceeds the maximum nesting depth at ${path}.`);
    }

    if (candidate === null || typeof candidate === 'boolean') {
      return candidate;
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) {
        invalid(`${label} contains a non-finite number at ${path}.`);
      }
      return candidate;
    }
    if (typeof candidate === 'string') {
      if (utf8Bytes(candidate) > MAX_JSON_STRING_BYTES) {
        invalid(`${label} contains an oversized string at ${path}.`);
      }
      return candidate;
    }

    if (!candidate || typeof candidate !== 'object') {
      invalid(`${label} contains a non-JSON value at ${path}.`);
    }
    if (ancestors.has(candidate)) {
      invalid(`${label} contains a cycle at ${path}.`);
    }
    ancestors.add(candidate);

    try {
      if (Array.isArray(candidate)) {
        return candidate.map((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      }

      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        invalid(`${label} contains a non-plain object at ${path}.`);
      }

      const result: RuntimeJsonObject = {};
      for (const [key, item] of Object.entries(candidate)) {
        if (
          key.length === 0 ||
          key.length > MAX_JSON_KEY_CHARS ||
          FORBIDDEN_OBJECT_KEYS.has(key) ||
          FORBIDDEN_PUBLIC_KEYS.has(normalizePublicKey(key))
        ) {
          invalid(`${label} contains forbidden key ${path}.${key}.`);
        }
        result[key] = visit(item, `${path}.${key}`, depth + 1);
      }
      return result;
    } finally {
      ancestors.delete(candidate);
    }
  };

  const cloned = visit(value, '$', 0);
  if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) {
    invalid(`${label} must be a JSON object.`);
  }
  return cloned as RuntimeJsonObject;
}

export function assertOpaqueCheckpointState(
  opaque: { codec: 'reference-v1' | 'sealed-v1'; value: string } | undefined
): void {
  if (!opaque) return;
  if (opaque.codec !== 'reference-v1' && opaque.codec !== 'sealed-v1') {
    invalid('Checkpoint opaque codec is not supported.');
  }
  if (
    typeof opaque.value !== 'string' ||
    opaque.value.length === 0 ||
    utf8Bytes(opaque.value) > MAX_OPAQUE_STATE_BYTES ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(opaque.value)
  ) {
    invalid('Checkpoint opaque state must be a non-empty bounded envelope.');
  }
}

export function isAgentRunStatus(value: string): value is AgentRunStatus {
  return (AGENT_RUN_STATUSES as readonly string[]).includes(value);
}

export function isCheckpointBoundary(value: string): value is AgentCheckpointBoundary {
  return (CHECKPOINT_BOUNDARIES as readonly string[]).includes(value);
}

export function isToolEffect(value: string): value is AgentToolEffect {
  return (TOOL_EFFECTS as readonly string[]).includes(value);
}

export function isToolIdempotency(value: string): value is AgentToolIdempotency {
  return (TOOL_IDEMPOTENCY_MODES as readonly string[]).includes(value);
}

export function isToolExecutionStatus(value: string): value is AgentToolExecutionStatus {
  return (TOOL_EXECUTION_STATUSES as readonly string[]).includes(value);
}
