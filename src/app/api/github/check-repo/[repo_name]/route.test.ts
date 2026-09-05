import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAction: vi.fn(),
  checkRepositoryAvailability: vi.fn(),
}));

vi.mock('@/lib/auth/action', () => ({ requireAction: mocks.requireAction }));
vi.mock('@/lib/services/github', () => ({
  checkRepositoryAvailability: mocks.checkRepositoryAvailability,
}));

import { AuthorizationError } from '@/lib/auth/authorization';
import { GET } from './route';

const request = new NextRequest('http://localhost/api/github/check-repo/quantpilot-demo');
const context = { params: Promise.resolve({ repo_name: 'quantpilot-demo' }) };

describe('GET /api/github/check-repo/[repo_name]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAction.mockResolvedValue({ session: { user: { id: 'user-a' } } });
    mocks.checkRepositoryAvailability.mockResolvedValue({ exists: false, username: 'octocat' });
  });

  it('returns an explicit availability contract', async () => {
    const response = await GET(request, context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ available: true, username: 'octocat' });
    expect(mocks.checkRepositoryAvailability).toHaveBeenCalledWith('quantpilot-demo');
  });

  it('uses conflict for an existing repository', async () => {
    mocks.checkRepositoryAvailability.mockResolvedValue({ exists: true, username: 'octocat' });

    const response = await GET(request, context);

    expect(response.status).toBe(409);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    await expect(response.json()).resolves.toMatchObject({ available: false });
  });

  it('rejects invalid names before contacting GitHub', async () => {
    const response = await GET(
      new NextRequest('http://localhost/api/github/check-repo/alpha..beta'),
      { params: Promise.resolve({ repo_name: 'alpha..beta' }) },
    );

    expect(response.status).toBe(400);
    expect(mocks.checkRepositoryAvailability).not.toHaveBeenCalled();
  });

  it('checks authorization before contacting GitHub', async () => {
    mocks.requireAction.mockRejectedValue(
      new AuthorizationError('FORBIDDEN', 403, '无权管理平台凭据。'),
    );

    const response = await GET(request, context);

    expect(response.status).toBe(403);
    expect(mocks.checkRepositoryAvailability).not.toHaveBeenCalled();
  });

  it('does not expose upstream errors', async () => {
    mocks.checkRepositoryAvailability.mockRejectedValue(
      Object.assign(new Error('token secret leaked'), { status: 500 }),
    );

    const response = await GET(request, context);

    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain('secret');
  });
});
