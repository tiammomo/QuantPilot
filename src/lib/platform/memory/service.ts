import { createHash } from 'node:crypto';

import type { MemoryIntegrationConfig } from './config';
import { getMemoryIntegrationConfig } from './config';
import {
  PrismaPersonalMemoryControlRepository,
  type PersonalMemoryControlRepository,
  type PersonalMemoryControlState,
  type PersonalMemoryControlUpdate,
} from './control';
import { ExternalMemoryHttpError } from './errors';
import { EvolvableMemoryHttpAdapter } from './evolvable-memory-http';
import {
  PersonalMemoryFeedbackConflictError,
  PrismaPersonalMemoryFeedbackRepository,
  type PersonalMemoryFeedbackRepository,
} from './feedback-repository';
import type { PersonalMemoryPort } from './port';
import { memoryCompatibilityIssues } from './compatibility';
import {
  PrismaExternalMemoryUseRepository,
  type ExternalMemoryUseRepository,
} from './repository';
import {
  assertPersonalizationKey,
  buildPreferenceContext,
  isQuantPilotPreference,
  selectPersonalizationProjection,
} from './policy';
import {
  MEMORY_CAPABILITY,
  MEMORY_CHAT_CAPABILITIES,
  MEMORY_INTEGRATION_CAPABILITIES,
  MEMORY_PROVIDER_ID,
  type MemoryCapability,
  type MemoryOutcomeKind,
  type MemoryPreferenceSummary,
  type MemoryRevision,
  type MemoryServiceInfo,
  type MemoryWriteResult,
  type PersonalizationCapsule,
  type PersonalizationRecallResult,
} from './types';

export class MemoryIntegrationError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'MemoryIntegrationError';
  }
}

interface MemoryDependencies {
  config: MemoryIntegrationConfig;
  port: PersonalMemoryPort;
  uses: ExternalMemoryUseRepository;
  controls: PersonalMemoryControlRepository;
  feedback: PersonalMemoryFeedbackRepository;
}

function dependencies(overrides: Partial<MemoryDependencies> = {}): MemoryDependencies {
  const config = overrides.config ?? getMemoryIntegrationConfig();
  return {
    config,
    port: overrides.port ?? new EvolvableMemoryHttpAdapter(config),
    uses: overrides.uses ?? new PrismaExternalMemoryUseRepository(),
    controls: overrides.controls ?? new PrismaPersonalMemoryControlRepository(),
    feedback: overrides.feedback ?? new PrismaPersonalMemoryFeedbackRepository(),
  };
}

function requireEnabled(config: MemoryIntegrationConfig): void {
  if (!config.enabled) {
    throw new MemoryIntegrationError('MEMORY_DISABLED', 503, 'Personal memory integration is disabled.');
  }
}

async function negotiate(
  runtime: MemoryDependencies,
  capabilities: readonly MemoryCapability[],
  requestId?: string,
): Promise<MemoryServiceInfo> {
  const info = await runtime.port.discover(requestId);
  const issues = memoryCompatibilityIssues(info, runtime.config, capabilities);
  if (issues.length > 0) {
    throw new MemoryIntegrationError(
      'MEMORY_INCOMPATIBLE',
      503,
      `Personal memory service is incompatible: ${issues.join(', ')}.`,
    );
  }
  return info;
}

function subjectId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 128) {
    throw new MemoryIntegrationError('INVALID_MEMORY_SUBJECT', 400, 'Invalid memory subject.');
  }
  return normalized;
}

async function requirePersonalizationEnabled(
  runtime: MemoryDependencies,
  actor: string,
): Promise<PersonalMemoryControlState> {
  const control = await runtime.controls.get(actor);
  if (!control.personalizationEnabled) {
    throw new MemoryIntegrationError(
      'MEMORY_OPTED_OUT',
      409,
      'Personal memory is disabled for this account.',
    );
  }
  return control;
}

function eventId(value: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 160 || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new MemoryIntegrationError('INVALID_EVENT_ID', 400, 'Invalid client event ID.');
  }
  return normalized;
}

function boundedText(value: string, label: string, maximum: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new MemoryIntegrationError('INVALID_MEMORY_INPUT', 400, `Invalid ${label}.`);
  }
  return normalized;
}

