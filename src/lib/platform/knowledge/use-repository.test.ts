import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  updateMany: vi.fn(),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    governedKnowledgeUse: {
      findUnique: mocks.findUnique,
      updateMany: mocks.updateMany,
    },
  },
}));

import {
  GovernedKnowledgeFeedbackConflictError,
  PrismaGovernedKnowledgeUseRepository,
} from './use-repository';

function row(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: 'use-1',
    provider: 'akep-http-v0.1',
    projectId: 'project-1',
    requestId: 'request-1',
    consumerId: 'quantpilot',
    integrationScopeSha256: `sha256:${'9'.repeat(64)}`,
    requestedSpaceIds: ['https://knowledge.example/spaces/research'],
    projectSpaceId: 'https://knowledge.example/spaces/research',
    contextPackId: `urn:akep:context:sha256:${'a'.repeat(64)}`,
    exposureReceiptId: 'urn:uuid:00000000-0000-4000-8000-000000000001',
    contextDigest: `sha256:${'b'.repeat(64)}`,
    policyEpoch: 'epoch-1',
    taskCategory: 'risk-dashboard',
    citations: [{
      citationId: 'urn:akep:citation:one',
      payloadDigest: `sha256:${'c'.repeat(64)}`,
      locator: { type: 'text-offset', start: 0, end: 10 },
      revisionId: `urn:akep:sha256:${'d'.repeat(64)}`,
      spaceId: 'https://knowledge.example/spaces/research',
    }],
    usageReceipts: [{
      usageId: 'urn:uuid:00000000-0000-4000-8000-000000000002',
      exposureReceiptId: 'urn:uuid:00000000-0000-4000-8000-000000000001',
      spaceId: 'https://knowledge.example/spaces/research',
      policyEpoch: 'epoch-1',
      createdAt: now.toISOString(),
      feedbackUntil: new Date(now.getTime() + 60_000).toISOString(),
    }],
    acceptedReceiptId: 'acceptance-1',
    acceptedReceiptSha256: `sha256:${'e'.repeat(64)}`,
    feedbackStatus: 'awaiting_feedback',
    feedbackEventId: null,
    feedbackOutcome: null,
    feedbackActorUserId: null,
    providerFeedbackReceipts: null,
    lastErrorCode: null,
    feedbackCompletedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('PrismaGovernedKnowledgeUseRepository feedback claim', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateMany.mockResolvedValue({ count: 0 });
  });

  it('does not let a second authenticated actor replay another actor claim', async () => {
    mocks.findUnique
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(row({
        feedbackStatus: 'pending',
        feedbackEventId: 'knowledge-feedback:request-1:helped',
        feedbackOutcome: 'helped',
        feedbackActorUserId: 'user-1',
      }));

    await expect(new PrismaGovernedKnowledgeUseRepository().beginFeedback({
      projectId: 'project-1',
      requestId: 'request-1',
      actorUserId: 'user-2',
      eventId: 'knowledge-feedback:request-1:helped',
      outcome: 'helped',
    })).rejects.toBeInstanceOf(GovernedKnowledgeFeedbackConflictError);
  });
});
