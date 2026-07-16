import { describe, expect, it, vi } from 'vitest';

import {
  ACCESS_CONTROL_CATALOG,
  BUILTIN_PERMISSION_PROFILES,
  PERMISSION_ACTIONS,
  PermissionDeniedError,
  evaluatePermission,
  evaluatePermissionWithRepository,
  isPermissionAction,
  requirePermission,
  requirePermissionWithRepository,
  type PermissionEvaluationInput,
  type PermissionGrantRecord,
} from './permissions';

function request(
  action: unknown,
  options: Partial<PermissionEvaluationInput> = {},
): PermissionEvaluationInput {
  return {
    action,
    actor: { id: 'user-1', platformRole: 'member' },
    project: { id: 'project-1', role: 'editor' },
    ...options,
  };
}

function grant(
  permissionKey: string,
  effect: 'allow' | 'deny',
  extras: Partial<PermissionGrantRecord> = {},
): PermissionGrantRecord {
  return { permissionKey, effect, ...extras };
}

describe('access-control catalog', () => {
  it('classifies every strongly typed action exactly once', () => {
    expect(Object.keys(ACCESS_CONTROL_CATALOG.actions).sort()).toEqual([...PERMISSION_ACTIONS].sort());
    expect(BUILTIN_PERMISSION_PROFILES).toContain(ACCESS_CONTROL_CATALOG.defaultMemberProfile);
    for (const definition of Object.values(ACCESS_CONTROL_CATALOG.actions)) {
      expect(['account', 'project', 'platform']).toContain(definition.scope);
      expect(definition.description.length).toBeGreaterThan(0);
    }
  });

  it('recognizes catalog actions and rejects unclassified runtime strings', () => {
    expect(isPermissionAction('agent.run')).toBe(true);
    expect(isPermissionAction('agent.run-anything')).toBe(false);
    expect(evaluatePermission(request('agent.run-anything'))).toMatchObject({
      allowed: false,
      reason: 'UNKNOWN_ACTION',
    });
  });
});

