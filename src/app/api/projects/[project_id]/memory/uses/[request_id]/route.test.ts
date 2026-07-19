import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAction: vi.fn(),
  getPersonalMemoryUseAttribution: vi.fn(),
}));

vi.mock('@/lib/auth/action', () => ({ requireAction: mocks.requireAction }));
vi.mock('@/lib/platform/memory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/memory')>();
  return { ...actual, getPersonalMemoryUseAttribution: mocks.getPersonalMemoryUseAttribution };
});

import { GET } from './route';

describe('/api/projects/:projectId/memory/uses/:requestId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAction.mockResolvedValue({ actorUserId: 'trusted-user-a' });
    mocks.getPersonalMemoryUseAttribution.mockResolvedValue({
      requestId: 'request-a',
      revisionIds: ['revision-a'],
      contentSha256: 'hash-a',
    });
  });

  it('returns only opaque attribution scoped to the trusted actor and project', async () => {
    const response = await GET(
      new NextRequest('http://localhost/api/projects/project-a/memory/uses/request-a'),
      { params: Promise.resolve({ project_id: 'project-a', request_id: 'request-a' }) },
    );
    const payload = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.getPersonalMemoryUseAttribution).toHaveBeenCalledWith({
      projectId: 'project-a',
      actorUserId: 'trusted-user-a',
      requestId: 'request-a',
    });
    expect(payload.data).toEqual({
      requestId: 'request-a',
      revisionIds: ['revision-a'],
      contentSha256: 'hash-a',
    });
  });
});
