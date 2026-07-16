import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QuantRunPlan } from './workspace';
import { getProjectLlmConfig } from '@/lib/config/llm';
import {
  extractQuantSymbolNameCandidates,
  buildFundamentalMetricComparison,
  hasExplicitTradingPlanIntent,
  inferHistoryLimit,
  prefetchQuantDataForRunPlan,
} from './data-prefetch';

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

  it.each([
    ['大位科技这个股票怎么样', ['大位科技']],
    ['大位科技这只股票如何', ['大位科技']],
    ['大位科技这家公司最近怎么样', ['大位科技']],
    ['中信证券最近怎么样', ['中信证券']],
    ['中国平安公司最近怎么样', ['中国平安公司']],
    ['帮我分析一下北方稀土', ['北方稀土']],
    ['能不能分析一下北方稀土', ['北方稀土']],
    ['我想了解一下北方稀土', ['北方稀土']],
  ])('normalizes %s before calling the resolver', (question, expected) => {
    expect(extractQuantSymbolNameCandidates(question)).toEqual(expected);
  });

  it('does not resolve a nested ETF suffix as a second security name', () => {
    expect(extractQuantSymbolNameCandidates('510300 沪深300ETF 最近120天走势如何？')).toEqual([
      '沪深300ETF',
    ]);
  });

  it.each([
    '这个股票怎么样',
    '这只股票如何',
    '该证券最近走势怎么样',
  ])('does not send a generic conversational reference to the resolver: %s', (question) => {
    expect(extractQuantSymbolNameCandidates(question)).toEqual([]);
  });

  it('resolves the cleaned company name and writes the ticker back to the run plan', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'quantpilot-prefetch-symbol-'));
    temporaryProjects.push(projectPath);
    await fs.mkdir(path.join(projectPath, '.quantpilot'), { recursive: true });

    const now = '2026-07-15T02:29:30.000Z';
    const plan: QuantRunPlan = {
      schemaVersion: 1,
      runId: 'conversational-symbol-prefetch',
      status: 'planned',
      capabilityId: 'stock_diagnosis',
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
      path.join(projectPath, '.quantpilot', 'run_plan.json'),
      `${JSON.stringify(plan, null, 2)}\n`,
      'utf8'
    );

    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.pathname === '/api/v1/symbols/resolve') {
        expect(url.searchParams.get('query')).toBe('大位科技');
        return Response.json({
          results: [{
            symbol: '600589',
            name: '大位科技',
            asset_type: 'stock',
            raw: { Classify: 'AStock' },
          }],
        });
      }
      if (url.pathname === '/api/v1/quotes/realtime/600589') {
        return Response.json({
          symbol: '600589',
          name: '大位科技',
          asset_type: 'stock',
          price: 10.25,
          change_percent: 1.2,
          quote_time: now,
          source: 'test-market-api',
          as_of: now,
          fetched_at: now,
        });
      }
      return new Response(`Unexpected market API request: ${url.pathname}`, { status: 500 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await prefetchQuantDataForRunPlan({ projectPath, plan });

    expect(result).toMatchObject({ skipped: false, symbol: '600589' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const persistedPlan = JSON.parse(
      await fs.readFile(path.join(projectPath, '.quantpilot', 'run_plan.json'), 'utf8')
    ) as { symbols?: string[]; symbolResolution?: { source?: string } };
    expect(persistedPlan).toMatchObject({
      symbols: ['600589'],
      symbolResolution: { source: 'question' },
    });
    await expect(
      fs.access(path.join(projectPath, 'data_file', 'final', 'dashboard-data.json'))
    ).resolves.toBeUndefined();
    await expect(fs.access(path.join(projectPath, 'evidence', 'sources.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(projectPath, 'evidence', 'data_quality.json'))).resolves.toBeUndefined();
  });
});
