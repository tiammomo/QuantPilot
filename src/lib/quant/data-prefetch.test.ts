import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QuantRunPlan } from '@/lib/domains/finance/workspace';
import { rewriteQuantQuery } from '@/lib/domains/finance/query-rewrite';
import {
  createQuantPilotDataAgentRegistry,
  QUANTPILOT_AGENT_PROFILE_ID,
} from '@/lib/domains/finance';
import { getProjectLlmConfig } from '@/lib/config/llm';
import { buildFundamentalMetricComparison } from "./data-prefetch/fundamentals";
import { hasExplicitTradingPlanIntent, inferHistoryLimit, isBroadStockScreenerPlan } from "./data-prefetch/planning";
import { prefetchQuantDataForRunPlan } from "./data-prefetch";

const temporaryProjects: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryProjects.splice(0).map((projectPath) =>
      fs.rm(projectPath, { recursive: true, force: true })
    )
  );
});

describe('quant trading-plan intent', () => {
  it.each([
    '帮我推荐6月3日要买的股票，给我推荐10个',
    '我准备买几只股票，给出研究计划',
    '给我一个明确的买入区间和止损',
  ])('recognizes explicit execution intent: %s', (question) => {
    expect(hasExplicitTradingPlanIntent(question)).toBe(true);
  });

  it('does not add an execution plan to a neutral comparison request', () => {
    expect(hasExplicitTradingPlanIntent('比较贵州茅台和宁德时代的财务质量')).toBe(false);
  });
});

