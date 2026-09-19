import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    claim: vi.fn(), configure: vi.fn(), enqueue: vi.fn(), prepare: vi.fn(), recall: vi.fn(),
  };
});

vi.mock('@/lib/services/project', () => ({
  getProjectById: mocks.getProjectById,
  updateProject: mocks.updateProject,
  updateProjectActivity: mocks.updateProjectActivity,
  ensureProjectLlmConfiguration: mocks.configure,
}));

vi.mock('@/lib/services/user-requests', () => ({
  assertUserRequestProjectBinding: mocks.assertBinding,
  upsertUserRequest: mocks.upsertRequest,
  markUserRequestAsProcessing: mocks.markProcessing,
  markUserRequestAsCompleted: mocks.markCompleted,
  markUserRequestAsFailed: mocks.markFailed,
  isUserRequestCancelled: mocks.isCancelled,
  UserRequestProjectMismatchError: mocks.ProjectMismatchError,
  claimUserRequest: mocks.claim,
  UserRequestAlreadyExistsError: class extends Error {},
  UserRequestActorMismatchError: class extends Error {},
}));

vi.mock('@/lib/quant/finance-research-request', () => ({ enqueueFinanceResearchRequest: mocks.enqueue }));
vi.mock('@/lib/quant/finance-act-preparation', () => ({ prepareFinanceActGeneration: mocks.prepare }));
vi.mock('@/lib/platform/memory', () => ({ recallPersonalization: mocks.recall }));
vi.mock('@/lib/quant/chat-act-support', () => ({ resolveProjectRoot: () => '/tmp/project-a' }));
vi.mock('@/lib/domains/finance', async original => ({
  ...await original<object>(),
  writeFinanceAttachmentContext: vi.fn(async () => null), buildFinanceAttachmentInstruction: () => '',
}));
vi.mock('@/lib/auth/action', () => ({ requireAction: vi.fn(async () => ({ session: null, actorUserId: 'workspace-user' })) }));

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
    vi.resetAllMocks();
    mocks.getProjectById.mockResolvedValue({
      id: 'project-a',
      repoPath: '/tmp/project-a',
      selectedModel: null,
    });
  });
  afterEach(() => vi.unstubAllEnvs());

  it('acknowledges only after durable enqueue without doing preparation in the HTTP request', async () => {
    vi.stubEnv('PI_AGENT_DISPATCH_MODE', 'worker');
    let persist!: () => void;
    mocks.enqueue.mockImplementation(async () => {
      await new Promise<void>(resolve => { persist = resolve; });
      return { userMessageId: 'message-1' };
    });
    let responded = false;
    const pending = POST(actRequest('request-queued') as never, context).then(response => { responded = true; return response; });
    await vi.waitFor(() => expect(mocks.enqueue).toHaveBeenCalledOnce());
    expect(responded).toBe(false);
    persist();
    const response = await pending;
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ success: true, status: 'queued', requestId: 'request-queued', userMessageId: 'message-1' });
    expect(mocks.configure).not.toHaveBeenCalled();
    expect(mocks.recall).not.toHaveBeenCalled();
    expect(mocks.prepare).not.toHaveBeenCalled();
  });

  it('fails the claimed request when durable enqueue fails', async () => {
    vi.stubEnv('PI_AGENT_DISPATCH_MODE', 'worker');
    mocks.enqueue.mockRejectedValue(new Error('dispatch unavailable'));
    mocks.markFailed.mockResolvedValue(true);
    const response = await POST(actRequest('request-rejected') as never, context);
    expect(response.status).toBe(500);
    expect(mocks.markFailed).toHaveBeenCalledWith('project-a', 'request-rejected', 'dispatch unavailable');
    expect(mocks.prepare).not.toHaveBeenCalled();
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

  it('rejects legacy request aliases before loading project state', async () => {
    const response = await POST(
      new Request('http://localhost/api/chat/project-a/act', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          instruction: '生成量化看板',
          request_id: 'legacy-request-id',
          selected_model: 'local_qwen:qwen3.5-9b-q5km',
        }),
      }) as never,
      context,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'INVALID_ACT_REQUEST',
    });
    expect(mocks.getProjectById).not.toHaveBeenCalled();
    expect(mocks.upsertRequest).not.toHaveBeenCalled();
  });
});
