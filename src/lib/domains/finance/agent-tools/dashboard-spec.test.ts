import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MoAgentToolContext } from '@/lib/agent/types';
import { serializeQuantVisualizationTemplate } from '../visualization-templates';

import { MoAgentToolError } from '@/lib/agent/tools/errors';
import {
  __dashboardSpecTesting,
  createApplyDashboardSpecTool,
  isDashboardSpecCapabilitySupported,
} from './dashboard-spec';

const SINGLE_STOCK_COMPONENTS = [
  '紧凑行情摘要',
  'K 线与成交量主图',
  '趋势/量能/风险信号',
  '财务与公告摘要',
  '数据质量',
];

const SINGLE_STOCK_FUNDAMENTAL_COMPONENTS = [
  '行情侧栏',
  '财务质量评分',
  '营收利润趋势',
  '利润率/ROE',
  '公告事件',
  '缺失字段说明',
];

const TECHNICAL_KLINE_COMPONENTS = [
  'K 线主图',
  '成交量副图',
  'MA5/MA10/MA20/MA60',
  '触发条件',
  '失效条件',
  '风险指标',
];

const STOCK_SELECTION_COMPONENTS = [
  '标的覆盖摘要',
  '多标的指标矩阵',
  '收益对比主图',
  '回撤/波动主图',
  '排序依据',
  '数据口径',
];

const BACKTEST_COMPONENTS = [
  '策略参数',
  '净值曲线',
  '回撤指标',
  '收益/胜率/交易次数',
  '交易明细',
  '限制说明',
];

const FUNDAMENTAL_COMPONENTS = [
  '质量评分',
  '营收利润趋势',
  'ROE/利润率',
  '现金流或缺失说明',
  '报告期表',
];

const STRATEGY_COMPONENTS = [
  '策略假设',
  '信号规则',
  '样本参数',
  '待验证清单',
  '数据限制',
];

const PORTFOLIO_RISK_COMPONENTS = [
  '组合摘要',
  '持仓矩阵',
  '仓位集中度',
  '相关性/流动性风险',
  '数据缺口',
];

const REJECTED_VARIANTS = [
  ['technical-timing', 'technical-breakout-watch'],
  ['fundamental-research', 'fundamental-report-trend'],
  ['stock-selection', 'selection-correlation-risk-map'],
  ['stock-selection', 'selection-liquidity-trend-board'],
  ['sector-rotation', 'sector-rotation-radar'],
  ['sector-rotation', 'sector-capital-flow-board'],
  ['strategy-research', 'strategy-signal-lab'],
  ['backtest-review', 'backtest-trade-forensics'],
  ['holding-analysis', 'portfolio-rebalance-plan'],
] as const;

const KNOWN_TEMPLATE_IDS = [
  'single-stock-diagnosis',
  'technical-timing',
  'fundamental-research',
  'stock-selection',
  'sector-rotation',
  'strategy-research',
  'backtest-review',
  'holding-analysis',
] as const;

type JsonRecord = Record<string, unknown>;

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function runPlan(
  templateId: string,
  variantId: string,
  panels: string[],
): JsonRecord {
  return {
    runId: 'run-plan',
    status: 'planned',
    symbols: ['stock-selection', 'strategy-research', 'holding-analysis'].includes(templateId)
      ? ['600519', '600589']
      : [templateId === 'backtest-review' ? '510300' : '600589'],
    visualization: {
      required: true,
      templateId,
      variantId,
      panels,
    },
  };
}

function visualization(
  templateId: string,
  variantId: string,
  requiredComponents: string[],
): JsonRecord {
  return {
    template_id: templateId,
    variant_id: variantId,
    required_components: requiredComponents,
    missing_components: [],
  };
}

function stockSelectionData(): JsonRecord {
  const assets = [
    { symbol: '600519', name: '贵州茅台', source: 'eastmoney', quote: { symbol: '600519', price: 1512, source: 'eastmoney' } },
    { symbol: '600589', name: '大位科技', source: 'eastmoney', quote: { symbol: '600589', price: 8.31, source: 'eastmoney' } },
  ];
  return {
    runId: 'run-plan',
    symbol: '600519',
    requestedSymbols: ['600519', '600589'],
    symbols: ['600519', '600589'],
    assets,
    comparison: {
      rows: [
        { symbol: '600519', period_return: 8.2, max_drawdown: -6.1, volatility20d: 17.3 },
        { symbol: '600589', period_return: -2.4, max_drawdown: -12.8, volatility20d: 31.4 },
      ],
    },
    selectionRanking: {
      rows: [
        { symbol: '600519', rank: 1, score: 82 },
        { symbol: '600589', rank: 2, score: 61 },
      ],
    },
    visualization: visualization(
      'stock-selection',
      'selection-ranking-matrix',
      STOCK_SELECTION_COMPONENTS,
    ),
  };
}

function strategyResearchData(): JsonRecord {
  const data = stockSelectionData();
  data.screener = {
    universe_id: 'a-share-research-pool',
    mode: 'short_term',
    trade_date: '2026-07-17',
    scanned_symbols: 298,
    total_candidates: 2,
    candidates: [
      { code: '600519', signals: ['收盘价站上 MA20', '量能改善'] },
      { code: '600589', signals: ['低波动代理'] },
    ],
  };
  data.conclusion = {
    summary: ['排序仅用于横向研究。'],
    risk_disclaimer: '尚未完成样本外回测，不构成投资建议。',
  };
  data.warnings = ['未建模交易成本。'];
  data.visualization = visualization(
    'strategy-research',
    'strategy-hypothesis-canvas',
    STRATEGY_COMPONENTS,
  );
  return data;
}

