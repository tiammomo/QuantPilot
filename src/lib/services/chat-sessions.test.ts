import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    session: {
      findFirst: mocks.findFirst,
    },
  },
}));

import { getActiveSession, getSessionById } from './chat-sessions';

describe('MoAgent session compatibility queries', () => {
  beforeEach(() => {
    mocks.findFirst.mockReset();
    mocks.findFirst.mockResolvedValue(null);
  });

  it('never treats a legacy Claude session as an active MoAgent run', async () => {
    await expect(getActiveSession('project-1')).resolves.toBeNull();

    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: {
        projectId: 'project-1',
        cliType: 'moagent',
        status: { in: ['active', 'running'] },
      },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('scopes compatibility status lookups to MoAgent records', async () => {
    await expect(getSessionById('project-1', 'session-1')).resolves.toBeNull();

    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: {
        projectId: 'project-1',
        id: 'session-1',
        cliType: 'moagent',
      },
    });
  });
});