function personalizationKey(value: string): string {
  try {
    return assertPersonalizationKey(value);
  } catch {
    throw new MemoryIntegrationError(
      'INVALID_MEMORY_KEY',
      400,
      'Unsupported personal memory key.',
    );
  }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeFailure(error: unknown): { code: string; status: number | null; requestId: string | null } {
  if (error instanceof ExternalMemoryHttpError) {
    return { code: error.code, status: error.status, requestId: error.requestId };
  }
  return { code: 'INTEGRATION_ERROR', status: null, requestId: null };
}

export async function inspectPersonalMemory(
  requestId?: string,
  overrides: Partial<MemoryDependencies> = {},
): Promise<MemoryServiceInfo> {
  const runtime = dependencies(overrides);
  requireEnabled(runtime.config);
  const info = await negotiate(runtime, MEMORY_INTEGRATION_CAPABILITIES, requestId);
  await runtime.port.checkReady(requestId);
  return info;
}

export async function getPersonalMemoryControl(
  actorUserId: string,
  overrides: Partial<MemoryDependencies> = {},
): Promise<PersonalMemoryControlState> {
  const runtime = dependencies(overrides);
  return runtime.controls.get(subjectId(actorUserId));
}

export async function setPersonalMemoryEnabled(
  actorUserId: string,
  enabled: boolean,
  overrides: Partial<MemoryDependencies> = {},
): Promise<PersonalMemoryControlUpdate> {
  const runtime = dependencies(overrides);
  return runtime.controls.set(subjectId(actorUserId), enabled);
}

export async function recallPersonalization(input: {
  projectId: string;
  actorUserId: string;
  requestId: string;
  instruction: string;
  capabilityId?: string | null;
}, overrides: Partial<MemoryDependencies> = {}): Promise<PersonalizationRecallResult> {
  const runtime = dependencies(overrides);
  if (!runtime.config.enabled) {
    return { status: 'disabled', capsule: null, exposedMemoryCount: 0, preparedUse: null };
  }

  const actor = subjectId(input.actorUserId);
  try {
    const control = await runtime.controls.get(actor);
    if (!control.personalizationEnabled) {
      return { status: 'opted_out', capsule: null, exposedMemoryCount: 0, preparedUse: null };
    }
    await negotiate(runtime, MEMORY_CHAT_CAPABILITIES, input.requestId);
    const recall = await runtime.port.recall({
      tenantId: runtime.config.tenantId,
      subjectId: actor,
      query: input.instruction.trim().slice(0, 4_096),
      context: {
        product: 'quantpilot',
        project_id: input.projectId,
        ...(input.capabilityId ? { capability: input.capabilityId.slice(0, 512) } : {}),
      },
      limit: runtime.config.recallLimit,
      purpose: runtime.config.purpose,
    }, input.requestId);
    const projection = await runtime.port.projectContext({
      tenantId: runtime.config.tenantId,
      subjectId: actor,
      traceId: recall.traceId,
      algorithm: 'exact-deduplicated-v1',
      maxCharacters: runtime.config.maxProjectionCharacters,
      purpose: runtime.config.purpose,
    }, input.requestId);
    const selected = selectPersonalizationProjection(projection, input.projectId);
    const currentControl = await runtime.controls.get(actor);
    if (!currentControl.personalizationEnabled) {
      return { status: 'opted_out', capsule: null, exposedMemoryCount: 0, preparedUse: null };
    }
    const contentSha256 = sha256(selected.content);

    if (selected.revisionIds.length === 0) {
      return { status: 'empty', capsule: null, exposedMemoryCount: 0, preparedUse: null };
    }
    return {
      status: 'prepared',
      exposedMemoryCount: selected.revisionIds.length,
      capsule: {
        content: selected.content,
        traceId: recall.traceId,
        revisionIds: selected.revisionIds,
        sourceProjectionSha256: projection.projectionSha256,
        contentSha256,
      },
      preparedUse: {
        tenantId: runtime.config.tenantId,
        subjectId: actor,
        traceId: recall.traceId,
        policyId: recall.policyId,
        policyVersion: recall.policyVersion,
        validAt: recall.validAt,
        knownAt: recall.knownAt,
        sourceProjectionSha256: projection.projectionSha256,
        deliveredContextSha256: contentSha256,
        exposedRevisionIds: selected.revisionIds,
      },
    };
  } catch (error) {
    if (runtime.config.required) {
      throw new MemoryIntegrationError(
        'MEMORY_REQUIRED_UNAVAILABLE',
        503,
        'Required personal memory is unavailable.',
      );
    }
    const failure = safeFailure(error);
    console.warn('[PersonalMemory] Optional integration degraded.', failure);
    return { status: 'unavailable', capsule: null, exposedMemoryCount: 0, preparedUse: null };
  }
}

export async function exposePersonalization(input: {
  projectId: string;
  actorUserId: string;
  requestId: string;
  recall: PersonalizationRecallResult;
}, overrides: Partial<MemoryDependencies> = {}): Promise<PersonalizationCapsule | null> {
  if (
    input.recall.status !== 'prepared'
    || !input.recall.capsule
    || !input.recall.preparedUse
  ) {
    return null;
  }

  const runtime = dependencies(overrides);
  if (!runtime.config.enabled) return null;
  const actor = subjectId(input.actorUserId);
  const requestId = eventId(input.requestId);
  const prepared = input.recall.preparedUse;
  const capsule = input.recall.capsule;
  const validAt = new Date(prepared.validAt);
  const knownAt = new Date(prepared.knownAt);
  const receiptMatchesCapsule =
    prepared.tenantId === runtime.config.tenantId
    && prepared.subjectId === actor
    && prepared.traceId === capsule.traceId
    && prepared.sourceProjectionSha256 === capsule.sourceProjectionSha256
    && prepared.deliveredContextSha256 === capsule.contentSha256
    && JSON.stringify(prepared.exposedRevisionIds) === JSON.stringify(capsule.revisionIds)
    && Number.isFinite(validAt.getTime())
    && Number.isFinite(knownAt.getTime());
  if (!receiptMatchesCapsule) {
    throw new MemoryIntegrationError(
      'MEMORY_USE_MISMATCH',
      400,
      'Prepared personal memory attribution does not match the delivered capsule.',
    );
  }

  try {
    const control = await runtime.controls.get(actor);
    if (!control.personalizationEnabled) return null;
    await runtime.uses.save({
      provider: MEMORY_PROVIDER_ID,
      projectId: input.projectId,
      requestId,
      tenantId: prepared.tenantId,
      subjectId: prepared.subjectId,
      traceId: prepared.traceId,
      policyId: prepared.policyId,
      policyVersion: prepared.policyVersion,
      validAt,
      knownAt,
      sourceProjectionSha256: prepared.sourceProjectionSha256,
      deliveredContextSha256: prepared.deliveredContextSha256,
      exposedRevisionIds: prepared.exposedRevisionIds,
    });
    return capsule;
  } catch (error) {
    if (runtime.config.required) {
      throw new MemoryIntegrationError(
        'MEMORY_REQUIRED_UNAVAILABLE',
        503,
        'Required personal memory attribution is unavailable.',
      );
    }
    console.warn('[PersonalMemory] Prepared memory was not exposed because attribution failed.', {
      code: error instanceof Error ? error.name : 'INTEGRATION_ERROR',
    });
    return null;
  }
}

export async function listPersonalPreferences(input: {
  actorUserId: string;
  requestId?: string;
}, overrides: Partial<MemoryDependencies> = {}): Promise<MemoryPreferenceSummary[]> {
  const runtime = dependencies(overrides);
  requireEnabled(runtime.config);
  const actor = subjectId(input.actorUserId);
  await negotiate(runtime, [MEMORY_CAPABILITY.preferenceList], input.requestId);
  const preferences = await runtime.port.listPreferences({
    tenantId: runtime.config.tenantId,
    subjectId: actor,
    purpose: runtime.config.purpose,
  }, input.requestId);
  return preferences.filter(isQuantPilotPreference);
}

export async function rememberPersonalPreference(input: {
  projectId: string;
  actorUserId: string;
  eventId: string;
  key: string;
  value: string;
  evidenceText: string;
  confidence?: number;
  scope?: 'global' | 'project';
  context?: Record<string, unknown>;
  occurredAt?: string;
}, overrides: Partial<MemoryDependencies> = {}): Promise<MemoryWriteResult> {
  const runtime = dependencies(overrides);
  requireEnabled(runtime.config);
  const confidence = input.confidence ?? 0.95;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new MemoryIntegrationError('INVALID_MEMORY_INPUT', 400, 'Invalid confidence.');
  }
  const stableEventId = eventId(input.eventId);
  const actor = subjectId(input.actorUserId);
  const key = personalizationKey(input.key);
  const value = boundedText(input.value, 'preference value', 4_096);
  const evidenceText = boundedText(input.evidenceText, 'evidence text', 16_384);
  const context = buildPreferenceContext({
    projectId: input.projectId,
    scope: input.scope ?? 'global',
    context: input.context,
  });
  await requirePersonalizationEnabled(runtime, actor);
  await negotiate(runtime, [MEMORY_CAPABILITY.preferenceWrite], stableEventId);
  return runtime.port.rememberPreference({
    tenantId: runtime.config.tenantId,
    subjectId: actor,
    source: 'quantpilot-explicit-confirmation',
    idempotencyKey: `quantpilot:${stableEventId}:preference`,
    key,
    value,
    context,
    evidenceText,
    confidence,
    purpose: runtime.config.purpose,
    occurredAt: input.occurredAt,
  }, stableEventId);
}