function portfolioRiskData(): JsonRecord {
  const assets = [
    { symbol: '600519', name: '贵州茅台', source: 'eastmoney', quote: { symbol: '600519', price: 1512, source: 'eastmoney' } },
    { symbol: '600589', name: '大位科技', source: 'eastmoney', quote: { symbol: '600589', price: 8.31, source: 'eastmoney' } },
  ];
  return {
    runId: 'run-plan',
    symbol: '600519',
    requestedSymbols: ['600519', '600589'],
    symbols: ['600519', '600589'],
    assets,
    holdings: [
      { symbol: '600519', name: '贵州茅台', weight: 50, current_price: 1512 },
      { symbol: '600589', name: '大位科技', weight: 50, current_price: 8.31 },
    ],
    portfolio: {
      concentration: { max_weight_pct: 50, top3_weight_pct: 100 },
      data_gaps: ['shares', 'cost_price'],
      warnings: ['当前使用等权代理。'],
    },
    comparison: {
      rows: [
        { symbol: '600519', period_return: 8.2, max_drawdown: -6.1, volatility20d: 17.3 },
        { symbol: '600589', period_return: -2.4, max_drawdown: -12.8, volatility20d: 31.4 },
      ],
    },
    correlation: {
      symbols: ['600519', '600589'],
      matrix: [
        { symbol: '600519', '600519': 1, '600589': 0.32 },
        { symbol: '600589', '600519': 0.32, '600589': 1 },
      ],
      top_pairs: [{ left: '600519', right: '600589', correlation: 0.32, overlap: 119 }],
    },
    liquidity: {
      rows: [
        { symbol: '600519', avg_amount_20d: 1_000_000, liquidity_score: 'high' },
        { symbol: '600589', avg_amount_20d: 500_000, liquidity_score: 'medium' },
      ],
    },
    visualization: visualization(
      'holding-analysis',
      'portfolio-risk-console',
      PORTFOLIO_RISK_COMPONENTS,
    ),
  };
}

function singleStockData(): JsonRecord {
  return {
    runId: 'run-plan',
    symbol: '600589',
    source: 'eastmoney',
    quote: { symbol: '600589', price: 8.31, source: 'eastmoney' },
    kline: {
      symbol: '600589',
      bars: Array.from({ length: 20 }, (_, index) => ({
        date: `2026-06-${String(index + 1).padStart(2, '0')}`,
        close: 8 + index / 100,
        volume: 1_000_000 + index,
      })),
    },
    computedMetrics: {
      maxDrawdown: -8.5,
      volatility20d: 24.1,
      avgVolume20d: 1_000_009,
      ma5: 8.17,
      ma20: 8.095,
    },
    visualization: visualization(
      'single-stock-diagnosis',
      'single-stock-command-center',
      SINGLE_STOCK_COMPONENTS,
    ),
  };
}

function technicalKlineData(): JsonRecord {
  const data = singleStockData();
  data.computedMetrics = {
    ...(data.computedMetrics as JsonRecord),
    ma10: 8.14,
    ma60: 7.92,
  };
  data.visualization = visualization(
    'technical-timing',
    'technical-kline-trader',
    TECHNICAL_KLINE_COMPONENTS,
  );
  return data;
}

function backtestData(): JsonRecord {
  return {
    runId: 'run-plan',
    symbol: '510300',
    backtest: {
      symbol: '510300',
      strategy_id: 'ma_crossover',
      strategy_name: '均线交叉趋势',
      fast_window: 20,
      slow_window: 60,
      fee_bps: 5,
      summary: {
        total_return_pct: 12.3,
        max_drawdown_pct: -7.2,
        trade_count: 1,
        win_rate_pct: 100,
      },
      equity_curve: [
        { date: '2026-01-01', equity: 1 },
        { date: '2026-01-02', equity: 1.01 },
      ],
      trades: [{ entry_date: '2026-01-01', exit_date: '2026-01-02', return_pct: 1 }],
    },
    visualization: visualization(
      'backtest-review',
      'backtest-performance-review',
      BACKTEST_COMPONENTS,
    ),
  };
}

function fundamentalData(): JsonRecord {
  const reports = [
    { symbol: '600589', report_date: '2025-12-31', revenue: 200, parent_net_profit: 80 },
    { symbol: '600589', report_date: '2024-12-31', revenue: 180, parent_net_profit: 40 },
  ];
  return {
    runId: 'run-plan',
    symbol: '600589',
    financials: { symbol: '600589', reports },
    fundamentalIndicators: { symbol: '600589', points: reports },
    fundamentalMetricComparison: {
      symbol: '600589',
      conclusion: '每股经营现金流增速未跑赢净利润增速。',
      basis: '每股经营活动现金流净额同比代理口径。',
    },
    visualization: visualization(
      'fundamental-research',
      'fundamental-quality-scorecard',
      FUNDAMENTAL_COMPONENTS,
    ),
  };
}

