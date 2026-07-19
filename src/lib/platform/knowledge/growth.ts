import type {
  GovernedKnowledgeCapsule,
  KnowledgeFeedbackOutcome,
  KnowledgeUsageResult,
} from './types';
import { recordGovernedKnowledgeFeedback } from './service';
import {
  GovernedKnowledgeFeedbackConflictError,
  GovernedKnowledgeUseNotFoundError,
  PrismaGovernedKnowledgeUseRepository,
  type GovernedKnowledgeUseRecord,
  type GovernedKnowledgeUseRepository,
} from './use-repository';
import { getProjectIntegrationScope } from '@/lib/platform/context/integration-scope';

interface GrowthDependencies {
  repository: GovernedKnowledgeUseRepository;
  submitFeedback: typeof recordGovernedKnowledgeFeedback;
}

function dependencies(overrides: Partial<GrowthDependencies> = {}): GrowthDependencies {
  return {
    repository: overrides.repository ?? new PrismaGovernedKnowledgeUseRepository(),
    submitFeedback: overrides.submitFeedback ?? recordGovernedKnowledgeFeedback,
  };
}

function boundedIdentifier(value: string, label: string, maxLength = 255): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength || !/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    throw new GovernedKnowledgeGrowthInputError(`${label} is invalid.`);
  }
  return normalized;
}

function taskCategory(value: string): string {
  const normalized = value.trim().slice(0, 255);
  return normalized || 'quant-research';
}

function sha256Digest(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^sha256:[0-9a-f]{64}$/.test(normalized)) {
    throw new GovernedKnowledgeGrowthInputError(`${label} is invalid.`);
  }
  return normalized;
}

function feedbackOpen(record: GovernedKnowledgeUseRecord): boolean {
  if (record.feedbackStatus === 'completed') return false;
  return record.usageReceipts.some((receipt) => Date.parse(receipt.feedbackUntil) > Date.now());
}

export class GovernedKnowledgeGrowthInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GovernedKnowledgeGrowthInputError';
  }
}

export class GovernedKnowledgeGrowthUnavailableError extends Error {
  constructor(readonly code: string) {
    super('Governed knowledge outcome could not be recorded.');
    this.name = 'GovernedKnowledgeGrowthUnavailableError';
  }
}

export interface GovernedKnowledgeAttribution {
  requestId: string;
  citationCount: number;
  revisionCount: number;
  spaceCount: number;
  feedbackStatus: GovernedKnowledgeUseRecord['feedbackStatus'];
  feedbackOutcome: KnowledgeFeedbackOutcome | null;
  feedbackAvailable: boolean;
}

function attribution(record: GovernedKnowledgeUseRecord): GovernedKnowledgeAttribution {
  return {
    requestId: record.requestId,
    citationCount: record.citations.length,
    revisionCount: new Set(record.citations.map((citation) => citation.revisionId)).size,
    spaceCount: new Set(record.citations.map((citation) => citation.spaceId)).size,
    feedbackStatus: record.feedbackStatus,
    feedbackOutcome: record.feedbackOutcome,
    feedbackAvailable: feedbackOpen(record),
  };
}

