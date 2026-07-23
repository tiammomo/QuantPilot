import { createHash, randomBytes } from 'node:crypto';

import type {
  JsonValue,
  MoAgentTool,
  MoAgentToolApprovalDecision,
  MoAgentToolApprovalRequest,
  MoAgentToolApprovalResolution,
  MoAgentToolCall,
  MoAgentToolEffect,
  MoAgentToolIdempotency,
} from '../types';
import { MOAGENT_TOOL_APPROVAL_DECISIONS } from '../types';
import { parseMoAgentToolArguments } from './tool-arguments';

const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_APPROVAL_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const MAX_APPROVAL_REASON_CHARS = 500;
const MAX_PUBLIC_INPUT_BYTES = 64 * 1_024;
const MAX_PUBLIC_INPUT_DEPTH = 16;
const MAX_PUBLIC_INPUT_NODES = 5_000;
const MAX_PUBLIC_KEY_CHARS = 160;
const SAFE_ACTOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:+/@=-]{0,255}$/;
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const FORBIDDEN_PUBLIC_KEYS = new Set([
  'authorization',
  'cookie',
  'setcookie',
  'apikey',
  'secret',
  'password',
  'accesstoken',
  'refreshtoken',
  'privatekey',
  'credential',
  'credentials',
  'reasoning',
  'reasoningcontent',
  'chainofthought',
  'systemprompt',
  'messages',
  'rawrequest',
  'rawresponse',
]);

export class MoAgentToolApprovalError extends Error {
  constructor(
    readonly code:
      | 'INVALID_TOOL_APPROVAL_POLICY'
      | 'INVALID_TOOL_APPROVAL_INPUT'
      | 'INVALID_TOOL_APPROVAL_RESOLUTION',
    message: string,
  ) {
    super(message);
    this.name = 'MoAgentToolApprovalError';
  }
}