function singleStockFundamentalData(): JsonRecord {
  const reports = [
    { symbol: '600589', report_date: '2026-03-31', revenue: 547, parent_net_profit: 272 },
    { symbol: '600589', report_date: '2025-12-31', revenue: 1_800, parent_net_profit: 900 },
  ];
  return {
    runId: 'run-plan',
    symbol: '600589',
    quote: { symbol: '600589', price: 8.31, source: 'eastmoney' },
    financials: { symbol: '600589', reports },
    fundamentalIndicators: { symbol: '600589', points: reports },
    financialQuality: {
      rows: [{
        symbol: '600589',
        latest_report_date: '2026-03-31',
        quality_score: 83,
        quality_label: '盈利质量较强',
        strengths: ['毛利率较高'],
        watch_items: ['复核现金流'],
      }],
      limitations: ['未纳入行业景气度'],
    },
    announcements: { symbol: '600589', announcements: [] },
    visualization: visualization(
      'single-stock-diagnosis',
      'single-stock-fundamental-snapshot',
      SINGLE_STOCK_FUNDAMENTAL_COMPONENTS,
    ),
  };
}

function capturedToolError(operation: () => unknown): MoAgentToolError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(MoAgentToolError);
    return error as MoAgentToolError;
  }
  throw new Error('Expected operation to throw MoAgentToolError.');
}