export async function persistAcceptedGovernedKnowledgeUse(input: {
  projectId: string;
  requestId: string;
  taskCategory: string;
  capsule: GovernedKnowledgeCapsule | null;
  usage: KnowledgeUsageResult;
  acceptedReceiptId: string;
  acceptedReceiptSha256: string;
}, overrides: Partial<GrowthDependencies> = {}): Promise<GovernedKnowledgeAttribution | null> {
  if (!input.capsule || input.usage.status !== 'recorded' || input.usage.usageReceipts.length === 0) {
    return null;
  }
  const expectedScope = getProjectIntegrationScope(input.projectId);
  if (
    input.capsule.integrationScopeSha256 !== expectedScope.scopeSha256
    || input.capsule.consumerId !== expectedScope.consumerId
    || JSON.stringify([...input.capsule.requestedSpaceIds].sort())
      !== JSON.stringify(expectedScope.knowledge.requestedSpaceIds)
  ) {
    throw new GovernedKnowledgeGrowthInputError(
      'Governed knowledge capsule is outside the accepted project integration scope.',
    );
  }
  const deliveredSpaceIds = [
    ...input.capsule.citations.map((citation) => citation.spaceId),
    ...input.usage.usageReceipts.map((receipt) => receipt.spaceId),
  ];
  if (deliveredSpaceIds.some((spaceId) => !input.capsule!.requestedSpaceIds.includes(spaceId))) {
    throw new GovernedKnowledgeGrowthInputError(
      'Governed knowledge attribution contains a Space outside the accepted project scope.',
    );
  }
  const runtime = dependencies(overrides);
  const record = await runtime.repository.save({
    projectId: boundedIdentifier(input.projectId, 'Project ID'),
    requestId: boundedIdentifier(input.requestId, 'Request ID'),
    consumerId: input.capsule.consumerId,
    integrationScopeSha256: input.capsule.integrationScopeSha256,
    requestedSpaceIds: input.capsule.requestedSpaceIds,
    projectSpaceId: input.capsule.projectSpaceId,
    contextPackId: input.capsule.contextPackId,
    exposureReceiptId: input.capsule.exposureReceiptId,
    contextDigest: input.capsule.contextDigest,
    policyEpoch: input.capsule.policyEpoch,
    taskCategory: taskCategory(input.taskCategory),
    citations: input.capsule.citations.map((citation) => ({
      citationId: citation.citationId,
      payloadDigest: citation.payloadDigest,
      locator: citation.locator,
      revisionId: citation.revisionId,
      spaceId: citation.spaceId,
    })),
    usageReceipts: input.usage.usageReceipts,
    acceptedReceiptId: boundedIdentifier(input.acceptedReceiptId, 'Accepted receipt ID'),
    acceptedReceiptSha256: sha256Digest(
      input.acceptedReceiptSha256,
      'Accepted receipt SHA-256',
    ),
  });
  return attribution(record);
}

export async function getGovernedKnowledgeAttribution(input: {
  projectId: string;
  requestId: string;
}, overrides: Partial<GrowthDependencies> = {}): Promise<GovernedKnowledgeAttribution> {
  const runtime = dependencies(overrides);
  const record = await runtime.repository.find(
    boundedIdentifier(input.projectId, 'Project ID'),
    boundedIdentifier(input.requestId, 'Request ID'),
  );
  if (!record) throw new GovernedKnowledgeUseNotFoundError();
  return attribution(record);
}

export async function recordGovernedKnowledgeBusinessFeedback(input: {
  projectId: string;
  requestId: string;
  actorUserId: string;
  eventId: string;
  outcome: KnowledgeFeedbackOutcome;
}, overrides: Partial<GrowthDependencies> = {}): Promise<GovernedKnowledgeAttribution> {
  if (!['helped', 'neutral', 'harmed'].includes(input.outcome)) {
    throw new GovernedKnowledgeGrowthInputError('Knowledge feedback outcome is invalid.');
  }
  const runtime = dependencies(overrides);
  const claim = await runtime.repository.beginFeedback({
    projectId: boundedIdentifier(input.projectId, 'Project ID'),
    requestId: boundedIdentifier(input.requestId, 'Request ID'),
    actorUserId: boundedIdentifier(input.actorUserId, 'Actor user ID'),
    eventId: boundedIdentifier(input.eventId, 'Feedback event ID'),
    outcome: input.outcome,
  });
  if (!claim.shouldSubmit) return attribution(claim.record);
  if (!feedbackOpen(claim.record)) {
    await runtime.repository.failFeedback(claim.record.id, 'KNOWLEDGE_FEEDBACK_EXPIRED');
    throw new GovernedKnowledgeGrowthUnavailableError('KNOWLEDGE_FEEDBACK_EXPIRED');
  }
  const result = await runtime.submitFeedback({
    citations: claim.record.citations,
    contextDigest: claim.record.contextDigest,
    usage: { status: 'recorded', usageReceipts: claim.record.usageReceipts },
    requestId: claim.record.requestId,
    taskCategory: claim.record.taskCategory,
    eventId: claim.record.feedbackEventId!,
    outcome: input.outcome,
    acceptedReceiptId: claim.record.acceptedReceiptId,
    acceptedReceiptSha256: claim.record.acceptedReceiptSha256,
  });
  if (result.status !== 'recorded') {
    const code = result.failureCode ?? 'KNOWLEDGE_FEEDBACK_UNAVAILABLE';
    await runtime.repository.failFeedback(claim.record.id, code);
    throw new GovernedKnowledgeGrowthUnavailableError(code);
  }
  return attribution(await runtime.repository.completeFeedback(
    claim.record.id,
    result.feedbackReceipts,
  ));
}

export {
  GovernedKnowledgeFeedbackConflictError,
  GovernedKnowledgeUseNotFoundError,
};
