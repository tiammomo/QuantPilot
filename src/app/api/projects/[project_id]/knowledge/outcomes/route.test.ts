import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAction: vi.fn(),
  recordGovernedKnowledgeBusinessFeedback: vi.fn(),
}));

vi.mock('@/lib/auth/action', () => ({ requireAction: mocks.requireAction }));
vi.mock('@/lib/platform/knowledge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/knowledge')>();
  return {
    ...actual,
    recordGovernedKnowledgeBusinessFeedback: mocks.recordGovernedKnowledgeBusinessFeedback,
  };
});

import { POST } from './route';

const context = { params: Promise.resolve({ project_id: 'project-a' }) };

describe('/api/projects/:projectId/knowledge/outcomes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAction.mockResolvedValue({ actorUserId: 'trusted-user-a' });
    mocks.recordGovernedKnowledgeBusinessFeedback.mockResolvedValue({
      requestId: 'request-a',
      citationCount: 2,
      revisionCount: 1,
      spaceCount: 1,
      feedbackStatus: 'completed',
      feedbackOutcome: 'helped',
      feedbackAvailable: false,
    });
  });

  it('binds the explicit outcome to the authenticated project actor', async () => {
    const response = await POST(new NextRequest(
      'http://localhost/api/projects/project-a/knowledge/outcomes',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          actorUserId: 'forged-user',
          requestId: 'request-a',
          eventId: 'knowledge-feedback:request-a:helped',
          outcome: 'helped',
        }),
      },
    ), context);

    expect(response.status).toBe(201);
    expect(mocks.recordGovernedKnowledgeBusinessFeedback).toHaveBeenCalledWith({
      projectId: 'project-a',
      actorUserId: 'trusted-user-a',
      requestId: 'request-a',
      eventId: 'knowledge-feedback:request-a:helped',
      outcome: 'helped',
    });
  });

  it('rejects automatic or unknown outcome values before contacting AKEP', async () => {
    const response = await POST(new NextRequest(
      'http://localhost/api/projects/project-a/knowledge/outcomes',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ outcome: 'automatic_success' }),
      },
    ), context);

    expect(response.status).toBe(400);
    expect(mocks.recordGovernedKnowledgeBusinessFeedback).not.toHaveBeenCalled();
  });
});