describe('apply_dashboard_spec tool', () => {
  let workspace: string;
  let outside: string;
  let commitCount: number;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moagent-dashboard-spec-'));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'moagent-dashboard-outside-'));
    commitCount = 0;
    await fs.mkdir(path.join(workspace, 'app'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'app', 'page.tsx'), 'export default function Page(){return null}\n');
    await fs.writeFile(path.join(workspace, 'app', 'globals.css'), 'body{}\n');
    await writeJson(
      path.join(workspace, '.data-agent', 'finance-run-plan.json'),
      runPlan('stock-selection', 'selection-ranking-matrix', STOCK_SELECTION_COMPONENTS),
    );
    await writeJson(
      path.join(workspace, 'data_file', 'final', 'dashboard-data.json'),
      stockSelectionData(),
    );
  });

  afterEach(async () => {
    await Promise.all([
      fs.rm(workspace, { recursive: true, force: true }),
      fs.rm(outside, { recursive: true, force: true }),
    ]);
  });

  function context(withFence = true): MoAgentToolContext {
    return {
      runId: 'run-dashboard-spec',
      turn: 1,
      toolCallId: 'call-dashboard-spec',
      operationId: 'op_dashboard_spec',
      signal: new AbortController().signal,
      ...(withFence
        ? {
            commitWorkspaceMutation: async <T>(commit: () => Promise<T>): Promise<T> => {
              commitCount += 1;
              return commit();
            },
          }
        : {}),
    };
  }

  it('compiles an exact authoritative capability into both artifacts under one commit fence', async () => {
    const tool = createApplyDashboardSpecTool({ workspaceRoot: workspace });
    const result = await tool.execute(tool.parseInput?.({}) ?? {}, context());

    expect(result).toMatchObject({
      ok: true,
      data: {
        spec: {
          schemaVersion: 1,
          templateId: 'stock-selection',
          variantId: 'selection-ranking-matrix',
          renderer: 'stock-selection',
          requiredComponents: STOCK_SELECTION_COMPONENTS,
          dataPrerequisites: [
            'comparison_symbol_coverage',
            'comparison_chart_metrics',
            'selection_ranking',
            'asset_source_evidence',
          ],
        },
      },
    });
    expect(commitCount).toBe(1);
    const [page, styles] = await Promise.all([
      fs.readFile(path.join(workspace, 'app', 'page.tsx'), 'utf8'),
      fs.readFile(path.join(workspace, 'app', 'globals.css'), 'utf8'),
    ]);
    expect(page).toContain("data-template={isStrategyResearch ? 'strategy-research' : 'stock-selection'}");
    expect(page).toContain('data_file/final/dashboard-data.json');
    expect(styles).toContain('.selection-shell');
    expect(styles).toContain('.comparison-panel');
  });

  it('treats model template fields as assertions and fails before any write', async () => {
    const originalPage = await fs.readFile(path.join(workspace, 'app', 'page.tsx'), 'utf8');
    const tool = createApplyDashboardSpecTool({ workspaceRoot: workspace });
    const result = await tool.execute(
      tool.parseInput?.({ templateId: 'technical-timing' }) ?? {},
      context(),
    );

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'DASHBOARD_SPEC_ASSERTION_FAILED' },
    });
    expect(commitCount).toBe(0);
    await expect(fs.readFile(path.join(workspace, 'app', 'page.tsx'), 'utf8'))
      .resolves.toBe(originalPage);
  });

  it('requires status=planned before contract compilation', async () => {
    await writeJson(path.join(workspace, '.data-agent', 'finance-run-plan.json'), {
      ...runPlan('stock-selection', 'selection-ranking-matrix', STOCK_SELECTION_COMPONENTS),
      status: 'ready',
    });
    const tool = createApplyDashboardSpecTool({ workspaceRoot: workspace });
    const result = await tool.execute(tool.parseInput?.({}) ?? {}, context());

    expect(result).toMatchObject({ ok: false, error: { code: 'DASHBOARD_SPEC_PLAN_NOT_READY' } });
    expect(commitCount).toBe(0);
  });

  it('requires visualization.required=true in the run plan', async () => {
    const plan = runPlan('stock-selection', 'selection-ranking-matrix', STOCK_SELECTION_COMPONENTS);
    (plan.visualization as JsonRecord).required = false;
    await writeJson(path.join(workspace, '.data-agent', 'finance-run-plan.json'), plan);
    const tool = createApplyDashboardSpecTool({ workspaceRoot: workspace });
    const result = await tool.execute(tool.parseInput?.({}) ?? {}, context());

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'DASHBOARD_SPEC_VISUALIZATION_NOT_REQUIRED' },
    });
    expect(commitCount).toBe(0);
  });

  it('fails closed when run plan and final data disagree on identity', async () => {
    const data = stockSelectionData();
    data.visualization = visualization(
      'holding-analysis',
      'selection-ranking-matrix',
      STOCK_SELECTION_COMPONENTS,
    );
    await writeJson(path.join(workspace, 'data_file', 'final', 'dashboard-data.json'), data);
    const tool = createApplyDashboardSpecTool({ workspaceRoot: workspace });
    const result = await tool.execute(tool.parseInput?.({}) ?? {}, context());

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'DASHBOARD_SPEC_CONTRACT_MISMATCH' },
    });
    expect(commitCount).toBe(0);
  });

  it('compares plan and final component sets after normalization', () => {
    const plan = runPlan(
      'stock-selection',
      'selection-ranking-matrix',
      [...STOCK_SELECTION_COMPONENTS].reverse().map((component) => `  ${component}  `),
    );
    const spec = __dashboardSpecTesting.compileDashboardSpec(plan, stockSelectionData(), {});
    expect(spec.requiredComponents).toEqual(STOCK_SELECTION_COMPONENTS);
  });

  it('renders every metric alias accepted by the stock-selection compiler', () => {
    const spec = __dashboardSpecTesting.compileDashboardSpec(
      runPlan('stock-selection', 'selection-ranking-matrix', STOCK_SELECTION_COMPONENTS),
      stockSelectionData(),
      {},
    );
    const page = __dashboardSpecTesting.renderDashboard(spec).page;
    expect(page).toContain("['period_return', 'period_return_pct', 'return_120d_pct', 'return_120d']");
    expect(page).toContain("['max_drawdown', 'max_drawdown_pct']");
    expect(page).toContain("['volatility20d', 'volatility_20d_annualized_pct', 'volatility20d_pct']");
    expect(page).toContain(".sort((left, right) => (numeric(left.rank)");
  });

  it('compiles the standard technical K-line contract with explicit condition boundaries', () => {
    const spec = __dashboardSpecTesting.compileDashboardSpec(
      runPlan('technical-timing', 'technical-kline-trader', TECHNICAL_KLINE_COMPONENTS),
      technicalKlineData(),
      {},
    );
    expect(spec).toMatchObject({
      renderer: 'base',
      templateId: 'technical-timing',
      variantId: 'technical-kline-trader',
      requiredComponents: TECHNICAL_KLINE_COMPONENTS,
      dataPrerequisites: [
        'single_stock_quote',
        'kline_20_with_volume',
        'technical_moving_averages',
        'derived_volume_signals',
        'derived_risk_signals',
      ],
    });
    const page = __dashboardSpecTesting.renderDashboard(spec).page;
    expect(page).toContain('function TechnicalConditionsPanel');
    expect(page).toContain('触发、失效与风险边界');
    expect(page).toContain("=== 'technical-timing'");
  });

  it('refuses the technical renderer when MA60 is absent', () => {
    const data = technicalKlineData();
    delete (data.computedMetrics as JsonRecord).ma60;
    const error = capturedToolError(() => {
      __dashboardSpecTesting.compileDashboardSpec(
        runPlan('technical-timing', 'technical-kline-trader', TECHNICAL_KLINE_COMPONENTS),
        data,
        {},
      );
    });
    expect(error.code).toBe('DASHBOARD_SPEC_DATA_PREREQUISITE_FAILED');
    expect(error.details).toMatchObject({
      missing: expect.arrayContaining([
        expect.objectContaining({ id: 'technical_moving_averages' }),
      ]),
    });
  });

  it('compiles strategy research as an explicitly unvalidated hypothesis surface', () => {
    const spec = __dashboardSpecTesting.compileDashboardSpec(
      runPlan('strategy-research', 'strategy-hypothesis-canvas', STRATEGY_COMPONENTS),
      strategyResearchData(),
      {},
    );
    expect(spec).toMatchObject({
      renderer: 'stock-selection',
      requiredComponents: STRATEGY_COMPONENTS,
      dataPrerequisites: expect.arrayContaining([
        'strategy_research_contract',
        'selection_ranking',
      ]),
    });
    const page = __dashboardSpecTesting.renderDashboard(spec).page;
    expect(page).toContain('function StrategyResearchProtocol');
    expect(page).toContain('尚未完成独立样本外回测');
    expect(page).toContain("'strategy-research'");
  });

  it('compiles portfolio risk only with holdings, correlation, liquidity, and explicit gaps', () => {
    const spec = __dashboardSpecTesting.compileDashboardSpec(
      runPlan('holding-analysis', 'portfolio-risk-console', PORTFOLIO_RISK_COMPONENTS),
      portfolioRiskData(),
      {},
    );
    expect(spec).toMatchObject({
      renderer: 'holding-analysis',
      requiredComponents: PORTFOLIO_RISK_COMPONENTS,
      dataPrerequisites: [
        'portfolio_holding_coverage',
        'comparison_chart_metrics',
        'portfolio_risk_evidence',
        'asset_source_evidence',
      ],
    });
    const page = __dashboardSpecTesting.renderDashboard(spec).page;
    expect(page).toContain('function CorrelationLiquidityRiskPanel');
    expect(page).toContain('function PortfolioDataGapsPanel');
  });

  it('rejects portfolio risk when position-data gaps are not disclosed', () => {
    const data = portfolioRiskData();
    (data.portfolio as JsonRecord).data_gaps = [];
    const error = capturedToolError(() => {
      __dashboardSpecTesting.compileDashboardSpec(
        runPlan('holding-analysis', 'portfolio-risk-console', PORTFOLIO_RISK_COMPONENTS),
        data,
        {},
      );
    });
    expect(error.code).toBe('DASHBOARD_SPEC_DATA_PREREQUISITE_FAILED');
    expect(error.details).toMatchObject({
      missing: expect.arrayContaining([
        expect.objectContaining({ id: 'portfolio_risk_evidence' }),
      ]),
    });
  });

  it.each([
    {
      name: 'duplicate ranks',
      rows: [
        { symbol: '600519', rank: 1, score: 82 },
        { symbol: '600589', rank: 1, score: 61 },
      ],
    },
    {
      name: 'a non-contiguous rank sequence',
      rows: [
        { symbol: '600519', rank: 1, score: 82 },
        { symbol: '600589', rank: 3, score: 61 },
      ],
    },
    {
      name: 'rows not ordered by ascending rank',
      rows: [
        { symbol: '600589', rank: 2, score: 61 },
        { symbol: '600519', rank: 1, score: 82 },
      ],
    },
    {
      name: 'scores inconsistent with the recommended rank order',
      rows: [
        { symbol: '600519', rank: 1, score: 61 },
        { symbol: '600589', rank: 2, score: 82 },
      ],
    },
  ])('rejects $name before entering the workspace commit fence', async ({ rows }) => {
    const data = stockSelectionData();
    data.selectionRanking = { rows };
    await writeJson(path.join(workspace, 'data_file', 'final', 'dashboard-data.json'), data);
    const originalPage = await fs.readFile(path.join(workspace, 'app', 'page.tsx'), 'utf8');
    const tool = createApplyDashboardSpecTool({ workspaceRoot: workspace });

    const result = await tool.execute(tool.parseInput?.({}) ?? {}, context());

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'DASHBOARD_SPEC_DATA_PREREQUISITE_FAILED' },
    });
    expect(commitCount).toBe(0);
    await expect(fs.readFile(path.join(workspace, 'app', 'page.tsx'), 'utf8'))
      .resolves.toBe(originalPage);
  });

  it('rejects plan/final component drift with a stable code', () => {
    const plan = runPlan(
      'stock-selection',
      'selection-ranking-matrix',
      STOCK_SELECTION_COMPONENTS.slice(0, -1),
    );
    const error = capturedToolError(() => {
      __dashboardSpecTesting.compileDashboardSpec(plan, stockSelectionData(), {});
    });
    expect(error.code).toBe('DASHBOARD_SPEC_COMPONENTS_MISMATCH');
  });

  it('rejects a matching but incomplete component set the renderer cannot satisfy', () => {
    const components = STOCK_SELECTION_COMPONENTS.slice(0, -1);
    const data = stockSelectionData();
    data.visualization = visualization(
      'stock-selection',
      'selection-ranking-matrix',
      components,
    );
    const error = capturedToolError(() => {
      __dashboardSpecTesting.compileDashboardSpec(
        runPlan('stock-selection', 'selection-ranking-matrix', components),
        data,
        {},
      );
    });
    expect(error.code).toBe('DASHBOARD_SPEC_COMPONENT_UNSUPPORTED');
  });

  it('rejects missing comparison data instead of generating zero-valued charts', () => {
    const data = stockSelectionData();
    data.comparison = { rows: [] };
    const error = capturedToolError(() => {
      __dashboardSpecTesting.compileDashboardSpec(
        runPlan('stock-selection', 'selection-ranking-matrix', STOCK_SELECTION_COMPONENTS),
        data,
        {},
      );
    });
    expect(error.code).toBe('DASHBOARD_SPEC_DATA_PREREQUISITE_FAILED');
    expect(error.details).toMatchObject({
      missing: expect.arrayContaining([
        expect.objectContaining({ id: 'comparison_symbol_coverage' }),
        expect.objectContaining({ id: 'comparison_chart_metrics' }),
      ]),
    });
  });

  it('refuses a sector-rotation single target with no comparison dataset', async () => {
    const components = ['板块代理说明', '相对强弱矩阵', '收益/回撤对比', '阶段排名变化', '能力边界'];
    await writeJson(
      path.join(workspace, '.data-agent', 'finance-run-plan.json'),
      runPlan('sector-rotation', 'sector-rotation-radar', components),
    );
    await writeJson(path.join(workspace, 'data_file', 'final', 'dashboard-data.json'), {
      assets: [{ symbol: '510300' }],
      visualization: visualization('sector-rotation', 'sector-rotation-radar', components),
    });
    const originalPage = await fs.readFile(path.join(workspace, 'app', 'page.tsx'), 'utf8');
    const tool = createApplyDashboardSpecTool({ workspaceRoot: workspace });
    const result = await tool.execute(tool.parseInput?.({}) ?? {}, context());

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'DASHBOARD_SPEC_VARIANT_UNSUPPORTED' },
    });
    expect(commitCount).toBe(0);
    await expect(fs.readFile(path.join(workspace, 'app', 'page.tsx'), 'utf8'))
      .resolves.toBe(originalPage);
  });

  it('requires the durable workspace mutation fence', async () => {
    const tool = createApplyDashboardSpecTool({ workspaceRoot: workspace });
    const result = await tool.execute(tool.parseInput?.({}) ?? {}, context(false));

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'WORKSPACE_COMMIT_FENCE_REQUIRED' },
    });
    expect(commitCount).toBe(0);
  });

  it('denies a symlinked output directory without touching the target', async () => {
    await fs.rm(path.join(workspace, 'app'), { recursive: true, force: true });
    await fs.symlink(outside, path.join(workspace, 'app'));
    const tool = createApplyDashboardSpecTool({ workspaceRoot: workspace });
    const result = await tool.execute(tool.parseInput?.({}) ?? {}, context());

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'SYMLINK_ESCAPE_DENIED' },
    });
    expect(commitCount).toBe(0);
    await expect(fs.readdir(outside)).resolves.toEqual([]);
  });
});

