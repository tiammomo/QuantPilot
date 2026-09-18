import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ dashboard: vi.fn(), read: vi.fn() }));
vi.mock('./skills-dashboard', () => ({ getSkillsDashboardData: mocks.dashboard }));
vi.mock('@/lib/data-agent/workspace-read', () => ({ readWorkspaceFileBounded: mocks.read, readWorkspaceJsonBounded: vi.fn() }));
import { readVerifiedSkillPackage } from './skills-market';
beforeEach(() => {
  vi.resetAllMocks();
  mocks.dashboard.mockResolvedValue({ skills: [{ id: 'test', version: '1.0.0', status: 'stable', health: { status: 'ok' }, package: { exists: true, path: '.pi/skill-packages/test.tgz' }, lock: { packageSha256: 'expected' } }] });
});
it('rejects bytes changed after dashboard inspection', async () => {
  mocks.read.mockResolvedValue({ content: Buffer.from('changed'), sha256: 'sha256:changed' });
  await expect(readVerifiedSkillPackage('test')).rejects.toThrow('已变更');
});
it('never reads an unverified or unregistered package', async () => {
  await expect(readVerifiedSkillPackage('unknown')).rejects.toThrow();
  mocks.dashboard.mockResolvedValue({ skills: [{ id: 'test', health: { status: 'warning' } }] });
  await expect(readVerifiedSkillPackage('test')).rejects.toThrow();
  expect(mocks.read).not.toHaveBeenCalled();
});