export async function correctPersonalPreference(input: {
  actorUserId: string;
  recordId: string;
  eventId: string;
  value: string;
  evidenceText: string;
  reason: string;
  expectedRevisionId?: string;
  occurredAt?: string;
}, overrides: Partial<MemoryDependencies> = {}): Promise<MemoryWriteResult> {
  const runtime = dependencies(overrides);
  requireEnabled(runtime.config);
  const stableEventId = eventId(input.eventId);
  const actor = subjectId(input.actorUserId);
  const recordId = boundedText(input.recordId, 'record ID', 64);
  const value = boundedText(input.value, 'preference value', 4_096);
  const evidenceText = boundedText(input.evidenceText, 'evidence text', 16_384);
  const reason = boundedText(input.reason, 'correction reason', 2_048);
  await requirePersonalizationEnabled(runtime, actor);
  await negotiate(runtime, [
    MEMORY_CAPABILITY.preferenceList,
    MEMORY_CAPABILITY.preferenceCorrect,
  ], stableEventId);
  const visible = await runtime.port.listPreferences({
    tenantId: runtime.config.tenantId,
    subjectId: actor,
    purpose: runtime.config.purpose,
  }, input.eventId);
  if (!visible.some((item) => item.recordId === recordId && isQuantPilotPreference(item))) {
    throw new MemoryIntegrationError('MEMORY_PREFERENCE_NOT_FOUND', 404, 'Memory preference was not found.');
  }
  return runtime.port.correctPreference({
    tenantId: runtime.config.tenantId,
    subjectId: actor,
    recordId,
    source: 'quantpilot-explicit-correction',
    idempotencyKey: `quantpilot:${stableEventId}:correction`,
    value,
    evidenceText,
    reason,
    purpose: runtime.config.purpose,
    expectedRevisionId: input.expectedRevisionId,
    occurredAt: input.occurredAt,
  }, stableEventId);
}

