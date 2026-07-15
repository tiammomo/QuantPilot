import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeInitialRunPlan } from '@/lib/quant/workspace';
import {
  buildQuantPilotSystemPrompt,
  buildQuantPilotTaskPrompt,
  hasPlatformPreparedQuantArtifacts,
} from './moagent-prompts';

const temporaryProjects: string[] = [];

async function createProject(): Promise<string> {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'moagent-task-prompt-'));
  temporaryProjects.push(projectPath);
  return projectPath;
}

afterEach(async () => {
  await Promise.all(
    temporaryProjects.splice(0).map((projectPath) =>
      fs.rm(projectPath, { recursive: true, force: true }),
    ),
  );
});

describe('MoAgent QuantPilot prompts', () => {
  it('locks platform-prefetched artifacts and names only native MoAgent tools', async () => {
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
    expect(prompt).toContain('initial_dashboard_contract');
    expect(prompt).toContain('不要重复检查');
    expect(prompt).toContain('query_json 查询精确 JSON Pointer');
    expect(prompt).toContain('query_text_file');
    expect(prompt).toContain('不得重复取数、重写计划或覆盖数据');
    expect(prompt).toContain('禁止卡片宫格');
    expect(prompt).toContain('不增加买入区间、止损、目标价、仓位');
    expect(prompt).not.toContain('quant_api_get');
    expect(prompt).not.toContain('quant_extract_uploaded_image');
    expect(prompt).not.toContain('mcp__');
    expect(prompt).not.toContain('curl -G');
    expect(prompt.length).toBeLessThan(4_000);
    expect(await hasPlatformPreparedQuantArtifacts(projectPath)).toBe(true);
  });

  it('keeps the invariant system prompt compact and terminal-workbench oriented', () => {
    const prompt = buildQuantPilotSystemPrompt();

    expect(prompt).toContain('continuous, data-dense trading/research terminal');
    expect(prompt).toContain('not a card gallery');
    expect(prompt).toContain('inspect_dashboard_contract');
    expect(prompt).toContain('submit_result');
    expect(prompt.length).toBeLessThan(3_000);
  });
});
