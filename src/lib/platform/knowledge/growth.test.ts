import { describe, expect, it, vi } from 'vitest';

import type { KnowledgeFeedbackResult } from './types';
import {
  persistAcceptedGovernedKnowledgeUse,
  recordGovernedKnowledgeBusinessFeedback,
} from './growth';
import type { GovernedKnowledgeUseRecord, GovernedKnowledgeUseRepository } from './use-repository';
import { getProjectIntegrationScope } from '@/lib/platform/context/integration-scope';

const integrationScope = getProjectIntegrationScope('project-1');
const testSpaceId = integrationScope.knowledge.projectSpaceId
  ?? integrationScope.knowledge.requestedSpaceIds[0]!;
const capsuleScope = {
  integrationScopeSha256: integrationScope.scopeSha256,
  consumerId: integrationScope.consumerId,
  requestedSpaceIds: integrationScope.knowledge.requestedSpaceIds,
  projectSpaceId: integrationScope.knowledge.projectSpaceId,
};

function knowledgeUseRecord(
  overrides: Partial<GovernedKnowledgeUseRecord> = {}
): GovernedKnowledgeUseRecord {
  return {
    id: 'use-1',
    provider: 'akep-http-v0.1',
    projectId: 'project-1',
    requestId: 'request-1',
    consumerId: integrationScope.consumerId,
    integrationScopeSha256: integrationScope.scopeSha256,
    requestedSpaceIds: integrationScope.knowledge.requestedSpaceIds,
    projectSpaceId: integrationScope.knowledge.projectSpaceId,
    contextPackId: `urn:akep:context:sha256:${'a'.repeat(64)}`,
    exposureReceiptId: 'urn:uuid:00000000-0000-4000-8000-000000000001',
    contextDigest: `sha256:${'b'.repeat(64)}`,
    policyEpoch: 'epoch-1',
    taskCategory: 'risk-dashboard',
    citations: [
      {
        citationId: 'urn:akep:citation:one',
        payloadDigest: `sha256:${'c'.repeat(64)}`,
        locator: { type: 'text-offset', start: 0, end: 10 },
        revisionId: `urn:akep:sha256:${'d'.repeat(64)}`,
        spaceId: testSpaceId,
      },
    ],
    usageReceipts: [
      {
        usageId: 'urn:uuid:00000000-0000-4000-8000-000000000002',
        exposureReceiptId: 'urn:uuid:00000000-0000-4000-8000-000000000001',
        spaceId: testSpaceId,
        policyEpoch: 'epoch-1',
        createdAt: new Date().toISOString(),
        feedbackUntil: new Date(Date.now() + 60_000).toISOString(),
      },
    ],
    acceptedReceiptId: 'acceptance-1',
    acceptedReceiptSha256: `sha256:${'e'.repeat(64)}`,
    feedbackStatus: 'awaiting_feedback',
    feedbackEventId: null,
    feedbackOutcome: null,
    feedbackActorUserId: null,
    providerFeedbackReceipts: [],
    lastErrorCode: null,
    feedbackCompletedAt: null,
    ...overrides,
  };
}

function repository(record = knowledgeUseRecord()): GovernedKnowledgeUseRepository {
  return {
    save: vi.fn(async () => record),
    find: vi.fn(async () => record),
    beginFeedback: vi.fn(async (input) => ({
      record: knowledgeUseRecord({
        feedbackStatus: 'pending',
        feedbackEventId: input.eventId,
        feedbackOutcome: input.outcome,
        feedbackActorUserId: input.actorUserId,
      }),
      shouldSubmit: true,
    })),
    completeFeedback: vi.fn(async (_id, receipts) =>
      knowledgeUseRecord({
        feedbackStatus: 'completed',
        feedbackEventId: 'knowledge-feedback:request-1:helped',
        feedbackOutcome: 'helped',
        feedbackActorUserId: 'user-1',
        providerFeedbackReceipts: receipts,
        feedbackCompletedAt: new Date(),
      })
    ),
    failFeedback: vi.fn(async () => undefined),
  };
}

