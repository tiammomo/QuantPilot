import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findProject: vi.fn(),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    project: { findUnique: mocks.findProject },
  },
}));

import {
  authorizeApplicationRequest,
  authorizeProject,
  projectIdFromPath,
  requiredProjectRole,
} from './authorization';

function session(user: Record<string, unknown>) {
  return {
    user: { id: 'user-1', role: 'member', ...user },
    session: { id: 'session-1', createdAt: new Date() },
  } as never;
}

describe('authorization policy', () => {
  beforeEach(() => mocks.findProject.mockReset());

  it('extracts project ids from every project-scoped ingress', () => {
    expect(projectIdFromPath('/api/projects/project-1/files')).toBe('project-1');
    expect(projectIdFromPath('/api/chat/project%202/messages')).toBe('project 2');
    expect(projectIdFromPath('/project-3/chat')).toBe('project-3');
    expect(projectIdFromPath('/api/quant/capabilities')).toBeNull();
  });

  it('maps safe, mutating and ownership operations to project roles', () => {
    expect(requiredProjectRole('/api/projects/p1/files', 'GET')).toBe('viewer');
    expect(requiredProjectRole('/api/chat/p1/messages', 'POST')).toBe('editor');
    expect(requiredProjectRole('/api/projects/p1', 'DELETE')).toBe('owner');
    expect(requiredProjectRole('/api/projects/p1/vercel/deploy', 'POST')).toBe('owner');
  });

  it('denies project access by default and permits sufficient membership', async () => {
    mocks.findProject.mockResolvedValueOnce({ ownerId: 'owner-1', memberships: [] });
    await expect(authorizeProject(session({}), 'p1', 'viewer')).resolves.toMatchObject({
      allowed: false,
      status: 404,
    });
    mocks.findProject.mockResolvedValueOnce({ ownerId: 'owner-1', memberships: [{ role: 'editor' }] });
    await expect(authorizeProject(session({}), 'p1', 'editor')).resolves.toMatchObject({ allowed: true });
  });

  it('lets platform admins cross project boundaries', async () => {
    await expect(authorizeProject(session({ role: 'admin' }), 'p1', 'owner')).resolves.toMatchObject({
      allowed: true,
    });
    expect(mocks.findProject).not.toHaveBeenCalled();
  });

  it('forces initial password change before other routes', async () => {
    await expect(authorizeApplicationRequest(
      session({ mustChangePassword: true }),
      '/strategy-platform',
      'GET',
    )).resolves.toMatchObject({ allowed: false, code: 'PASSWORD_CHANGE_REQUIRED', status: 428 });
    await expect(authorizeApplicationRequest(
      session({ mustChangePassword: true }),
      '/account/security',
      'GET',
    )).resolves.toMatchObject({ allowed: true });
  });

  it('keeps absolute admin endpoints closed while delegating capability routes to handlers', async () => {
    await expect(authorizeApplicationRequest(session({}), '/admin/users', 'GET'))
      .resolves.toMatchObject({ allowed: false, code: 'ADMIN_REQUIRED' });
    await expect(authorizeApplicationRequest(session({}), '/api/admin/users', 'GET'))
      .resolves.toMatchObject({ allowed: false, code: 'ADMIN_REQUIRED' });
    await expect(authorizeApplicationRequest(session({}), '/api/tokens', 'POST'))
      .resolves.toMatchObject({ allowed: true });
    await expect(authorizeApplicationRequest(session({}), '/api/workspaces/trace', 'GET'))
      .resolves.toMatchObject({ allowed: true });
  });

  it('does not let coarse HTTP methods override project capabilities in the proxy', async () => {
    await expect(authorizeApplicationRequest(
      session({}),
      '/api/repo/project-1/file',
      'DELETE',
    )).resolves.toMatchObject({ allowed: true });
    expect(mocks.findProject).not.toHaveBeenCalled();

    mocks.findProject.mockResolvedValueOnce({
      ownerId: 'owner-1',
      memberships: [],
    });
    await expect(authorizeApplicationRequest(
      session({}),
      '/project-1/chat',
      'GET',
    )).resolves.toMatchObject({ allowed: false, code: 'PROJECT_NOT_FOUND' });
  });
});
