import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), project: vi.fn(), workspace: vi.fn(), deploy: vi.fn() }));
vi.mock('@/lib/auth/action', () => ({ requireAction: mocks.auth }));
vi.mock('@/lib/services/project', () => ({ getProjectById: mocks.project }));
vi.mock('@/lib/data-agent/workspace-path', async (original) => ({ ...await original<object>(), assertManagedWorkspaceExists: mocks.workspace }));
vi.mock('@/lib/quant/skills-deployment', () => ({ deployProjectSkills: mocks.deploy }));
import { AuthorizationError } from '@/lib/auth/authorization';
import { SkillConflictError } from '@/lib/agent/skills/catalog-store';
import { POST } from './route';
const body = { projectId: 'demo', target: 'pi-agent', action: 'install', skillId: 'image-extraction', version: '0.5.0', expectedRevision: null };
const request = (value = body, origin = 'http://localhost') => new Request('http://localhost/api/skills/installations', { method: 'POST', headers: { 'Content-Type': 'application/json', origin }, body: JSON.stringify(value) });
describe('Skill project deployment API', () => {
  beforeEach(() => {
    vi.resetAllMocks(); mocks.auth.mockResolvedValue({ actorUserId: 'member-id', session: { user: { id: 'member-id' } }, localSystemAdmin: false });
    mocks.project.mockResolvedValue({ repoPath: '/managed/demo' }); mocks.workspace.mockResolvedValue('/managed/demo'); mocks.deploy.mockResolvedValue({ id: 'deployment-id' });
  });
  it('checks project write access and records the authenticated actor', async () => {
    expect((await POST(request())).status).toBe(200);
    expect(mocks.auth).toHaveBeenCalledWith(expect.objectContaining({ action: 'project.update', projectId: 'demo' }));
    expect(mocks.deploy).toHaveBeenCalledWith(expect.objectContaining({ workspace: '/managed/demo', actor: 'member-id', expectedRevision: null }));
  });
  it('denies another project before reading its path or installing files', async () => {
    mocks.auth.mockRejectedValue(new AuthorizationError('DENIED', 403, 'denied'));
    expect((await POST(request())).status).toBe(403); expect(mocks.project).not.toHaveBeenCalled(); expect(mocks.deploy).not.toHaveBeenCalled();
  });
  it('rejects cross-origin requests despite an authorized browser session', async () => {
    expect((await POST(request(body, 'https://untrusted.example'))).status).toBe(403);
    expect(mocks.deploy).not.toHaveBeenCalled();
  });
  it('rejects actor injection, paths and unknown adapters', async () => {
    for (const value of [{ ...body, actor: 'admin' }, { ...body, projectId: '../outside' }, { ...body, target: 'unknown' }]) {
      expect((await POST(request(value))).status).toBe(400);
    }
    expect(mocks.deploy).not.toHaveBeenCalled();
  });
  it('reports stale installation revisions as conflicts', async () => {
    mocks.deploy.mockRejectedValue(new SkillConflictError('stale'));
    expect((await POST(request())).status).toBe(409);
  });
});
