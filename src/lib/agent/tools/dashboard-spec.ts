import fs from 'node:fs/promises';

import type { MoAgentTool } from '@/lib/agent/types';
import { assessQuantDatasetIdentity } from '@/lib/quant/data-identity';
import {
  baseDashboardCssTemplate,
  baseDashboardPageTemplate,
} from '@/lib/utils/scaffold-base-templates';
import {
  comparisonCss,
  comparisonPageTemplate,
  holdingAnalysisCss,
  holdingAnalysisPageTemplate,
  stockSelectionCss,
  stockSelectionPageTemplate,
} from '@/lib/utils/scaffold-dashboard-templates';

import { MoAgentToolError, throwIfAborted } from './errors';
import type { MoAgentFileToolOptions } from './filesystem';
import { writeMoAgentWorkspaceBatch } from './filesystem';
import { inputRecord, optionalString } from './input';
import { MoAgentWorkspacePolicy } from './path-policy';
import { DEFAULT_TOOL_TIMEOUT_MS, executeMoAgentTool } from './runtime';

const RUN_PLAN_PATH = '.quantpilot/run_plan.json';
const FINAL_DATA_PATH = 'data_file/final/dashboard-data.json';
const PAGE_PATH = 'app/page.tsx';
const STYLES_PATH = 'app/globals.css';
const MAX_CONTRACT_BYTES = 2_000_000;
const DEFAULT_MAX_GENERATED_FILE_BYTES = 256_000;
const DEFAULT_MAX_GENERATED_TOTAL_BYTES = 512_000;

type JsonRecord = Record<string, unknown>;
type DashboardRenderer = 'base' | 'comparison' | 'stock-selection' | 'holding-analysis';

interface DashboardDataPrerequisite {
  id: string;
  description: string;
  satisfiedBy: (finalData: JsonRecord) => boolean;
}

interface SupportedDashboardCapability {
  supported: true;
  templateId: string;
  variantId: string;
  renderer: DashboardRenderer;
  requiredComponents: readonly string[];
  dataPrerequisites: readonly DashboardDataPrerequisite[];
}

interface UnsupportedDashboardCapability {
  supported: false;
  templateId: string;
  variantId: string;
  reason: string;
}

type DashboardCapability = SupportedDashboardCapability | UnsupportedDashboardCapability;

export interface ApplyDashboardSpecInput {
  /** Optional assertion only. The authoritative value always comes from run_plan/final data. */
  templateId?: string;
  /** Optional assertion only. The authoritative value always comes from run_plan/final data. */
  variantId?: string;
}

export interface CompiledDashboardSpec {
  schemaVersion: 1;
  templateId: string;
  variantId: string | null;
  renderer: DashboardRenderer;
  requiredComponents: string[];
  dataPrerequisites: string[];
  dataArtifact: typeof FINAL_DATA_PATH;
  outputArtifacts: [typeof PAGE_PATH, typeof STYLES_PATH];
}

export interface ApplyDashboardSpecOutput {
  spec: CompiledDashboardSpec;
  files: Array<{
    path: string;
    bytes: number;
    created: boolean;
    beforeSha256: string | null;
    afterSha256: string;
  }>;
  totalBytes: number;
}

export interface DashboardSpecReadinessAssessment {
  ready: boolean;
  errorCode: string | null;
  reasons: string[];
  spec: CompiledDashboardSpec | null;
}

export interface MoAgentDashboardSpecToolOptions extends Pick<
  MoAgentFileToolOptions,
  | 'workspaceRoot'
  | 'allowedWriteGlobs'
  | 'includeDefaultWriteGlobs'
  | 'timeoutMs'
  | 'maxWriteBytes'
  | 'resourceLockWaitTimeoutMs'
> {
  maxGeneratedTotalBytes?: number;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contractString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized && normalized.length <= 160 ? normalized : null;
}

function nestedRecord(record: JsonRecord, key: string): JsonRecord | null {
  return isRecord(record[key]) ? record[key] : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function recordArray(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord);
}

function normalizedComponent(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('zh-CN');
}

interface ContractComponents {
  values: string[];
  normalized: Map<string, string>;
}

function contractComponents(value: unknown, label: string): ContractComponents {
  if (!Array.isArray(value) || value.length === 0) {
    throw new MoAgentToolError(
      'DASHBOARD_SPEC_CONTRACT_INCOMPLETE',
      `${label} must declare at least one dashboard component.`,
    );
  }
  if (value.length > 64) {
    throw new MoAgentToolError(
      'DASHBOARD_SPEC_CONTRACT_INVALID',
      `${label} exceeds the 64-component contract limit.`,
    );
  }
  const values: string[] = [];
  const normalized = new Map<string, string>();
  for (const item of value) {
    const component = contractString(item);
    if (!component) {
      throw new MoAgentToolError(
        'DASHBOARD_SPEC_CONTRACT_INVALID',
        `${label} contains an invalid dashboard component.`,
      );
    }
    const key = normalizedComponent(component);
    if (normalized.has(key)) {
      throw new MoAgentToolError(
        'DASHBOARD_SPEC_CONTRACT_INVALID',
        `${label} contains duplicate dashboard components after normalization.`,
        { component },
      );
    }
    values.push(component);
    normalized.set(key, component);
  }
  return { values, normalized };
}

function componentSetDifference(
  left: Map<string, string>,
  right: Map<string, string>,
): string[] {
  return [...left.entries()]
    .filter(([key]) => !right.has(key))
    .map(([, value]) => value);
}

function componentsMatch(left: Map<string, string>, right: Map<string, string>): boolean {
  return left.size === right.size && componentSetDifference(left, right).length === 0;
}

