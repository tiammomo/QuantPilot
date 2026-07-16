import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class ProjectMismatchError extends Error {
    constructor(readonly requestId: string) {
      super('The request ID is already bound to a different project.');
      this.name = 'UserRequestProjectMismatchError';
    }
  }
  return {
    ProjectMismatchError,
    getProjectById: vi.fn(),
    updateProject: vi.fn(),
    updateProjectActivity: vi.fn(),
    assertBinding: vi.fn(),
    upsertRequest: vi.fn(),
    markProcessing: vi.fn(),
    markCompleted: vi.fn(),
    markFailed: vi.fn(),
    isCancelled: vi.fn(),
    createMessage: vi.fn(),
    ensureMessage: vi.fn(),
  };
});

vi.mock('@/lib/services/project', () => ({
  getProjectById: mocks.getProjectById,
  updateProject: mocks.updateProject,
  updateProjectActivity: mocks.updateProjectActivity,
}));

vi.mock('@/lib/services/user-requests', () => ({
  assertUserRequestProjectBinding: mocks.assertBinding,
  upsertUserRequest: mocks.upsertRequest,
  markUserRequestAsProcessing: mocks.markProcessing,
  markUserRequestAsCompleted: mocks.markCompleted,
  markUserRequestAsFailed: mocks.markFailed,
  isUserRequestCancelled: mocks.isCancelled,
  UserRequestProjectMismatchError: mocks.ProjectMismatchError,
}));

vi.mock('@/lib/services/message', () => ({
  createMessage: mocks.createMessage,
  ensureMessage: mocks.ensureMessage,
}));

import { POST } from './route';

function actRequest(requestId: string): Request {
  return new Request('http://localhost/api/chat/project-a/act', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      requestId,
      instruction: '生成量化看板',
    }),
  });
}

const context = { params: Promise.resolve({ project_id: 'project-a' }) };

describe('act route request project scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProjectById.mockResolvedValue({
      id: 'project-a',
      repoPath: '/tmp/project-a',
      selectedModel: null,
    });
  });

  it('returns 409 before product persistence for a cross-project request ID', async () => {
    mocks.assertBinding.mockRejectedValue(
      new mocks.ProjectMismatchError('request-other-project'),
    );

    const response = await POST(actRequest('request-other-project') as never, context);

    expect(response.status).toBe(409);
    expect(mocks.upsertRequest).not.toHaveBeenCalled();
    expect(mocks.createMessage).not.toHaveBeenCalled();
    expect(mocks.updateProjectActivity).not.toHaveBeenCalled();
  });
});
