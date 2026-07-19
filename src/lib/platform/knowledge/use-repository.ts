import { isDeepStrictEqual } from 'node:util';

import type { GovernedKnowledgeUse, Prisma } from '@prisma/client';

import { prisma } from '@/lib/db/client';

import type {
  KnowledgeFeedbackCitation,
  KnowledgeFeedbackOutcome,
  KnowledgeFeedbackReceipt,
  KnowledgeUsageReceipt,
} from './types';

export const GOVERNED_KNOWLEDGE_PROVIDER_ID = 'akep-http-v0.1' as const;

export type GovernedKnowledgeFeedbackStatus =
  | 'awaiting_feedback'
  | 'pending'
  | 'completed'
  | 'failed';

export interface GovernedKnowledgeUseRecord {
  id: string;
  provider: typeof GOVERNED_KNOWLEDGE_PROVIDER_ID;
  projectId: string;
  requestId: string;
  consumerId: string;
  integrationScopeSha256: string;
  requestedSpaceIds: string[];
  projectSpaceId: string | null;
  contextPackId: string;
  exposureReceiptId: string;
  contextDigest: string;
  policyEpoch: string;
  taskCategory: string;
  citations: KnowledgeFeedbackCitation[];
  usageReceipts: KnowledgeUsageReceipt[];
  acceptedReceiptId: string;
  acceptedReceiptSha256: string;
  feedbackStatus: GovernedKnowledgeFeedbackStatus;
  feedbackEventId: string | null;
  feedbackOutcome: KnowledgeFeedbackOutcome | null;
  feedbackActorUserId: string | null;
  providerFeedbackReceipts: KnowledgeFeedbackReceipt[];
  lastErrorCode: string | null;
  feedbackCompletedAt: Date | null;
}

export interface GovernedKnowledgeUseWrite {
  projectId: string;
  requestId: string;
  consumerId: string;
  integrationScopeSha256: string;
  requestedSpaceIds: string[];
  projectSpaceId: string | null;
  contextPackId: string;
  exposureReceiptId: string;
  contextDigest: string;
  policyEpoch: string;
  taskCategory: string;
  citations: KnowledgeFeedbackCitation[];
  usageReceipts: KnowledgeUsageReceipt[];
  acceptedReceiptId: string;
  acceptedReceiptSha256: string;
}

export interface GovernedKnowledgeFeedbackClaim {
  projectId: string;
  requestId: string;
  actorUserId: string;
  eventId: string;
  outcome: KnowledgeFeedbackOutcome;
}

export class GovernedKnowledgeUseNotFoundError extends Error {
  constructor() {
    super('No accepted governed knowledge use exists for this request.');
    this.name = 'GovernedKnowledgeUseNotFoundError';
  }
}

export class GovernedKnowledgeFeedbackConflictError extends Error {
  constructor() {
    super('Governed knowledge feedback was already claimed with different semantics.');
    this.name = 'GovernedKnowledgeFeedbackConflictError';
  }
}

export class GovernedKnowledgeUseCollisionError extends Error {
  constructor() {
    super('Governed knowledge use attribution collided with a different accepted context.');
    this.name = 'GovernedKnowledgeUseCollisionError';
  }
}

function jsonInput(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function citations(value: Prisma.JsonValue): KnowledgeFeedbackCitation[] {
  if (!Array.isArray(value)) throw new GovernedKnowledgeUseCollisionError();
  return value.map((item) => {
    const data = object(item);
    const locator = object(data?.locator);
    if (!data || !locator) throw new GovernedKnowledgeUseCollisionError();
    const citation = {
      citationId: stringValue(data.citationId),
      payloadDigest: stringValue(data.payloadDigest),
      locator,
      revisionId: stringValue(data.revisionId),
      spaceId: stringValue(data.spaceId),
    };
    if (Object.values(citation).some((field) => typeof field === 'string' && !field)) {
      throw new GovernedKnowledgeUseCollisionError();
    }
    return citation;
  });
}

function usageReceipts(value: Prisma.JsonValue): KnowledgeUsageReceipt[] {
  if (!Array.isArray(value)) throw new GovernedKnowledgeUseCollisionError();
  return value.map((item) => {
    const data = object(item);
    if (!data) throw new GovernedKnowledgeUseCollisionError();
    const receipt = {
      usageId: stringValue(data.usageId),
      exposureReceiptId: stringValue(data.exposureReceiptId),
      spaceId: stringValue(data.spaceId),
      policyEpoch: stringValue(data.policyEpoch),
      createdAt: stringValue(data.createdAt),
      feedbackUntil: stringValue(data.feedbackUntil),
    };
    if (Object.values(receipt).some((field) => !field)) {
      throw new GovernedKnowledgeUseCollisionError();
    }
    return receipt;
  });
}

function stringArray(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new GovernedKnowledgeUseCollisionError();
  }
  return [...new Set(value)].sort();
}

function feedbackReceipts(value: Prisma.JsonValue | null): KnowledgeFeedbackReceipt[] {
  if (value === null) return [];
  if (!Array.isArray(value)) throw new GovernedKnowledgeUseCollisionError();
  return value as unknown as KnowledgeFeedbackReceipt[];
}

function feedbackStatus(value: string): GovernedKnowledgeFeedbackStatus {
  if (value === 'pending' || value === 'completed' || value === 'failed') return value;
  return 'awaiting_feedback';
}

function feedbackOutcome(value: string | null): KnowledgeFeedbackOutcome | null {
  return value === 'helped' || value === 'neutral' || value === 'harmed' ? value : null;
}

