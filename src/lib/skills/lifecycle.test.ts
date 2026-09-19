import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSkillsAdministration } from './administration';
import { deployProjectSkills } from './deployment';
import { compilePiAgentSkills } from '@/lib/agent/skills';
import { readSkillCatalogState, deploymentKey } from '@/lib/agent/skills/catalog-store';
import { resolveRuntimeSkillCatalog, stageSkillCatalog } from '@/lib/agent/skills/catalog-images';
import { readSkillMetadata, assertNewSkillVersion } from './publication';
import { hashSkillDirectory } from '@/lib/agent/skills/workspace-integrity';

const repository = process.cwd();
const temporary: string[] = [];
const id = 'image-extraction';
const actor = 'test-editor';
async function fixture() {
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-lifecycle-'));
  temporary.push(parent);
  const root = await stageSkillCatalog(parent, repository);
  const workspace = path.join(parent, 'workspace');
  await fs.mkdir(workspace);
  return { root, workspace, admin: createSkillsAdministration(root, repository) };
}
afterEach(async () => { await Promise.all(temporary.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });
const compile = (root: string, workspace?: string) => compilePiAgentSkills({ repositoryRoot: root,
  runtimeWorkspace: workspace, requiredSkillIds: [id], phase: 'data-preparation', maxSystemContextChars: 8_000 });

async function changeRuntime(admin: ReturnType<typeof createSkillsAdministration>) {
  const file = await admin.readSkillFile(id, 'skill.runtime.json');
  const value = JSON.parse(file.content);
  value.objective += ' 仅使用已确认的数据。';
  return admin.saveSkillFile({ skillId: id, filePath: file.filePath, content: JSON.stringify(value), expectedRevision: file.revision, actor });
}
async function publish(admin: ReturnType<typeof createSkillsAdministration>, version: string) {
  const diff = await admin.diffSkillVersion(id);
  return admin.publishSkillVersion({ skillId: id, version, summary: '生命周期回归', changes: ['完整快照'], expectedRevision: diff.revision, actor });
}

describe('Skill lifecycle: isolated drafts, immutable releases and trusted deployments', { timeout: 30_000 }, () => {
  it('isolates drafts and rejects concurrent saves without changing executable content', async () => {
    const { root, admin } = await fixture();
    const before = await compile(root);
    const file = await admin.readSkillFile(id);
    const results = await Promise.allSettled(['甲', '乙'].map((text) => admin.saveSkillFile({ skillId: id,
      content: `${file.content}\n${text}\n`, expectedRevision: file.revision, actor })));
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
    const draft = await admin.readSkillFile(id);
    expect(draft.draft).toBe(true);
    expect((await compile(root)).skills).toEqual(before.skills);
    expect(await fs.readFile(path.join(root, '.pi/skills', id, 'SKILL.md'), 'utf8')).toBe(file.content);
    const view = await admin.getStudioData();
    expect(view.skills.find((skill) => skill.id === id)?.health.status).toBe('ok');
    expect(view.activity[0]).toMatchObject({ actor, action: 'draft.save' });
    await admin.discardDraft({ skillId: id, expectedRevision: draft.revision, actor });
    expect((await admin.readSkillFile(id)).content).toBe(file.content);
  });

  it('keeps empty draft folders across immutable snapshot deduplication', async () => {
    const { admin } = await fixture(); const file = await admin.readSkillFile(id);
    const view = await admin.createSkillFolder({ skillId: id, folderPath: 'references/new-folder', expectedRevision: file.revision, actor });
    const skill = view.skills.find((item) => item.id === id)!;
    expect(skill.source.directories.map((item) => item.path)).toContain('references/new-folder');
    await admin.deleteSkillFolder({ skillId: id, folderPath: 'references/new-folder', expectedRevision: skill.editing!.revision, actor });
    expect((await admin.getStudioData()).skills.find((item) => item.id === id)!.source.directories.map((item) => item.path)).not.toContain('references/new-folder');
  });

  it('binds publication to the reviewed draft and preserves the active image on failed validation', async () => {
    const { root, admin } = await fixture();
    await changeRuntime(admin);
    const reviewed = await admin.diffSkillVersion(id);
    const source = await admin.readSkillFile(id);
    await admin.saveSkillFile({ skillId: id, content: `${source.content}\n更新\n`, expectedRevision: source.revision, actor });
    await expect(admin.publishSkillVersion({ skillId: id, version: '0.5.1', summary: 'stale', changes: ['stale'], expectedRevision: reviewed.revision, actor })).rejects.toMatchObject({ status: 409 });
    const runtime = await admin.readSkillFile(id, 'skill.runtime.json');
    const bad = JSON.parse(runtime.content); bad.resources = [{ id: 'missing-reference', path: 'references/nonexistent.md', profiles: ['data-preparation'], selector: 'named-headings', headings: ['Missing'], maxChars: 512, required: true }];
    await admin.saveSkillFile({ skillId: id, filePath: runtime.filePath, content: JSON.stringify(bad), expectedRevision: runtime.revision, actor });
    const activeBefore = (await readSkillCatalogState(root)).active;
    await expect(publish(admin, '0.5.1')).rejects.toThrow();
    expect((await readSkillCatalogState(root)).active).toBe(activeBefore);
    expect((await admin.readSkillFile(id)).draft).toBe(true);
    expect((await compile(root)).skills[0].version).toBe('0.5.0');
    // Executes real packaging and all Python behavior contracts before rejecting
    // the invalid capsule; use the same budget as the full publication case.
  }, 60_000);

  it('publishes and rolls back complete behavior while pinned projects keep their executable version', async () => {
    const { root, workspace, admin } = await fixture();
    const original = await compile(root);
    const first = await deployProjectSkills({ workspace, target: 'pi-agent', action: 'initialize',
      skillIds: [id], expectedRevision: null, actor }, root);
    await changeRuntime(admin);
    await publish(admin, '0.5.1');
    const next = await compile(root);
    expect(next.skills[0].version).toBe('0.5.1');
    expect(next.skills[0].capsuleSha256).not.toBe(original.skills[0].capsuleSha256);
    expect((await compile(root, workspace)).skills).toEqual(original.skills);
    // A workspace receipt cannot choose executable content.
    await fs.writeFile(path.join(workspace, '.pi/installed-skills.json'), '{}');
    expect((await compile(root, workspace)).skills).toEqual(original.skills);
    await fs.rm(path.join(workspace, '.pi'), { recursive: true, force: true });
    const upgraded = await deployProjectSkills({ workspace, target: 'pi-agent', action: 'install', skillId: id,
      version: '0.5.1', expectedRevision: first.id, actor }, root);
    expect((await compile(root, workspace)).skills).toEqual(next.skills);
    const file = await admin.readSkillFile(id);
    await admin.rollbackSkillVersion({ skillId: id, version: '0.5.0', expectedRevision: file.revision, actor });
    expect((await compile(root)).skills).toEqual(original.skills);
    expect((await compile(root, workspace)).skills).toEqual(next.skills);
    await deployProjectSkills({ workspace, target: 'pi-agent', action: 'rollback', expectedRevision: upgraded.id, actor }, root);
    expect((await compile(root, workspace)).skills).toEqual(original.skills);
    await changeRuntime(admin);
    await expect(publish(admin, '0.5.1')).rejects.toThrow('高于所有已发布版本');
  }, 60_000);

  it('does not offer incomplete legacy releases as full behavior rollbacks', async () => {
    const { admin } = await fixture();
    const source = await admin.readSkillFile(id);
    await expect(admin.rollbackSkillVersion({ skillId: id, version: '0.4.0', expectedRevision: source.revision, actor })).rejects.toThrow('缺少完整运行规则');
    const view = await admin.getStudioData();
    expect(view.skills.find((skill) => skill.id === id)?.changelog.releases.find((release) => release.version === '0.4.0')?.completeSnapshot).toBe(false);
  });

  it('imports packages into a draft without activating them', async () => {
    const { root, admin } = await fixture();
    const file = await admin.readSkillFile(id);
    const packageBytes = await fs.readFile(path.join(root, '.pi/skill-packages', `${id}.tgz`));
    await admin.uploadSkillPackage({ skillId: id, file: new File([packageBytes], `${id}.tgz`), expectedRevision: file.revision, actor });
    expect((await admin.readSkillFile(id)).draft).toBe(true);
    expect((await compile(root)).skills[0].version).toBe('0.5.0');
  });

  it.each(['claude-code', 'codex'] as const)('installs, removes and restores %s without overwriting unmanaged skills', async (target) => {
    const { root, workspace } = await fixture();
    const directory = target === 'codex' ? '.agents' : '.claude';
    const userFile = path.join(workspace, directory, 'skills/personal/SKILL.md');
    await fs.mkdir(path.dirname(userFile), { recursive: true }); await fs.writeFile(userFile, 'user owned');
    const first = await deployProjectSkills({ workspace, target, action: 'install', skillId: id, expectedRevision: null, actor }, root);
    const installed = path.join(workspace, directory, 'skills', id, 'SKILL.md');
    await expect(fs.access(installed)).resolves.toBeUndefined();
    await fs.appendFile(installed, '\nlocal edit');
    await expect(deployProjectSkills({ workspace, target, action: 'uninstall', skillId: id, expectedRevision: first.id, actor }, root)).rejects.toThrow('本地修改');
    const removed = await deployProjectSkills({ workspace, target, action: 'uninstall', skillId: id, expectedRevision: first.id, actor, overwriteModified: true }, root);
    expect(removed.id).not.toBe(first.id); // identity changes even when the catalog image did not
    await expect(deployProjectSkills({ workspace, target, action: 'install', skillId: id, expectedRevision: first.id, actor }, root)).rejects.toMatchObject({ status: 409 });
    await expect(fs.access(installed)).rejects.toThrow();
    await deployProjectSkills({ workspace, target, action: 'rollback', expectedRevision: removed.id, actor }, root);
    await expect(fs.access(installed)).resolves.toBeUndefined();
    expect(await fs.readFile(userFile, 'utf8')).toBe('user owned');
    expect((await readSkillCatalogState(root)).deployments[deploymentKey(workspace, target)].skillIds).toEqual([id]);
  }, 30_000);

  it('rejects tampered runtime metadata in a pinned immutable image', async () => {
    const { root, workspace } = await fixture();
    await deployProjectSkills({ workspace, target: 'pi-agent', action: 'initialize', skillIds: [id], expectedRevision: null, actor }, root);
    const resolved = await resolveRuntimeSkillCatalog(root, workspace);
    const metadata = await readSkillMetadata(resolved.root);
    metadata.capsules.skills[id].objective = 'tampered';
    await fs.writeFile(path.join(resolved.root, 'config/pi-agent-skill-capsules.json'), JSON.stringify(metadata.capsules));
    await expect(compile(root, workspace)).rejects.toThrow('integrity');
  });

  it('adopts verified legacy mirrors without trusting receipts that claim personal skills', async () => {
    const { root, workspace } = await fixture();
    const runtime = path.join(workspace, '.pi');
    const personal = path.join(runtime, 'skills/personal');
    await fs.mkdir(personal, { recursive: true }); await fs.writeFile(path.join(personal, 'SKILL.md'), 'user owned');
    await fs.cp(path.join(root, '.pi/skills', id), path.join(runtime, 'skills', id), { recursive: true });
    const { lock } = await readSkillMetadata(root);
    const claim = { version: lock.skills[id].version, source: 'source', sourceSha256: lock.skills[id].sourceSha256, packageSha256: lock.skills[id].packageSha256 };
    await fs.writeFile(path.join(runtime, 'installed-skills.json'), JSON.stringify({ schemaVersion: 1, runtime: 'PI Agent', skillsDirectory: '.pi/skills', skills: {
      [id]: claim, personal: { ...claim, sourceSha256: (await hashSkillDirectory(personal)).hash },
    } }));
    await deployProjectSkills({ workspace, target: 'pi-agent', action: 'initialize', skillIds: [id], expectedRevision: null, actor }, root);
    expect(await fs.readFile(path.join(personal, 'SKILL.md'), 'utf8')).toBe('user owned');
    expect((await compile(root, workspace)).skills[0].id).toBe(id);
  });

  it('enforces monotonic, canonical release versions', () => {
    expect(() => assertNewSkillVersion('1.10.0', ['1.9.9'])).not.toThrow();
    for (const next of ['1.9.9', '1.2.0', '01.10.0', '1.0.0-preview']) expect(() => assertNewSkillVersion(next, ['1.9.9'])).toThrow();
  });
});
