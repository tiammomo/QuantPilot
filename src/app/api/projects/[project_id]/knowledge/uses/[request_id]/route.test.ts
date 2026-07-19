import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAction: vi.fn(),
  getGovernedKnowledgeAttribution: vi.fn(),
}));

vi.mock('@/lib/auth/action', () => ({ requireAction: mocks.requireAction }));
vi.mock('@/lib/platform/knowledge', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/knowledge')>();
  return { ...actual, getGovernedKnowledgeAttribution: mocks.getGovernedKnowledgeAttribution };
});

import { GET } from './route';

describe('/api/projects/:projectId/knowledge/uses/:requestId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAction.mockResolvedValue({ actorUserId: 'trusted-user-a' });
    mocks.getGovernedKnowledgeAttribution.mockResolvedValue({
      requestId: 'request-a',
      citationCount: 2,
      revisionCount: 1,
      spaceCount: 1,
      feedbackStatus: 'awaiting_feedback',
      feedbackOutcome: null,
      feedbackAvailable: true,
    });
  });

  it('returns only request-scoped counts and feedback state', async () => {
    const response = await GET(
      new NextRequest('http://localhost/api/projects/project-a/knowledge/uses/request-a'),
      { params: Promise.resolve({ project_id: 'project-a', request_id: 'request-a' }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.getGovernedKnowledgeAttribution).toHaveBeenCalledWith({
      projectId: 'project-a',
      requestId: 'request-a',
    });
    expect(payload.data).toEqual(expect.objectContaining({
      citationCount: 2,
      feedbackStatus: 'awaiting_feedback',
    }));
    expect(payload.data).not.toHaveProperty('citations');
    expect(payload.data).not.toHaveProperty('usageReceipts');
  });
});