function dataRecord(data: JsonRecord, key: string): JsonRecord | null {
  return isRecord(data[key]) ? data[key] : null;
}

function rowsFromRecord(data: JsonRecord, key: string): JsonRecord[] {
  return recordArray(dataRecord(data, key)?.rows);
}

function recordSymbol(record: JsonRecord): string | null {
  return contractString(record.symbol ?? dataRecord(record, 'quote')?.symbol);
}

function distinctSymbols(rows: JsonRecord[]): Set<string> {
  return new Set(rows.map(recordSymbol).filter((value): value is string => value !== null));
}

function hasNumericField(record: JsonRecord, fields: readonly string[]): boolean {
  return fields.some((field) => finiteNumber(record[field]) !== null);
}

function hasSingleStockQuote(finalData: JsonRecord): boolean {
  const quote = dataRecord(finalData, 'quote');
  return Boolean(
    quote &&
    contractString(finalData.symbol ?? quote.symbol) &&
    finiteNumber(quote.price) !== null,
  );
}

function hasUsableKline(finalData: JsonRecord): boolean {
  const bars = recordArray(dataRecord(finalData, 'kline')?.bars);
  const latestWindow = bars.slice(-20);
  const latestBar = latestWindow.at(-1);
  return (
    latestWindow.length === 20 &&
    latestWindow.every((bar) => finiteNumber(bar.close) !== null) &&
    Boolean(latestBar && finiteNumber(latestBar.volume) !== null)
  );
}

function signalMetric(
  finalData: JsonRecord,
  computedFields: readonly string[],
  summaryFields: readonly string[],
): number | null {
  const computed = dataRecord(finalData, 'computedMetrics');
  const summary = dataRecord(dataRecord(finalData, 'technicalIndicators') ?? {}, 'summary');
  for (const [record, fields] of [
    [summary, summaryFields],
    [computed, computedFields],
  ] as const) {
    if (!record) continue;
    for (const field of fields) {
      const value = finiteNumber(record[field]);
      if (value !== null) return value;
    }
  }
  return null;
}

function hasDerivedTrendSignals(finalData: JsonRecord): boolean {
  const ma5 = signalMetric(finalData, ['ma5'], ['ma5']);
  const ma20 = signalMetric(finalData, ['ma20'], ['ma20']);
  return ma5 !== null && ma5 > 0 && ma20 !== null && ma20 > 0;
}

function hasTechnicalMovingAverages(finalData: JsonRecord): boolean {
  return [
    signalMetric(finalData, ['ma5'], ['ma5']),
    signalMetric(finalData, ['ma10'], ['ma10']),
    signalMetric(finalData, ['ma20'], ['ma20']),
    signalMetric(finalData, ['ma60'], ['ma60']),
  ].every((value) => value !== null && value > 0);
}

function hasDerivedVolumeSignals(finalData: JsonRecord): boolean {
  const bars = recordArray(dataRecord(finalData, 'kline')?.bars);
  const latestVolume = finiteNumber(bars.at(-1)?.volume);
  const averageVolume = signalMetric(
    finalData,
    ['avgVolume20d'],
    ['avg_volume20', 'avg_volume_20d'],
  );
  return (
    latestVolume !== null &&
    latestVolume >= 0 &&
    averageVolume !== null &&
    averageVolume > 0
  );
}

function hasDerivedRiskSignals(finalData: JsonRecord): boolean {
  const maxDrawdown = signalMetric(
    finalData,
    ['maxDrawdown'],
    ['max_drawdown_pct'],
  );
  const volatility = signalMetric(
    finalData,
    ['volatility20d'],
    ['volatility_20d_annualized_pct', 'volatility_annualized_pct'],
  );
  return (
    maxDrawdown !== null &&
    maxDrawdown >= -100 &&
    maxDrawdown <= 0 &&
    volatility !== null &&
    volatility >= 0
  );
}

function hasComparisonCoverage(finalData: JsonRecord): boolean {
  const assets = recordArray(finalData.assets);
  const comparisonRows = rowsFromRecord(finalData, 'comparison');
  const assetSymbols = distinctSymbols(assets);
  const comparisonSymbols = distinctSymbols(comparisonRows);
  return (
    assets.length >= 2 &&
    comparisonRows.length >= 2 &&
    assetSymbols.size === assets.length &&
    comparisonSymbols.size === comparisonRows.length &&
    assetSymbols.size === comparisonSymbols.size &&
    [...assetSymbols].every((symbol) => comparisonSymbols.has(symbol))
  );
}

function hasComparisonChartMetrics(finalData: JsonRecord): boolean {
  const rows = rowsFromRecord(finalData, 'comparison');
  return rows.length >= 2 && rows.every((row) => (
    hasNumericField(row, ['period_return', 'period_return_pct', 'return_120d_pct', 'return_120d']) &&
    hasNumericField(row, ['max_drawdown', 'max_drawdown_pct']) &&
    hasNumericField(row, ['volatility20d', 'volatility_20d_annualized_pct', 'volatility20d_pct'])
  ));
}

function hasSelectionRanking(finalData: JsonRecord): boolean {
  const assets = recordArray(finalData.assets);
  const rankingRows = rowsFromRecord(finalData, 'selectionRanking');
  const assetSymbols = distinctSymbols(assets);
  const rankingSymbols = distinctSymbols(rankingRows);
  const ranks = rankingRows.map((row) => finiteNumber(row.rank));
  const scores = rankingRows.map((row) => finiteNumber(row.score));
  return (
    rankingRows.length >= 2 &&
    rankingSymbols.size === rankingRows.length &&
    rankingSymbols.size === assetSymbols.size &&
    [...assetSymbols].every((symbol) => rankingSymbols.has(symbol)) &&
    ranks.every((rank): rank is number => rank !== null && Number.isInteger(rank)) &&
    new Set(ranks).size === rankingRows.length &&
    ranks.every((rank, index) => rank === index + 1) &&
    scores.every((score): score is number => score !== null) &&
    scores.every((score, index) => index === 0 || score <= scores[index - 1])
  );
}