describe('permission evaluator', () => {
  it('allows admins every classified action by default, including cross-project operations', () => {
    for (const action of PERMISSION_ACTIONS) {
      const project = ACCESS_CONTROL_CATALOG.actions[action].scope === 'project'
        ? { id: 'project-1' }
        : undefined;
      expect(evaluatePermission(request(action, {
        actor: { id: 'admin-1', platformRole: 'admin' },
        project,
      }))).toMatchObject({ allowed: true, reason: 'ADMIN_ALL' });
    }
  });

  it('requires project context even for administrators', () => {
    expect(evaluatePermission(request('project.read', {
      actor: { id: 'admin-1', platformRole: 'admin' },
      project: undefined,
    }))).toMatchObject({ allowed: false, reason: 'PROJECT_CONTEXT_REQUIRED' });
  });

  it('treats shared quant and research capabilities as account scoped', () => {
    for (const action of [
      'quant.data.read',
      'quant.query.rewrite.llm',
      'quant.strategy.run',
      'research.report.read',
      'research.report.run',
    ] as const) {
      expect(ACCESS_CONTROL_CATALOG.actions[action].scope).toBe('account');
      expect(evaluatePermission(request(action, { project: undefined })))
        .toMatchObject({ allowed: true, reason: 'GRANTED' });
    }
  });

  it('applies the standard profile and project role as intersecting policy planes', () => {
    expect(evaluatePermission(request('agent.run'))).toMatchObject({
      allowed: true,
      reason: 'GRANTED',
    });
    expect(evaluatePermission(request('project.secrets.read'))).toMatchObject({
      allowed: false,
      reason: 'PROJECT_ROLE_NOT_GRANTED',
    });
    expect(evaluatePermission(request('project.secrets.read', {
      project: { id: 'project-1', role: 'owner' },
    }))).toMatchObject({ allowed: true });
  });

  it('keeps viewer and read-only templates read-only', () => {
    expect(evaluatePermission(request('project.source.read', {
      actor: { id: 'user-1', permissionProfileKey: 'read-only' },
      project: { id: 'project-1', role: 'viewer' },
    }))).toMatchObject({ allowed: true });
    expect(evaluatePermission(request('project.source.write', {
      actor: { id: 'user-1', permissionProfileKey: 'read-only' },
      project: { id: 'project-1', role: 'owner' },
    }))).toMatchObject({ allowed: false, reason: 'PROFILE_NOT_GRANTED' });
    expect(evaluatePermission(request('agent.run', {
      project: { id: 'project-1', role: 'viewer' },
    }))).toMatchObject({ allowed: false, reason: 'PROJECT_ROLE_NOT_GRANTED' });
    expect(evaluatePermission(request('quant.data.read', {
      actor: { id: 'user-1', permissionProfileKey: 'readonly-default' },
      project: { id: 'project-1', role: 'viewer' },
    }))).toMatchObject({ allowed: true });
  });

  it('requires membership for project-scoped member actions', () => {
    expect(evaluatePermission(request('project.read', {
      project: { id: 'project-1', role: null },
    }))).toMatchObject({ allowed: false, reason: 'PROJECT_MEMBERSHIP_REQUIRED' });
  });

  it('lets explicit allows expand a profile or membership without bypassing the other plane', () => {
    const readOnlyWithRun = {
      profile: {
        key: 'read-only',
        grants: [grant('project.read', 'allow')],
      },
      userOverrides: [grant('agent.run', 'allow')],
    };
    expect(evaluatePermission(request('agent.run', {
      project: { id: 'project-1', role: 'editor' },
      policy: readOnlyWithRun,
    }))).toMatchObject({ allowed: true });

    expect(evaluatePermission(request('project.secrets.read', {
      project: { id: 'project-1', role: 'editor' },
      policy: { membershipOverrides: [grant('project.secrets.read', 'allow')] },
    }))).toMatchObject({ allowed: true });

    expect(evaluatePermission(request('project.secrets.read', {
      project: { id: 'project-1', role: null },
      policy: { membershipOverrides: [grant('project.secrets.read', 'allow')] },
    }))).toMatchObject({ allowed: false, reason: 'PROJECT_MEMBERSHIP_REQUIRED' });
  });

  it('gives active explicit denies priority over member allows', () => {
    expect(evaluatePermission(request('agent.run', {
      policy: {
        userOverrides: [grant('agent.run', 'allow'), grant('agent.run', 'deny')],
      },
    }))).toMatchObject({ allowed: false, reason: 'EXPLICIT_DENY' });
  });

  it('keeps the administrator policy immutable even if stale restriction rows exist', () => {
    expect(evaluatePermission(request('agent.run', {
      actor: { id: 'admin-1', platformRole: 'admin' },
      policy: { userOverrides: [grant('agent.run', 'deny')] },
    }))).toMatchObject({ allowed: true, reason: 'ADMIN_ALL' });
  });

  it('ignores expired overrides and malformed database permission keys', () => {
    const now = new Date('2026-07-16T00:00:00.000Z');
    expect(evaluatePermission(request('agent.run', {
      now,
      policy: {
        userOverrides: [
          grant('agent.run', 'deny', { expiresAt: '2026-07-15T23:59:59.000Z' }),
          grant('unknown.action', 'deny'),
        ],
      },
    }))).toMatchObject({ allowed: true });
  });

  it('treats malformed deny expiry as active and malformed allow expiry as inactive', () => {
    expect(evaluatePermission(request('agent.run', {
      policy: {
        userOverrides: [grant('agent.run', 'deny', { expiresAt: 'not-a-date' })],
      },
    }))).toMatchObject({ allowed: false, reason: 'EXPLICIT_DENY' });
    expect(evaluatePermission(request('platform.audit.read', {
      project: undefined,
      policy: {
        userOverrides: [grant('platform.audit.read', 'allow', { expiresAt: 'not-a-date' })],
      },
    }))).toMatchObject({ allowed: false, reason: 'PROFILE_NOT_GRANTED' });
  });

  it('accepts a database-shaped permission profile and fails closed for unknown profiles', () => {
    expect(evaluatePermission(request('agent.run', {
      policy: {
        profile: {
          key: 'custom-researcher',
          name: 'Custom researcher',
          isDefault: false,
          grants: [grant('agent.run', 'allow')],
        },
      },
    }))).toMatchObject({ allowed: true, profileKey: 'custom-researcher' });

    expect(evaluatePermission(request('agent.run', {
      actor: { id: 'user-1', permissionProfileKey: 'missing-profile' },
    }))).toMatchObject({ allowed: false, reason: 'PROFILE_NOT_GRANTED' });
  });

  it('can delegate a platform capability through an explicit user grant', () => {
    expect(evaluatePermission(request('platform.audit.read', {
      project: undefined,
      policy: { userOverrides: [grant('platform.audit.read', 'allow')] },
    }))).toMatchObject({ allowed: true, reason: 'GRANTED' });
  });

  it('loads database policy through a repository and fails closed when lookup fails', async () => {
    const resolvePolicy = vi.fn().mockResolvedValue({
      profile: {
        key: 'database-profile',
        grants: [grant('agent.run', 'allow')],
      },
    });
    await expect(evaluatePermissionWithRepository(
      request('agent.run'),
      { resolvePolicy },
    )).resolves.toMatchObject({ allowed: true });
    expect(resolvePolicy).toHaveBeenCalledWith({ userId: 'user-1', projectId: 'project-1' });

    await expect(evaluatePermissionWithRepository(
      request('agent.run'),
      { resolvePolicy: vi.fn().mockRejectedValue(new Error('database unavailable')) },
    )).resolves.toMatchObject({ allowed: false, reason: 'POLICY_LOOKUP_FAILED' });
  });

  it('exposes a strongly typed throwing DAL boundary', () => {
    expect(requirePermission(request('agent.run') as PermissionEvaluationInput & { action: 'agent.run' }))
      .toMatchObject({ allowed: true });
    expect(() => requirePermission(request('project.secrets.read') as PermissionEvaluationInput & {
      action: 'project.secrets.read';
    })).toThrow(PermissionDeniedError);
  });

  it('exposes the same throwing boundary for repository-backed decisions', async () => {
    await expect(requirePermissionWithRepository(
      request('agent.run') as PermissionEvaluationInput & { action: 'agent.run' },
      { resolvePolicy: vi.fn().mockResolvedValue({}) },
    )).resolves.toMatchObject({ allowed: true });
    await expect(requirePermissionWithRepository(
      request('agent.run') as PermissionEvaluationInput & { action: 'agent.run' },
      { resolvePolicy: vi.fn().mockRejectedValue(new Error('database unavailable')) },
    )).rejects.toBeInstanceOf(PermissionDeniedError);
  });
});
