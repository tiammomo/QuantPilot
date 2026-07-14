import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeInitialRunPlan } from '@/lib/quant/workspace';
import { buildQuantPilotTaskPrompt, ensureClaudeSkillsForProject } from './claude-skills';

const temporaryProjects: string[] = [];

async function createProject() {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'quantpilot-task-prompt-'));
  temporaryProjects.push(projectPath);
  return projectPath;
}

afterEach(async () => {
  await Promise.all(
    temporaryProjects.splice(0).map((projectPath) =>
      fs.rm(projectPath, { recursive: true, force: true })
    )
  );
});

describe('buildQuantPilotTaskPrompt', () => {
  it('locks platform-prefetched planning and data artifacts for dashboard generation', async () => {
    const projectPath = await createProject();
    await writeInitialRunPlan({
      projectPath,
      requestId: 'platform-prefetched-dashboard',
      capabilityId: 'technical_analysis',
      capabilitySource: 'auto',
      instruction: '生成贵州茅台最近120个交易日的技术分析看板。',
    });
    await fs.mkdir(path.join(projectPath, 'data_file', 'final'), { recursive: true });
    await fs.mkdir(path.join(projectPath, 'evidence'), { recursive: true });
    await Promise.all([
      fs.writeFile(path.join(projectPath, 'data_file', 'final', 'dashboard-data.json'), '{}\n'),
      fs.writeFile(path.join(projectPath, 'evidence', 'sources.json'), '{}\n'),
      fs.writeFile(path.join(projectPath, 'evidence', 'data_quality.json'), '{}\n'),
    ]);

    const prompt = await buildQuantPilotTaskPrompt('增强技术分析看板', projectPath);

    expect(prompt).toContain('平台预取产物：已完成');
    expect(prompt).toContain('只读取 .quantpilot/run_plan.json');
    expect(prompt).toContain('不得重写 capabilityId、symbols、visualization.templateId');
    expect(prompt).toContain('不重复取数');
    expect(prompt).toContain('禁止在 final 数据或页面中新增交易执行计划');
    expect(prompt).toContain('平台预取模式禁止创建或更新 Task/Todo 列表');
    expect(prompt).toContain('不自行运行 npm build');
  });

  it('installs a capability-scoped, lock-verified skill set', async () => {
    const projectPath = await createProject();
    await writeInitialRunPlan({
      projectPath,
      requestId: 'capability-scoped-skills',
      capabilityId: 'technical_analysis',
      capabilitySource: 'auto',
      instruction: '生成中信证券最近120个交易日技术看板。',
    });

    const installed = await ensureClaudeSkillsForProject(projectPath);
    const receipt = JSON.parse(
      await fs.readFile(path.join(projectPath, '.claude', 'installed-skills.json'), 'utf8'),
    ) as { capabilityId: string; skills: Record<string, { packageSha256: string | null }> };

    expect(installed).toContain('run-planner');
    expect(installed).toContain('quant-market-data');
    expect(installed).toContain('dashboard-visualization');
    expect(installed).toContain('platform-ui-product-design');
    expect(installed).not.toContain('quant-backtest');
    expect(receipt.capabilityId).toBe('technical_analysis');
    expect(Object.values(receipt.skills).every((skill) => Boolean(skill.packageSha256))).toBe(true);
  });
});
