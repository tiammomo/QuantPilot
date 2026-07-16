import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deleteMany: vi.fn(),
}));

vi.mock('@/lib/db/client', () => ({
  prisma: {
    projectServiceConnection: {
      deleteMany: mocks.deleteMany,
    },
  },
}));

import { deleteProjectService } from './project-services';

describe('project service deletion scope', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes only when both project ID and service ID match', async () => {
    mocks.deleteMany.mockResolvedValue({ count: 1 });

    await expect(deleteProjectService('project-a', 'service-1')).resolves.toBe(true);
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: { id: 'service-1', projectId: 'project-a' },
    });
  });

  it('returns not found for a service belonging to another project', async () => {
    mocks.deleteMany.mockResolvedValue({ count: 0 });

    await expect(deleteProjectService('project-b', 'service-1')).resolves.toBe(false);
  });
});
