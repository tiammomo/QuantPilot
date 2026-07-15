import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compileMoAgentSkills, installMoAgentSkillsForWorkspace } from './compiler';

const temporaryDirectories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
});

describe('compileMoAgentSkills', () => {
  it('selects capability skills, validates hashes, and obeys the total character budget', async () => {
    const result = await compileMoAgentSkills({
      capabilityId: 'technical_analysis',
      maxSystemContextChars: 7_000,
    });

    expect(result.runtime).toBe('MoAgent');
    expect(result.resolvedSkillIds).toContain('quant-market-data');
    expect(result.resolvedSkillIds).toContain('quant-indicators');
    expect(result.resolvedSkillIds).not.toContain('quant-backtest');
    expect(result.totalCharacters).toBeLessThanOrEqual(7_000);
    expect(result.systemContext).toContain('# MoAgent Skills Context');
    expect(result.systemContext).toContain('职责边界');
    expect(result.systemContext).not.toContain('.claude/skills/');
    expect(result.systemContext).not.toContain('mcp__QuantPilotImage__');
    expect(result.truncated).toBe(true);
    expect(result.skills.every((skill) => Boolean(skill.sourceSha256))).toBe(true);
  });

  it('normalizes compatible aliases without installing an alias runtime directory', async () => {
    const result = await compileMoAgentSkills({
      requiredSkillIds: ['quant-technical-indicators'],
      maxSystemContextChars: 4_000,
    });

    expect(result.aliases).toEqual({ 'quant-technical-indicators': 'quant-indicators' });
    expect(result.resolvedSkillIds).toEqual(['quant-indicators']);
    expect(result.skills[0].requestedIds).toEqual(['quant-technical-indicators']);
  });

  it('rejects unknown capabilities even when explicit skills are supplied', async () => {
    await expect(compileMoAgentSkills({
      capabilityId: 'unknown-capability',
      requiredSkillIds: ['data-quality'],
    })).rejects.toThrow('不支持量化 capability');
  });

  it('installs verified assets only under the workspace .moagent directory', async () => {
    const workspace = await temporaryDirectory('moagent-skills-workspace-');
    await fs.mkdir(path.join(workspace, '.moagent', 'skills', 'user-owned-skill'), { recursive: true });
    await fs.writeFile(
      path.join(workspace, '.moagent', 'skills', 'user-owned-skill', 'SKILL.md'),
      '# unmanaged\n',
    );
    const receipt = await installMoAgentSkillsForWorkspace(workspace, {
      requiredSkillIds: ['image-extraction'],
      maxSystemContextChars: 4_000,
    });

    expect(receipt.runtime).toBe('MoAgent');
    expect(receipt.skillsDirectory).toBe('.moagent/skills');
    const installedSkill = await fs.readFile(
      path.join(workspace, '.moagent', 'skills', 'image-extraction', 'SKILL.md'),
      'utf8',
    );
    expect(installedSkill).toContain('图片提取能力');
    expect(installedSkill).toContain('quant_extract_uploaded_image');
    expect(installedSkill).not.toContain('mcp__QuantPilotImage__');
    await expect(
      fs.readFile(path.join(workspace, '.moagent', 'skills', 'user-owned-skill', 'SKILL.md'), 'utf8'),
    ).resolves.toContain('unmanaged');
    await expect(
      fs.readFile(path.join(workspace, '.moagent', 'skills', 'image-extraction', 'SKILL.md'), 'utf8'),
    ).resolves.toContain('图片提取能力');
    await expect(fs.access(path.join(workspace, '.claude'))).rejects.toThrow();
  });

  it('fails closed when a compatible source directory no longer matches its lock hash', async () => {
    const repositoryRoot = process.cwd();
    const fixtureRoot = await temporaryDirectory('moagent-skills-fixture-');
    const fixtureState = path.join(fixtureRoot, '.claude');
    const [registry, lock] = await Promise.all([
      fs.readFile(path.join(repositoryRoot, '.claude', 'skills.registry.json'), 'utf8').then(JSON.parse),
      fs.readFile(path.join(repositoryRoot, '.claude', 'skills.lock.json'), 'utf8').then(JSON.parse),
    ]);
    const skill = registry.coreSkills.find((entry: { id: string }) => entry.id === 'image-extraction');
    await fs.mkdir(path.join(fixtureState, 'skills'), { recursive: true });
    await fs.mkdir(path.join(fixtureState, 'skill-packages'), { recursive: true });
    await Promise.all([
      fs.cp(
        path.join(repositoryRoot, '.claude', 'skills', 'image-extraction'),
        path.join(fixtureState, 'skills', 'image-extraction'),
        { recursive: true },
      ),
      fs.copyFile(
        path.join(repositoryRoot, '.claude', 'skill-packages', 'image-extraction.tgz'),
        path.join(fixtureState, 'skill-packages', 'image-extraction.tgz'),
      ),
    ]);
    await Promise.all([
      fs.writeFile(path.join(fixtureState, 'skills.registry.json'), JSON.stringify({
        ...registry,
        coreSkills: [skill],
        legacyAliases: {},
      })),
      fs.writeFile(path.join(fixtureState, 'skills.lock.json'), JSON.stringify({
        ...lock,
        skills: { 'image-extraction': lock.skills['image-extraction'] },
      })),
      fs.appendFile(
        path.join(fixtureState, 'skills', 'image-extraction', 'SKILL.md'),
        '\nunauthorized change\n',
      ),
    ]);

    await expect(compileMoAgentSkills({
      repositoryRoot: fixtureRoot,
      requiredSkillIds: ['image-extraction'],
    })).rejects.toThrow('源目录哈希不一致');
  });
});