function normalizeKey(value: string): string {
  return value.replace(/[_\-.\s]/g, '').toLowerCase();
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`;
}

function publicInput(value: unknown, label: string): { [key: string]: JsonValue } {
  let nodes = 0;
  const ancestors = new WeakSet<object>();

  const visit = (candidate: unknown, path: string, depth: number): JsonValue => {
    nodes += 1;
    if (nodes > MAX_PUBLIC_INPUT_NODES) {
      throw new MoAgentToolApprovalError(
        'INVALID_TOOL_APPROVAL_INPUT',
        `${label} exceeds the maximum JSON node count.`,
      );
    }
    if (depth > MAX_PUBLIC_INPUT_DEPTH) {
      throw new MoAgentToolApprovalError(
        'INVALID_TOOL_APPROVAL_INPUT',
        `${label} exceeds the maximum nesting depth at ${path}.`,
      );
    }
    if (
      candidate === null ||
      typeof candidate === 'string' ||
      typeof candidate === 'boolean'
    ) {
      return candidate;
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) {
        throw new MoAgentToolApprovalError(
          'INVALID_TOOL_APPROVAL_INPUT',
          `${label} contains a non-finite number at ${path}.`,
        );
      }
      return candidate;
    }
    if (!candidate || typeof candidate !== 'object') {
      throw new MoAgentToolApprovalError(
        'INVALID_TOOL_APPROVAL_INPUT',
        `${label} contains a non-JSON value at ${path}.`,
      );
    }
    if (ancestors.has(candidate)) {
      throw new MoAgentToolApprovalError(
        'INVALID_TOOL_APPROVAL_INPUT',
        `${label} contains a cycle at ${path}.`,
      );
    }
    ancestors.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        return candidate.map((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      }
      const prototype = Object.getPrototypeOf(candidate);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new MoAgentToolApprovalError(
          'INVALID_TOOL_APPROVAL_INPUT',
          `${label} contains a non-plain object at ${path}.`,
        );
      }
      const output: { [key: string]: JsonValue } = {};
      for (const [key, item] of Object.entries(candidate)) {
        if (
          !key ||
          key.length > MAX_PUBLIC_KEY_CHARS ||
          FORBIDDEN_OBJECT_KEYS.has(key) ||
          FORBIDDEN_PUBLIC_KEYS.has(normalizeKey(key))
        ) {
          throw new MoAgentToolApprovalError(
            'INVALID_TOOL_APPROVAL_INPUT',
            `${label} contains forbidden key ${path}.${key}.`,
          );
        }
        output[key] = visit(item, `${path}.${key}`, depth + 1);
      }
      return output;
    } finally {
      ancestors.delete(candidate);
    }
  };

  const result = visit(value, '$', 0);
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new MoAgentToolApprovalError(
      'INVALID_TOOL_APPROVAL_INPUT',
      `${label} must be a JSON object.`,
    );
  }
  const serialized = canonicalJson(result);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_PUBLIC_INPUT_BYTES) {
    throw new MoAgentToolApprovalError(
      'INVALID_TOOL_APPROVAL_INPUT',
      `${label} exceeds the ${MAX_PUBLIC_INPUT_BYTES}-byte limit.`,
    );
  }
  return result;
}

function allowedDecisions(
  values: readonly MoAgentToolApprovalDecision[] | undefined,
): MoAgentToolApprovalDecision[] {
  const decisions = [...new Set(values ?? ['approve', 'reject'])];
  if (
    decisions.length === 0 ||
    decisions.some(
      (decision) => !(MOAGENT_TOOL_APPROVAL_DECISIONS as readonly string[]).includes(decision),
    ) ||
    !decisions.includes('approve') ||
    !decisions.includes('reject')
  ) {
    throw new MoAgentToolApprovalError(
      'INVALID_TOOL_APPROVAL_POLICY',
      'Tool approval decisions must contain approve and reject, with edit optional.',
    );
  }
  return MOAGENT_TOOL_APPROVAL_DECISIONS.filter((decision) =>
    decisions.includes(decision),
  );
}

export function assertMoAgentToolApprovalPolicy(
  tool: MoAgentTool,
  effect: MoAgentToolEffect,
): void {
  if (!tool.approval) return;
  if (effect !== 'workspace_write' && effect !== 'external_write') {
    throw new MoAgentToolApprovalError(
      'INVALID_TOOL_APPROVAL_POLICY',
      `Tool "${tool.name}" can require approval only for a mutating effect.`,
    );
  }
  const reason = tool.approval.reason.trim();
  if (
    !reason ||
    reason.length > MAX_APPROVAL_REASON_CHARS ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(reason)
  ) {
    throw new MoAgentToolApprovalError(
      'INVALID_TOOL_APPROVAL_POLICY',
      `Tool "${tool.name}" has an invalid approval reason.`,
    );
  }
  allowedDecisions(tool.approval.allowedDecisions);
  const timeoutMs = tool.approval.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > MAX_APPROVAL_TIMEOUT_MS
  ) {
    throw new MoAgentToolApprovalError(
      'INVALID_TOOL_APPROVAL_POLICY',
      `Tool "${tool.name}" approval timeout must be between 1 and ${MAX_APPROVAL_TIMEOUT_MS} ms.`,
    );
  }
}

function parseInput(tool: MoAgentTool, value: { [key: string]: JsonValue }): unknown {
  return tool.parseInput ? tool.parseInput(value) : value;
}

export function createMoAgentToolApprovalRequest(options: {
  runId: string;
  turn: number;
  toolCall: MoAgentToolCall;
  tool: MoAgentTool;
  effect: Extract<MoAgentToolEffect, 'workspace_write' | 'external_write'>;
  idempotency: MoAgentToolIdempotency;
  now: number;
}): MoAgentToolApprovalRequest | null {
  const policy = options.tool.approval;
  if (!policy) return null;
  let parsed: unknown;
  try {
    parsed = parseMoAgentToolArguments(options.toolCall.arguments).value;
  } catch {
    // The normal tool-input path will produce INVALID_TOOL_ARGUMENTS without
    // creating an approval for a call that can never execute.
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const sourceInput = publicInput(
    parsed,
    `Tool "${options.tool.name}" approval source input`,
  );
  let input: unknown;
  try {
    input = parseInput(options.tool, sourceInput);
  } catch {
    // The normal tool-input path will produce INVALID_TOOL_INPUT.
    return null;
  }
  const projected = publicInput(
    policy.projectPublicInput(input),
    `Tool "${options.tool.name}" approval public input`,
  );
  const timeoutMs = policy.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
  return {
    approvalId: `approval_${randomBytes(18).toString('base64url')}`,
    runId: options.runId,
    turn: options.turn,
    toolCallId: options.toolCall.id,
    toolName: options.toolCall.name,
    effect: options.effect,
    idempotency: options.idempotency,
    inputSha256: createHash('sha256')
      .update(options.toolCall.arguments, 'utf8')
      .digest('hex'),
    publicInput: projected,
    reason: policy.reason.trim(),
    allowedDecisions: allowedDecisions(policy.allowedDecisions),
    requestedAt: options.now,
    expiresAt: options.now + timeoutMs,
  };
}

export function applyMoAgentToolApprovalResolution(options: {
  request: MoAgentToolApprovalRequest;
  resolution: MoAgentToolApprovalResolution;
  tool: MoAgentTool;
  toolCall: MoAgentToolCall;
}): {
  resolution: MoAgentToolApprovalResolution;
  toolCall: MoAgentToolCall;
  effectiveInputSha256: string;
} {
  const { request, resolution, tool } = options;
  if (!request.allowedDecisions.includes(resolution.decision)) {
    throw new MoAgentToolApprovalError(
      'INVALID_TOOL_APPROVAL_RESOLUTION',
      `Decision "${resolution.decision}" is not allowed for approval ${request.approvalId}.`,
    );
  }
  if (resolution.resolvedBy !== undefined && !SAFE_ACTOR_PATTERN.test(resolution.resolvedBy)) {
    throw new MoAgentToolApprovalError(
      'INVALID_TOOL_APPROVAL_RESOLUTION',
      'Approval resolver must be a bounded public identifier.',
    );
  }

  let toolCall = { ...options.toolCall };
  if (resolution.decision === 'edit') {
    if (!resolution.editedInput) {
      throw new MoAgentToolApprovalError(
        'INVALID_TOOL_APPROVAL_RESOLUTION',
        'An edit decision requires editedInput.',
      );
    }
    const editedInput = publicInput(
      resolution.editedInput,
      `Tool "${tool.name}" edited approval input`,
    );
    const parsed = parseInput(tool, editedInput);
    const projected = publicInput(
      tool.approval!.projectPublicInput(parsed),
      `Tool "${tool.name}" edited approval projection`,
    );
    if (canonicalJson(projected) !== canonicalJson(editedInput)) {
      throw new MoAgentToolApprovalError(
        'INVALID_TOOL_APPROVAL_RESOLUTION',
        'Editable approval input must be the complete public tool input.',
      );
    }
    toolCall = { ...toolCall, arguments: canonicalJson(editedInput) };
  } else if (resolution.editedInput !== undefined) {
    throw new MoAgentToolApprovalError(
      'INVALID_TOOL_APPROVAL_RESOLUTION',
      'editedInput is allowed only for an edit decision.',
    );
  }

  return {
    resolution: {
      decision: resolution.decision,
      ...(resolution.editedInput ? { editedInput: resolution.editedInput } : {}),
      ...(resolution.resolvedBy ? { resolvedBy: resolution.resolvedBy } : {}),
    },
    toolCall,
    effectiveInputSha256: createHash('sha256')
      .update(toolCall.arguments, 'utf8')
      .digest('hex'),
  };
}

type ToolApprovalLifecycleEvent =
  | {
      type: 'tool_approval_requested';
      turn: number;
      request: MoAgentToolApprovalRequest;
    }
  | {
      type: 'tool_approval_resolved';
      turn: number;
      approvalId: string;
      toolCallId: string;
      toolName: string;
      decision: MoAgentToolApprovalDecision;
      inputSha256: string;
      effectiveInputSha256: string;
      resolvedBy?: string;
    };

function approvalEffect(
  effect: MoAgentToolEffect,
): Extract<MoAgentToolEffect, 'workspace_write' | 'external_write'> | null {
  return effect === 'workspace_write' || effect === 'external_write' ? effect : null;
}

async function abortable<T>(value: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    value.then(
      (result) => {
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Emits the requested boundary before awaiting a decision, then returns the
 * effective call only after the resolved boundary has been consumed.
 */
export async function* resolveMoAgentToolApproval(options: {
  runId: string;
  turn: number;
  toolCall: MoAgentToolCall;
  tool: MoAgentTool | undefined;
  effect: MoAgentToolEffect;
  idempotency: MoAgentToolIdempotency;
  handler: (
    request: MoAgentToolApprovalRequest,
    context: { signal: AbortSignal },
  ) => Promise<MoAgentToolApprovalResolution> | MoAgentToolApprovalResolution;
  signal: AbortSignal;
  now: () => number;
}): AsyncGenerator<
  ToolApprovalLifecycleEvent,
  { toolCall: MoAgentToolCall; rejected: boolean },
  void
> {
  const effect = approvalEffect(options.effect);
  if (!options.tool?.approval || !effect) {
    return { toolCall: options.toolCall, rejected: false };
  }
  const request = createMoAgentToolApprovalRequest({
    runId: options.runId,
    turn: options.turn,
    toolCall: options.toolCall,
    tool: options.tool,
    effect,
    idempotency: options.idempotency,
    now: options.now(),
  });
  if (!request) return { toolCall: options.toolCall, rejected: false };
  yield { type: 'tool_approval_requested', turn: options.turn, request };
  const rawResolution = await abortable(
    Promise.resolve(options.handler(request, { signal: options.signal })),
    options.signal,
  );
  const applied = applyMoAgentToolApprovalResolution({
    request,
    resolution: rawResolution,
    tool: options.tool,
    toolCall: options.toolCall,
  });
  yield {
    type: 'tool_approval_resolved',
    turn: options.turn,
    approvalId: request.approvalId,
    toolCallId: applied.toolCall.id,
    toolName: applied.toolCall.name,
    decision: applied.resolution.decision,
    inputSha256: request.inputSha256,
    effectiveInputSha256: applied.effectiveInputSha256,
    ...(applied.resolution.resolvedBy
      ? { resolvedBy: applied.resolution.resolvedBy }
      : {}),
  };
  return {
    toolCall: applied.toolCall,
    rejected: applied.resolution.decision === 'reject',
  };
}
