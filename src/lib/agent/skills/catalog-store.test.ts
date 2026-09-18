import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { commitSkillCatalogState, readSkillCatalogState, skillsStateDirectory } from './catalog-store';
import { pruneUnusedSkillImages } from './catalog-images';

const roots: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-catalog-state-')); roots.push(root); return root;
}
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
describe('Skill catalog commit and retention', () => {
  it('keeps the previous state when atomic activation fails', async () => {
    const root = await fixture(); const state = await readSkillCatalogState(root);
    state.active = 'a'.repeat(64); await commitSkillCatalogState(root, state);
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('storage failure'));
    state.active = 'b'.repeat(64);
    await expect(commitSkillCatalogState(root, state)).rejects.toThrow('storage failure');
    expect((await readSkillCatalogState(root)).active).toBe('a'.repeat(64));
  });
  it('fails closed on corrupt deployment state instead of following the latest platform version', async () => {
    const root = await fixture(); await commitSkillCatalogState(root, await readSkillCatalogState(root));
    await fs.writeFile(path.join(skillsStateDirectory(root), 'state.json'), JSON.stringify({ schemaVersion: 1, generation: 1, active: null, drafts: {}, releases: [], deployments: { invalid: {} }, events: [] }));
    await expect(readSkillCatalogState(root)).rejects.toThrow('Invalid skill catalog state');
  });
  it('prunes only old unreferenced images and retains published history', async () => {
    const root = await fixture(); const state = await readSkillCatalogState(root);
    const directory = path.join(skillsStateDirectory(root), 'images');
    const [released, orphan, recent] = ['a', 'b', 'c'].map((value) => value.repeat(64));
    for (const revision of [released, orphan, recent]) await fs.mkdir(path.join(directory, revision), { recursive: true });
    const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    await fs.utimes(path.join(directory, released), old, old); await fs.utimes(path.join(directory, orphan), old, old);
    state.releases.push({ skillId: 'example', version: '1.0.0', revision: released, actor: 'test', date: new Date().toISOString() });
    await pruneUnusedSkillImages(root, state);
    expect((await fs.readdir(directory)).sort()).toEqual([released, recent]);
  });
});
