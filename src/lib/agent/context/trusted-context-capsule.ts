import { createHash } from 'node:crypto';

import type { MoAgentToolEffect, MoAgentToolResult } from '../types';

export const TRUSTED_CONTEXT_CAPSULE_VERSION = 1 as const;
export const TRUSTED_CONTEXT_CAPSULE_PREFIX = '[MoAgent Trusted Context Capsule v1]\n';

const DEFAULT_MAX_CAPSULE_UTF8_BYTES = 8_192;
const MAX_CAPSULE_RECEIPTS = 64;
// The interactive product currently permits at most 20 tool calls per run.
// Keep that whole common path exact, then fold older facts into a bounded,
// hash-chained rollup instead of growing trusted context without limit.
const MAX_EXACT_OPERATION_TOMBSTONES = 20;
const MAX_CAPSULE_TARGET_REFERENCES = 64;
const MAX_TARGET_REFERENCE_CHARS = 1_024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

export type MoAgentContextCapsulePhase = 'exploration' | 'writing' | 'submission';

export interface MoAgentContextCapsuleSessionOptions {
  maxUtf8Bytes?: number;
}

export interface MoAgentContextCapsuleOperation {
  operationId: string;
  toolCallId: string;
  toolName: string;
  turn: number;
  effect: MoAgentToolEffect;
  terminal: boolean;
  result: MoAgentToolResult;
  resultSha256: string;
  targetReferences: readonly string[];
}

interface ContextCapsuleReceipt {
  operationId: string;
  toolName: string;
  turn: number;
  targets: string[];
  resultSha256: string;
  workspaceGeneration: number;
  artifactSha256?: string;
  bytes?: number;
}

interface ContextCapsuleFailureReceipt {
  operationId: string;
  toolName: string;
  turn: number;
  effect: MoAgentToolEffect;
  code: string;
  targets: string[];
}

type ContextCapsuleOperationStatus = 'succeeded' | 'failed';

/**
 * An append-only, framework-generated replacement for a compacted tool-call
 * cluster. Detailed receipts may be de-duplicated or evicted, but this bounded
 * fact is never evicted: once raw history is removed, its canonical replacement
 * must remain in every later checkpoint.
 */
interface ContextCapsuleOperationTombstone {
  toolCallId: string;
  toolName: string;
  turn: number;
  effect: MoAgentToolEffect;
  status: ContextCapsuleOperationStatus;
  terminal: boolean;
  targets: string[];
  /** Opaque identity derived by the framework; no untrusted input is embedded. */
  targetIdentitySha256?: string;
  resultSha256: string;
  workspaceGeneration: number;
  source: 'trusted_receipt' | 'framework_outcome';
  artifactSha256?: string;
  bytes?: number;
  failureCode?: string;
}

interface ContextCapsuleOperationTombstoneRollup {
  count: number;
  throughTurn: number;
  sha256: string;
  succeeded: number;
  failed: number;
  pure: number;
  reads: number;
  workspaceWrites: number;
  externalWrites: number;
}

interface TrustedContextCapsuleBody {
  phase: Exclude<MoAgentContextCapsulePhase, 'exploration'>;
  workspaceGeneration: number;
  invalidatedReadReceipts: number;
  targetReferences: string[];
  operationTombstoneRollup: ContextCapsuleOperationTombstoneRollup | null;
  operationTombstones: ContextCapsuleOperationTombstone[];
  artifactReceipts: ContextCapsuleReceipt[];
  readReceipts: ContextCapsuleReceipt[];
  invalidatedReceipts: ContextCapsuleReceipt[];
  successfulWrites: ContextCapsuleReceipt[];
  remainingFailures: ContextCapsuleFailureReceipt[];
}

interface TrustedContextCapsulePayload extends TrustedContextCapsuleBody {
  $moagent: {
    kind: 'trusted_context_capsule';
    version: typeof TRUSTED_CONTEXT_CAPSULE_VERSION;
    generatedBy: 'MoAgentContextCapsuleSession';
    digest: {
      algorithm: 'SHA-256';
      hex: string;
    };
    maxUtf8Bytes: number;
  };
}