describe('dashboard renderer capability registry', () => {
  it('provides the same fail-closed support decision to provider-surface routing', () => {
    expect(isDashboardSpecCapabilitySupported(
      'single-stock-diagnosis',
      'single-stock-command-center',
    )).toBe(true);
    expect(isDashboardSpecCapabilitySupported(
      'single-stock-diagnosis',
      'single-stock-fundamental-snapshot',
    )).toBe(true);
    expect(isDashboardSpecCapabilitySupported(
      'fundamental-research',
      'fundamental-quality-scorecard',
    )).toBe(true);
    expect(isDashboardSpecCapabilitySupported(
      'technical-timing',
      'technical-kline-trader',
    )).toBe(true);
    expect(isDashboardSpecCapabilitySupported(
      'strategy-research',
      'strategy-hypothesis-canvas',
    )).toBe(true);
    expect(isDashboardSpecCapabilitySupported(
      'holding-analysis',
      'portfolio-risk-console',
    )).toBe(true);
    expect(isDashboardSpecCapabilitySupported('unknown', 'unknown')).toBe(false);
    expect(isDashboardSpecCapabilitySupported('stock-selection', null)).toBe(false);
  });

  it('explicitly classifies every known template/variant pair', () => {
    const matrix = __dashboardSpecTesting.capabilityMatrix.map((capability) => ({
      templateId: capability.templateId,
      variantId: capability.variantId,
      supported: capability.supported,
    }));
    expect(matrix).toEqual([
      { templateId: 'single-stock-diagnosis', variantId: 'single-stock-command-center', supported: true },
      { templateId: 'single-stock-diagnosis', variantId: 'single-stock-fundamental-snapshot', supported: true },
      { templateId: 'technical-timing', variantId: 'technical-kline-trader', supported: true },
      ...REJECTED_VARIANTS.slice(0, 1).map(([templateId, variantId]) => ({ templateId, variantId, supported: false })),
      { templateId: 'fundamental-research', variantId: 'fundamental-quality-scorecard', supported: true },
      ...REJECTED_VARIANTS.slice(1, 2).map(([templateId, variantId]) => ({ templateId, variantId, supported: false })),
      { templateId: 'stock-selection', variantId: 'selection-ranking-matrix', supported: true },
      ...REJECTED_VARIANTS.slice(2, 6).map(([templateId, variantId]) => ({ templateId, variantId, supported: false })),
      { templateId: 'strategy-research', variantId: 'strategy-hypothesis-canvas', supported: true },
      ...REJECTED_VARIANTS.slice(6, 7).map(([templateId, variantId]) => ({ templateId, variantId, supported: false })),
      { templateId: 'backtest-review', variantId: 'backtest-performance-review', supported: true },
      ...REJECTED_VARIANTS.slice(7, 8).map(([templateId, variantId]) => ({ templateId, variantId, supported: false })),
      { templateId: 'holding-analysis', variantId: 'portfolio-risk-console', supported: true },
      ...REJECTED_VARIANTS.slice(8).map(([templateId, variantId]) => ({ templateId, variantId, supported: false })),
    ]);
    const catalogIdentities = KNOWN_TEMPLATE_IDS.flatMap((templateId) => (
      serializeQuantVisualizationTemplate(templateId).alternatives.map((variant) => ({
        templateId,
        variantId: variant.variantId,
      }))
    ));
    expect(matrix.map(({ templateId, variantId }) => ({ templateId, variantId })))
      .toEqual(catalogIdentities);
  });

  it.each(REJECTED_VARIANTS)(
    'rejects known but unimplemented %s/%s before rendering',
    (templateId, variantId) => {
      const error = capturedToolError(() => {
        __dashboardSpecTesting.compileDashboardSpec(
          runPlan(templateId, variantId, ['component']),
          { visualization: visualization(templateId, variantId, ['component']) },
          {},
        );
      });
      expect(error.code).toBe('DASHBOARD_SPEC_VARIANT_UNSUPPORTED');
    },
  );

  it.each([
    {
      templateId: 'single-stock-diagnosis',
      variantId: 'single-stock-command-center',
      components: SINGLE_STOCK_COMPONENTS,
      data: singleStockData(),
      renderer: 'base',
    },
    {
      templateId: 'single-stock-diagnosis',
      variantId: 'single-stock-fundamental-snapshot',
      components: SINGLE_STOCK_FUNDAMENTAL_COMPONENTS,
      data: singleStockFundamentalData(),
      renderer: 'base',
    },
    {
      templateId: 'fundamental-research',
      variantId: 'fundamental-quality-scorecard',
      components: FUNDAMENTAL_COMPONENTS,
      data: fundamentalData(),
      renderer: 'base',
    },
    {
      templateId: 'stock-selection',
      variantId: 'selection-ranking-matrix',
      components: STOCK_SELECTION_COMPONENTS,
      data: stockSelectionData(),
      renderer: 'stock-selection',
    },
    {
      templateId: 'backtest-review',
      variantId: 'backtest-performance-review',
      components: BACKTEST_COMPONENTS,
      data: backtestData(),
      renderer: 'base',
    },
  ])(
    'compiles supported $templateId/$variantId only with its complete contract',
    ({ templateId, variantId, components, data, renderer }) => {
      expect(__dashboardSpecTesting.compileDashboardSpec(
        runPlan(templateId, variantId, components),
        data,
        {},
      )).toMatchObject({ templateId, variantId, renderer, requiredComponents: components });
    },
  );

  it.each([
    {
      name: 'trend moving averages are absent even though risk metrics exist',
      computedMetrics: {
        maxDrawdown: -8.5,
        volatility20d: 24.1,
        avgVolume20d: 1_000_009,
      },
      missing: ['derived_trend_signals'],
    },
    {
      name: 'average volume is absent even though trend and risk metrics exist',
      computedMetrics: {
        maxDrawdown: -8.5,
        volatility20d: 24.1,
        ma5: 8.17,
        ma20: 8.095,
      },
      missing: ['derived_volume_signals'],
    },
    {
      name: 'only drawdown and volatility are available',
      computedMetrics: {
        maxDrawdown: -8.5,
        volatility20d: 24.1,
      },
      missing: ['derived_trend_signals', 'derived_volume_signals'],
    },
  ])('rejects single-stock false success when $name', ({ computedMetrics, missing }) => {
    const data = { ...singleStockData(), computedMetrics };
    const error = capturedToolError(() => {
      __dashboardSpecTesting.compileDashboardSpec(
        runPlan('single-stock-diagnosis', 'single-stock-command-center', SINGLE_STOCK_COMPONENTS),
        data,
        {},
      );
    });
    expect(error.code).toBe('DASHBOARD_SPEC_DATA_PREREQUISITE_FAILED');
    expect(error.details).toMatchObject({
      missing: expect.arrayContaining(missing.map((id) => expect.objectContaining({ id }))),
    });
  });

  it.each([
    {
      name: 'trade_count is positive but trades is empty',
      update: (backtest: JsonRecord) => ({ ...backtest, trades: [] }),
      missingId: 'backtest_series_and_trades',
    },
    {
      name: 'completed trade rows do not match trade_count',
      update: (backtest: JsonRecord) => ({
        ...backtest,
        summary: { ...(backtest.summary as JsonRecord), trade_count: 2 },
      }),
      missingId: 'backtest_series_and_trades',
    },
    {
      name: 'strategy_name source is absent while strategy_id remains',
      update: (backtest: JsonRecord) => {
        const { strategy_name: _strategyName, ...withoutStrategyName } = backtest;
        return withoutStrategyName;
      },
      missingId: 'reproducible_backtest_parameters',
    },
  ])('rejects backtest false success when $name', ({ update, missingId }) => {
    const data = backtestData();
    data.backtest = update(data.backtest as JsonRecord);
    const error = capturedToolError(() => {
      __dashboardSpecTesting.compileDashboardSpec(
        runPlan('backtest-review', 'backtest-performance-review', BACKTEST_COMPONENTS),
        data,
        {},
      );
    });
    expect(error.code).toBe('DASHBOARD_SPEC_DATA_PREREQUISITE_FAILED');
    expect(error.details).toMatchObject({
      missing: expect.arrayContaining([expect.objectContaining({ id: missingId })]),
    });
  });

  it('accepts a zero-completed-trade backtest with an explicit empty trades array', () => {
    const data = backtestData();
    const backtest = data.backtest as JsonRecord;
    data.backtest = {
      ...backtest,
      summary: { ...(backtest.summary as JsonRecord), trade_count: 0, win_rate_pct: null },
      trades: [],
    };
    expect(__dashboardSpecTesting.compileDashboardSpec(
      runPlan('backtest-review', 'backtest-performance-review', BACKTEST_COMPONENTS),
      data,
      {},
    )).toMatchObject({ templateId: 'backtest-review' });
  });

  it('accepts the backend contract where trade_count counts closed trades and an open row remains', () => {
    const data = backtestData();
    const backtest = data.backtest as JsonRecord;
    data.backtest = {
      ...backtest,
      summary: { ...(backtest.summary as JsonRecord), trade_count: 1 },
      trades: [
        { entry_date: '2026-01-01', exit_date: '2026-01-02', return_pct: 1, status: 'closed' },
        { entry_date: '2026-01-03', status: 'open' },
      ],
    };
    expect(__dashboardSpecTesting.compileDashboardSpec(
      runPlan('backtest-review', 'backtest-performance-review', BACKTEST_COMPONENTS),
      data,
      {},
    )).toMatchObject({ templateId: 'backtest-review' });
  });

  it('renders the explicit backtest strategy source and completed-trade display contract', () => {
    const spec = __dashboardSpecTesting.compileDashboardSpec(
      runPlan('backtest-review', 'backtest-performance-review', BACKTEST_COMPONENTS),
      backtestData(),
      {},
    );
    const page = __dashboardSpecTesting.renderDashboard(spec).page;
    expect(page).not.toContain("strategy_name ?? '均线突破'");
    expect(page).toContain("strategyName || strategyId || '策略名称缺失'");
    expect(page).toContain('策略名称来源：回测数据');
    expect(page).toContain('已完成交易');
    expect(page).toContain('笔已完成');
  });

  it('renders the certified single-stock fundamental snapshot from prepared data', () => {
    const spec = __dashboardSpecTesting.compileDashboardSpec(
      runPlan(
        'single-stock-diagnosis',
        'single-stock-fundamental-snapshot',
        SINGLE_STOCK_FUNDAMENTAL_COMPONENTS,
      ),
      singleStockFundamentalData(),
      {},
    );
    const page = __dashboardSpecTesting.renderDashboard(spec).page;
    expect(page).toContain('FinancialQualityPanel');
    expect(page).toContain('财务质量评分');
    expect(page).toContain('缺失字段与口径说明');
    expect(page).toContain('single-stock-fundamental-snapshot');
    expect(page).toContain('PB-MRQ');
  });

  it('rejects a fundamental snapshot without an attributable quality score', () => {
    const data = singleStockFundamentalData();
    data.financialQuality = { rows: [], limitations: [] };
    const error = capturedToolError(() => {
      __dashboardSpecTesting.compileDashboardSpec(
        runPlan(
          'single-stock-diagnosis',
          'single-stock-fundamental-snapshot',
          SINGLE_STOCK_FUNDAMENTAL_COMPONENTS,
        ),
        data,
        {},
      );
    });
    expect(error.code).toBe('DASHBOARD_SPEC_DATA_PREREQUISITE_FAILED');
    expect(error.details).toMatchObject({
      missing: expect.arrayContaining([
        expect.objectContaining({ id: 'financial_quality_score' }),
      ]),
    });
  });

  it.each([
    {
      name: 'single-stock command center without K-line history',
      templateId: 'single-stock-diagnosis',
      variantId: 'single-stock-command-center',
      components: SINGLE_STOCK_COMPONENTS,
      data: { ...singleStockData(), kline: { symbol: '600589', bars: [] } },
    },
    {
      name: 'selection matrix without ranking rows',
      templateId: 'stock-selection',
      variantId: 'selection-ranking-matrix',
      components: STOCK_SELECTION_COMPONENTS,
      data: { ...stockSelectionData(), selectionRanking: { rows: [] } },
    },
    {
      name: 'backtest review without equity series',
      templateId: 'backtest-review',
      variantId: 'backtest-performance-review',
      components: BACKTEST_COMPONENTS,
      data: {
        ...backtestData(),
        backtest: { ...(backtestData().backtest as JsonRecord), equity_curve: [] },
      },
    },
  ])('rejects $name', ({ templateId, variantId, components, data }) => {
    const error = capturedToolError(() => {
      __dashboardSpecTesting.compileDashboardSpec(
        runPlan(templateId, variantId, components),
        data,
        {},
      );
    });
    expect(error.code).toBe('DASHBOARD_SPEC_DATA_PREREQUISITE_FAILED');
  });

  it('uses stable errors for unknown template and variant identities', () => {
    const unknownTemplate = capturedToolError(() => {
      __dashboardSpecTesting.compileDashboardSpec(
        runPlan('unknown-template', 'unknown-variant', ['component']),
        { visualization: visualization('unknown-template', 'unknown-variant', ['component']) },
        {},
      );
    });
    expect(unknownTemplate.code).toBe('DASHBOARD_SPEC_TEMPLATE_UNSUPPORTED');

    const unknownVariant = capturedToolError(() => {
      __dashboardSpecTesting.compileDashboardSpec(
        runPlan('stock-selection', 'future-variant', ['component']),
        { visualization: visualization('stock-selection', 'future-variant', ['component']) },
        {},
      );
    });
    expect(unknownVariant.code).toBe('DASHBOARD_SPEC_VARIANT_UNSUPPORTED');
  });
});
