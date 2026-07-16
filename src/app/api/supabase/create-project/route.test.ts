import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireAction: vi.fn(),
  getProjectById: vi.fn(),
  createSupabaseProject: vi.fn(),
}));

vi.mock('@/lib/auth/action', () => ({ requireAction: mocks.requireAction }));
vi.mock('@/lib/services/project', () => ({ getProjectById: mocks.getProjectById }));
vi.mock('@/lib/services/supabase', () => ({
  createSupabaseProject: mocks.createSupabaseProject,
}));

import { AuthorizationError } from '@/lib/auth/authorization';
import { POST } from './route';

function request() {
  return new Request('http://localhost/api/supabase/create-project', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project_id: 'local-project-1',
      project_name: 'Remote project',
      organization_id: 'org-1',
      db_pass: 'database-password',
      region: 'ap-southeast-1',
    }),
  }) as never;
}

describe('POST /api/supabase/create-project authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireAction.mockResolvedValue({});
    mocks.getProjectById.mockResolvedValue({ id: 'local-project-1' });
    mocks.createSupabaseProject.mockResolvedValue({
      id: 'remote-project-1',
      name: 'Remote project',
      organization_id: 'org-1',
      status: 'ACTIVE_HEALTHY',
      region: 'ap-southeast-1',
      created_at: '2026-07-17T00:00:00.000Z',
    });
  });

  it('binds external project creation to manage access on the local project', async () => {
    const response = await POST(request());

    expect(response.status).toBe(200);
    expect(mocks.requireAction).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      action: 'project.services.manage',
      projectId: 'local-project-1',
    });
    expect(mocks.requireAction.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.createSupabaseProject.mock.invocationCallOrder[0]);
  });

  it('does not call Supabase when the local project capability is denied', async () => {
    mocks.requireAction.mockRejectedValueOnce(
      new AuthorizationError('PROJECT_NOT_FOUND', 404, '项目不存在。'),
    );

    const response = await POST(request());

    expect(response.status).toBe(404);
    expect(mocks.createSupabaseProject).not.toHaveBeenCalled();
  });

  it('does not create an orphan external project for a missing local project', async () => {
    mocks.getProjectById.mockResolvedValueOnce(null);

    const response = await POST(request());

    expect(response.status).toBe(404);
    expect(mocks.createSupabaseProject).not.toHaveBeenCalled();
  });
});