function hasAssetSourceEvidence(finalData: JsonRecord): boolean {
  const assets = recordArray(finalData.assets);
  return assets.length >= 2 && assets.every((asset) => (
    contractString(asset.source ?? dataRecord(asset, 'quote')?.source) !== null
  ));
}

function hasStrategyResearchContract(finalData: JsonRecord): boolean {
  const screener = dataRecord(finalData, 'screener');
  const warnings = recordArray(finalData.warnings);
  const conclusion = dataRecord(finalData, 'conclusion');
  return Boolean(
    screener &&
    contractString(screener.mode) &&
    finiteNumber(screener.scanned_symbols) !== null &&
    Array.isArray(screener.candidates) &&
    (Array.isArray(finalData.warnings) || warnings.length === 0) &&
    conclusion &&
    contractString(conclusion.risk_disclaimer)
  );
}

function hasPortfolioRiskCoverage(finalData: JsonRecord): boolean {
  const holdings = recordArray(finalData.holdings);
  const assets = recordArray(finalData.assets);
  const holdingSymbols = distinctSymbols(holdings);
  const assetSymbols = distinctSymbols(assets);
  const weights = holdings.map((holding) => finiteNumber(
    holding.weight ?? holding.position_pct,
  ));
  return (
    holdings.length >= 2 &&
    assets.length === holdings.length &&
    holdingSymbols.size === holdings.length &&
    assetSymbols.size === assets.length &&
    [...holdingSymbols].every((symbol) => assetSymbols.has(symbol)) &&
    weights.every((weight): weight is number => weight !== null && weight > 0) &&
    Math.abs(weights.reduce((sum, weight) => sum + weight, 0) - 100) <= 1
  );
}

function hasPortfolioRiskEvidence(finalData: JsonRecord): boolean {
  const portfolio = dataRecord(finalData, 'portfolio');
  const correlation = dataRecord(finalData, 'correlation');
  const liquidityRows = rowsFromRecord(finalData, 'liquidity');
  const holdings = recordArray(finalData.holdings);
  const symbols = distinctSymbols(holdings);
  const correlationSymbols = new Set(
    Array.isArray(correlation?.symbols)
      ? correlation.symbols.filter((value): value is string => contractString(value) !== null)
      : [],
  );
  const liquiditySymbols = distinctSymbols(liquidityRows);
  return Boolean(
    portfolio &&
    dataRecord(portfolio, 'concentration') &&
    Array.isArray(portfolio.data_gaps) &&
    portfolio.data_gaps.length > 0 &&
    correlation &&
    Array.isArray(correlation.matrix) &&
    correlationSymbols.size === symbols.size &&
    [...symbols].every((symbol) => correlationSymbols.has(symbol)) &&
    liquidityRows.length === symbols.size &&
    [...symbols].every((symbol) => liquiditySymbols.has(symbol))
  );
}

function hasFundamentalReports(finalData: JsonRecord): boolean {
  const financials = dataRecord(finalData, 'financials');
  const reports = recordArray(financials?.reports);
  return reports.length >= 2 && reports.every((report) => (
    contractString(report.report_date) !== null &&
    finiteNumber(report.revenue) !== null &&
    finiteNumber(report.parent_net_profit) !== null
  ));
}

function hasFundamentalTrend(finalData: JsonRecord): boolean {
  const indicators = dataRecord(finalData, 'fundamentalIndicators');
  const points = recordArray(indicators?.points);
  return points.length >= 2 && points.every((point) => (
    contractString(point.report_date) !== null &&
    finiteNumber(point.revenue) !== null &&
    finiteNumber(point.parent_net_profit) !== null
  ));
}

function hasFinancialQualityScore(finalData: JsonRecord): boolean {
  const quality = dataRecord(finalData, 'financialQuality');
  const rows = recordArray(quality?.rows);
  if (rows.length !== 1) return false;
  const row = rows[0];
  const score = finiteNumber(row.quality_score);
  return Boolean(
    contractString(row.symbol) &&
    contractString(row.latest_report_date) &&
    score !== null &&
    score >= 0 &&
    score <= 100 &&
    contractString(row.quality_label) &&
    Array.isArray(row.strengths) &&
    Array.isArray(row.watch_items) &&
    Array.isArray(quality?.limitations)
  );
}

function hasAnnouncementContract(finalData: JsonRecord): boolean {
  const announcements = dataRecord(finalData, 'announcements');
  return Boolean(announcements && Array.isArray(announcements.announcements));
}

function hasCashFlowComparisonOrLimitation(finalData: JsonRecord): boolean {
  const comparison = dataRecord(finalData, 'fundamentalMetricComparison');
  return Boolean(
    comparison &&
    contractString(comparison.conclusion) &&
    contractString(comparison.basis),
  );
}

function hasReproducibleBacktest(finalData: JsonRecord): boolean {
  const backtest = dataRecord(finalData, 'backtest');
  return Boolean(
    backtest &&
    contractString(backtest.strategy_id) &&
    contractString(backtest.strategy_name) &&
    finiteNumber(backtest.fast_window) !== null &&
    finiteNumber(backtest.slow_window) !== null &&
    finiteNumber(backtest.fee_bps) !== null,
  );
}

