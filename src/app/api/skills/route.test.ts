import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn(), save: vi.fn(), publish: vi.fn(), rollback: vi.fn(), studio: vi.fn(), dashboard: vi.fn() }));
vi.mock('@/lib/auth/action', () => ({ requireAction: mocks.auth }));
vi.mock('@/lib/quant/skills-admin', () => ({ createSkillsAdministration: () => ({ readSkillFile: mocks.read, saveSkillFile: mocks.save, publishSkillVersion: mocks.publish, rollbackSkillVersion: mocks.rollback, getStudioData: mocks.studio }) }));
vi.mock('@/lib/quant/skills-dashboard', () => ({ getSkillsDashboardData: mocks.dashboard }));
import { AuthorizationError } from '@/lib/auth/authorization';
import { SkillConflictError } from '@/lib/agent/skills/catalog-store';
import { GET, POST } from './route';
const request = (action: string, origin = 'https://quant.example') => new Request('https://quant.example/api/skills', {
  method: 'POST', headers: { origin, 'Content-Type': 'application/json' },
  body: JSON.stringify({ action, skillId: 'image-extraction', filePath: 'SKILL.md', content: 'draft', version: '0.5.1', summary: 'test', changes: ['test'], actor: 'forged-admin', expectedRevision: 'a'.repeat(64) }),
});
describe('Skill administration API', () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.auth.mockResolvedValue({ actorUserId: 'real-editor', session: { user: { id: 'real-editor' } }, localSystemAdmin: false }); mocks.dashboard.mockResolvedValue({ skills: [] }); mocks.studio.mockResolvedValue({ skills: [] }); });
  it('requires management permission to inspect drafts', async () => {
    expect((await GET(new Request('https://quant.example/api/skills?view=studio'))).status).toBe(200);
    expect(mocks.auth).toHaveBeenLastCalledWith(expect.objectContaining({ action: 'platform.settings.manage' }));
    expect(mocks.studio).toHaveBeenCalledOnce();
  });
  it.each(['save-file', 'publish-version', 'rollback-version'])('propagates revision and authenticated actor for %s', async (action) => {
    expect((await POST(request(action))).status).toBe(200);
    const operation = action === 'save-file' ? mocks.save : action === 'publish-version' ? mocks.publish : mocks.rollback;
    expect(operation).toHaveBeenCalledWith(expect.objectContaining({ actor: 'real-editor', expectedRevision: 'a'.repeat(64) }));
  });
  it('rejects permission denial and cross-origin mutations before touching drafts', async () => {
    expect((await POST(request('save-file', 'https://evil.example'))).status).toBe(403);
    mocks.auth.mockRejectedValue(new AuthorizationError('DENIED', 403, 'denied'));
    expect((await POST(request('save-file'))).status).toBe(403);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('returns a conflict without disguising it as a successful save', async () => {
    mocks.save.mockRejectedValue(new SkillConflictError('内容已更新'));
    expect((await POST(request('save-file'))).status).toBe(409);
  });
});