export interface MoAgentTrustedContextCapsuleTelemetry {
  applied: boolean;
  version: typeof TRUSTED_CONTEXT_CAPSULE_VERSION;
  phase: Exclude<MoAgentContextCapsulePhase, 'exploration'>;
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
}

export interface MoAgentTrustedContextCapsuleCheckpoint {
  version: typeof TRUSTED_CONTEXT_CAPSULE_VERSION;
  phase: Exclude<MoAgentContextCapsulePhase, 'exploration'>;
  sha256: string;
  content: string;
  serializedUtf8Bytes: number;
  coveredToolCallIds: readonly string[];
  telemetry: Omit<
    MoAgentTrustedContextCapsuleTelemetry,
    'applied' | 'replacedToolCallClusters' | 'replacedMessages' | 'replacedPreviousCapsule'
  >;
}

export type MoAgentContextCapsuleErrorCode =
  | 'CONTEXT_CAPSULE_BUDGET_EXCEEDED'
  | 'INVALID_CONTEXT_CAPSULE';

export interface MoAgentContextCapsuleFrameworkOutcome {
  operationId: string;
  toolCallId: string;
  toolName: string;
  turn: number;
  effect: MoAgentToolEffect;
  terminal: boolean;
  status: ContextCapsuleOperationStatus;
  resultSha256: string;
  /** SHA-256 of the model-produced argument envelope; its contents stay untrusted. */
  targetIdentitySha256: string;
}

export class MoAgentContextCapsuleError extends Error {
  readonly code: MoAgentContextCapsuleErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: MoAgentContextCapsuleErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = 'MoAgentContextCapsuleError';
    this.code = code;
    this.details = details;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(String(value));
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function safeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function artifactMetadata(result: MoAgentToolResult): {
  artifactSha256?: string;
  bytes?: number;
} {
  if (!result.ok || !isRecord(result.data)) return {};
  const digest = typeof result.data.sha256 === 'string' && SHA256_PATTERN.test(result.data.sha256)
    ? result.data.sha256
    : undefined;
  const bytes = safeInteger(result.data.bytes);
  return {
    ...(digest ? { artifactSha256: digest } : {}),
    ...(bytes !== undefined ? { bytes } : {}),
  };
}

function normalizeTargetReference(value: string, key: string): string | null {
  const candidate = value.trim().replace(/\\/g, '/');
  if (
    !candidate ||
    candidate.length > MAX_TARGET_REFERENCE_CHARS ||
    /[\0-\x1f\x7f]/.test(candidate) ||
    /^[a-zA-Z]:\//.test(candidate) ||
    candidate.startsWith('//') ||
    candidate.split('/').includes('..')
  ) {
    return null;
  }
  if (key === 'artifact' && !candidate.startsWith('artifact:')) {
    return `artifact:${candidate}`;
  }
  if (candidate.startsWith('/api/')) return `endpoint:${candidate}`;
  if (candidate.startsWith('/')) return null;
  return candidate.replace(/^\.\//, '');
}

const TARGET_KEYS = new Set([
  'artifact',
  'artifactPath',
  'artifacts',
  'canonicalRelativePath',
  'changedFiles',
  'path',
  'paths',
  'requestedPath',
  'resolvedPath',
  'targetPath',
  'verifiedArtifacts',
]);

/**
 * Extract only validated path/artifact identifiers. Values such as file
 * contents, search queries, model summaries, and tool output bodies are never
 * admitted to a capsule.
 */
export function collectTrustedContextTargetReferences(...sources: unknown[]): string[] {
  const output = new Set<string>();
  let visited = 0;
  const visit = (value: unknown, depth: number, parentKey = ''): void => {
    if (visited >= 512 || output.size >= MAX_CAPSULE_TARGET_REFERENCES || depth > 4) return;
    visited += 1;
    if (typeof value === 'string') {
      if (!TARGET_KEYS.has(parentKey)) return;
      const normalized = normalizeTargetReference(value, parentKey);
      if (normalized) output.add(normalized);
      return;
    }
    if (Array.isArray(value)) {
      if (!TARGET_KEYS.has(parentKey)) return;
      for (const item of value) visit(item, depth + 1, parentKey);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, child] of Object.entries(value)) {
      if (TARGET_KEYS.has(key)) {
        visit(child, depth + 1, key);
      } else if (depth < 4 && isRecord(child)) {
        visit(child, depth + 1, key);
      }
    }
  };
  for (const source of sources) visit(source, 0);
  return [...output].sort();
}

function receiptKey(receipt: Pick<ContextCapsuleReceipt, 'toolName' | 'targets'>): string {
  return `${receipt.toolName}\0${receipt.targets.join('\0')}`;
}

function sharesTarget(
  failure: ContextCapsuleFailureReceipt,
  operation: Pick<
    MoAgentContextCapsuleOperation,
    'effect' | 'toolName' | 'targetReferences'
  >,
): boolean {
  if (failure.targets.length === 0 || operation.targetReferences.length === 0) {
    return failure.toolName === operation.toolName;
  }
  const targets = new Set(operation.targetReferences);
  const overlaps = failure.targets.some((target) => targets.has(target));
  return overlaps && (
    failure.toolName === operation.toolName || operation.effect === 'workspace_write'
  );
}

function validatedIdentifier(value: string, label: string, maxLength = 512): string {
  if (!value || value.length > maxLength || /[\0-\x1f\x7f]/.test(value)) {
    throw new MoAgentContextCapsuleError(
      'INVALID_CONTEXT_CAPSULE',
      `Invalid ${label} supplied to the trusted context capsule.`,
      { field: label },
    );
  }
  return value;
}

export class MoAgentContextCapsuleSession {
  private readonly maxUtf8Bytes: number;
  private readonly operationTombstones = new Map<string, ContextCapsuleOperationTombstone>();
  private operationTombstoneRollup: ContextCapsuleOperationTombstoneRollup | null = null;
  private readonly artifactReceipts = new Map<string, ContextCapsuleReceipt>();
  private readonly readReceipts = new Map<string, ContextCapsuleReceipt>();
  private readonly invalidatedReceipts = new Map<string, ContextCapsuleReceipt>();
  private readonly successfulWrites = new Map<string, ContextCapsuleReceipt>();
  private readonly remainingFailures = new Map<string, ContextCapsuleFailureReceipt>();
  private workspaceGeneration = 0;
  private invalidatedReadReceipts = 0;

