import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAdminSession: vi.fn(),
  getDashboard: vi.fn(),
}));

vi.mock('@/lib/auth/authorization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/authorization')>();
  return {
    ...actual,
    requireAdminSession: mocks.requireAdminSession,
  };
});

vi.mock('@/lib/quant/generation-observability', () => ({
  getGenerationObservabilityDashboard: mocks.getDashboard,
}));

import { AuthorizationError } from '@/lib/auth/authorization';
import { GET } from './route';

const request = new NextRequest('http://localhost/api/observability/generation');

describe('generation observability authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAdminSession.mockResolvedValue({ user: { id: 'admin-1' } });
    mocks.getDashboard.mockResolvedValue({ projects: [] });
  });

  it('requires an administrator before loading cross-project telemetry', async () => {
    mocks.requireAdminSession.mockRejectedValue(
      new AuthorizationError('ADMIN_REQUIRED', 403, '需要管理员权限。'),
    );

    const response = await GET(request);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'ADMIN_REQUIRED',
    });
    expect(mocks.getDashboard).not.toHaveBeenCalled();
  });

  it('returns the dashboard after the administrator check succeeds', async () => {
    const response = await GET(request);

    expect(response.status).toBe(200);
    expect(mocks.requireAdminSession).toHaveBeenCalledWith(request.headers);
    expect(mocks.getDashboard).toHaveBeenCalledTimes(1);
  });
});
