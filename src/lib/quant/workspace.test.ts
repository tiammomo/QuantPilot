import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  rewriteQuantQuery,
  type QuantQueryFocusId,
  type QuantQueryLlmSemantics,
} from './query-rewrite';
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
    ),
  );
});

async function buildRewrite(params: {
  query: string;
  targets?: string[];
  symbolByTarget?: Record<string, string>;
  focus?: QuantQueryFocusId;
  outputIntent?: 'dashboard' | 'answer';
  answerOnlyEvidence?: string | null;
  timeRange?: QuantQueryLlmSemantics['timeRange'];
  broadUniverse?: boolean;
  broadUniverseEvidence?: string | null;
}) {
  const targets = params.targets ?? [];
  return rewriteQuantQuery(params.query, {
    semanticRewriter: async () => ({
      ok: true,
      provider: 'openai',
      model: 'local_qwen:qwen3.5-9b-q5km',
      data: {
        targetCandidates: targets,
        timeRange: params.timeRange ?? null,
        analysisFocusId: params.focus ?? 'comprehensive',
        outputIntent: params.outputIntent ?? 'dashboard',
        answerOnlyEvidence: params.answerOnlyEvidence ?? null,
        broadUniverse: params.broadUniverse ?? false,
        broadUniverseEvidence: params.broadUniverseEvidence ?? null,
        confidence: 0.95,
      },
    }),
    resolver: async (target) => {
      const symbol = params.symbolByTarget?.[target];
      return symbol
        ? {
            results: [{
              symbol,
              name: target,
              asset_type: 'stock',
              market: symbol.startsWith('6') ? 'SH' : 'SZ',
              source: 'test-resolver',
            }],
          }
        : { results: [] };
    },
  });
}

