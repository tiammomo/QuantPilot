import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rewriteQuantQuery } from './query-rewrite';
import { writeInitialRunPlan } from './workspace';

const temporaryProjects: string[] = [];

async function createProject() {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'quantpilot-run-plan-'));
  temporaryProjects.push(projectPath);
  return projectPath;
}

afterEach(async () => {
  vi.unstubAllGlobals();
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
    expect(plan.symbols).toEqual(['600030']);
    expect(plan.timeRange).toBe('最近 120 个交易日');
    expect(plan.visualization.required).toBe(true);
    expect(plan.visualization.templateId).toBe('single-stock-diagnosis');
    expect(plan.visualization.matchReasons).toEqual(
      expect.arrayContaining([expect.stringMatching(/^识别到 1 个标的$/)])
    );
  });

  it('persists dynamically resolved conversational names as plan symbols', async () => {
    const projectPath = await createProject();
    const queryRewrite = await rewriteQuantQuery('大位科技这个股票怎么样', {
      resolver: async () => ({
        results: [{
          symbol: '600589',
          name: '大位科技',
          asset_type: 'stock',
          market: 'SH',
          secid: '1.600589',
          source: 'test-market-api',
        }],
      }),
    });
    const plan = await writeInitialRunPlan({
      projectPath,
      requestId: 'conversational-security-diagnosis-regression',
      capabilityId: 'stock_diagnosis',
      capabilitySource: 'auto',
      instruction: '大位科技这个股票怎么样',
      queryRewrite,
    });

    expect(plan.status).toBe('planned');
    expect(plan.symbols).toEqual(['600589']);
    expect(plan.visualization.matchReasons).toEqual(
      expect.arrayContaining([expect.stringMatching(/^识别到 1 个标的$/)])
    );
    await expect(
      fs.readFile(path.join(projectPath, '.quantpilot', 'query_rewrite.json'), 'utf8'),
    ).resolves.toContain('600589');
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

  it('uses dynamic resolution for names not covered by the partial static alias set', async () => {
    const projectPath = await createProject();
    const symbolByQuery: Record<string, string> = {
      北方稀土: '600111',
      宁德时代: '300750',
    };
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      const query = url.searchParams.get('query') ?? '';
      return Response.json({
        results: [{
          symbol: symbolByQuery[query],
          name: query,
          asset_type: 'stock',
          market: query === '北方稀土' ? 'SH' : 'SZ',
        }],
      });
    }));

    const plan = await writeInitialRunPlan({
      projectPath,
      requestId: 'mixed-static-dynamic-symbols',
      capabilityId: 'asset_comparison',
      capabilitySource: 'auto',
      instruction: '比较北方稀土和宁德时代的收益与风险',
    });

    expect(plan.status).toBe('planned');
    expect(plan.symbols).toEqual(['600111', '300750']);
    expect(plan.symbols).toEqual(
      plan.queryRewrite?.resolvedSymbols.map((item) => item.symbol),
    );
    expect(plan.queryRewrite?.resolvedSymbols).toHaveLength(2);
  });

  it('keeps a single-stock financial metric comparison on fundamental analysis', async () => {
    const projectPath = await createProject();
    const queryRewrite = await rewriteQuantQuery(
      '北方稀土2025年年报里，经营现金流增速是否跑赢净利润？',
      {
        resolver: async () => ({
          results: [{
            symbol: '600111',
            name: '北方稀土',
            asset_type: 'stock',
            market: 'SH',
          }],
        }),
      },
    );
    const plan = await writeInitialRunPlan({
      projectPath,
      requestId: 'fundamental-metric-comparison',
      capabilityId: 'fundamental_analysis',
      capabilitySource: 'auto',
      instruction: queryRewrite.originalQuery,
      queryRewrite,
    });

    expect(plan).toMatchObject({
      status: 'planned',
      capabilityId: 'fundamental_analysis',
      symbols: ['600111'],
      llm: {
        provider: 'deepseek',
        model: 'deepseek-v4-flash',
        queryRewrite: { mode: 'auto' },
      },
    });
    expect(plan.clarification).toBeUndefined();
  });

  it('creates a non-executable refused plan for guaranteed-return requests', async () => {
    const projectPath = await createProject();
    const plan = await writeInitialRunPlan({
      projectPath,
      requestId: 'guaranteed-return-refusal',
      capabilityId: 'stock_diagnosis',
      capabilitySource: 'auto',
      instruction: '明天买哪只股票一定能涨停？',
      enableLlmRewrite: true,
    });

    expect(plan).toMatchObject({
      status: 'refused',
      symbols: [],
      refusal: { code: 'GUARANTEED_RETURN_REQUEST' },
      visualization: { required: false },
    });
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
