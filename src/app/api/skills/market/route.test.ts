import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), project: vi.fn(), workspace: vi.fn(), market: vi.fn() }));
vi.mock('@/lib/auth/action', () => ({ requireAction: mocks.auth }));
vi.mock('@/lib/services/project', () => ({ getProjectById: mocks.project }));
vi.mock('@/lib/data-agent/workspace-path', async importOriginal => ({ ...await importOriginal<object>(), assertManagedWorkspaceExists: mocks.workspace }));
vi.mock('@/lib/quant/skills-market', () => ({ getSkillsMarketData: mocks.market }));
import { AuthorizationError } from '@/lib/auth/authorization';
import { GET } from './route';
const request = (query = '') => new Request(`http://localhost/api/skills/market${query}`);
describe('trusted skill market API', () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.auth.mockResolvedValue({}); mocks.market.mockResolvedValue({ skills: [] }); mocks.project.mockResolvedValue({ repoPath: '/managed/demo' }); mocks.workspace.mockResolvedValue('/managed/demo'); });
  it('reads the catalog without touching project files', async () => {
    const response = await GET(request()); expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(mocks.workspace).not.toHaveBeenCalled(); expect(mocks.project).not.toHaveBeenCalled();
  });
  it('authorizes a project before resolving or inspecting its workspace', async () => {
    const response = await GET(request('?projectId=demo')); expect(response.status).toBe(200);
    expect(mocks.auth).toHaveBeenNthCalledWith(2, expect.objectContaining({ action: 'project.read', projectId: 'demo' }));
    expect(mocks.workspace).toHaveBeenCalledWith('demo', '/managed/demo');
    expect(mocks.market).toHaveBeenCalledWith({ id: 'demo', workspace: '/managed/demo' });
  });
  it('denies cross-project access before database and file reads', async () => {
    mocks.auth.mockResolvedValueOnce({}).mockRejectedValueOnce(new AuthorizationError('FORBIDDEN', 403, 'denied'));
    expect((await GET(request('?projectId=other'))).status).toBe(403);
    expect(mocks.project).not.toHaveBeenCalled(); expect(mocks.workspace).not.toHaveBeenCalled(); expect(mocks.market).not.toHaveBeenCalled();
  });
  it('rejects invalid project paths', async () => {
    expect((await GET(request('?projectId=..%2Fescape'))).status).toBe(400);
    expect(mocks.project).not.toHaveBeenCalled();
  });
  it('returns missing projects without filesystem lookup', async () => {
    mocks.project.mockResolvedValue(null);
    expect((await GET(request('?projectId=missing'))).status).toBe(404);
    expect(mocks.workspace).not.toHaveBeenCalled();
  });
});
