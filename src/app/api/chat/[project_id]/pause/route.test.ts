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
    assertBinding: vi.fn(),
    markCancelled: vi.fn(),
    markActiveCancelled: vi.fn(),
    cancelAgentRuns: vi.fn(),
    publish: vi.fn(),
    getProjectById: vi.fn(),
    markQueueCancelled: vi.fn(),
    cancelGenerationRun: vi.fn(),
    readMission: vi.fn(),
    cancelMission: vi.fn(),
    cancelActiveMissions: vi.fn(),
  };
});

vi.mock('@/lib/services/user-requests', () => ({
  assertUserRequestProjectBinding: mocks.assertBinding,
  markUserRequestAsCancelled: mocks.markCancelled,
  markActiveUserRequestsAsCancelled: mocks.markActiveCancelled,
  UserRequestProjectMismatchError: mocks.ProjectMismatchError,
}));

vi.mock('@/lib/services/agent-runtime', () => ({
  cancelAgentRuns: mocks.cancelAgentRuns,
}));

vi.mock('@/lib/services/stream', () => ({
  streamManager: { publish: mocks.publish },
}));

vi.mock('@/lib/services/project', () => ({
  getProjectById: mocks.getProjectById,
}));

vi.mock('@/lib/quant/generation-queue', () => ({
  markQuantGenerationQueueCancelled: mocks.markQueueCancelled,
}));

vi.mock('@/lib/quant/generation-state', () => ({
  cancelQuantGenerationRun: mocks.cancelGenerationRun,
}));

vi.mock('@/lib/services/moagent-mission-store', () => ({
  readMoAgentMission: mocks.readMission,
  cancelMoAgentMission: mocks.cancelMission,
  cancelActiveMoAgentMissions: mocks.cancelActiveMissions,
}));

import { POST } from './route';

function pauseRequest(requestId: string): Request {
  return new Request('http://localhost/api/chat/project-a/pause', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId, reason: 'stop' }),
  });
}

const context = { params: Promise.resolve({ project_id: 'project-a' }) };

describe('pause route request project scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.cancelAgentRuns.mockReturnValue({ cancelled: 1, activeCount: 0 });
    mocks.markCancelled.mockResolvedValue(true);
    mocks.getProjectById.mockResolvedValue(null);
    mocks.readMission.mockResolvedValue(null);
    mocks.cancelActiveMissions.mockResolvedValue(0);
  });

  it('returns 409 before cancelling anything for a cross-project request ID', async () => {
    mocks.assertBinding.mockRejectedValue(
      new mocks.ProjectMismatchError('request-other-project'),
    );

    const response = await POST(pauseRequest('request-other-project') as never, context);

    expect(response.status).toBe(409);
    expect(mocks.cancelAgentRuns).not.toHaveBeenCalled();
    expect(mocks.markCancelled).not.toHaveBeenCalled();
  });

  it('returns 404 before cancelling when the project has no such request', async () => {
    mocks.assertBinding.mockResolvedValue(false);

    const response = await POST(pauseRequest('request-missing') as never, context);

    expect(response.status).toBe(404);
    expect(mocks.cancelAgentRuns).not.toHaveBeenCalled();
    expect(mocks.markCancelled).not.toHaveBeenCalled();
  });

  it('cancels a verified request using both project ID and request ID', async () => {
    mocks.assertBinding.mockResolvedValue(true);

    const response = await POST(pauseRequest('request-owned') as never, context);

    expect(response.status).toBe(200);
    expect(mocks.cancelAgentRuns).toHaveBeenCalledWith(
      'project-a',
      'request-owned',
      'stop',
    );
    expect(mocks.markCancelled).toHaveBeenCalledWith(
      'project-a',
      'request-owned',
      'stop',
    );
  });

  it('durably cancels the Mission bound to the verified request', async () => {
    mocks.assertBinding.mockResolvedValue(true);
    mocks.readMission.mockResolvedValue({ id: 'mission-1' });
    mocks.cancelMission.mockResolvedValue({ status: 'cancelled' });

    const response = await POST(pauseRequest('request-owned') as never, context);
    const body = await response.json();

    expect(mocks.cancelMission).toHaveBeenCalledWith({
      missionId: 'mission-1',
      projectId: 'project-a',
      requestId: 'request-owned',
      message: 'stop',
    });
    expect(body.data.cancelledMissions).toBe(1);
  });
});
