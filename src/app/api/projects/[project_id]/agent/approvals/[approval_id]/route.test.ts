import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAction: vi.fn(),
  resolveApproval: vi.fn(),
}));

vi.mock('@/lib/auth/action', () => ({ requireAction: mocks.requireAction }));
vi.mock('@/lib/services/moagent-tool-approval-store', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/services/moagent-tool-approval-store')>();
  return {
    ...actual,
    resolveMoAgentToolApproval: mocks.resolveApproval,
  };
});

import { POST } from './route';

const context = {
  params: Promise.resolve({
    project_id: 'project-a',
    approval_id: 'approval_abcdefghijklmnop',
  }),
};

describe('/api/projects/:projectId/agent/approvals/:approvalId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAction.mockResolvedValue({
      actorUserId: 'reviewer-a',
      localSystemAdmin: false,
    });
    mocks.resolveApproval.mockResolvedValue({
      approvalId: 'approval_abcdefghijklmnop',
      status: 'edited',
      decision: 'edit',
      resolvedAt: new Date('2026-07-24T00:00:00.000Z'),
    });
  });

  it('uses the authenticated project actor and forwards an explicit edit', async () => {
    const response = await POST(new Request(
      'http://localhost/api/projects/project-a/agent/approvals/approval_abcdefghijklmnop',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          actorUserId: 'forged-user',
          decision: 'edit',
          editedInput: { channel: 'reviewed' },
        }),
      },
    ), context);

    expect(response.status).toBe(200);
    expect(mocks.requireAction).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      action: 'project.update',
      projectId: 'project-a',
    });
    expect(mocks.resolveApproval).toHaveBeenCalledWith({
      projectId: 'project-a',
      approvalId: 'approval_abcdefghijklmnop',
      actorId: 'reviewer-a',
      actorUserId: 'reviewer-a',
      decision: 'edit',
      editedInput: { channel: 'reviewed' },
    });
  });

  it('rejects an unknown decision before accessing the store', async () => {
    const response = await POST(new Request(
      'http://localhost/api/projects/project-a/agent/approvals/approval_abcdefghijklmnop',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'auto_execute' }),
      },
    ), context);

    expect(response.status).toBe(400);
    expect(mocks.resolveApproval).not.toHaveBeenCalled();
  });

  it('records the local system principal without inventing an auth-user foreign key', async () => {
    mocks.requireAction.mockResolvedValue({
      actorUserId: 'local-system-admin',
      localSystemAdmin: true,
    });

    const response = await POST(new Request(
      'http://localhost/api/projects/project-a/agent/approvals/approval_abcdefghijklmnop',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ decision: 'approve' }),
      },
    ), context);

    expect(response.status).toBe(200);
    expect(mocks.resolveApproval).toHaveBeenCalledWith({
      projectId: 'project-a',
      approvalId: 'approval_abcdefghijklmnop',
      actorId: 'local-system-admin',
      decision: 'approve',
    });
  });
});
