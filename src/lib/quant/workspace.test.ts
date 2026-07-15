import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeInitialRunPlan } from './workspace';

const temporaryProjects: string[] = [];

async function createProject() {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'quantpilot-run-plan-'));
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

describe('writeInitialRunPlan', () => {
  it('plans a named security diagnosis without requiring a ticker clarification', async () => {
    const projectPath = await createProject();
    const plan = await writeInitialRunPlan({
      projectPath,
      requestId: 'named-security-diagnosis-regression',
      capabilityId: 'stock_diagnosis',
      capabilitySource: 'auto',
      instruction: '中信证券最近怎么样',
    });

    expect(plan.status).toBe('planned');
    expect(plan.clarification).toBeUndefined();
    expect(plan.symbols).toEqual([]);
    expect(plan.timeRange).toBe('最近 120 个交易日');
    expect(plan.visualization.required).toBe(true);
    expect(plan.visualization.templateId).toBe('single-stock-diagnosis');
    expect(plan.visualization.matchReasons).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^识别到 \d+ 个标的$/)])
    );
  });

  it('does not report unresolved conversational name candidates as resolved symbols', async () => {
    const projectPath = await createProject();
    const plan = await writeInitialRunPlan({
      projectPath,
      requestId: 'conversational-security-diagnosis-regression',
      capabilityId: 'stock_diagnosis',
      capabilitySource: 'auto',
      instruction: '大位科技这个股票怎么样',
    });

    expect(plan.status).toBe('planned');
    expect(plan.symbols).toEqual([]);
    expect(plan.visualization.matchReasons).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/^识别到 \d+ 个标的$/)])
    );
  });

  it('keeps a single symbol with duplicate aliases on the technical-analysis template', async () => {
    const projectPath = await createProject();
    const plan = await writeInitialRunPlan({
      projectPath,
      requestId: 'single-stock-technical-regression',
      capabilityId: 'technical_analysis',
      capabilitySource: 'auto',
      instruction:
        '生成贵州茅台最近120个交易日的技术分析看板，必须包含价格趋势、成交量、MA5/MA20/MA60、风险结论、数据更新时间和数据信源。',
    });

    expect(plan.symbols).toEqual(['600519']);
    expect(plan.capabilityId).toBe('technical_analysis');
    expect(plan.visualization.templateId).toBe('technical-timing');
  });

  it('does not reinterpret an ETF alias as both the ETF and its index prefix', async () => {
    const projectPath = await createProject();
    const plan = await writeInitialRunPlan({
      projectPath,
      requestId: 'hs300-etf-alias-regression',
      capabilityId: 'technical_analysis',
      capabilitySource: 'auto',
      instruction: '510300 沪深300ETF 最近120天走势如何？生成趋势看板。',
    });

    expect(plan.symbols).toEqual(['510300']);
    expect(plan.capabilityId).toBe('technical_analysis');
    expect(plan.visualization.templateId).toBe('technical-timing');
  });

  it('selects asset comparison only when the instruction resolves to distinct symbols', async () => {
    const projectPath = await createProject();
    const plan = await writeInitialRunPlan({
      projectPath,
      requestId: 'multi-stock-comparison',
      capabilityId: 'technical_analysis',
      capabilitySource: 'auto',
      instruction: '对比贵州茅台和宁德时代最近120个交易日的收益、回撤和波动率看板。',
    });

    expect(plan.symbols).toEqual(['600519', '300750']);
    expect(plan.capabilityId).toBe('asset_comparison');
    expect(plan.visualization.templateId).toBe('stock-selection');
  });

  it('requires clarification when a comparison only names a generic quantity', async () => {
    const projectPath = await createProject();
    const plan = await writeInitialRunPlan({
      projectPath,
      requestId: 'generic-comparison-clarification',
      capabilityId: 'asset_comparison',
      capabilitySource: 'auto',
      instruction: '帮我对比几只股票，生成看板。',
    });

    expect(plan.status).toBe('needs_clarification');
    expect(plan.symbols).toEqual([]);
    expect(plan.clarification?.missing).toContain('comparison_universe');
  });

  it('lets an explicit rebalance action outrank generic portfolio-risk nouns', async () => {
    const projectPath = await createProject();
    const plan = await writeInitialRunPlan({
      projectPath,
      requestId: 'portfolio-rebalance-specificity',
      capabilityId: 'portfolio_risk',
      capabilitySource: 'auto',
      instruction:
        '我持有杭钢股份、京沪高铁、三七互娱、中国黄金、完美世界，请结合集中风险和现金生成调仓分析看板。',
    });

    expect(plan.status).toBe('planned');
    expect(plan.visualization.templateId).toBe('holding-analysis');
    expect(plan.visualization.variantId).toBe('portfolio-rebalance-plan');
    expect(plan.visualization.matchReasons).toEqual(
      expect.arrayContaining([expect.stringContaining('调仓')]),
    );
  });
});