  constructor(options: MoAgentContextCapsuleSessionOptions = {}) {
    const maxUtf8Bytes = options.maxUtf8Bytes ?? DEFAULT_MAX_CAPSULE_UTF8_BYTES;
    if (!Number.isSafeInteger(maxUtf8Bytes) || maxUtf8Bytes < 256) {
      throw new MoAgentContextCapsuleError(
        'INVALID_CONTEXT_CAPSULE',
        'Context capsule maxUtf8Bytes must be a safe integer of at least 256.',
        { field: 'maxUtf8Bytes', value: maxUtf8Bytes },
      );
    }
    this.maxUtf8Bytes = maxUtf8Bytes;
  }

  private evictOldestReceiptForBudget(): boolean {
    const evict = (receipts: Map<string, unknown>, keep = 0): boolean => {
      if (receipts.size <= keep) return false;
      const oldest = receipts.keys().next().value as string | undefined;
      if (!oldest) return false;
      receipts.delete(oldest);
      return true;
    };
    // Reads are cheapest to reproduce, then derived artifact receipts. Keep
    // the latest write/failure state as long as the byte budget permits.
    return evict(this.invalidatedReceipts) ||
      evict(this.readReceipts) ||
      evict(this.artifactReceipts) ||
      evict(this.successfulWrites, 1) ||
      evict(this.remainingFailures, 1) ||
      evict(this.successfulWrites) ||
      evict(this.remainingFailures);
  }