function hasBacktestSummary(finalData: JsonRecord): boolean {
  const summary = dataRecord(dataRecord(finalData, 'backtest') ?? {}, 'summary');
  const tradeCount = finiteNumber(summary?.trade_count);
  return Boolean(
    summary &&
    finiteNumber(summary.total_return_pct) !== null &&
    finiteNumber(summary.max_drawdown_pct) !== null &&
    tradeCount !== null &&
    Number.isInteger(tradeCount) &&
    tradeCount >= 0 &&
    (tradeCount === 0 || finiteNumber(summary.win_rate_pct) !== null),
  );
}

function isCompletedBacktestTrade(trade: JsonRecord): boolean {
  const status = contractString(trade.status)?.toLocaleLowerCase('en-US');
  if (status === 'closed') return true;
  if (status && status !== 'completed') return false;
  return contractString(trade.exit_date) !== null;
}

function hasBacktestSeriesAndTrades(finalData: JsonRecord): boolean {
  const backtest = dataRecord(finalData, 'backtest');
  if (!backtest || !Array.isArray(backtest.trades)) return false;
  const points = recordArray(backtest.equity_curve);
  const trades = recordArray(backtest.trades);
  const summary = dataRecord(backtest, 'summary');
  const tradeCount = finiteNumber(summary?.trade_count);
  if (
    points.filter((point) => finiteNumber(point.equity) !== null).length < 2 ||
    trades.length !== backtest.trades.length ||
    tradeCount === null ||
    !Number.isInteger(tradeCount) ||
    tradeCount < 0
  ) {
    return false;
  }
  if (!trades.every((trade) => contractString(trade.entry_date) !== null)) return false;
  const completedTrades = trades.filter(isCompletedBacktestTrade);
  if (!completedTrades.every((trade) => (
    contractString(trade.exit_date) !== null && finiteNumber(trade.return_pct) !== null
  ))) {
    return false;
  }
  return completedTrades.length === tradeCount && (tradeCount === 0 || trades.length > 0);
}

const SINGLE_STOCK_COMMAND_CENTER_COMPONENTS = [
  '紧凑行情摘要',
  'K 线与成交量主图',
  '趋势/量能/风险信号',
  '财务与公告摘要',
  '数据质量',
] as const;

const SINGLE_STOCK_FUNDAMENTAL_COMPONENTS = [
  '行情侧栏',
  '财务质量评分',
  '营收利润趋势',
  '利润率/ROE',
  '公告事件',
  '缺失字段说明',
] as const;

const TECHNICAL_KLINE_TRADER_COMPONENTS = [
  'K 线主图',
  '成交量副图',
  'MA5/MA10/MA20/MA60',
  '触发条件',
  '失效条件',
  '风险指标',
] as const;

const STOCK_SELECTION_RANKING_COMPONENTS = [
  '标的覆盖摘要',
  '多标的指标矩阵',
  '收益对比主图',
  '回撤/波动主图',
  '排序依据',
  '数据口径',
] as const;

const BACKTEST_PERFORMANCE_COMPONENTS = [
  '策略参数',
  '净值曲线',
  '回撤指标',
  '收益/胜率/交易次数',
  '交易明细',
  '限制说明',
] as const;

const FUNDAMENTAL_QUALITY_COMPONENTS = [
  '质量评分',
  '营收利润趋势',
  'ROE/利润率',
  '现金流或缺失说明',
  '报告期表',
] as const;

const STRATEGY_HYPOTHESIS_COMPONENTS = [
  '策略假设',
  '信号规则',
  '样本参数',
  '待验证清单',
  '数据限制',
] as const;

const PORTFOLIO_RISK_COMPONENTS = [
  '组合摘要',
  '持仓矩阵',
  '仓位集中度',
  '相关性/流动性风险',
  '数据缺口',
] as const;

const prerequisite = (
  id: string,
  description: string,
  satisfiedBy: (finalData: JsonRecord) => boolean,
): DashboardDataPrerequisite => ({ id, description, satisfiedBy });

const supportedCapability = (
  templateId: string,
  variantId: string,
  renderer: DashboardRenderer,
  requiredComponents: readonly string[],
  dataPrerequisites: readonly DashboardDataPrerequisite[],
): SupportedDashboardCapability => ({
  supported: true,
  templateId,
  variantId,
  renderer,
  requiredComponents,
  dataPrerequisites,
});

const unsupportedCapability = (
  templateId: string,
  variantId: string,
  reason: string,
): UnsupportedDashboardCapability => ({
  supported: false,
  templateId,
  variantId,
  reason,
});

