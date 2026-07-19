import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAction: vi.fn(),
  listPersonalPreferences: vi.fn(),
  rememberPersonalPreference: vi.fn(),
}));

vi.mock('@/lib/auth/action', () => ({ requireAction: mocks.requireAction }));
vi.mock('@/lib/platform/memory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/memory')>();
  return {
    ...actual,
    listPersonalPreferences: mocks.listPersonalPreferences,
    rememberPersonalPreference: mocks.rememberPersonalPreference,
  };
});

import { GET, POST } from './route';

const context = { params: Promise.resolve({ project_id: 'project-a' }) };

describe('/api/projects/:projectId/memory/preferences', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAction.mockResolvedValue({ actorUserId: 'trusted-user-a' });
    mocks.listPersonalPreferences.mockResolvedValue([]);
    mocks.rememberPersonalPreference.mockResolvedValue({
      observationId: 'observation-a',
      candidateId: 'candidate-a',
      recordId: 'record-a',
      revisionId: 'revision-a',
      sequence: 1,
      idempotentReplay: false,
    });
  });

  it('lists only the authenticated subject and marks the response private', async () => {
    const response = await GET(
      new NextRequest('http://localhost/api/projects/project-a/memory/preferences?subjectId=forged'),
      context,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.requireAction).toHaveBeenCalledWith(expect.objectContaining({
      action: 'project.read',
      projectId: 'project-a',
    }));
    expect(mocks.listPersonalPreferences).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 'trusted-user-a',
    }));
  });

  it('ignores forged identity and delegates explicit idempotency input to the service', async () => {
    const response = await POST(new NextRequest(
      'http://localhost/api/projects/project-a/memory/preferences',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          subjectId: 'forged-user',
          tenantId: 'forged-tenant',
          eventId: 'event-a',
          key: 'output.answer_style',
          value: '先给结论，再给证据',
          evidenceText: '用户明确确认',
          scope: 'project',
        }),
      },
    ), context);

    expect(response.status).toBe(201);
    expect(mocks.requireAction).toHaveBeenCalledWith(expect.objectContaining({
      action: 'project.update',
      projectId: 'project-a',
    }));
    expect(mocks.rememberPersonalPreference).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-a',
      actorUserId: 'trusted-user-a',
      eventId: 'event-a',
      scope: 'project',
    }));
    expect(mocks.rememberPersonalPreference.mock.calls[0][0]).not.toHaveProperty('tenantId');
  });

  it('rejects an unsupported scope before contacting the memory application service', async () => {
    const response = await POST(new NextRequest(
      'http://localhost/api/projects/project-a/memory/preferences',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: 'tenant' }),
      },
    ), context);

    expect(response.status).toBe(400);
    expect(mocks.rememberPersonalPreference).not.toHaveBeenCalled();
  });
});
