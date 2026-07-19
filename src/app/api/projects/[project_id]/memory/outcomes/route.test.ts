import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAction: vi.fn(),
  recordPersonalMemoryFeedback: vi.fn(),
}));

vi.mock('@/lib/auth/action', () => ({ requireAction: mocks.requireAction }));
vi.mock('@/lib/platform/memory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/memory')>();
  return { ...actual, recordPersonalMemoryFeedback: mocks.recordPersonalMemoryFeedback };
});

import { POST } from './route';

const context = { params: Promise.resolve({ project_id: 'project-a' }) };

describe('/api/projects/:projectId/memory/outcomes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAction.mockResolvedValue({ actorUserId: 'trusted-user-a' });
    mocks.recordPersonalMemoryFeedback.mockResolvedValue({
      outcomeId: 'outcome-a',
      idempotentReplay: false,
    });
  });

  it('attributes feedback using only the authenticated project actor', async () => {
    const response = await POST(new NextRequest(
      'http://localhost/api/projects/project-a/memory/outcomes',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subjectId: 'forged-user',
          requestId: 'request-a',
          revisionId: 'revision-a',
          eventId: 'feedback-a',
          kind: 'helpful',
        }),
      },
    ), context);

    expect(response.status).toBe(201);
    expect(mocks.recordPersonalMemoryFeedback).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-a',
      actorUserId: 'trusted-user-a',
      requestId: 'request-a',
      revisionId: 'revision-a',
      eventId: 'feedback-a',
      kind: 'helpful',
    }));
  });

  it('rejects an unknown outcome kind before contacting the memory service', async () => {
    const response = await POST(new NextRequest(
      'http://localhost/api/projects/project-a/memory/outcomes',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'automatic_success' }),
      },
    ), context);

    expect(response.status).toBe(400);
    expect(mocks.recordPersonalMemoryFeedback).not.toHaveBeenCalled();
  });
});
