import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ auth: vi.fn(), read: vi.fn() }));
vi.mock('@/lib/auth/action', () => ({ requireAction: mocks.auth }));
vi.mock('@/lib/skills/market', () => ({ readVerifiedSkillPackage: mocks.read }));
import { AuthorizationError } from '@/lib/auth/authorization';
import { GET } from './route';
const download = (skillId = 'test-skill') => GET(new Request('http://localhost/package'), { params: Promise.resolve({ skillId }) });
describe('verified skill downloads', () => {
  beforeEach(() => { vi.resetAllMocks(); mocks.auth.mockResolvedValue({}); mocks.read.mockResolvedValue({ content: Buffer.from('artifact'), version: '1.0.0', sha256: 'sha256:fixture' }); });
  it('includes exact package identity in an uncached download', async () => {
    const response = await download(); expect(await response.text()).toBe('artifact');
    expect(response.headers.get('X-Skill-Version')).toBe('1.0.0');
    expect(response.headers.get('X-Content-SHA256')).toBe('sha256:fixture');
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });
  it('fails closed on tampering without exposing paths', async () => {
    mocks.read.mockRejectedValue(new Error('/private/package.tgz'));
    const response = await download(); expect(response.status).toBe(409); expect(await response.text()).not.toContain('/private');
  });
  it('does not read packages for unauthorized users or invalid IDs', async () => {
    expect((await download('../escape')).status).toBe(400);
    mocks.auth.mockRejectedValue(new AuthorizationError('FORBIDDEN', 403, 'denied'));
    expect((await download()).status).toBe(403); expect(mocks.read).not.toHaveBeenCalled();
  });
});
