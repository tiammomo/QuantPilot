import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { hashSkillDirectory, readSkillsInstallReceipt } from '@/lib/agent/skills/workspace-integrity';
import { inspectSkillInstallation } from './installation-status';
import type { SkillItem } from './dashboard';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-state-')); roots.push(root);
  const directory = path.join(root, '.pi/skills/test-skill');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'SKILL.md'), 'trusted content');
  const { hash } = await hashSkillDirectory(directory);
  const skill = { id: 'test-skill', version: '1.0.0', lock: { sourceSha256: hash, packageSha256: 'package' } } as SkillItem;
  const receipt = { schemaVersion: 1, runtime: 'PI Agent', skillsDirectory: '.pi/skills', skills: {
    'test-skill': { version: '1.0.0', sourceSha256: hash, packageSha256: 'package' },
  } };
  const save = () => fs.writeFile(path.join(root, '.pi/installed-skills.json'), JSON.stringify(receipt));
  const inspect = async () => (await inspectSkillInstallation(root, [skill])).skills[0];
  await save(); return { root, directory, skill, receipt, save, inspect };
}
describe('project skill inspection', () => {
  it('verifies installed content instead of trusting the receipt', async () => {
    const f = await fixture(); expect((await f.inspect()).state).toBe('current');
    await fs.writeFile(path.join(f.directory, 'SKILL.md'), 'modified');
    expect((await f.inspect()).state).toBe('modified');
    f.receipt.skills['test-skill'].sourceSha256 = (await hashSkillDirectory(f.directory)).hash;
    await f.save(); expect((await f.inspect()).state).toBe('modified');
  });
  it('distinguishes outdated, missing and unverified content', async () => {
    const f = await fixture(); f.receipt.skills['test-skill'].version = '0.9.0'; await f.save();
    expect((await f.inspect()).state).toBe('outdated');
    await fs.rm(path.join(f.root, '.pi/installed-skills.json'));
    expect((await f.inspect()).state).toBe('unverified');
    await fs.rm(f.directory, { recursive: true }); expect((await f.inspect()).state).toBe('missing');
  });
  it('rejects traversal keys in receipts before using any managed paths', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, '.pi/installed-skills.json'), JSON.stringify({ ...f.receipt, skills: { '../../outside': {} } }));
    await expect(readSkillsInstallReceipt(path.join(f.root, '.pi'))).rejects.toThrow('Invalid');
    expect((await f.inspect()).state).toBe('unverified');
  });
  it('rejects symlink receipts and content', async () => {
    const f = await fixture(); const receiptPath = path.join(f.root, '.pi/installed-skills.json');
    await fs.rename(receiptPath, path.join(f.root, 'receipt'));
    await fs.symlink(path.join(f.root, 'receipt'), receiptPath);
    expect((await f.inspect()).state).toBe('unverified');
    await fs.rm(receiptPath); await f.save();
    await fs.symlink(path.join(f.root, 'receipt'), path.join(f.directory, 'extra'));
    expect((await f.inspect()).state).toBe('unverified');
  });
});