  private validateOperationIdentity(operation: {
    operationId: string;
    toolCallId: string;
    toolName: string;
    turn: number;
    resultSha256: string;
  }): {
    operationId: string;
    toolCallId: string;
    toolName: string;
  } {
    const operationId = validatedIdentifier(operation.operationId, 'operationId');
    const toolCallId = validatedIdentifier(operation.toolCallId, 'toolCallId');
    const toolName = validatedIdentifier(operation.toolName, 'toolName', 256);
    if (!Number.isSafeInteger(operation.turn) || operation.turn < 1) {
      throw new MoAgentContextCapsuleError(
        'INVALID_CONTEXT_CAPSULE',
        'Context capsule operation turn must be a positive safe integer.',
        { field: 'turn', value: operation.turn },
      );
    }
    if (!SHA256_PATTERN.test(operation.resultSha256)) {
      throw new MoAgentContextCapsuleError(
        'INVALID_CONTEXT_CAPSULE',
        'Context capsule result receipt requires a SHA-256 digest.',
        { field: 'resultSha256' },
      );
    }
    return { operationId, toolCallId, toolName };
  }

  private invalidateForWorkspaceWrite(): void {
    this.workspaceGeneration += 1;
    this.invalidatedReadReceipts += this.readReceipts.size;
    for (const [key, receipt] of this.readReceipts) {
      this.invalidatedReceipts.set(key, receipt);
    }
    this.readReceipts.clear();
    for (const [key, receipt] of this.artifactReceipts) {
      if (receipt.workspaceGeneration < this.workspaceGeneration) {
        this.invalidatedReceipts.set(key, receipt);
        this.artifactReceipts.delete(key);
      }
    }
  }

  private recordTombstone(
    operationId: string,
    tombstone: ContextCapsuleOperationTombstone,
  ): void {
    const existing = this.operationTombstones.get(operationId);
    if (existing && canonicalJson(existing) !== canonicalJson(tombstone)) {
      throw new MoAgentContextCapsuleError(
        'INVALID_CONTEXT_CAPSULE',
        'A framework operation ID cannot be reused for a different context fact.',
        { field: 'operationId' },
      );
    }
    this.operationTombstones.set(operationId, tombstone);
    while (this.operationTombstones.size > MAX_EXACT_OPERATION_TOMBSTONES) {
      if (!this.rollOldestExactTombstone()) break;
    }
  }

  private rollOldestExactTombstone(): boolean {
    const oldestOperationId = this.operationTombstones.keys().next().value as string | undefined;
    if (!oldestOperationId) return false;
    const oldest = this.operationTombstones.get(oldestOperationId);
    this.operationTombstones.delete(oldestOperationId);
    if (!oldest) return false;
    const removeDetailedOperation = (receipts: Map<string, ContextCapsuleReceipt>): void => {
      for (const [key, receipt] of receipts) {
        if (receipt.operationId === oldestOperationId) receipts.delete(key);
      }
    };
    removeDetailedOperation(this.artifactReceipts);
    removeDetailedOperation(this.readReceipts);
    removeDetailedOperation(this.invalidatedReceipts);
    this.successfulWrites.delete(oldestOperationId);
    this.remainingFailures.delete(oldestOperationId);
    const previous = this.operationTombstoneRollup;
    this.operationTombstoneRollup = {
      count: (previous?.count ?? 0) + 1,
      throughTurn: Math.max(previous?.throughTurn ?? 0, oldest.turn),
      sha256: sha256(`${previous?.sha256 ?? ''}\0${canonicalJson(oldest)}`),
      succeeded: (previous?.succeeded ?? 0) + (oldest.status === 'succeeded' ? 1 : 0),
      failed: (previous?.failed ?? 0) + (oldest.status === 'failed' ? 1 : 0),
      pure: (previous?.pure ?? 0) + (oldest.effect === 'pure' ? 1 : 0),
      reads: (previous?.reads ?? 0) + (oldest.effect === 'read' ? 1 : 0),
      workspaceWrites: (previous?.workspaceWrites ?? 0) +
        (oldest.effect === 'workspace_write' ? 1 : 0),
      externalWrites: (previous?.externalWrites ?? 0) +
        (oldest.effect === 'external_write' ? 1 : 0),
    };
    return true;
  }

