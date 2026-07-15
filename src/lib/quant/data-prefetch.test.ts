import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QuantRunPlan } from './workspace';
import {
  extractQuantSymbolNameCandidates,
  hasExplicitTradingPlanIntent,
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
  it.each([
    ['大位科技这个股票怎么样', ['大位科技']],
    ['大位科技这只股票如何', ['大位科技']],
    ['大位科技这家公司最近怎么样', ['大位科技']],
    ['中信证券最近怎么样', ['中信证券']],
    ['中国平安公司最近怎么样', ['中国平安公司']],
  ])('normalizes %s before calling the resolver', (question, expected) => {
    expect(extractQuantSymbolNameCandidates(question)).toEqual(expected);
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
      requestedCapabilityId: 'stock_diagnosis',
      executionCapabilityId: 'stock_diagnosis',
      question: '大位科技这个股票怎么样',
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
