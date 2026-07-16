import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const transactionClient = {
    authUser: { updateMany: vi.fn() },
    userPermissionOverride: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    userQuotaOverride: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
  };
  return {
    transactionClient,
    requireAdminSession: vi.fn(),
    loadUserAccessDetails: vi.fn(),
    writeAuthAuditEvent: vi.fn(),
    authUserFindUnique: vi.fn(),
    permissionProfileFindUnique: vi.fn(),
    quotaProfileFindUnique: vi.fn(),
    quotaRuleFindMany: vi.fn(),
    transaction: vi.fn(),
  };
});

vi.mock('@/lib/auth/authorization', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/authorization')>();
  return {
    ...actual,
    requireAdminSession: mocks.requireAdminSession,
  };
});

vi.mock('@/lib/auth/access-management', () => ({
  loadUserAccessDetails: mocks.loadUserAccessDetails,
}));

vi.mock('@/lib/auth/audit', () => ({
  writeAuthAuditEvent: mocks.writeAuthAuditEvent,
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    authUser: { findUnique: mocks.authUserFindUnique },
    permissionProfile: { findUnique: mocks.permissionProfileFindUnique },
    quotaProfile: { findUnique: mocks.quotaProfileFindUnique },
    quotaRule: { findMany: mocks.quotaRuleFindMany },
    $transaction: mocks.transaction,
  },
}));

import { AuthorizationError } from '@/lib/auth/authorization';
import { GET, PATCH } from './route';

function context(userId = 'member-1') {
  return { params: Promise.resolve({ user_id: userId }) };
}

function patchRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/admin/users/member-1/access', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('/api/admin/users/[user_id]/access', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.requireAdminSession.mockResolvedValue({
      user: { id: 'admin-1', role: 'admin' },
      session: { id: 'session-1', createdAt: new Date() },
    });
    mocks.loadUserAccessDetails.mockResolvedValue({
      user: { id: 'member-1', accessVersion: 8 },
    });
    mocks.authUserFindUnique.mockResolvedValue({ id: 'member-1', role: 'member' });
    mocks.permissionProfileFindUnique.mockResolvedValue(null);
    mocks.quotaProfileFindUnique.mockResolvedValue(null);
    mocks.quotaRuleFindMany.mockResolvedValue([]);
    mocks.transactionClient.authUser.updateMany.mockResolvedValue({ count: 1 });
    mocks.transactionClient.userPermissionOverride.deleteMany.mockResolvedValue({ count: 0 });
    mocks.transactionClient.userPermissionOverride.createMany.mockResolvedValue({ count: 0 });
    mocks.transactionClient.userQuotaOverride.deleteMany.mockResolvedValue({ count: 0 });
    mocks.transactionClient.userQuotaOverride.createMany.mockResolvedValue({ count: 0 });
    mocks.transaction.mockImplementation(async (
      callback: (transaction: typeof mocks.transactionClient) => unknown,
    ) => callback(mocks.transactionClient));
  });

  it('requires an administrator before exposing another user access policy', async () => {
    mocks.requireAdminSession.mockRejectedValueOnce(
      new AuthorizationError('ADMIN_REQUIRED', 403, '需要管理员权限。'),
    );

    const response = await GET(
      new NextRequest('http://localhost/api/admin/users/member-1/access'),
      context(),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'ADMIN_REQUIRED',
    });
    expect(mocks.loadUserAccessDetails).not.toHaveBeenCalled();
  });

  it('does not allow an administrator account to be assigned restrictive policy', async () => {
    mocks.authUserFindUnique.mockResolvedValueOnce({ id: 'admin-2', role: 'admin' });

    const response = await PATCH(patchRequest({
      expectedAccessVersion: 3,
      reason: 'restrict admin account',
      permissionProfileId: 'readonly-profile',
    }), context('admin-2'));

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      message: expect.stringContaining('管理员固定为全部权限和无限配额'),
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.writeAuthAuditEvent).not.toHaveBeenCalled();
  });

  it('rejects quota overrides for metrics absent from the quota catalog', async () => {
    const response = await PATCH(patchRequest({
      expectedAccessVersion: 7,
      reason: 'temporary research allowance',
      quotaOverrides: [{
        metric: 'unknown.expensive.operation',
        limit: '5',
        enforcement: 'hard',
        windowType: 'day',
      }],
    }), context());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      message: '未知配额指标：unknown.expensive.operation',
    });
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(mocks.writeAuthAuditEvent).not.toHaveBeenCalled();
  });

  it('detects an accessVersion conflict before replacing any overrides', async () => {
    mocks.transactionClient.authUser.updateMany.mockResolvedValueOnce({ count: 0 });

    const response = await PATCH(patchRequest({
      expectedAccessVersion: 6,
      reason: 'remove project mutation rights',
      permissionOverrides: [{ permissionKey: 'project.update', effect: 'deny' }],
    }), context());

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      message: expect.stringContaining('权限配置已被其他管理员更新'),
    });
    expect(mocks.transactionClient.userPermissionOverride.deleteMany).not.toHaveBeenCalled();
    expect(mocks.transactionClient.userQuotaOverride.deleteMany).not.toHaveBeenCalled();
    expect(mocks.writeAuthAuditEvent).not.toHaveBeenCalled();
  });

  it('atomically replaces overrides, increments the version, and records the reason in audit', async () => {
    mocks.quotaRuleFindMany.mockResolvedValueOnce([{ metric: 'agent.requests.daily' }]);

    const response = await PATCH(patchRequest({
      expectedAccessVersion: 7,
      reason: 'pilot access for research team',
      permissionOverrides: [{
        permissionKey: 'research.report.send',
        effect: 'allow',
        expiresAt: '2026-08-01T00:00:00.000Z',
      }],
      quotaOverrides: [{
        metric: 'agent.requests.daily',
        limit: '250',
        enforcement: 'hard',
        windowType: 'day',
        reservationTtlSeconds: 900,
      }],
    }), context());

    expect(response.status).toBe(200);
    expect(mocks.transactionClient.authUser.updateMany).toHaveBeenCalledWith({
      where: { id: 'member-1', accessVersion: 7 },
      data: { accessVersion: { increment: 1 } },
    });
    expect(mocks.transactionClient.userPermissionOverride.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'member-1' },
    });
    expect(mocks.transactionClient.userPermissionOverride.createMany).toHaveBeenCalledWith({
      data: [{
        userId: 'member-1',
        permissionKey: 'research.report.send',
        effect: 'allow',
        reason: 'pilot access for research team',
        expiresAt: new Date('2026-08-01T00:00:00.000Z'),
      }],
    });
    expect(mocks.transactionClient.userQuotaOverride.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'member-1' },
    });
    expect(mocks.transactionClient.userQuotaOverride.createMany).toHaveBeenCalledWith({
      data: [{
        userId: 'member-1',
        metric: 'agent.requests.daily',
        isUnlimited: false,
        limit: 250n,
        enforcement: 'hard',
        windowType: 'day',
        windowSeconds: null,
        reservationTtlSeconds: 900,
        reason: 'pilot access for research team',
        expiresAt: null,
      }],
    });
    expect(mocks.writeAuthAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 'admin-1',
      eventType: 'admin.access_policy_updated',
      targetType: 'user',
      targetId: 'member-1',
      outcome: 'success',
      metadata: {
        reason: 'pilot access for research team',
        permissionOverrideCount: 1,
        quotaOverrideCount: 1,
        expectedAccessVersion: 7,
      },
    }));
    expect(mocks.loadUserAccessDetails).toHaveBeenCalledWith('member-1');
  });
});
