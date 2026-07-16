import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAuthSession: vi.fn(),
  loadUserAccessDetails: vi.fn(),
}));

vi.mock('@/lib/auth/authorization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/authorization')>();
  return {
    ...actual,
    requireAuthSession: mocks.requireAuthSession,
  };
});

vi.mock('@/lib/auth/access-management', () => ({
  loadUserAccessDetails: mocks.loadUserAccessDetails,
}));

import { AuthorizationError } from '@/lib/auth/authorization';
import { GET } from './route';

describe('GET /api/account/usage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAuthSession.mockResolvedValue({
      user: { id: 'current-user', role: 'member' },
      session: { id: 'session-1', createdAt: new Date() },
    });
    mocks.loadUserAccessDetails.mockResolvedValue({
      user: { id: 'current-user' },
      quotas: [{ metric: 'agent.requests.daily', used: '3', remaining: '97' }],
    });
  });

  it('ignores user selectors and loads usage only for the authenticated principal', async () => {
    const request = new NextRequest(
      'http://localhost/api/account/usage?userId=another-user&actorUserId=admin-1',
    );

    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(mocks.requireAuthSession).toHaveBeenCalledWith(request.headers);
    expect(mocks.loadUserAccessDetails).toHaveBeenCalledTimes(1);
    expect(mocks.loadUserAccessDetails).toHaveBeenCalledWith('current-user');
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      data: { user: { id: 'current-user' } },
    });
  });

  it('does not query usage when authentication fails', async () => {
    mocks.requireAuthSession.mockRejectedValueOnce(
      new AuthorizationError('AUTHENTICATION_REQUIRED', 401, '请先登录。'),
    );

    const response = await GET(new NextRequest('http://localhost/api/account/usage'));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'AUTHENTICATION_REQUIRED',
    });
    expect(mocks.loadUserAccessDetails).not.toHaveBeenCalled();
  });
});
