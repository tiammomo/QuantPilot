import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAction: vi.fn(),
  readTimeline: vi.fn(),
}));

vi.mock('@/lib/auth/action', () => ({ requireAction: mocks.requireAction }));
vi.mock('@/lib/services/moagent-tool-approval-store', () => ({
  readMoAgentRunTimeline: mocks.readTimeline,
}));

import { GET } from './route';

const context = {
  params: Promise.resolve({
    project_id: 'project-a',
    run_id: 'run-a',
  }),
};

describe('/api/projects/:projectId/agent/runs/:runId', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAction.mockResolvedValue({ actorUserId: 'reader-a' });
    mocks.readTimeline.mockResolvedValue({
      id: 'run-a',
      status: 'waiting',
      events: [],
      latestCheckpoint: {
        boundary: 'waiting_for_external_input',
      },
      toolApprovals: [{ id: 'approval-a', status: 'pending' }],
    });
  });

  it('returns only the project-bound public runtime timeline', async () => {
    const response = await GET(new Request(
      'http://localhost/api/projects/project-a/agent/runs/run-a?afterSequence=12&limit=40',
    ), context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.requireAction).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      action: 'project.read',
      projectId: 'project-a',
    });
    expect(mocks.readTimeline).toHaveBeenCalledWith({
      projectId: 'project-a',
      runId: 'run-a',
      afterSequence: 12,
      limit: 40,
    });
    expect(body.data).toMatchObject({
      status: 'waiting',
      latestCheckpoint: { boundary: 'waiting_for_external_input' },
    });
  });

  it('does not reveal whether a run belongs to another project', async () => {
    mocks.readTimeline.mockResolvedValue(null);
    const response = await GET(
      new Request('http://localhost/api/projects/project-a/agent/runs/run-other'),
      context,
    );
    expect(response.status).toBe(404);
  });
});