const DASHBOARD_CAPABILITIES: readonly DashboardCapability[] = [
  supportedCapability(
    'single-stock-diagnosis',
    'single-stock-command-center',
    'base',
    SINGLE_STOCK_COMMAND_CENTER_COMPONENTS,
    [
      prerequisite('single_stock_quote', 'quote contains an identified symbol and finite price', hasSingleStockQuote),
      prerequisite('kline_20_with_volume', 'the latest 20 kline bars contain finite closes and the latest bar contains volume', hasUsableKline),
      prerequisite('derived_trend_signals', 'computed or technical data contains positive MA5 and MA20 values consumed by the renderer', hasDerivedTrendSignals),
      prerequisite('derived_volume_signals', 'the latest K-line volume and positive 20-day average volume consumed by the renderer are present', hasDerivedVolumeSignals),
      prerequisite('derived_risk_signals', 'computed or technical data contains bounded drawdown and non-negative volatility signals', hasDerivedRiskSignals),
    ],
  ),
  supportedCapability(
    'single-stock-diagnosis',
    'single-stock-fundamental-snapshot',
    'base',
    SINGLE_STOCK_FUNDAMENTAL_COMPONENTS,
    [
      prerequisite('single_stock_quote', 'quote contains an identified symbol and finite price', hasSingleStockQuote),
      prerequisite('fundamental_reports', 'financials contains at least two identified report periods', hasFundamentalReports),
      prerequisite('fundamental_trend', 'fundamentalIndicators contains at least two revenue and profit points', hasFundamentalTrend),
      prerequisite('financial_quality_score', 'financialQuality contains one bounded, attributable score with strengths, watch items, and limitations', hasFinancialQualityScore),
      prerequisite('announcement_contract', 'announcements declares an explicit announcements array, including an empty array when no events are available', hasAnnouncementContract),
    ],
  ),
  supportedCapability(
    'technical-timing',
    'technical-kline-trader',
    'base',
    TECHNICAL_KLINE_TRADER_COMPONENTS,
    [
      prerequisite('single_stock_quote', 'quote contains an identified symbol and finite price', hasSingleStockQuote),
      prerequisite('kline_20_with_volume', 'the latest 20 kline bars contain finite closes and the latest bar contains volume', hasUsableKline),
      prerequisite('technical_moving_averages', 'computed or technical data contains positive MA5, MA10, MA20, and MA60 values used by the chart and trigger rail', hasTechnicalMovingAverages),
      prerequisite('derived_volume_signals', 'latest and average volume are available for confirmation conditions', hasDerivedVolumeSignals),
      prerequisite('derived_risk_signals', 'bounded drawdown and non-negative volatility are available for the risk boundary', hasDerivedRiskSignals),
    ],
  ),
  unsupportedCapability('technical-timing', 'technical-breakout-watch', 'The base renderer does not implement breakout price bands and invalidation workflow.'),
  supportedCapability(
    'fundamental-research',
    'fundamental-quality-scorecard',
    'base',
    FUNDAMENTAL_QUALITY_COMPONENTS,
    [
      prerequisite('fundamental_reports', 'financials contains at least two identified report periods', hasFundamentalReports),
      prerequisite('fundamental_trend', 'fundamentalIndicators contains at least two revenue and profit points', hasFundamentalTrend),
      prerequisite('cash_flow_comparison_or_limitation', 'the selected period contains a cash-flow comparison or an explicit limitation', hasCashFlowComparisonOrLimitation),
    ],
  ),
  unsupportedCapability('fundamental-research', 'fundamental-report-trend', 'The base renderer does not implement period-over-period decomposition.'),
  supportedCapability(
    'stock-selection',
    'selection-ranking-matrix',
    'stock-selection',
    STOCK_SELECTION_RANKING_COMPONENTS,
    [
      prerequisite('comparison_symbol_coverage', 'assets and comparison.rows cover the same two or more symbols', hasComparisonCoverage),
      prerequisite('comparison_chart_metrics', 'every comparison row contains return, drawdown, and volatility metrics', hasComparisonChartMetrics),
      prerequisite('selection_ranking', 'selectionRanking.rows ranks every covered symbol in unique contiguous 1..N order with non-increasing finite scores', hasSelectionRanking),
      prerequisite('asset_source_evidence', 'every asset declares its real data source', hasAssetSourceEvidence),
    ],
  ),
  unsupportedCapability('stock-selection', 'selection-correlation-risk-map', 'The stock-selection renderer does not implement risk contribution or a correlation matrix heatmap.'),
  unsupportedCapability('stock-selection', 'selection-liquidity-trend-board', 'The stock-selection renderer does not implement the full liquidity/trend exclusion workflow.'),
  unsupportedCapability('sector-rotation', 'sector-rotation-radar', 'The generic comparison renderer does not implement sector proxy semantics or stage-ranking changes.'),
  unsupportedCapability('sector-rotation', 'sector-capital-flow-board', 'No trusted capital-flow renderer is implemented.'),
  supportedCapability(
    'strategy-research',
    'strategy-hypothesis-canvas',
    'stock-selection',
    STRATEGY_HYPOTHESIS_COMPONENTS,
    [
      prerequisite('comparison_symbol_coverage', 'assets and comparison.rows cover the same two or more research candidates', hasComparisonCoverage),
      prerequisite('comparison_chart_metrics', 'every candidate contains return, drawdown, and volatility metrics', hasComparisonChartMetrics),
      prerequisite('selection_ranking', 'selectionRanking ranks every research candidate with an auditable score', hasSelectionRanking),
      prerequisite('strategy_research_contract', 'screener parameters and an explicit risk limitation are present', hasStrategyResearchContract),
      prerequisite('asset_source_evidence', 'every candidate declares its real data source', hasAssetSourceEvidence),
    ],
  ),
  unsupportedCapability('strategy-research', 'strategy-signal-lab', 'The base renderer does not implement auditable signal-rule editing and overlays.'),
  supportedCapability(
    'backtest-review',
    'backtest-performance-review',
    'base',
    BACKTEST_PERFORMANCE_COMPONENTS,
    [
      prerequisite('reproducible_backtest_parameters', 'backtest contains explicit strategy_id and strategy_name source fields, windows, and fees', hasReproducibleBacktest),
      prerequisite('backtest_summary', 'backtest.summary contains return, drawdown, trade count, and applicable win rate', hasBacktestSummary),
      prerequisite('backtest_series_and_trades', 'backtest contains an equity series and a displayable trades array whose completed rows equal summary.trade_count', hasBacktestSeriesAndTrades),
    ],
  ),
  unsupportedCapability('backtest-review', 'backtest-trade-forensics', 'The base renderer does not implement return distribution or maximum-loss forensics.'),
  supportedCapability(
    'holding-analysis',
    'portfolio-risk-console',
    'holding-analysis',
    PORTFOLIO_RISK_COMPONENTS,
    [
      prerequisite('portfolio_holding_coverage', 'holdings and assets cover the same two or more symbols with weights summing to 100%', hasPortfolioRiskCoverage),
      prerequisite('comparison_chart_metrics', 'every holding contains return, drawdown, and volatility metrics', hasComparisonChartMetrics),
      prerequisite('portfolio_risk_evidence', 'concentration, correlation, liquidity, and explicit position-data gaps cover the portfolio', hasPortfolioRiskEvidence),
      prerequisite('asset_source_evidence', 'every holding asset declares its real data source', hasAssetSourceEvidence),
    ],
  ),
  unsupportedCapability('holding-analysis', 'portfolio-rebalance-plan', 'The holding renderer does not implement constrained rebalance scenarios.'),
] as const;

