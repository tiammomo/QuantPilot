import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const transactionClient = {
    $queryRaw: vi.fn(),
    authUser: {
      create: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
    authAccount: {
      create: vi.fn(),
    },
    userPermissionOverride: {
      deleteMany: vi.fn(),
    },
    userQuotaOverride: {
      deleteMany: vi.fn(),
    },
    authSession: {
      deleteMany: vi.fn(),
    },
  };

  return {
    transactionClient,
    requireAdminSession: vi.fn(),
    hashAuthPassword: vi.fn(),
    writeAuthAuditEvent: vi.fn(),
    authUserFindUnique: vi.fn(),
    authUserUpdate: vi.fn(),
    authAccountUpdate: vi.fn(),
    authSessionDeleteMany: vi.fn(),
    permissionProfileFindUnique: vi.fn(),
    quotaProfileFindUnique: vi.fn(),
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

vi.mock('@/lib/auth/password', () => ({
  hashAuthPassword: mocks.hashAuthPassword,
}));

vi.mock('@/lib/auth/audit', () => ({
  writeAuthAuditEvent: mocks.writeAuthAuditEvent,
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    authUser: {
      findUnique: mocks.authUserFindUnique,
      update: mocks.authUserUpdate,
    },
    authAccount: {
      update: mocks.authAccountUpdate,
    },
    authSession: {
      deleteMany: mocks.authSessionDeleteMany,
    },
    permissionProfile: {
      findUnique: mocks.permissionProfileFindUnique,
    },
    quotaProfile: {
      findUnique: mocks.quotaProfileFindUnique,
    },
    $transaction: mocks.transaction,
  },
}));

import { PATCH, POST } from './route';

function request(method: 'POST' | 'PATCH', body: unknown): NextRequest {
  return new NextRequest('http://localhost/api/admin/users', {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function advisorySql(): string {
  const strings = mocks.transactionClient.$queryRaw.mock.calls[0]?.[0] as
    | TemplateStringsArray
    | undefined;
  return strings ? strings.join(' ') : '';
}

function expectGovernanceCheckBeforeMutation(): void {
  expect(mocks.transactionClient.$queryRaw).toHaveBeenCalledTimes(1);
  expect(advisorySql()).toContain('pg_advisory_xact_lock');
  expect(advisorySql()).toContain('auth:active-admin-governance');
  expect(mocks.transactionClient.$queryRaw.mock.invocationCallOrder[0])
    .toBeLessThan(mocks.transactionClient.authUser.findUnique.mock.invocationCallOrder[0]!);
  expect(mocks.transactionClient.authUser.findUnique.mock.invocationCallOrder[0])
    .toBeLessThan(mocks.transactionClient.authUser.count.mock.invocationCallOrder[0]!);
}

describe('/api/admin/users', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    mocks.requireAdminSession.mockResolvedValue({
      user: { id: 'admin-actor', role: 'admin' },
      session: { id: 'session-1', createdAt: new Date() },
    });
    mocks.hashAuthPassword.mockImplementation(async (password: string) => `hashed:${password}`);
    mocks.writeAuthAuditEvent.mockResolvedValue(undefined);

    mocks.authUserFindUnique.mockResolvedValue({ id: 'target-user', role: 'member' });
    mocks.permissionProfileFindUnique.mockResolvedValue({ id: 'permission-member-default' });
    mocks.quotaProfileFindUnique.mockResolvedValue({ id: 'quota-member-default' });
    mocks.authUserUpdate.mockResolvedValue({});
    mocks.authAccountUpdate.mockResolvedValue({});
    mocks.authSessionDeleteMany.mockResolvedValue({ count: 2 });

    mocks.transactionClient.$queryRaw.mockResolvedValue([]);
    mocks.transactionClient.authUser.create.mockResolvedValue({});
    mocks.transactionClient.authUser.findUnique.mockResolvedValue({ role: 'admin' });
    mocks.transactionClient.authUser.count.mockResolvedValue(2);
    mocks.transactionClient.authUser.update.mockResolvedValue({});
    mocks.transactionClient.authAccount.create.mockResolvedValue({});
    mocks.transactionClient.userPermissionOverride.deleteMany.mockResolvedValue({ count: 0 });
    mocks.transactionClient.userQuotaOverride.deleteMany.mockResolvedValue({ count: 0 });
    mocks.transactionClient.authSession.deleteMany.mockResolvedValue({ count: 2 });

    mocks.transaction.mockImplementation(async (
      operation: unknown[] | ((transaction: typeof mocks.transactionClient) => unknown),
    ) => {
      if (Array.isArray(operation)) return Promise.all(operation);
      return operation(mocks.transactionClient);
    });
  });

  it('creates a member atomically with both default access profiles and a first-login password change', async () => {
    const response = await POST(request('POST', {
      email: '  New.Member@Example.COM  ',
      name: 'New Member',
      role: 'member',
      password: 'Temporary-Password-123!',
    }));

    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload).toMatchObject({
      success: true,
      data: {
        email: 'new.member@example.com',
        initialPassword: 'Temporary-Password-123!',
        mustChangePassword: true,
      },
    });
    expect(mocks.requireAdminSession).toHaveBeenCalledWith(expect.any(Headers), { fresh: true });
    expect(mocks.hashAuthPassword).toHaveBeenCalledWith('Temporary-Password-123!');

    const userData = mocks.transactionClient.authUser.create.mock.calls[0]![0].data;
    expect(userData).toMatchObject({
      id: payload.data.userId,
      email: 'new.member@example.com',
      name: 'New Member',
      role: 'member',
      emailVerified: true,
      mustChangePassword: true,
      permissionProfile: { connect: { key: 'member-default' } },
      quotaProfile: { connect: { key: 'member-default' } },
    });
    const accountData = mocks.transactionClient.authAccount.create.mock.calls[0]![0].data;
    expect(accountData).toMatchObject({
      providerId: 'credential',
      accountId: payload.data.userId,
      userId: payload.data.userId,
      password: 'hashed:Temporary-Password-123!',
    });
    expect(mocks.writeAuthAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 'admin-actor',
      eventType: 'admin.user_created',
      targetType: 'user',
      targetId: payload.data.userId,
      metadata: { role: 'member' },
    }));
  });

  it('creates a non-bootstrap administrator with no restrictive profiles and a strong temporary password that must be changed', async () => {
    const response = await POST(request('POST', {
      email: 'operator@example.com',
      name: 'Operator',
      role: 'admin',
    }));

    expect(response.status).toBe(201);
    const payload = await response.json();
    expect(payload.data.initialPassword).toMatch(/^[A-Za-z0-9_-]+Aa1!$/);
    expect(payload.data.initialPassword.length).toBeGreaterThanOrEqual(16);
    expect(payload.data.mustChangePassword).toBe(true);
    expect(mocks.hashAuthPassword).toHaveBeenCalledWith(payload.data.initialPassword);

    const userData = mocks.transactionClient.authUser.create.mock.calls[0]![0].data;
    expect(userData).toMatchObject({
      role: 'admin',
      mustChangePassword: true,
    });
    expect(userData).not.toHaveProperty('permissionProfile');
    expect(userData).not.toHaveProperty('quotaProfile');
  });

  it('promotes a member to unrestricted admin and clears stale overrides and sessions atomically', async () => {
    const response = await PATCH(request('PATCH', {
      action: 'set-role',
      userId: 'target-user',
      role: 'admin',
    }));

    expect(response.status).toBe(200);
    expect(mocks.transactionClient.$queryRaw).not.toHaveBeenCalled();
    expect(mocks.transactionClient.authUser.update).toHaveBeenCalledWith({
      where: { id: 'target-user' },
      data: {
        role: 'admin',
        permissionProfileId: null,
        quotaProfileId: null,
        accessVersion: { increment: 1 },
      },
    });
    expect(mocks.transactionClient.userPermissionOverride.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'target-user' },
    });
    expect(mocks.transactionClient.userQuotaOverride.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'target-user' },
    });
    expect(mocks.transactionClient.authSession.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'target-user' },
    });
  });

  it('demotes an admin only after the transaction-scoped governance lock and assigns member defaults', async () => {
    mocks.authUserFindUnique.mockResolvedValueOnce({ id: 'admin-target', role: 'admin' });

    const response = await PATCH(request('PATCH', {
      action: 'set-role',
      userId: 'admin-target',
      role: 'member',
    }));

    expect(response.status).toBe(200);
    expectGovernanceCheckBeforeMutation();
    expect(mocks.transactionClient.authUser.update).toHaveBeenCalledWith({
      where: { id: 'admin-target' },
      data: {
        role: 'member',
        permissionProfileId: 'permission-member-default',
        quotaProfileId: 'quota-member-default',
        accessVersion: { increment: 1 },
      },
    });
    expect(mocks.transactionClient.authUser.count.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.transactionClient.authUser.update.mock.invocationCallOrder[0]!);
    expect(mocks.transactionClient.userPermissionOverride.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'admin-target' },
    });
    expect(mocks.transactionClient.userQuotaOverride.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'admin-target' },
    });
    expect(mocks.transactionClient.authSession.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'admin-target' },
    });

    const mutationTransaction = mocks.transaction.mock.calls.find(
      ([operation]) => typeof operation === 'function',
    );
    expect(mutationTransaction?.[0]).toEqual(expect.any(Function));
  });

  it.each([
    {
      label: 'demotion',
      body: { action: 'set-role', userId: 'admin-target', role: 'member' },
    },
    {
      label: 'deactivation',
      body: { action: 'set-status', userId: 'admin-target', banned: true },
    },
  ])('rejects last-active-admin $label under the same transaction lock', async ({ body }) => {
    mocks.authUserFindUnique.mockResolvedValueOnce({ id: 'admin-target', role: 'admin' });
    mocks.transactionClient.authUser.count.mockResolvedValueOnce(1);

    const response = await PATCH(request('PATCH', body));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'AUTH_OPERATION_FAILED',
      message: '不能停用或降级最后一个可用管理员。',
    });
    expectGovernanceCheckBeforeMutation();
    expect(mocks.transactionClient.authUser.update).not.toHaveBeenCalled();
    expect(mocks.transactionClient.userPermissionOverride.deleteMany).not.toHaveBeenCalled();
    expect(mocks.transactionClient.userQuotaOverride.deleteMany).not.toHaveBeenCalled();
    expect(mocks.transactionClient.authSession.deleteMany).not.toHaveBeenCalled();
    expect(mocks.writeAuthAuditEvent).not.toHaveBeenCalled();
  });

  it('resetting even an administrator uses a new temporary credential, requires a change, and revokes sessions', async () => {
    mocks.authUserFindUnique.mockResolvedValueOnce({ id: 'admin-target', role: 'admin' });

    const response = await PATCH(request('PATCH', {
      action: 'reset-password',
      userId: 'admin-target',
    }));

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.data.initialPassword).toMatch(/^[A-Za-z0-9_-]+Aa1!$/);
    expect(payload.data.mustChangePassword).toBe(true);
    expect(mocks.hashAuthPassword).toHaveBeenCalledWith(payload.data.initialPassword);
    expect(mocks.authAccountUpdate).toHaveBeenCalledWith({
      where: {
        providerId_accountId: {
          providerId: 'credential',
          accountId: 'admin-target',
        },
      },
      data: { password: `hashed:${payload.data.initialPassword}` },
    });
    expect(mocks.authUserUpdate).toHaveBeenCalledWith({
      where: { id: 'admin-target' },
      data: { mustChangePassword: true, passwordChangedAt: null },
    });
    expect(mocks.authSessionDeleteMany).toHaveBeenCalledWith({
      where: { userId: 'admin-target' },
    });
  });
});