describe('quant data-prefetch symbol candidates', () => {
  it('skips legacy plans with a system failure even when symbols and attachments are present', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const queryRewrite = await rewriteQuantQuery('分析贵州茅台', {
      semanticRewriter: async () => ({ ok: false, code: 'LLM_NOT_CONFIGURED', retryable: false }),
    });
    const result = await prefetchQuantDataForRunPlan({
      projectPath: '/unused-failed-plan',
      plan: { status: 'planned', symbols: ['600519'], queryRewrite: { ...queryRewrite, status: 'needs_clarification' } } as QuantRunPlan,
    });
    expect(result).toMatchObject({ skipped: true, summary: '研究规划失败，未执行数据预取。' });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('uses one batch request for a multi-asset plan and persists matching quotes and progress', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'qp-prefetch-batch-'));
    temporaryProjects.push(projectPath);
    const quotes = ['510300', '510500'].map(symbol => ({
      symbol, price: '4.1', asset_type: 'etf', source: 'fixture', fetched_at: '2026-09-18T08:00:00Z',
    }));
    const fetcher = vi.fn(async (url: string) => {
      if (url.endsWith('/api/v1/quotes/realtime')) return Response.json({ quotes });
      throw new Error(`Unexpected single-asset fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetcher);
    const onProgress = vi.fn().mockResolvedValue(undefined);
    const result = await prefetchQuantDataForRunPlan({
      projectPath,
      plan: {
        schemaVersion: 1, runId: 'batch', status: 'planned', capabilityId: 'stock_diagnosis',
        symbols: quotes.map(quote => quote.symbol), question: '研究两个 ETF', dataRequirements: [],
        timeRange: null, visualization: { required: true, panels: [] },
      } as unknown as QuantRunPlan,
      onProgress,
    });
    expect(result.skipped).toBe(false);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(onProgress).toHaveBeenLastCalledWith({ completed: 2, total: 2, succeeded: 2, failed: 0 });
    const data = JSON.parse(await fs.readFile(path.join(projectPath, result.finalDataPath!), 'utf8'));
    expect(data.assets.map((asset: { quote: unknown }) => asset.quote)).toEqual(quotes);
    for (const quote of quotes) {
      expect(JSON.parse(await fs.readFile(path.join(projectPath, `data_file/raw/batch/${quote.symbol}/quote.json`), 'utf8'))).toEqual(quote);
    }
  });

  it('builds a selected-period cash-flow versus net-profit comparison from stable or raw API fields', () => {
    expect(buildFundamentalMetricComparison({
      symbol: '600111',
      reports: [
        {
          symbol: '600111',
          report_date: '2025-12-31T00:00:00Z',
          data_type: '2025年 年报',
          net_profit_yoy: 124.17,
          raw: { MGJYXJJE: 0.3084 },
        },
        {
          symbol: '600111',
          report_date: '2024-12-31T00:00:00Z',
          data_type: '2024年 年报',
          raw: { MGJYXJJE: 0.2837 },
        },
      ],
    }, '2025年年报')).toMatchObject({
      reporting_period: '2025年 年报',
      operating_cash_flow_per_share_yoy: 8.71,
      net_profit_yoy: 124.17,
      cash_flow_outpaced_net_profit: false,
      conclusion: '每股经营现金流增速未跑赢净利润增速。',
    });
  });

  it('allocates a half-year sample for anchored half-year rewrites', () => {
    expect(inferHistoryLimit({
      timeRange: '去年下半年',
      question: '比较北方稀土和宁德时代',
    } as QuantRunPlan)).toBe(126);
  });

  it('uses accepted numeric ranges instead of a conflicting question', () => {
    expect(inferHistoryLimit({
      timeRange: '最近 120 个交易日',
      question: '不要使用最近500日，改成近2个月',
      queryRewrite: { timeRange: { label: '近2个月', value: 2, unit: 'month', source: 'explicit' } },
    } as QuantRunPlan)).toBe(42);
    expect(inferHistoryLimit({
      timeRange: '最近 120 个交易日', question: '最近500日',
    } as QuantRunPlan)).toBe(120);
  });

  it('does not turn a rejected universe into a screener from prose or endpoints', () => {
    const plan = {
      question: '有哪些股票值得关注',
      dataRequirements: ['/api/v1/research/screeners/a-share/short-term-candidates'],
      queryRewrite: { broadUniverse: false },
    } as QuantRunPlan;
    expect(isBroadStockScreenerPlan(plan)).toBe(false);
    expect(isBroadStockScreenerPlan({ ...plan, queryRewrite: undefined })).toBe(true);
    expect(isBroadStockScreenerPlan({ ...plan, queryRewrite: undefined, dataRequirements: [] })).toBe(false);
    expect(isBroadStockScreenerPlan({
      ...plan, queryRewrite: { ...plan.queryRewrite!, broadUniverse: true }, dataRequirements: [],
    })).toBe(false);
  });

  it('does not parse symbols from the question after Query Rewrite has produced the run plan', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'quantpilot-prefetch-symbol-'));
    temporaryProjects.push(projectPath);
    await fs.mkdir(path.join(projectPath, '.data-agent'), { recursive: true });

    const now = '2026-07-15T02:29:30.000Z';
    const plan: QuantRunPlan = {
      schemaVersion: 1,
      runId: 'conversational-symbol-prefetch',
      status: 'planned',
      capabilityId: 'stock_diagnosis',
      composition: createQuantPilotDataAgentRegistry().resolveCapability(
        QUANTPILOT_AGENT_PROFILE_ID,
        'stock_diagnosis',
      ).composition,
      llm: getProjectLlmConfig(),
      requestedCapabilityId: 'stock_diagnosis',
      executionCapabilityId: 'stock_diagnosis',
      question: '帮我分析一下大位科技',
      symbols: [],
      timeRange: '最近 120 个交易日',
      dataRequirements: [],
      analysisSteps: [],
      visualization: {
        required: true,
        templateId: 'single-stock-diagnosis',
        matchReasons: ['命中问题关键词：股票'],
        panels: [],
      },
      expectedArtifacts: [],
      validationRules: [],
      createdAt: now,
      updatedAt: now,
    };
    await fs.writeFile(
      path.join(projectPath, '.data-agent', 'finance-run-plan.json'),
      `${JSON.stringify(plan, null, 2)}\n`,
      'utf8'
    );

    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await prefetchQuantDataForRunPlan({ projectPath, plan });

    expect(result).toMatchObject({ skipped: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