const CAPABILITY_BY_KEY = new Map(
  DASHBOARD_CAPABILITIES.map((capability) => [
    `${capability.templateId}\u0000${capability.variantId}`,
    capability,
  ]),
);
const KNOWN_TEMPLATE_IDS = new Set(DASHBOARD_CAPABILITIES.map((capability) => capability.templateId));

/** Provider-surface routing must not expose a compiler that is known to reject. */
export function isDashboardSpecCapabilitySupported(
  templateId: string,
  variantId: string | null | undefined,
): boolean {
  if (!variantId) return false;
  return CAPABILITY_BY_KEY.get(`${templateId}\u0000${variantId}`)?.supported === true;
}

async function readContractRecord(
  policy: MoAgentWorkspacePolicy,
  relativePath: string,
  signal: AbortSignal,
): Promise<JsonRecord> {
  throwIfAborted(signal);
  const resolved = await policy.resolveReadPath(relativePath);
  const stat = await fs.stat(resolved.canonicalPath);
  if (!stat.isFile()) {
    throw new MoAgentToolError(
      'DASHBOARD_SPEC_CONTRACT_INVALID',
      `Dashboard contract artifact is not a file: ${resolved.relativePath}.`,
    );
  }
  if (stat.size > MAX_CONTRACT_BYTES) {
    throw new MoAgentToolError(
      'DASHBOARD_SPEC_CONTRACT_TOO_LARGE',
      `Dashboard contract artifact exceeds ${MAX_CONTRACT_BYTES} bytes: ${resolved.relativePath}.`,
    );
  }
  const content = await fs.readFile(resolved.canonicalPath, { encoding: 'utf8', signal });
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new MoAgentToolError(
      'DASHBOARD_SPEC_CONTRACT_INVALID',
      `Dashboard contract artifact is not valid JSON: ${resolved.relativePath}.`,
    );
  }
  if (!isRecord(parsed)) {
    throw new MoAgentToolError(
      'DASHBOARD_SPEC_CONTRACT_INVALID',
      `Dashboard contract artifact must contain a JSON object: ${resolved.relativePath}.`,
    );
  }
  return parsed;
}

function authoritativeValue(
  label: string,
  planned: string | null,
  prepared: string | null,
  required: boolean,
): string | null {
  if (required && (!planned || !prepared)) {
    throw new MoAgentToolError(
      'DASHBOARD_SPEC_CONTRACT_INCOMPLETE',
      `${label} must be declared by both the run plan and final data.`,
      { planned, prepared },
    );
  }
  if (planned && prepared && planned !== prepared) {
    throw new MoAgentToolError(
      'DASHBOARD_SPEC_CONTRACT_MISMATCH',
      `${label} differs between the run plan and final data.`,
      { planned, prepared },
    );
  }
  const value = planned ?? prepared;
  return value;
}

function resolveDashboardCapability(
  templateId: string,
  variantId: string,
): SupportedDashboardCapability {
  if (!KNOWN_TEMPLATE_IDS.has(templateId)) {
    throw new MoAgentToolError(
      'DASHBOARD_SPEC_TEMPLATE_UNSUPPORTED',
      `No trusted QuantPilot renderer is registered for template ${templateId}.`,
      { templateId, variantId },
    );
  }
  const capability = CAPABILITY_BY_KEY.get(`${templateId}\u0000${variantId}`);
  if (!capability) {
    throw new MoAgentToolError(
      'DASHBOARD_SPEC_VARIANT_UNSUPPORTED',
      `No trusted QuantPilot renderer capability is registered for ${templateId}/${variantId}.`,
      { templateId, variantId },
    );
  }
  if (!capability.supported) {
    throw new MoAgentToolError(
      'DASHBOARD_SPEC_VARIANT_UNSUPPORTED',
      `Dashboard variant ${templateId}/${variantId} is not implemented by a trusted renderer.`,
      { templateId, variantId, reason: capability.reason },
    );
  }
  return capability;
}

function assertDataPrerequisites(
  capability: SupportedDashboardCapability,
  finalData: JsonRecord,
): void {
  const missing = capability.dataPrerequisites.filter((requirement) => {
    try {
      return !requirement.satisfiedBy(finalData);
    } catch {
      return true;
    }
  });
  if (missing.length === 0) return;
  throw new MoAgentToolError(
    'DASHBOARD_SPEC_DATA_PREREQUISITE_FAILED',
    `Final dashboard data cannot satisfy ${capability.templateId}/${capability.variantId}.`,
    {
      missing: missing.map((requirement) => ({
        id: requirement.id,
        description: requirement.description,
      })),
    },
  );
}

