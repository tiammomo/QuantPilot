import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  deleteProjectService: vi.fn(),
}));

vi.mock('@/lib/services/project-services', () => ({
  deleteProjectService: mocks.deleteProjectService,
}));

import { DELETE } from './route';

describe('project service delete route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.deleteProjectService.mockResolvedValue(true);
  });

  it('passes the route project ID together with the service ID', async () => {
    const response = await DELETE(
      new Request('http://localhost/api/projects/project-a/services/service-1'),
      { params: Promise.resolve({ project_id: 'project-a', service_id: 'service-1' }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.deleteProjectService).toHaveBeenCalledWith('project-a', 'service-1');
  });

  it('returns not found when the scoped delete matches no row', async () => {
    mocks.deleteProjectService.mockResolvedValue(false);

    const response = await DELETE(
      new Request('http://localhost/api/projects/project-b/services/service-1'),
      { params: Promise.resolve({ project_id: 'project-b', service_id: 'service-1' }) },
    );

    expect(response.status).toBe(404);
  });
});