  record(operation: MoAgentContextCapsuleOperation): void {
    const { operationId, toolCallId, toolName } = this.validateOperationIdentity(operation);
    const targets = collectTrustedContextTargetReferences({
      paths: operation.targetReferences,
    });
    const failureCode = operation.result.ok
      ? null
      : validatedIdentifier(operation.result.error.code, 'failureCode', 256);
    const metadata = artifactMetadata(operation.result);

    if (!operation.result.ok) {
      this.remainingFailures.set(operationId, {
        operationId,
        toolName,
        turn: operation.turn,
        effect: operation.effect,
        code: failureCode!,
        targets,
      });
      this.recordTombstone(operationId, {
        toolCallId,
        toolName,
        turn: operation.turn,
        effect: operation.effect,
        status: 'failed',
        terminal: false,
        targets,
        resultSha256: operation.resultSha256,
        workspaceGeneration: this.workspaceGeneration,
        source: 'trusted_receipt',
        failureCode: failureCode!,
      });
      return;
    }

    for (const [key, failure] of this.remainingFailures) {
      if (sharesTarget(failure, operation)) this.remainingFailures.delete(key);
    }

    if (operation.effect === 'workspace_write') {
      this.invalidateForWorkspaceWrite();
    }

    const receipt: ContextCapsuleReceipt = {
      operationId,
      toolName,
      turn: operation.turn,
      targets,
      resultSha256: operation.resultSha256,
      workspaceGeneration: this.workspaceGeneration,
      ...metadata,
    };
    if (operation.effect === 'read') {
      this.readReceipts.set(receiptKey(receipt), receipt);
    } else if (operation.effect !== 'workspace_write') {
      // Keep a minimal operation receipt even when a trusted side-effect tool
      // has no path-like target. Otherwise compaction could erase knowledge of
      // the effect and invite a duplicate execution.
      this.artifactReceipts.set(receiptKey(receipt), receipt);
    }
    if (operation.effect === 'workspace_write') {
      this.successfulWrites.set(operationId, receipt);
    }
    this.recordTombstone(operationId, {
      toolCallId,
      toolName,
      turn: operation.turn,
      effect: operation.effect,
      status: 'succeeded',
      terminal: operation.terminal,
      targets,
      resultSha256: operation.resultSha256,
      workspaceGeneration: this.workspaceGeneration,
      source: 'trusted_receipt',
      ...metadata,
    });
  }

  /**
   * Record only framework-observed metadata for a tool without a trusted
   * projector. Third-party output and model-provided arguments never enter the
   * capsule; their exact bytes are represented only by SHA-256 identities.
   */
  recordFrameworkOutcome(operation: MoAgentContextCapsuleFrameworkOutcome): void {
    const { operationId, toolCallId, toolName } = this.validateOperationIdentity(operation);
    if (!SHA256_PATTERN.test(operation.targetIdentitySha256)) {
      throw new MoAgentContextCapsuleError(
        'INVALID_CONTEXT_CAPSULE',
        'Framework context target identity requires a SHA-256 digest.',
        { field: 'targetIdentitySha256' },
      );
    }
    if (operation.status === 'succeeded' && operation.effect === 'workspace_write') {
      this.invalidateForWorkspaceWrite();
    }
    this.recordTombstone(operationId, {
      toolCallId,
      toolName,
      turn: operation.turn,
      effect: operation.effect,
      status: operation.status,
      terminal: operation.status === 'succeeded' && operation.terminal,
      targets: [],
      targetIdentitySha256: operation.targetIdentitySha256,
      resultSha256: operation.resultSha256,
      workspaceGeneration: this.workspaceGeneration,
      source: 'framework_outcome',
    });
  }