function compileDashboardSpec(
  runPlan: JsonRecord,
  finalData: JsonRecord,
  assertion: ApplyDashboardSpecInput,
): CompiledDashboardSpec {
  if (contractString(runPlan.status) !== 'planned') {
    throw new MoAgentToolError(
      'DASHBOARD_SPEC_PLAN_NOT_READY',
      'The authoritative run plan must have status=planned before dashboard compilation.',
      { status: runPlan.status ?? null },
    );
  }
  const planVisualization = nestedRecord(runPlan, 'visualization');
  const finalVisualization = nestedRecord(finalData, 'visualization');
  if (!planVisualization || planVisualization.required !== true) {
    throw new MoAgentToolError(
      'DASHBOARD_SPEC_VISUALIZATION_NOT_REQUIRED',
      'The authoritative run plan must explicitly declare visualization.required=true.',
    );
  }
  if (!finalVisualization) {
    throw new MoAgentToolError(
      'DASHBOARD_SPEC_CONTRACT_INCOMPLETE',
      'Final dashboard data must contain a visualization contract.',
    );
  }
  const templateId = authoritativeValue(
    'templateId',
    contractString(planVisualization?.templateId ?? planVisualization?.template_id),
    contractString(finalVisualization?.template_id ?? finalVisualization?.templateId),
    true,
  );
  const variantId = authoritativeValue(
    'variantId',
    contractString(planVisualization?.variantId ?? planVisualization?.variant_id),
    contractString(finalVisualization?.variant_id ?? finalVisualization?.variantId),
    true,
  );
  if (!templateId || !variantId) {
    throw new MoAgentToolError(
      'DASHBOARD_SPEC_CONTRACT_INCOMPLETE',
      'templateId and variantId are required to compile a dashboard.',
    );
  }
  if (assertion.templateId && assertion.templateId !== templateId) {
    throw new MoAgentToolError(
      'DASHBOARD_SPEC_ASSERTION_FAILED',
      `Requested templateId ${assertion.templateId} does not match authoritative ${templateId}.`,
    );
  }
  if (assertion.variantId && assertion.variantId !== variantId) {
    throw new MoAgentToolError(
      'DASHBOARD_SPEC_ASSERTION_FAILED',
      `Requested variantId ${assertion.variantId} does not match authoritative ${variantId ?? '(missing)'}.`,
    );
  }
  const capability = resolveDashboardCapability(templateId, variantId);
  const datasetIdentity = assessQuantDatasetIdentity(runPlan, finalData);
  if (!datasetIdentity.ready) {
    throw new MoAgentToolError(
      'DASHBOARD_SPEC_DATA_IDENTITY_MISMATCH',
      'Final dashboard data is not bound to the authoritative run and symbol universe.',
      { reasons: datasetIdentity.reasons },
    );
  }
  const plannedComponents = contractComponents(
    planVisualization.panels,
    'run_plan.visualization.panels',
  );
  const preparedComponents = contractComponents(
    finalVisualization.required_components,
    'final.visualization.required_components',
  );
  if (!componentsMatch(plannedComponents.normalized, preparedComponents.normalized)) {
    throw new MoAgentToolError(
      'DASHBOARD_SPEC_COMPONENTS_MISMATCH',
      'Dashboard components differ between the run plan and final data.',
      {
        planOnly: componentSetDifference(plannedComponents.normalized, preparedComponents.normalized),
        finalOnly: componentSetDifference(preparedComponents.normalized, plannedComponents.normalized),
      },
    );
  }
  const supportedComponents = contractComponents(
    capability.requiredComponents,
    'renderer.requiredComponents',
  );
  if (!componentsMatch(preparedComponents.normalized, supportedComponents.normalized)) {
    throw new MoAgentToolError(
      'DASHBOARD_SPEC_COMPONENT_UNSUPPORTED',
      `The trusted renderer does not exactly implement the authoritative component contract for ${templateId}/${variantId}.`,
      {
        unsupported: componentSetDifference(preparedComponents.normalized, supportedComponents.normalized),
        missing: componentSetDifference(supportedComponents.normalized, preparedComponents.normalized),
      },
    );
  }
  const missingComponents = finalVisualization.missing_components;
  if (missingComponents !== undefined && !Array.isArray(missingComponents)) {
    throw new MoAgentToolError(
      'DASHBOARD_SPEC_CONTRACT_INVALID',
      'final.visualization.missing_components must be an array when declared.',
    );
  }
  if (Array.isArray(missingComponents) && missingComponents.length > 0) {
    throw new MoAgentToolError(
      'DASHBOARD_SPEC_COMPONENT_UNSUPPORTED',
      'Final dashboard data declares unresolved visualization components.',
      { missingComponents: missingComponents.slice(0, 64) },
    );
  }
  assertDataPrerequisites(capability, finalData);
  return {
    schemaVersion: 1,
    templateId,
    variantId,
    renderer: capability.renderer,
    requiredComponents: [...capability.requiredComponents],
    dataPrerequisites: capability.dataPrerequisites.map((requirement) => requirement.id),
    dataArtifact: FINAL_DATA_PATH,
    outputArtifacts: [PAGE_PATH, STYLES_PATH],
  };
}

/** Read-only compiler preflight used before a provider is allowed to see the tool. */
export function assessDashboardSpecReadiness(
  runPlan: JsonRecord,
  finalData: JsonRecord,
): DashboardSpecReadinessAssessment {
  try {
    return {
      ready: true,
      errorCode: null,
      reasons: [],
      spec: compileDashboardSpec(runPlan, finalData, {}),
    };
  } catch (error) {
    if (error instanceof MoAgentToolError) {
      const details = isRecord(error.details) ? error.details : {};
      const detailReasons = Array.isArray(details.reasons)
        ? details.reasons.filter((item): item is string => typeof item === 'string')
        : [];
      const missing = Array.isArray(details.missing)
        ? details.missing.flatMap((item: unknown) => {
            const id = isRecord(item) ? contractString(item.id) : null;
            return id ? [id] : [];
          })
        : [];
      return {
        ready: false,
        errorCode: error.code,
        reasons: detailReasons.length > 0
          ? detailReasons
          : missing.length > 0
            ? missing
            : [error.code],
        spec: null,
      };
    }
    throw error;
  }
}