export async function getPersonalPreferenceRevisions(input: {
  actorUserId: string;
  recordId: string;
  requestId?: string;
}, overrides: Partial<MemoryDependencies> = {}): Promise<MemoryRevision[]> {
  const runtime = dependencies(overrides);
  requireEnabled(runtime.config);
  const actor = subjectId(input.actorUserId);
  const recordId = boundedText(input.recordId, 'record ID', 64);
  await negotiate(runtime, [
    MEMORY_CAPABILITY.preferenceList,
    MEMORY_CAPABILITY.preferenceHistory,
  ], input.requestId);
  const visible = await runtime.port.listPreferences({
    tenantId: runtime.config.tenantId,
    subjectId: actor,
    purpose: runtime.config.purpose,
  }, input.requestId);
  if (!visible.some((item) => item.recordId === recordId && isQuantPilotPreference(item))) {
    throw new MemoryIntegrationError('MEMORY_PREFERENCE_NOT_FOUND', 404, 'Memory preference was not found.');
  }
  return runtime.port.getRevisions({
    tenantId: runtime.config.tenantId,
    subjectId: actor,
    purpose: runtime.config.purpose,
    recordId,
  }, input.requestId);
}

export async function getPersonalMemoryUseAttribution(input: {
  projectId: string;
  actorUserId: string;
  requestId: string;
}, overrides: Partial<MemoryDependencies> = {}): Promise<{
  requestId: string;
  revisionIds: string[];
  contentSha256: string;
}> {
  const runtime = dependencies(overrides);
  requireEnabled(runtime.config);
  const use = await runtime.uses.find(input.projectId, input.requestId);
  if (
    !use
    || use.tenantId !== runtime.config.tenantId
    || use.subjectId !== subjectId(input.actorUserId)
  ) {
    throw new MemoryIntegrationError('MEMORY_USE_NOT_FOUND', 404, 'Memory use was not found.');
  }
  return {
    requestId: use.requestId,
    revisionIds: use.exposedRevisionIds,
    contentSha256: use.deliveredContextSha256,
  };
}

export interface PersonalMemoryValueSummary {
  exposedRunCount: number;
  exposedRevisionReferenceCount: number;
  legacyEmptyAttributionCount: number;
  lastExposedAt: Date | null;
  completedFeedbackCount: number;
  helpfulFeedbackCount: number;
  rejectedFeedbackCount: number;
  pendingFeedbackCount: number;
  failedFeedbackCount: number;
}