  checkpoint(phase: MoAgentContextCapsulePhase): MoAgentTrustedContextCapsuleCheckpoint | null {
    if (phase === 'exploration') return null;
    const operationTombstones = [...this.operationTombstones.values()];
    const receipts = [
      ...this.artifactReceipts.values(),
      ...this.readReceipts.values(),
      ...this.invalidatedReceipts.values(),
      ...this.successfulWrites.values(),
      ...this.remainingFailures.values(),
    ];
    if (receipts.length > MAX_CAPSULE_RECEIPTS) {
      if (this.evictOldestReceiptForBudget()) return this.checkpoint(phase);
      return null;
    }
    const targetReferences = Array.from(new Set(
      operationTombstones.flatMap((receipt) => receipt.targets),
    ))
      .sort();
    if (targetReferences.length > MAX_CAPSULE_TARGET_REFERENCES) {
      // Preserve the latest exact operation and fold older facts into the
      // bounded hash-chain until literal target references fit.
      if (this.operationTombstones.size > 1 && this.rollOldestExactTombstone()) {
        return this.checkpoint(phase);
      }
      return null;
    }
    const body: TrustedContextCapsuleBody = {
      phase,
      workspaceGeneration: this.workspaceGeneration,
      invalidatedReadReceipts: this.invalidatedReadReceipts,
      targetReferences,
      operationTombstoneRollup: this.operationTombstoneRollup,
      operationTombstones,
      artifactReceipts: [...this.artifactReceipts.values()],
      readReceipts: [...this.readReceipts.values()],
      invalidatedReceipts: [...this.invalidatedReceipts.values()],
      successfulWrites: [...this.successfulWrites.values()],
      remainingFailures: [...this.remainingFailures.values()],
    };
    // Coverage is derived from append-only tombstones, never from the detailed
    // receipts that may be de-duplicated or evicted for size.
    const coveredToolCallIds = Array.from(new Set(
      operationTombstones.map((tombstone) => tombstone.toolCallId),
    )).sort();
    const digest = sha256(canonicalJson({
      body,
      coveredToolCallIds,
      maxUtf8Bytes: this.maxUtf8Bytes,
    }));
    const payload: TrustedContextCapsulePayload = {
      $moagent: {
        kind: 'trusted_context_capsule',
        version: TRUSTED_CONTEXT_CAPSULE_VERSION,
        generatedBy: 'MoAgentContextCapsuleSession',
        digest: { algorithm: 'SHA-256', hex: digest },
        maxUtf8Bytes: this.maxUtf8Bytes,
      },
      ...body,
    };
    const content = `${TRUSTED_CONTEXT_CAPSULE_PREFIX}${JSON.stringify(payload)}`;
    const serializedUtf8Bytes = utf8Bytes(content);
    if (serializedUtf8Bytes > this.maxUtf8Bytes) {
      if (this.evictOldestReceiptForBudget()) return this.checkpoint(phase);
      // Detailed receipts are already gone. Continue with the same bounded
      // rollup strategy, retaining at least the latest exact operation fact.
      if (this.operationTombstones.size > 1 && this.rollOldestExactTombstone()) {
        return this.checkpoint(phase);
      }
      // A deliberately tiny configured budget may not fit even one exact fact.
      // In that case preserve canonical history instead of producing a partial
      // or oversized trusted capsule.
      return null;
    }
    return {
      version: TRUSTED_CONTEXT_CAPSULE_VERSION,
      phase,
      sha256: digest,
      content,
      serializedUtf8Bytes,
      coveredToolCallIds,
      telemetry: {
        version: TRUSTED_CONTEXT_CAPSULE_VERSION,
        phase,
        sha256: digest,
        serializedUtf8Bytes,
        coveredToolCalls: coveredToolCallIds.length,
        targetReferences: body.targetReferences.length,
        operationTombstones: body.operationTombstones.length,
        rolledUpOperationTombstones: body.operationTombstoneRollup?.count ?? 0,
        frameworkOutcomeTombstones: body.operationTombstones.filter(
          (receipt) => receipt.source === 'framework_outcome',
        ).length,
        artifactReceipts: body.artifactReceipts.length,
        readReceipts: body.readReceipts.length,
        successfulWrites: body.successfulWrites.length,
        remainingFailures: body.remainingFailures.length,
        invalidatedReadReceipts: this.invalidatedReadReceipts,
      },
    };
  }
}

export function isTrustedContextCapsuleMessage(content: string): boolean {
  return content.startsWith(TRUSTED_CONTEXT_CAPSULE_PREFIX);
}

export function assertTrustedContextCapsule(
  checkpoint: MoAgentTrustedContextCapsuleCheckpoint,
): void {
  if (
    checkpoint.version !== TRUSTED_CONTEXT_CAPSULE_VERSION ||
    !SHA256_PATTERN.test(checkpoint.sha256) ||
    utf8Bytes(checkpoint.content) !== checkpoint.serializedUtf8Bytes ||
    !isTrustedContextCapsuleMessage(checkpoint.content)
  ) {
    throw new MoAgentContextCapsuleError(
      'INVALID_CONTEXT_CAPSULE',
      'Trusted context capsule checkpoint framing is invalid.',
    );
  }
  let payload: TrustedContextCapsulePayload;
  try {
    payload = JSON.parse(
      checkpoint.content.slice(TRUSTED_CONTEXT_CAPSULE_PREFIX.length),
    ) as TrustedContextCapsulePayload;
  } catch {
    throw new MoAgentContextCapsuleError(
      'INVALID_CONTEXT_CAPSULE',
      'Trusted context capsule payload is not valid JSON.',
    );
  }
  const { $moagent, ...body } = payload;
  const coveredToolCallIds = [...checkpoint.coveredToolCallIds];
  const normalizedCoveredToolCallIds = Array.from(new Set(coveredToolCallIds)).sort();
  const validCoverage = coveredToolCallIds.length === normalizedCoveredToolCallIds.length &&
    coveredToolCallIds.every((callId, index) =>
      callId === normalizedCoveredToolCallIds[index] &&
      typeof callId === 'string' &&
      callId.length > 0 &&
      callId.length <= 512 &&
      !/[\0-\x1f\x7f]/.test(callId));
  const validTombstone = (candidate: unknown): candidate is ContextCapsuleOperationTombstone => {
    if (!isRecord(candidate)) return false;
    const targets = candidate.targets;
    return typeof candidate.toolCallId === 'string' &&
      candidate.toolCallId.length > 0 && candidate.toolCallId.length <= 512 &&
      !/[\0-\x1f\x7f]/.test(candidate.toolCallId) &&
      typeof candidate.toolName === 'string' &&
      candidate.toolName.length > 0 && candidate.toolName.length <= 256 &&
      !/[\0-\x1f\x7f]/.test(candidate.toolName) &&
      Number.isSafeInteger(candidate.turn) && (candidate.turn as number) >= 1 &&
      ['pure', 'read', 'workspace_write', 'external_write'].includes(String(candidate.effect)) &&
      (candidate.status === 'succeeded' || candidate.status === 'failed') &&
      typeof candidate.terminal === 'boolean' &&
      Array.isArray(targets) && targets.every((target) =>
        typeof target === 'string' && normalizeTargetReference(target, 'paths') === target) &&
      (candidate.targetIdentitySha256 === undefined ||
        (typeof candidate.targetIdentitySha256 === 'string' &&
          SHA256_PATTERN.test(candidate.targetIdentitySha256))) &&
      typeof candidate.resultSha256 === 'string' && SHA256_PATTERN.test(candidate.resultSha256) &&
      Number.isSafeInteger(candidate.workspaceGeneration) &&
      (candidate.workspaceGeneration as number) >= 0 &&
      (candidate.source === 'trusted_receipt' || candidate.source === 'framework_outcome') &&
      (candidate.artifactSha256 === undefined ||
        (typeof candidate.artifactSha256 === 'string' &&
          SHA256_PATTERN.test(candidate.artifactSha256))) &&
      (candidate.bytes === undefined || safeInteger(candidate.bytes) !== undefined) &&
      (candidate.failureCode === undefined ||
        (typeof candidate.failureCode === 'string' && candidate.failureCode.length > 0 &&
          candidate.failureCode.length <= 256 && !/[\0-\x1f\x7f]/.test(candidate.failureCode)));
  };
  const validRollup = (
    candidate: unknown,
  ): candidate is ContextCapsuleOperationTombstoneRollup => {
    if (!isRecord(candidate)) return false;
    const countFields = [
      candidate.count,
      candidate.throughTurn,
      candidate.succeeded,
      candidate.failed,
      candidate.pure,
      candidate.reads,
      candidate.workspaceWrites,
      candidate.externalWrites,
    ];
    return countFields.every((value) => safeInteger(value) !== undefined) &&
      (candidate.count as number) > 0 &&
      (candidate.throughTurn as number) > 0 &&
      typeof candidate.sha256 === 'string' && SHA256_PATTERN.test(candidate.sha256) &&
      (candidate.succeeded as number) + (candidate.failed as number) === candidate.count &&
      (candidate.pure as number) + (candidate.reads as number) +
        (candidate.workspaceWrites as number) + (candidate.externalWrites as number) ===
        candidate.count;
  };
  const validBodyShape = (
    body.phase === 'writing' || body.phase === 'submission'
  ) && Number.isSafeInteger(body.workspaceGeneration) &&
    body.workspaceGeneration >= 0 &&
    Number.isSafeInteger(body.invalidatedReadReceipts) &&
    body.invalidatedReadReceipts >= 0 &&
    Array.isArray(body.targetReferences) &&
    (body.operationTombstoneRollup === null || validRollup(body.operationTombstoneRollup)) &&
    Array.isArray(body.operationTombstones) &&
    body.operationTombstones.length <= MAX_EXACT_OPERATION_TOMBSTONES &&
    body.operationTombstones.every(validTombstone) &&
    Array.isArray(body.artifactReceipts) &&
    Array.isArray(body.readReceipts) &&
    Array.isArray(body.invalidatedReceipts) &&
    Array.isArray(body.successfulWrites) &&
    Array.isArray(body.remainingFailures);
  const tombstoneCoverage = validBodyShape
    ? Array.from(new Set(body.operationTombstones.map((receipt) => receipt.toolCallId))).sort()
    : [];
  const coverageMatchesTombstones = canonicalJson(coveredToolCallIds) ===
    canonicalJson(tombstoneCoverage);
  const expectedTelemetry = validBodyShape ? {
    version: TRUSTED_CONTEXT_CAPSULE_VERSION,
    phase: body.phase,
    sha256: checkpoint.sha256,
    serializedUtf8Bytes: checkpoint.serializedUtf8Bytes,
    coveredToolCalls: coveredToolCallIds.length,
    targetReferences: body.targetReferences.length,
    operationTombstones: body.operationTombstones.length,
    rolledUpOperationTombstones: body.operationTombstoneRollup?.count ?? 0,
    frameworkOutcomeTombstones: body.operationTombstones.filter(
      (receipt) => receipt.source === 'framework_outcome',
    ).length,
    artifactReceipts: body.artifactReceipts.length,
    readReceipts: body.readReceipts.length,
    successfulWrites: body.successfulWrites.length,
    remainingFailures: body.remainingFailures.length,
    invalidatedReadReceipts: body.invalidatedReadReceipts,
  } : null;
  if (
    $moagent?.kind !== 'trusted_context_capsule' ||
    $moagent.version !== TRUSTED_CONTEXT_CAPSULE_VERSION ||
    $moagent.generatedBy !== 'MoAgentContextCapsuleSession' ||
    $moagent.digest?.algorithm !== 'SHA-256' ||
    $moagent.digest.hex !== checkpoint.sha256 ||
    body.phase !== checkpoint.phase ||
    !validCoverage ||
    !coverageMatchesTombstones ||
    !validBodyShape ||
    !Number.isSafeInteger($moagent.maxUtf8Bytes) ||
    $moagent.maxUtf8Bytes < 256 ||
    sha256(canonicalJson({
      body,
      coveredToolCallIds,
      maxUtf8Bytes: $moagent.maxUtf8Bytes,
    })) !==
      checkpoint.sha256 ||
    checkpoint.serializedUtf8Bytes > $moagent.maxUtf8Bytes ||
    canonicalJson(checkpoint.telemetry) !== canonicalJson(expectedTelemetry)
  ) {
    throw new MoAgentContextCapsuleError(
      'INVALID_CONTEXT_CAPSULE',
      'Trusted context capsule version, digest, phase, or budget verification failed.',
    );
  }
}
