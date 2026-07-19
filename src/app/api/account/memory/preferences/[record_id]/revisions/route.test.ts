import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuthSession: vi.fn(),
  getPersonalPreferenceRevisions: vi.fn(),
}));

vi.mock('@/lib/auth/authorization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/authorization')>();
  return { ...actual, requireAuthSession: mocks.requireAuthSession };
});
vi.mock('@/lib/platform/memory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/memory')>();
  return { ...actual, getPersonalPreferenceRevisions: mocks.getPersonalPreferenceRevisions };
});

import { GET } from './route';

describe('/api/account/memory/preferences/:recordId/revisions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthSession.mockResolvedValue({ user: { id: 'user-a' } });
    mocks.getPersonalPreferenceRevisions.mockResolvedValue([{ id: 'revision-a', sequence: 1 }]);
  });

  it('lists immutable history only for the authenticated subject', async () => {
    const response = await GET(
      new NextRequest('http://localhost/api/account/memory/preferences/record-a/revisions?subjectId=other'),
      { params: Promise.resolve({ record_id: 'record-a' }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(mocks.getPersonalPreferenceRevisions).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 'user-a',
      recordId: 'record-a',
    }));
  });
});