function mapRow(row: GovernedKnowledgeUse): GovernedKnowledgeUseRecord {
  return {
    ...row,
    provider: GOVERNED_KNOWLEDGE_PROVIDER_ID,
    requestedSpaceIds: stringArray(row.requestedSpaceIds),
    citations: citations(row.citations),
    usageReceipts: usageReceipts(row.usageReceipts),
    feedbackStatus: feedbackStatus(row.feedbackStatus),
    feedbackOutcome: feedbackOutcome(row.feedbackOutcome),
    providerFeedbackReceipts: feedbackReceipts(row.providerFeedbackReceipts),
  };
}

function immutableProjection(input: GovernedKnowledgeUseWrite) {
  return {
    projectId: input.projectId,
    requestId: input.requestId,
    consumerId: input.consumerId,
    integrationScopeSha256: input.integrationScopeSha256,
    requestedSpaceIds: [...input.requestedSpaceIds].sort(),
    projectSpaceId: input.projectSpaceId,
    contextPackId: input.contextPackId,
    exposureReceiptId: input.exposureReceiptId,
    contextDigest: input.contextDigest,
    policyEpoch: input.policyEpoch,
    taskCategory: input.taskCategory,
    citations: input.citations,
    usageReceipts: input.usageReceipts,
    acceptedReceiptId: input.acceptedReceiptId,
    acceptedReceiptSha256: input.acceptedReceiptSha256,
  };
}

export interface GovernedKnowledgeUseRepository {
  save(input: GovernedKnowledgeUseWrite): Promise<GovernedKnowledgeUseRecord>;
  find(projectId: string, requestId: string): Promise<GovernedKnowledgeUseRecord | null>;
  beginFeedback(input: GovernedKnowledgeFeedbackClaim): Promise<{
    record: GovernedKnowledgeUseRecord;
    shouldSubmit: boolean;
  }>;
  completeFeedback(id: string, receipts: KnowledgeFeedbackReceipt[]): Promise<GovernedKnowledgeUseRecord>;
  failFeedback(id: string, errorCode: string): Promise<void>;
}

export class PrismaGovernedKnowledgeUseRepository implements GovernedKnowledgeUseRepository {
  async save(input: GovernedKnowledgeUseWrite): Promise<GovernedKnowledgeUseRecord> {
    const row = await prisma.governedKnowledgeUse.upsert({
      where: {
        provider_projectId_requestId: {
          provider: GOVERNED_KNOWLEDGE_PROVIDER_ID,
          projectId: input.projectId,
          requestId: input.requestId,
        },
      },
      update: {},
      create: {
        provider: GOVERNED_KNOWLEDGE_PROVIDER_ID,
        ...input,
        citations: jsonInput(input.citations),
        usageReceipts: jsonInput(input.usageReceipts),
        requestedSpaceIds: jsonInput(input.requestedSpaceIds),
      },
    });
    const mapped = mapRow(row);
    if (!isDeepStrictEqual(immutableProjection(mapped), immutableProjection(input))) {
      throw new GovernedKnowledgeUseCollisionError();
    }
    return mapped;
  }

  async find(projectId: string, requestId: string): Promise<GovernedKnowledgeUseRecord | null> {
    const row = await prisma.governedKnowledgeUse.findUnique({
      where: {
        provider_projectId_requestId: {
          provider: GOVERNED_KNOWLEDGE_PROVIDER_ID,
          projectId,
          requestId,
        },
      },
    });
    return row ? mapRow(row) : null;
  }

  async beginFeedback(input: GovernedKnowledgeFeedbackClaim): Promise<{
    record: GovernedKnowledgeUseRecord;
    shouldSubmit: boolean;
  }> {
    const initial = await this.find(input.projectId, input.requestId);
    if (!initial) throw new GovernedKnowledgeUseNotFoundError();
    await prisma.governedKnowledgeUse.updateMany({
      where: { id: initial.id, feedbackEventId: null },
      data: {
        feedbackEventId: input.eventId,
        feedbackOutcome: input.outcome,
        feedbackActorUserId: input.actorUserId,
        feedbackStatus: 'pending',
        lastErrorCode: null,
      },
    });
    let claimed = await this.find(input.projectId, input.requestId);
    if (!claimed) throw new GovernedKnowledgeUseNotFoundError();
    if (
      claimed.feedbackEventId !== input.eventId
      || claimed.feedbackOutcome !== input.outcome
      || claimed.feedbackActorUserId !== input.actorUserId
    ) {
      throw new GovernedKnowledgeFeedbackConflictError();
    }
    if (claimed.feedbackStatus === 'completed') return { record: claimed, shouldSubmit: false };
    if (claimed.feedbackStatus === 'failed' || claimed.feedbackStatus === 'awaiting_feedback') {
      claimed = mapRow(await prisma.governedKnowledgeUse.update({
        where: { id: claimed.id },
        data: { feedbackStatus: 'pending', lastErrorCode: null },
      }));
    }
    return { record: claimed, shouldSubmit: true };
  }

  async completeFeedback(
    id: string,
    receipts: KnowledgeFeedbackReceipt[],
  ): Promise<GovernedKnowledgeUseRecord> {
    return mapRow(await prisma.governedKnowledgeUse.update({
      where: { id },
      data: {
        feedbackStatus: 'completed',
        providerFeedbackReceipts: jsonInput(receipts),
        lastErrorCode: null,
        feedbackCompletedAt: new Date(),
      },
    }));
  }

  async failFeedback(id: string, errorCode: string): Promise<void> {
    await prisma.governedKnowledgeUse.updateMany({
      where: { id, feedbackStatus: { not: 'completed' } },
      data: { feedbackStatus: 'failed', lastErrorCode: errorCode.slice(0, 160) },
    });
  }
}