export async function getPersonalMemoryValueSummary(
  actorUserId: string,
  overrides: {
    uses?: ExternalMemoryUseRepository;
    feedback?: PersonalMemoryFeedbackRepository;
  } = {},
): Promise<PersonalMemoryValueSummary> {
  const actor = subjectId(actorUserId);
  const uses = overrides.uses ?? new PrismaExternalMemoryUseRepository();
  const feedback = overrides.feedback ?? new PrismaPersonalMemoryFeedbackRepository();
  const [useSummary, feedbackSummary] = await Promise.all([
    uses.summarize(actor),
    feedback.summarize(actor),
  ]);
  return {
    exposedRunCount: useSummary.exposedRunCount,
    exposedRevisionReferenceCount: useSummary.exposedRevisionReferenceCount,
    legacyEmptyAttributionCount: useSummary.legacyEmptyAttributionCount,
    lastExposedAt: useSummary.lastExposedAt,
    completedFeedbackCount: feedbackSummary.completedCount,
    helpfulFeedbackCount: feedbackSummary.helpfulCount,
    rejectedFeedbackCount: feedbackSummary.rejectedCount,
    pendingFeedbackCount: feedbackSummary.pendingCount,
    failedFeedbackCount: feedbackSummary.failedCount,
  };
}

export async function recordPersonalMemoryFeedback(input: {
  projectId: string;
  actorUserId: string;
  requestId: string;
  revisionId: string;
  eventId: string;
  kind: MemoryOutcomeKind;
  weight?: number;
  note?: string;
  occurredAt?: string;
}, overrides: Partial<MemoryDependencies> = {}): Promise<{ outcomeId: string; idempotentReplay: boolean }> {
  const runtime = dependencies(overrides);
  requireEnabled(runtime.config);
  const use = await runtime.uses.find(input.projectId, input.requestId);
  const actor = subjectId(input.actorUserId);
  if (!use || use.tenantId !== runtime.config.tenantId || use.subjectId !== actor) {
    throw new MemoryIntegrationError('MEMORY_USE_NOT_FOUND', 404, 'Memory use was not found.');
  }
  if (!use.exposedRevisionIds.includes(input.revisionId)) {
    throw new MemoryIntegrationError(
      'MEMORY_REVISION_NOT_EXPOSED',
      422,
      'The revision was not exposed to this request.',
    );
  }
  const weight = input.weight ?? 1;
  if (!Number.isFinite(weight) || weight <= 0 || weight > 10) {
    throw new MemoryIntegrationError('INVALID_MEMORY_INPUT', 400, 'Invalid outcome weight.');
  }
  const stableEventId = eventId(input.eventId);
  await requirePersonalizationEnabled(runtime, actor);
  await negotiate(runtime, [MEMORY_CAPABILITY.experienceOutcome], stableEventId);
  let begun: Awaited<ReturnType<PersonalMemoryFeedbackRepository['begin']>>;
  try {
    begun = await runtime.feedback.begin({
      provider: MEMORY_PROVIDER_ID,
      projectId: input.projectId,
      requestId: input.requestId,
      subjectId: actor,
      revisionId: input.revisionId,
      eventId: stableEventId,
      kind: input.kind,
    });
  } catch (error) {
    if (error instanceof PersonalMemoryFeedbackConflictError) {
      throw new MemoryIntegrationError(
        'MEMORY_FEEDBACK_CONFLICT',
        409,
        error.message,
      );
    }
    throw error;
  }
  if (!begun.shouldSubmit && begun.receipt.outcomeId) {
    return { outcomeId: begun.receipt.outcomeId, idempotentReplay: true };
  }

  try {
    const outcome = await runtime.port.recordOutcome({
      tenantId: use.tenantId,
      subjectId: actor,
      traceId: use.traceId,
      revisionId: input.revisionId,
      kind: input.kind,
      idempotencyKey: `quantpilot:${stableEventId}:outcome`,
      weight,
      purpose: runtime.config.purpose,
      note: input.note?.trim().slice(0, 4_096),
      occurredAt: input.occurredAt,
    }, stableEventId);
    await runtime.feedback.complete(begun.receipt.id, outcome.outcomeId);
    return outcome;
  } catch (error) {
    const failure = safeFailure(error);
    await runtime.feedback.fail(begun.receipt.id, failure.code).catch(() => undefined);
    throw error;
  }
}
