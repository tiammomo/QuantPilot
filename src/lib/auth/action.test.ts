import { describe, expect, it, vi } from 'vitest';

import {
  PrismaPermissionPolicyRepository,
  requireAction,
} from './action';
import type {
  PermissionGrantRecord,
  PermissionPolicyRepository,
  ResolvedPermissionPolicy,
} from './permissions';

function session(role: 'admin' | 'member' = 'member') {
  return {
    user: { id: `${role}-1`, role, banned: false, mustChangePassword: false },
    session: { id: 'session-1', createdAt: new Date() },
  } as never;
}

function grant(permissionKey: string, effect: 'allow' | 'deny' = 'allow'): PermissionGrantRecord {
  return { permissionKey, effect };
}

function repository(policy: ResolvedPermissionPolicy): PermissionPolicyRepository {
  return { resolvePolicy: vi.fn().mockResolvedValue(policy) };
}

describe('PrismaPermissionPolicyRepository', () => {
  it('returns the assigned profile, grants and user overrides', async () => {
    const assignedProfile = {
      key: 'custom',
      name: 'Custom',
      isDefault: false,
      grants: [grant('quant.data.read')],
    };
    const userOverrides = [grant('research.report.send', 'deny')];
    const findFirst = vi.fn();
    const permissionRepository = new PrismaPermissionPolicyRepository({
      authUser: {
        findUnique: vi.fn().mockResolvedValue({
          permissionProfile: assignedProfile,
          permissionOverrides: userOverrides,
        }),
      },
      permissionProfile: { findFirst },
    } as never);

    await expect(permissionRepository.resolvePolicy({ userId: 'member-1' })).resolves.toEqual({
      profile: assignedProfile,
      userOverrides,
      membershipOverrides: [],
    });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('falls back to the database default profile when none is assigned', async () => {
    const defaultProfile = {
      key: 'member-default',
      name: 'Default',
      isDefault: true,
      grants: [grant('project.read')],
    };
    const findFirst = vi.fn().mockResolvedValue(defaultProfile);
    const permissionRepository = new PrismaPermissionPolicyRepository({
      authUser: {
        findUnique: vi.fn().mockResolvedValue({
          permissionProfile: null,
          permissionOverrides: [],
        }),
      },
      permissionProfile: { findFirst },
    } as never);

    await expect(permissionRepository.resolvePolicy({ userId: 'member-1' }))
      .resolves.toMatchObject({ profile: defaultProfile });
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { isDefault: true } }));
  });

  it('fails closed when the actor no longer exists', async () => {
    const permissionRepository = new PrismaPermissionPolicyRepository({
      authUser: { findUnique: vi.fn().mockResolvedValue(null) },
      permissionProfile: { findFirst: vi.fn() },
    } as never);
    await expect(permissionRepository.resolvePolicy({ userId: 'missing' }))
      .rejects.toThrow('Permission actor does not exist');
  });
});

describe('requireAction', () => {
  const headers = new Headers();

  it('keeps auth-disabled local development compatible as a system administrator', async () => {
    const policyRepository = { resolvePolicy: vi.fn() };
    const context = await requireAction({
      headers,
      action: 'project.secrets.write',
      projectId: 'project-1',
    }, {
      authEnabled: false,
      repository: policyRepository,
    });

    expect(context).toMatchObject({
      actorUserId: 'local-system-admin',
      localSystemAdmin: true,
      projectRole: 'owner',
      decision: { allowed: true, reason: 'ADMIN_ALL' },
    });
    expect(policyRepository.resolvePolicy).not.toHaveBeenCalled();
  });

  it('gives authenticated administrators all catalogued actions without policy lookups', async () => {
    const policyRepository = { resolvePolicy: vi.fn() };
    const getProjectRole = vi.fn();
    const context = await requireAction({
      headers,
      action: 'project.secrets.read',
      projectId: 'project-1',
    }, {
      authEnabled: true,
      getSession: vi.fn().mockResolvedValue(session('admin')),
      getProjectRole,
      repository: policyRepository,
    });

    expect(context.decision).toMatchObject({ allowed: true, reason: 'ADMIN_ALL' });
    expect(getProjectRole).not.toHaveBeenCalled();
    expect(policyRepository.resolvePolicy).not.toHaveBeenCalled();
  });

  it('intersects a member capability with the project role', async () => {
    const policy = repository({
      profile: {
        key: 'custom',
        grants: [grant('project.secrets.read')],
      },
    });
    await expect(requireAction({
      headers,
      action: 'project.secrets.read',
      projectId: 'project-1',
    }, {
      authEnabled: true,
      getSession: vi.fn().mockResolvedValue(session()),
      getProjectRole: vi.fn().mockResolvedValue('owner'),
      repository: policy,
    })).resolves.toMatchObject({ projectRole: 'owner', decision: { allowed: true } });

    await expect(requireAction({
      headers,
      action: 'project.secrets.read',
      projectId: 'project-1',
    }, {
      authEnabled: true,
      getSession: vi.fn().mockResolvedValue(session()),
      getProjectRole: vi.fn().mockResolvedValue('editor'),
      repository: policy,
    })).rejects.toMatchObject({
      code: 'CAPABILITY_DENIED',
      status: 403,
    });
  });

  it('hides projects from non-members with a 404 before loading policy', async () => {
    const policyRepository = { resolvePolicy: vi.fn() };
    await expect(requireAction({
      headers,
      action: 'project.read',
      projectId: 'private-project',
    }, {
      authEnabled: true,
      getSession: vi.fn().mockResolvedValue(session()),
      getProjectRole: vi.fn().mockResolvedValue(null),
      repository: policyRepository,
    })).rejects.toMatchObject({
      code: 'PROJECT_NOT_FOUND',
      status: 404,
    });
    expect(policyRepository.resolvePolicy).not.toHaveBeenCalled();
  });

  it('returns 403 when the account profile does not grant a capability', async () => {
    await expect(requireAction({
      headers,
      action: 'research.report.send',
    }, {
      authEnabled: true,
      getSession: vi.fn().mockResolvedValue(session()),
      repository: repository({
        profile: { key: 'member-default', grants: [grant('research.report.read')] },
      }),
    })).rejects.toMatchObject({
      code: 'CAPABILITY_DENIED',
      status: 403,
    });
  });

  it('allows account-scoped quant capabilities without a fake project context', async () => {
    await expect(requireAction({
      headers,
      action: 'quant.data.read',
    }, {
      authEnabled: true,
      getSession: vi.fn().mockResolvedValue(session()),
      getProjectRole: vi.fn(),
      repository: repository({
        profile: { key: 'member-default', grants: [grant('quant.data.read')] },
      }),
    })).resolves.toMatchObject({ projectRole: null, decision: { allowed: true } });
  });
});
