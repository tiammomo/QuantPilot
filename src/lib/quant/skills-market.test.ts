import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getSkillsMarketData, readVerifiedSkillPackage } from './skills-market';
import { installPiAgentSkillsForWorkspace } from '@/lib/agent/skills/compiler';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
describe('built-in skill market integration', () => {
  it('reports real packages, phase compatibility and version histories for all 12 skills', async () => {
    const data = await getSkillsMarketData(); expect(data.skills).toHaveLength(12);
    expect(data.skills.every(skill => skill.packageVerified && skill.releases.some(release => release.version === skill.version))).toBe(true);
    expect(data.skills.every(skill => skill.phases.length > 0 && skill.phases.every(phase => phase.compatible))).toBe(true);
    expect(data.project).toBeNull();
    const artifact = await readVerifiedSkillPackage('image-extraction');
    expect(artifact.content.length).toBeGreaterThan(100);
    expect(artifact.sha256).toBe(`sha256:${data.skills.find(skill => skill.id === 'image-extraction')!.packageSha256}`);
    await expect(readVerifiedSkillPackage('../outside')).rejects.toThrow();
  });
  it('matches a real compiler installation, then detects changes to the reference copy', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-market-')); roots.push(root);
    await installPiAgentSkillsForWorkspace(root, { requiredSkillIds: ['image-extraction'], phase: 'data-preparation' });
    const installed = await getSkillsMarketData({ id: 'fixture', workspace: root });
    expect(installed.project?.skills.find(skill => skill.skillId === 'image-extraction')?.state).toBe('current');
    await fs.appendFile(path.join(root, '.pi/skills/image-extraction/SKILL.md'), '\nmodified\n');
    const modified = await getSkillsMarketData({ id: 'fixture', workspace: root });
    expect(modified.project?.skills.find(skill => skill.skillId === 'image-extraction')?.state).toBe('modified');
    expect(modified.skills.find(skill => skill.id === 'image-extraction')?.packageVerified).toBe(true);
  });
  it('refuses malicious previous receipts without deleting outside canaries', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-receipt-')); roots.push(root);
    await fs.mkdir(path.join(root, '.pi'), { recursive: true });
    await fs.writeFile(path.join(root, 'canary'), 'keep');
    await fs.writeFile(path.join(root, '.pi/installed-skills.json'), JSON.stringify({ schemaVersion: 1, runtime: 'PI Agent', skillsDirectory: '.pi/skills', skills: { '../../canary': {} } }));
    await expect(installPiAgentSkillsForWorkspace(root, { requiredSkillIds: ['image-extraction'], phase: 'data-preparation' })).rejects.toThrow('Invalid');
    expect(await fs.readFile(path.join(root, 'canary'), 'utf8')).toBe('keep');
  });
});