describe('writeInitialRunPlan', () => {
  it('persists the LLM rewrite and authoritative resolver symbol in the run plan', async () => {
    const projectPath = await createProject();
    const query = '大位科技这个股票怎么样';
    const queryRewrite = await buildRewrite({
      query,
      targets: ['大位科技'],
      symbolByTarget: { 大位科技: '600589' },
    });

    const plan = await writeInitialRunPlan({
      projectPath,
      requestId: 'named-security-diagnosis',
      capabilityId: 'stock_diagnosis',
      capabilitySource: 'auto',
      instruction: query,
      queryRewrite,
    });

    expect(plan).toMatchObject({
      status: 'planned',
      capabilityId: 'stock_diagnosis',
      symbols: ['600589'],
      timeRange: '最近 120 个交易日',
      visualization: { required: true, templateId: 'single-stock-diagnosis' },
      queryRewrite: {
        schemaVersion: 4,
        execution: { strategy: 'llm_primary' },
      },
    });
    await expect(
      fs.readFile(path.join(projectPath, '.quantpilot', 'query_rewrite.json'), 'utf8'),
    ).resolves.toContain('600589');
  });

  it('uses the LLM output intent to skip dashboard generation', async () => {
    const projectPath = await createProject();
    const query = '只回答北方稀土怎么样，不需要看板';
    const queryRewrite = await buildRewrite({
      query,
      targets: ['北方稀土'],
      symbolByTarget: { 北方稀土: '600111' },
      outputIntent: 'answer',
      answerOnlyEvidence: '不需要看板',
    });

    const plan = await writeInitialRunPlan({
      projectPath,
      requestId: 'answer-only',
      capabilityId: 'stock_diagnosis',
      capabilitySource: 'auto',
      instruction: query,
      queryRewrite,
    });

    expect(plan.visualization.required).toBe(false);
  });

  it('selects asset comparison from LLM semantics and resolved targets', async () => {
    const projectPath = await createProject();
    const query = '对比贵州茅台和宁德时代最近120个交易日的收益、回撤和波动率看板。';
    const queryRewrite = await buildRewrite({
      query,
      targets: ['贵州茅台', '宁德时代'],
      symbolByTarget: { 贵州茅台: '600519', 宁德时代: '300750' },
      focus: 'comparison',
      timeRange: {
        label: '最近120个交易日',
        value: 120,
        unit: 'trading_day',
        evidence: '最近120个交易日',
      },
    });

    const plan = await writeInitialRunPlan({
      projectPath,
      requestId: 'multi-stock-comparison',
      capabilityId: 'technical_analysis',
      capabilitySource: 'auto',
      instruction: query,
      queryRewrite,
    });

    expect(plan).toMatchObject({
      status: 'planned',
      capabilityId: 'asset_comparison',
      symbols: ['600519', '300750'],
      timeRange: '最近120个交易日',
    });
  });

  it('keeps a benchmark capability authoritative while retaining the LLM rewrite', async () => {
    const projectPath = await createProject();
    const query = '分析沪深300最近120个交易日的趋势与量能。';
    const queryRewrite = await buildRewrite({
      query,
      targets: ['沪深300'],
      symbolByTarget: { 沪深300: '000300' },
      focus: 'strategy',
      timeRange: {
        label: '最近120个交易日',
        value: 120,
        unit: 'trading_day',
        evidence: '最近120个交易日',
      },
    });

    const plan = await writeInitialRunPlan({
      projectPath,
      requestId: 'benchmark-technical-routing',
      capabilityId: 'technical_analysis',
      capabilitySource: 'benchmark',
      instruction: query,
      queryRewrite,
    });

    expect(plan).toMatchObject({
      status: 'planned',
      capabilityId: 'technical_analysis',
      symbols: ['000300'],
      timeRange: '最近120个交易日',
      queryRewrite: {
        analysisFocus: { id: 'strategy' },
        execution: { strategy: 'llm_primary' },
      },
    });
  });

  it('asks for comparison targets when the LLM finds only a generic quantity', async () => {
    const projectPath = await createProject();
    const query = '帮我对比几只股票，生成看板。';
    const queryRewrite = await buildRewrite({ query, focus: 'comparison' });

    const plan = await writeInitialRunPlan({
      projectPath,
      requestId: 'generic-comparison-clarification',
      capabilityId: 'asset_comparison',
      capabilitySource: 'auto',
      instruction: query,
      queryRewrite,
    });

    expect(plan.status).toBe('needs_clarification');
    expect(plan.symbols).toEqual([]);
    expect(plan.clarification?.missing).toContain('comparison_universe');
  });

  it('stops the run plan when Query Rewrite is unavailable instead of parsing keywords', async () => {
    const projectPath = await createProject();
    const queryRewrite = await rewriteQuantQuery('分析大位科技', {
      semanticRewriter: async () => ({
        ok: false,
        code: 'LLM_NETWORK_ERROR',
        provider: 'openai',
        model: 'local_qwen:qwen3.5-9b-q5km',
        retryable: true,
      }),
    });

    const plan = await writeInitialRunPlan({
      projectPath,
      requestId: 'rewrite-unavailable',
      instruction: '分析大位科技',
      queryRewrite,
    });

    expect(plan).toMatchObject({
      status: 'needs_clarification',
      symbols: [],
      visualization: { required: false },
      clarification: { confidence: 0 },
    });
  });

  it('keeps a single-stock financial metric comparison on fundamental analysis', async () => {
    const projectPath = await createProject();
    const query = '北方稀土2025年年报里，经营现金流增速是否跑赢净利润？';
    const queryRewrite = await buildRewrite({
      query,
      targets: ['北方稀土'],
      symbolByTarget: { 北方稀土: '600111' },
      focus: 'fundamental',
      timeRange: {
        label: '2025年年报',
        value: 1,
        unit: 'reporting_period',
        evidence: '2025年年报',
      },
    });

    const plan = await writeInitialRunPlan({
      projectPath,
      requestId: 'fundamental-metric-comparison',
      capabilityId: 'fundamental_analysis',
      capabilitySource: 'auto',
      instruction: query,
      queryRewrite,
    });

    expect(plan).toMatchObject({
      status: 'planned',
      capabilityId: 'fundamental_analysis',
      symbols: ['600111'],
      llm: {
        provider: 'openai',
        model: 'local_qwen:qwen3.5-9b-q5km',
        queryRewrite: { enabled: true },
      },
    });
  });

  it('creates a non-executable refused plan before model execution', async () => {
    const projectPath = await createProject();
    const plan = await writeInitialRunPlan({
      projectPath,
      requestId: 'guaranteed-return-refusal',
      capabilityId: 'stock_diagnosis',
      capabilitySource: 'auto',
      instruction: '明天买哪只股票一定能涨停？',
    });

    expect(plan).toMatchObject({
      status: 'refused',
      symbols: [],
      refusal: { code: 'GUARANTEED_RETURN_REQUEST' },
      visualization: { required: false },
    });
  });
});
