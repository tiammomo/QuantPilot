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
    ensureProjectLlmConfiguration: vi.fn(),
    lockProjectDataAgentComposition: vi.fn(),
    updateProject: vi.fn(),
    updateProjectActivity: vi.fn(),
    assertBinding: vi.fn(),
    claimRequest: vi.fn(),
    upsertRequest: vi.fn(),
    markProcessing: vi.fn(),
    markCompleted: vi.fn(),
    markFailed: vi.fn(),
    isCancelled: vi.fn(),
    createMessage: vi.fn(),
    ensureMessage: vi.fn(),
    answerDashboardQuestion: vi.fn(),
    prepareFinanceActGeneration: vi.fn(),
    publish: vi.fn(),
  };
});

vi.mock('@/lib/services/project', () => ({
  getProjectById: mocks.getProjectById,
  ensureProjectLlmConfiguration: mocks.ensureProjectLlmConfiguration,
  lockProjectDataAgentComposition: mocks.lockProjectDataAgentComposition,
  updateProject: mocks.updateProject,
  updateProjectActivity: mocks.updateProjectActivity,
}));

vi.mock('@/lib/services/user-requests', () => ({
  assertUserRequestProjectBinding: mocks.assertBinding,
  claimUserRequest: mocks.claimRequest,
  upsertUserRequest: mocks.upsertRequest,
  markUserRequestAsProcessing: mocks.markProcessing,
  markUserRequestAsCompleted: mocks.markCompleted,
  markUserRequestAsFailed: mocks.markFailed,
  isUserRequestCancelled: mocks.isCancelled,
  UserRequestProjectMismatchError: mocks.ProjectMismatchError,
  UserRequestActorMismatchError: class UserRequestActorMismatchError extends Error {},
  UserRequestAlreadyExistsError: class UserRequestAlreadyExistsError extends Error {},
}));

vi.mock('@/lib/services/message', () => ({
  createMessage: mocks.createMessage,
  ensureMessage: mocks.ensureMessage,
}));

vi.mock('@/lib/auth/action', () => ({
  requireAction: vi.fn().mockResolvedValue({ session: null, actorUserId: 'actor-a' }),
}));

vi.mock('@/lib/auth/authorization', () => ({
  AuthorizationError: class AuthorizationError extends Error {},
}));

vi.mock('@/lib/auth/http', () => ({ authErrorResponse: vi.fn() }));

vi.mock('@/lib/quota', () => ({
  consumeQuota: vi.fn(),
  quotaErrorResponse: vi.fn().mockReturnValue(null),
}));

vi.mock('@/lib/services/stream', () => ({
  streamManager: { publish: mocks.publish },
}));

vi.mock('@/lib/serializers/chat', () => ({
  serializeMessage: (message: unknown, extra?: unknown) => ({
    ...(message as Record<string, unknown>),
    ...(extra as Record<string, unknown> | undefined),
  }),
}));

vi.mock('@/lib/quant/dashboard-chat', () => ({
  answerDashboardQuestion: mocks.answerDashboardQuestion,
}));

vi.mock('@/lib/quant/finance-act-preparation', () => ({
  prepareFinanceActGeneration: mocks.prepareFinanceActGeneration,
}));

vi.mock('@/lib/quant/chat-act-support', () => ({
  loadQuantValidation: vi.fn(),
  resolveProjectRoot: vi.fn((_projectId: string, repoPath: string) => repoPath),
}));

vi.mock('@/lib/agent/input-policy', () => ({
  validatePiAgentIngressInput: vi.fn().mockReturnValue({ ok: true }),
}));

import { POST } from './route';

function actRequest(requestId: string): Request {
  return new Request('http://localhost/api/chat/project-a/act', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mode: 'act',
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
    mocks.assertBinding.mockResolvedValue(false);
    mocks.claimRequest.mockResolvedValue(undefined);
    mocks.upsertRequest.mockResolvedValue(undefined);
    mocks.markProcessing.mockResolvedValue(true);
    mocks.markCompleted.mockResolvedValue(true);
    mocks.createMessage.mockImplementation(async (input: Record<string, unknown>) => ({
      ...input,
      id: input.role === 'assistant' ? 'assistant-message' : 'user-message',
    }));
    mocks.answerDashboardQuestion.mockResolvedValue({
      answer: '基于当前看板，第二个标的波动更低。',
      provider: 'test-provider',
      model: 'test-model',
      acceptedRequestId: 'accepted-run',
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

  it('rejects legacy request aliases before loading project state', async () => {
    const response = await POST(
      new Request('http://localhost/api/chat/project-a/act', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'act',
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

  it('answers chat mode without entering finance preparation or workspace generation', async () => {
    const response = await POST(
      new Request('http://localhost/api/chat/project-a/act', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          mode: 'chat',
          requestId: 'request-chat',
          instruction: '这两个标的哪个更稳？',
          displayInstruction: '这两个标的哪个更稳？',
        }),
      }) as never,
      context,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      status: 'chat_answered',
      requestId: 'request-chat',
      preservedDashboard: true,
    });
    expect(mocks.answerDashboardQuestion).toHaveBeenCalledOnce();
    expect(mocks.prepareFinanceActGeneration).not.toHaveBeenCalled();
    expect(mocks.ensureProjectLlmConfiguration).not.toHaveBeenCalled();
    expect(mocks.lockProjectDataAgentComposition).not.toHaveBeenCalled();
    expect(mocks.markCompleted).toHaveBeenCalledWith('project-a', 'request-chat');
  });
});