describe('governed knowledge growth loop', () => {
  it('persists only accepted AKEP identifiers and citation bindings', async () => {
    const repo = repository();
    const result = await persistAcceptedGovernedKnowledgeUse(
      {
        projectId: 'project-1',
        requestId: 'request-1',
        taskCategory: 'risk-dashboard',
        capsule: {
          content: 'untrusted full context',
          contextPackId: `urn:akep:context:sha256:${'a'.repeat(64)}`,
          contextDigest: `sha256:${'b'.repeat(64)}`,
          exposureReceiptId: 'urn:uuid:00000000-0000-4000-8000-000000000001',
          policyEpoch: 'epoch-1',
          purpose: 'quant-research',
          citations: [
            {
              ...knowledgeUseRecord().citations[0],
              chunkId: 'chunk-1',
              quote: 'must not be copied into the local attribution row',
              recordId: 'https://knowledge.example/records/risk',
            },
          ],
          obligations: ['cite'],
          qualityDecision: 'suitable',
          warningCodes: [],
          ...capsuleScope,
        },
        usage: {
          status: 'recorded',
          usageReceipts: knowledgeUseRecord().usageReceipts,
        },
        acceptedReceiptId: 'acceptance-1',
        acceptedReceiptSha256: `sha256:${'e'.repeat(64)}`,
      },
      { repository: repo }
    );

    expect(result).toMatchObject({
      citationCount: 1,
      feedbackStatus: 'awaiting_feedback',
    });
    expect(repo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        citations: [expect.not.objectContaining({ quote: expect.anything() })],
      })
    );
  });

  it('rejects a malformed Mission acceptance digest before local persistence', async () => {
    const repo = repository();

    await expect(
      persistAcceptedGovernedKnowledgeUse(
        {
          projectId: 'project-1',
          requestId: 'request-1',
          taskCategory: 'risk-dashboard',
          capsule: {
            content: 'context',
            contextPackId: `urn:akep:context:sha256:${'a'.repeat(64)}`,
            contextDigest: `sha256:${'b'.repeat(64)}`,
            exposureReceiptId: 'urn:uuid:00000000-0000-4000-8000-000000000001',
            policyEpoch: 'epoch-1',
            purpose: 'quant-research',
            citations: [],
            obligations: [],
            qualityDecision: 'suitable',
            warningCodes: [],
            ...capsuleScope,
          },
          usage: {
            status: 'recorded',
            usageReceipts: knowledgeUseRecord().usageReceipts,
          },
          acceptedReceiptId: 'acceptance-1',
          acceptedReceiptSha256: 'forged',
        },
        { repository: repo }
      )
    ).rejects.toThrow('Accepted receipt SHA-256 is invalid.');

    expect(repo.save).not.toHaveBeenCalled();
  });

  it('turns explicit user outcome into the one final AKEP Feedback', async () => {
    const repo = repository();
    const submitFeedback = vi.fn(
      async (): Promise<KnowledgeFeedbackResult> => ({
        status: 'recorded',
        outcome: 'helped',
        feedbackReceipts: [
          {
            feedbackId: 'urn:quantpilot:knowledge-feedback:one',
            usageId: knowledgeUseRecord().usageReceipts[0].usageId,
            evidenceId: 'urn:uuid:00000000-0000-4000-8000-000000000003',
            policyEpoch: 'epoch-1',
            receivedAt: new Date().toISOString(),
            status: 'recorded',
            correlationClass: 'same_organization',
            eligibleForAggregation: true,
            evaluatorVersion: {
              uri: 'urn:quantpilot:evaluator:human-business-outcome:v1',
              digest: `sha256:${'f'.repeat(64)}`,
            },
          },
        ],
      })
    );

    const result = await recordGovernedKnowledgeBusinessFeedback(
      {
        projectId: 'project-1',
        requestId: 'request-1',
        actorUserId: 'user-1',
        eventId: 'knowledge-feedback:request-1:helped',
        outcome: 'helped',
      },
      { repository: repo, submitFeedback }
    );

    expect(result).toMatchObject({
      feedbackStatus: 'completed',
      feedbackOutcome: 'helped',
    });
    expect(submitFeedback).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: 'helped',
        citations: knowledgeUseRecord().citations,
      })
    );
    expect(repo.completeFeedback).toHaveBeenCalledOnce();
  });
});
