import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { hashSkillDirectory } from './workspace-integrity';
import { installSkillAssets, type SkillInstallAsset } from './workspace-install';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-install-transaction-')); roots.push(root);
  const source = path.join(root, 'source'); await fs.mkdir(source); await fs.writeFile(path.join(source, 'SKILL.md'), '# original');
  const digest = await hashSkillDirectory(source);
  const asset: SkillInstallAsset = { id: 'first-skill', claim: { version: '1.0.0', source: 'source', sourceSha256: digest.hash, packageSha256: null }, prepare: (destination) => fs.cp(source, destination, { recursive: true }) };
  await installSkillAssets({ workspace: root, target: 'pi-agent', assets: [asset] });
  return { root, asset, original: await fs.readFile(path.join(root, '.pi/installed-skills.json'), 'utf8') };
}
describe('transactional Skill installation', () => {
  it('does not remove old skills or change the receipt when any asset fails preparation', async () => {
    const { root, asset, original } = await fixture();
    await expect(installSkillAssets({ workspace: root, target: 'pi-agent', assets: [
      { ...asset, id: 'second-skill' }, { ...asset, id: 'third-skill', prepare: async () => { throw new Error('disk failure'); } },
    ] })).rejects.toThrow('disk failure');
    expect(await fs.readdir(path.join(root, '.pi/skills'))).toEqual(['first-skill']);
    expect(await fs.readFile(path.join(root, '.pi/installed-skills.json'), 'utf8')).toBe(original);
  });
  it('restores the entire batch when the receipt rename fails after skills were swapped', async () => {
    const { root, asset, original } = await fixture();
    const rename = fs.rename.bind(fs); let failed = false;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (!failed && String(from).endsWith('next-receipt')) { failed = true; throw new Error('receipt failure'); }
      return rename(from, to);
    });
    await expect(installSkillAssets({ workspace: root, target: 'pi-agent', assets: [{ ...asset, id: 'second-skill' }] })).rejects.toThrow('receipt failure');
    expect(await fs.readdir(path.join(root, '.pi/skills'))).toEqual(['first-skill']);
    expect(await fs.readFile(path.join(root, '.pi/installed-skills.json'), 'utf8')).toBe(original);
  });
  it('restores mirrors if the platform version commit fails', async () => {
    const { root, asset, original } = await fixture();
    await expect(installSkillAssets({ workspace: root, target: 'pi-agent', assets: [{ ...asset, id: 'second-skill' }],
      activation: { id: 'new-operation', commit: async () => { throw new Error('catalog unavailable'); }, isCommitted: async () => false },
    })).rejects.toThrow('catalog unavailable');
    expect(await fs.readdir(path.join(root, '.pi/skills'))).toEqual(['first-skill']);
    expect(await fs.readFile(path.join(root, '.pi/installed-skills.json'), 'utf8')).toBe(original);
  });
  it('keeps activated mirrors if interrupted before writing the completion marker', async () => {
    const { root, asset } = await fixture(); let activated = false;
    const writeFile = fs.writeFile.bind(fs); let interrupted = false;
    vi.spyOn(fs, 'writeFile').mockImplementation(async (file, data, options) => {
      if (!interrupted && String(file).endsWith('/committed')) { interrupted = true; throw new Error('interrupted after activation'); }
      return writeFile(file, data, options);
    });
    await expect(installSkillAssets({ workspace: root, target: 'pi-agent', assets: [{ ...asset, id: 'second-skill' }],
      activation: { id: 'activated-operation', commit: async () => { activated = true; }, isCommitted: async () => activated },
    })).rejects.toThrow('interrupted after activation');
    expect(activated).toBe(true);
    expect(await fs.readdir(path.join(root, '.pi/skills'))).toEqual(['second-skill']);
    const receipt = JSON.parse(await fs.readFile(path.join(root, '.pi/installed-skills.json'), 'utf8'));
    expect(Object.keys(receipt.skills)).toEqual(['second-skill']);
  });
  it('recovers interrupted swaps before another installation', async () => {
    const { root, asset, original } = await fixture();
    const runtime = path.join(root, '.pi'); const journal = path.join(runtime, '.skill-install-transaction');
    await fs.mkdir(journal); await fs.writeFile(path.join(journal, 'intent.json'), JSON.stringify({ hadSkills: true, hadReceipt: true }));
    await fs.rename(path.join(runtime, 'skills'), path.join(journal, 'previous-skills'));
    await fs.mkdir(path.join(runtime, 'skills')); await fs.writeFile(path.join(runtime, 'skills', 'partial'), 'incomplete');
    await expect(installSkillAssets({ workspace: root, target: 'pi-agent', assets: [{ ...asset, prepare: async () => { throw new Error('stop after recovery'); } }] })).rejects.toThrow('stop after recovery');
    expect(await fs.readdir(path.join(runtime, 'skills'))).toEqual(['first-skill']);
    expect(await fs.readFile(path.join(runtime, 'installed-skills.json'), 'utf8')).toBe(original);
  });
  it('refuses unmanaged collisions and symlink runtime directories', async () => {
    const { root, asset } = await fixture();
    const other = path.join(root, '.pi/skills/personal'); await fs.mkdir(other); await fs.writeFile(path.join(other, 'SKILL.md'), 'private');
    await expect(installSkillAssets({ workspace: root, target: 'pi-agent', assets: [{ ...asset, id: 'personal' }] })).rejects.toThrow('非受管');
    await fs.symlink(path.join(root, '.pi'), path.join(root, '.claude'));
    await expect(installSkillAssets({ workspace: root, target: 'claude-code', assets: [asset] })).rejects.toThrow('真实目录');
    expect(await fs.readFile(path.join(other, 'SKILL.md'), 'utf8')).toBe('private');
  });
  it('does not let a forged receipt claim ownership of an unmanaged skill', async () => {
    const { root, asset, original } = await fixture();
    const personal = path.join(root, '.pi/skills/personal'); await fs.mkdir(personal); await fs.writeFile(path.join(personal, 'SKILL.md'), 'user owned');
    const forged = JSON.parse(original); forged.skills.personal = { ...asset.claim, sourceSha256: (await hashSkillDirectory(personal)).hash };
    await fs.writeFile(path.join(root, '.pi/installed-skills.json'), JSON.stringify(forged));
    await installSkillAssets({ workspace: root, target: 'pi-agent', assets: [], trustedManaged: { [asset.id]: asset.claim } });
    expect(await fs.readFile(path.join(personal, 'SKILL.md'), 'utf8')).toBe('user owned');
    await expect(fs.access(path.join(root, '.pi/skills/first-skill'))).rejects.toThrow();
  });
});