function renderDashboard(spec: CompiledDashboardSpec): { page: string; styles: string } {
  const baseStyles = baseDashboardCssTemplate().trimEnd();
  switch (spec.renderer) {
    case 'stock-selection':
      return {
        page: stockSelectionPageTemplate(),
        styles: `${baseStyles}\n\n${comparisonCss().trim()}\n\n${stockSelectionCss().trim()}\n`,
      };
    case 'comparison':
      return {
        page: comparisonPageTemplate(),
        styles: `${baseStyles}\n\n${comparisonCss().trim()}\n`,
      };
    case 'holding-analysis':
      return {
        page: holdingAnalysisPageTemplate(),
        styles: `${baseStyles}\n\n${holdingAnalysisCss().trim()}\n`,
      };
    case 'base':
      return { page: baseDashboardPageTemplate(), styles: `${baseStyles}\n` };
  }
}

function parseInput(value: unknown): ApplyDashboardSpecInput {
  const record = inputRecord(value);
  const templateId = record.templateId === undefined
    ? undefined
    : optionalString(record, 'templateId', '', { maxLength: 160 });
  const variantId = record.variantId === undefined
    ? undefined
    : optionalString(record, 'variantId', '', { maxLength: 160 });
  return {
    ...(templateId ? { templateId } : {}),
    ...(variantId ? { variantId } : {}),
  };
}

export function createApplyDashboardSpecTool(
  options: MoAgentDashboardSpecToolOptions,
): MoAgentTool<ApplyDashboardSpecInput, ApplyDashboardSpecOutput> {
  let policyPromise: Promise<MoAgentWorkspacePolicy> | undefined;
  const policy = () => policyPromise ??= MoAgentWorkspacePolicy.create({
    workspaceRoot: options.workspaceRoot,
    allowedWriteGlobs: options.allowedWriteGlobs,
    includeDefaultWriteGlobs: options.includeDefaultWriteGlobs,
  });
  return {
    name: 'apply_dashboard_spec',
    description: 'Compile the authoritative run plan and final-data visualization contract into trusted QuantPilot page and CSS artifacts. Pass {} to accept the authoritative template; templateId/variantId are optional assertions, never overrides. Prefer this once for standard dashboard generation instead of reading and rewriting whole TSX/CSS files.',
    effect: 'workspace_write',
    idempotency: 'reconcile_required',
    inputSchema: {
      type: 'object',
      properties: {
        templateId: {
          type: 'string',
          description: 'Optional assertion matching the authoritative template; omit to derive it safely.',
        },
        variantId: {
          type: 'string',
          description: 'Optional assertion matching the authoritative variant; omit to derive it safely.',
        },
      },
      additionalProperties: false,
    },
    parseInput,
    execute: (input, context) => executeMoAgentTool(
      context.signal,
      options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
      async (signal) => {
        const workspacePolicy = await policy();
        const [runPlan, finalData] = await Promise.all([
          readContractRecord(workspacePolicy, RUN_PLAN_PATH, signal),
          readContractRecord(workspacePolicy, FINAL_DATA_PATH, signal),
        ]);
        const spec = compileDashboardSpec(runPlan, finalData, input);
        const rendered = renderDashboard(spec);
        const writeResult = await writeMoAgentWorkspaceBatch({
          policy: workspacePolicy,
          files: [
            { relativePath: PAGE_PATH, content: Buffer.from(rendered.page, 'utf8') },
            { relativePath: STYLES_PATH, content: Buffer.from(rendered.styles, 'utf8') },
          ],
          maxBytesPerFile: options.maxWriteBytes ?? DEFAULT_MAX_GENERATED_FILE_BYTES,
          maxTotalBytes: options.maxGeneratedTotalBytes ?? DEFAULT_MAX_GENERATED_TOTAL_BYTES,
          signal,
          resourceLockWaitTimeoutMs: options.resourceLockWaitTimeoutMs,
          lockIdentity: { runId: context.runId, operationId: context.operationId },
          commitWorkspaceMutation: context.commitWorkspaceMutation,
        });
        const data: ApplyDashboardSpecOutput = {
          spec,
          files: writeResult.files,
          totalBytes: writeResult.totalBytes,
        };
        return {
          ok: true,
          data,
          content: `Compiled ${spec.templateId}/${spec.variantId ?? 'default'} with the trusted ${spec.renderer} renderer into ${spec.outputArtifacts.join(', ')}.`,
          metadata: {
            dashboardSpecVersion: spec.schemaVersion,
            templateId: spec.templateId,
            variantId: spec.variantId,
            renderer: spec.renderer,
          },
        };
      },
    ),
  };
}

export const __dashboardSpecTesting = {
  compileDashboardSpec,
  renderDashboard,
  capabilityMatrix: DASHBOARD_CAPABILITIES.map((capability) => ({
    templateId: capability.templateId,
    variantId: capability.variantId,
    supported: capability.supported,
    ...(capability.supported
      ? {
          renderer: capability.renderer,
          requiredComponents: [...capability.requiredComponents],
          dataPrerequisites: capability.dataPrerequisites.map((requirement) => requirement.id),
        }
      : { reason: capability.reason }),
  })),
};
