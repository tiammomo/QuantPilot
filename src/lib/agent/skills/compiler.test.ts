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
  it('selects phase-compatible capsules, validates hashes, and obeys the total character budget', async () => {
    const result = await compileMoAgentSkills({
      capabilityId: 'technical_analysis',
      phase: 'data-preparation',
      hasResolvedSymbols: true,
      maxSystemContextChars: 6_000,
    });

    expect(result.runtime).toBe('MoAgent');
    expect(result.resolvedSkillIds).toContain('quant-market-data');
    expect(result.resolvedSkillIds).toContain('quant-indicators');
    expect(result.resolvedSkillIds).not.toContain('quant-backtest');
    expect(result.totalCharacters).toBeLessThanOrEqual(6_000);
    expect(result.resolvedSkillIds).not.toContain('run-planner');
    expect(result.resolvedSkillIds).not.toContain('image-extraction');
    expect(result.systemContext).toContain('# MoAgent Skill Manifest');
    expect(result.taskContext).toContain('# MoAgent Skill Capsules');
    expect(result.taskContext).toContain('quant_api_get');
    expect(`${result.systemContext}\n${result.taskContext}`).not.toContain('.claude/skills/');
    expect(`${result.systemContext}\n${result.taskContext}`).not.toContain('mcp__QuantPilotImage__');
    expect(result.truncated).toBe(false);
    expect(result.skills.every((skill) => Boolean(skill.sourceSha256))).toBe(true);
    expect(result.skills.every((skill) => Boolean(skill.capsuleSha256))).toBe(true);
  });

  it.each([
    ['stock_diagnosis', 'single-stock-diagnosis'],
    ['technical_analysis', 'technical-timing'],
    ['fundamental_analysis', 'fundamental-research'],
    ['asset_comparison', 'stock-selection'],
    ['sector_rotation', 'sector-rotation'],
    ['strategy_research', 'strategy-research'],
    ['backtest_review', 'backtest-review'],
    ['portfolio_risk', 'holding-analysis'],
  ] as const)(
    'keeps %s phase skills and its %s scenario atomic under the production budget',
    async (capabilityId, templateId) => {
      const result = await compileMoAgentSkills({
        capabilityId,
        phase: 'data-preparation',
        hasResolvedSymbols: true,
        templateId,
        maxSystemContextChars: 6_000,
      });

      expect(result.totalCharacters).toBeLessThanOrEqual(6_000);
      expect(result.taskContext).toContain(`## ${templateId}`);
      expect(result.truncated).toBe(false);
      expect(result.skills.every((skill) => skill.truncated === false)).toBe(true);
      expect(result.skills.every((skill) => skill.status === 'stable')).toBe(true);
    },
  );

  it('injects only the selected dashboard scenario and judgement reference fragments', async () => {
    const result = await compileMoAgentSkills({
      capabilityId: 'asset_comparison',
      requiredSkillIds: ['dashboard-visualization'],
      phase: 'workspace-generation',
      templateId: 'stock-selection',
      variantId: 'selection-ranking-matrix',
      maxSystemContextChars: 4_000,
    });

    expect(result.totalCharacters).toBeLessThan(4_000);
    expect(result.taskContext).toContain('stock-selection：多标的对比/选股模板');
    expect(result.taskContext).not.toContain('holding-analysis：持仓分析模板');
    expect(result.taskContext).toContain('金融指标口径');
    expect(result.taskContext).toContain('图表选择');
    expect(result.taskContext).toContain('data_file/final/dashboard-data.json');
    expect(result.taskContext).toContain('绝不推断 public/data');
    expect(result.taskContext).not.toContain('references/scenario_templates.md');
    expect(result.skills[0].includedResources.map((resource) => resource.id)).toEqual([
      'scenario-template',
      'visual-judgement',
    ]);
  });

  it('activates attachment skills independently of capability and rejects incompatible tools', async () => {
    const result = await compileMoAgentSkills({
      capabilityId: 'stock_diagnosis',
      phase: 'data-preparation',
      hasAttachments: true,
      hasResolvedSymbols: true,
      maxSystemContextChars: 5_000,
    });
    expect(result.resolvedSkillIds).toContain('image-extraction');
    expect(result.resolvedSkillIds).toContain('data-quality');

    await expect(compileMoAgentSkills({
      capabilityId: 'stock_diagnosis',
      requiredSkillIds: ['image-extraction'],
      phase: 'data-preparation',
      availableToolNames: ['quant_api_get'],
    })).rejects.toThrow('quant_extract_uploaded_image');
  });

  it('fails closed instead of cutting a runtime capsule mid-section', async () => {
    await expect(compileMoAgentSkills({
      capabilityId: 'technical_analysis',
      requiredSkillIds: ['dashboard-visualization'],
      phase: 'workspace-generation',
      templateId: 'technical-timing',
      maxSystemContextChars: 512,
    })).rejects.toThrow('拒绝截断');
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

  it('keeps the reference mirror complete while runtime capsules stay phase-scoped', async () => {
    const workspace = await temporaryDirectory('moagent-skills-full-mirror-');
    const receipt = await installMoAgentSkillsForWorkspace(workspace, {
      capabilityId: 'technical_analysis',
      additionalSkillIds: ['platform-ui-product-design'],
    });

    expect(Object.keys(receipt.skills)).toEqual(expect.arrayContaining([
      'run-planner',
      'image-extraction',
      'quant-symbol-resolver',
      'quant-market-data',
      'quant-indicators',
      'data-quality',
      'dashboard-visualization',
      'platform-ui-product-design',
    ]));
    await expect(fs.access(
      path.join(workspace, '.moagent', 'skills', 'run-planner', 'SKILL.md'),
    )).resolves.toBeUndefined();
    await expect(fs.access(
      path.join(workspace, '.moagent', 'skills', 'platform-ui-product-design', 'SKILL.md'),
    )).resolves.toBeUndefined();
  });

  it('fails closed when a compatible source directory no longer matches its lock hash', async () => {
    const repositoryRoot = process.cwd();
    const fixtureRoot = await temporaryDirectory('moagent-skills-fixture-');
    const fixtureState = path.join(fixtureRoot, '.claude');
    const fixtureConfig = path.join(fixtureRoot, 'config');
    const [registry, lock, capsuleRegistry] = await Promise.all([
      fs.readFile(path.join(repositoryRoot, '.claude', 'skills.registry.json'), 'utf8').then(JSON.parse),
      fs.readFile(path.join(repositoryRoot, '.claude', 'skills.lock.json'), 'utf8').then(JSON.parse),
      fs.readFile(path.join(repositoryRoot, 'config', 'moagent-skill-capsules.json'), 'utf8').then(JSON.parse),
    ]);
    const skill = registry.coreSkills.find((entry: { id: string }) => entry.id === 'image-extraction');
    await fs.mkdir(path.join(fixtureState, 'skills'), { recursive: true });
    await fs.mkdir(path.join(fixtureState, 'skill-packages'), { recursive: true });
    await fs.mkdir(fixtureConfig, { recursive: true });
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
      fs.writeFile(
        path.join(fixtureConfig, 'moagent-skill-capsules.json'),
        JSON.stringify({
          ...capsuleRegistry,
          skills: { 'image-extraction': capsuleRegistry.skills['image-extraction'] },
        }),
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
