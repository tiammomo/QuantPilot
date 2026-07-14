import { getAllProjects } from '@/lib/services/project';
import { getRuntimeDegradationConfig } from '@/lib/config/degradation';
import { getQuantCapability, type QuantCapabilityId } from '@/lib/quant/capabilities';
import { serializeProjects } from '@/lib/serializers/project';
import type { Project } from '@/types';

export type {
  StrategyStatus,
  StrategyRiskLevel,
  StrategyTemplateKind,
  StrategyRule,
  StrategyDataReadiness,
  StrategyParameter,
  StrategyParameterScan,
  StrategyVersionRecord,
  StrategyBacktestArchive,
  StrategyScanRunResult,
  StrategyScanRun,
  StrategyScanJob,
  StrategyUniverseMember,
  StrategyUniverse,
  StrategyUniverseMembersPage,
  StrategyScreenerMode,
  StrategyScreenerCandidate,
  StrategyAnalyticsExecutionMetadata,
  StrategyScreenerResponse,
  StrategyDataCoverageItem,
  StrategyLocalKlineBar,
  StrategyDividendEvent,
  StrategyDividendEventsResponse,
  StrategySectorCapitalFlowItem,
  StrategySectorCapitalFlowMarketSummary,
  StrategySectorCapitalFlowTrendPoint,
  StrategySectorCapitalFlowMember,
  StrategySectorCapitalFlowDetail,
  StrategySectorCapitalFlowResponse,
  StrategyLocalKlineSummary,
  StrategyLocalKlineResponse,
  StrategyRealtimeQuote,
  StrategyIngestionPlan,
  StrategyResearchState,
  StrategyHistoryIngestionResult,
  StrategyAutoFillIngestionStartResult,
  StrategyIngestionJob,
  StrategyIngestionJobControlResult,
  StrategyIngestionJobsResponse,
  StrategyFoundationComponent,
  StrategyFactorDefinition,
  StrategyTradingCalendarDay,
  StrategyDataQualityIssue,
  StrategyDataQualityScan,
  StrategyFoundationState,
  StrategyFactorCatalogStatus,
  StrategyFactorCatalogDirection,
  StrategyFactorCatalogItem,
  StrategyFactorCatalogCategory,
  StrategyFactorCatalogEnrichmentItem,
  StrategyFactorResearchWorkflowStep,
  StrategyFactorDataLayer,
  StrategyFactorStrategyBlueprint,
  StrategyFactorCatalogState,
  StrategyUniverseMemberAddResult,
  StrategyTemplate,
  StrategyWorkspaceRef,
  StrategyCatalogItem,
  StrategyDashboardData
} from './strategy-types';
import {
  FALLBACK_FOUNDATION_STATE,
  SAMPLE_UNIVERSE_ID,
  SAMPLE_UNIVERSE_MEMBER_SEEDS,
  STRATEGY_FACTOR_CATALOG,
  STRATEGY_TEMPLATES,
} from './strategy-catalog';
import { readinessFor } from './strategy-readiness';
import { listScanJobs, listScanRuns, writeScanJob, writeScanRun } from './strategy-scan-repository';
import type {
  StrategyParameterScan,
  StrategyScanRunResult,
  StrategyScanRun,
  StrategyScanJob,
  StrategyUniverseMember,
  StrategyUniverse,
  StrategyUniverseMembersPage,
  StrategyScreenerMode,
  StrategyScreenerCandidate,
  StrategyAnalyticsExecutionMetadata,
  StrategyScreenerResponse,
  StrategyDataCoverageItem,
  StrategyLocalKlineBar,
  StrategyDividendEvent,
  StrategyDividendEventsResponse,
  StrategySectorCapitalFlowItem,
  StrategySectorCapitalFlowMarketSummary,
  StrategySectorCapitalFlowTrendPoint,
  StrategySectorCapitalFlowMember,
  StrategySectorCapitalFlowDetail,
  StrategySectorCapitalFlowResponse,
  StrategyLocalKlineResponse,
  StrategyRealtimeQuote,
  StrategyResearchState,
  StrategyHistoryIngestionResult,
  StrategyAutoFillIngestionStartResult,
  StrategyIngestionJob,
  StrategyIngestionJobControlResult,
  StrategyIngestionJobsResponse,
  StrategyFoundationComponent,
  StrategyFactorDefinition,
  StrategyTradingCalendarDay,
  StrategyDataQualityIssue,
  StrategyDataQualityScan,
  StrategyFoundationState,
  StrategyFactorCatalogState,
  StrategyUniverseMemberAddResult,
  StrategyTemplate,
  StrategyWorkspaceRef,
  StrategyCatalogItem,
  StrategyDashboardData
} from './strategy-types';
import {
  asRecord,
  asString,
  inferSampleSectorTags,
  dataStatus,
  trendStatus,
  mapResearchMember,
  mapResearchUniverse,
  mapResearchUniverseMembersPage,
  mapScreenerResponse,
  mapDividendEventsResponse,
  mapSectorCapitalFlowResponse,
  mapLocalKlineResponse,
  mapRealtimeQuote,
  mapIngestionJobsResponse,
  mapFoundationComponent,
  mapFactorDefinition,
  mapTradingCalendarDay,
  mapDataQualityScan,
  mapIngestionJobControlResult,
} from './strategy-mappers';

const MARKET_API_BASE_URL =
  process.env.QUANTPILOT_MARKET_API_URL ||
  process.env.QUANTPILOT_MARKET_API_BASE_URL ||
  'http://127.0.0.1:8000';
function getMarketApiConfig() {
  return getRuntimeDegradationConfig().components.marketApi;
}

function assertMarketApiEnabled() {
  if (!getMarketApiConfig().enabled) {
    throw new Error('market API 已按降级配置停用');
  }
}

const SAMPLE_UNIVERSE_MEMBERS: StrategyUniverseMember[] = SAMPLE_UNIVERSE_MEMBER_SEEDS.map(
  (member) => ({
    ...member,
    concepts: [],
    sectorTags: inferSampleSectorTags(member.name),
    assetType: 'stock',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    provider: 'eastmoney',
    securityStatus: 'active',
    role: 'member',
    weight: Number((1 / SAMPLE_UNIVERSE_MEMBER_SEEDS.length).toFixed(8)),
    rowCount: 0,
    latestClose: null,
    latestChangePct: null,
    latestAmount: null,
    latestTurnover: null,
    strength20dPct: null,
    strength60dPct: null,
    ma20: null,
    ma60: null,
    trendStatus: 'insufficient',
    avgAmount20d: null,
    avgVolume20d: null,
    avgTurnover20d: null,
    tradeStatus: null,
    isSt: null,
    limitUp: null,
    limitDown: null,
    peTtm: null,
    pbMrq: null,
    psTtm: null,
    pcfNcfTtm: null,
    dataStatus: 'missing',
  })
);

const FALLBACK_RESEARCH_STATE: StrategyResearchState = {
  primaryUniverseId: SAMPLE_UNIVERSE_ID,
  source: 'fallback',
  universes: [
    {
      id: SAMPLE_UNIVERSE_ID,
      name: 'A 股股票池',
      description: '用于策略平台打通本地行情覆盖、数据质量检查和回测链路的默认股票池。',
      status: 'active',
      source: 'seed',
      tags: ['A股', '股票', '东方财富', '策略回测'],
      defaultTimeframe: 'daily',
      defaultAdjustment: 'qfq',
      provider: 'eastmoney',
      members: SAMPLE_UNIVERSE_MEMBERS,
      memberCount: SAMPLE_UNIVERSE_MEMBERS.length,
      stockCount: SAMPLE_UNIVERSE_MEMBERS.length,
      etfCount: 0,
      indexCount: 0,
      fundCount: 0,
      readyCount: 0,
      barCount: 0,
      latestTs: null,
    },
    {
      id: 'etf-index-pool',
      name: 'ETF/指数池',
      description: '用于指数代理、ETF 轮动和跨资产对比的独立池。',
      status: 'active',
      source: 'seed',
      tags: ['ETF', '指数', '东方财富', '轮动'],
      defaultTimeframe: 'daily',
      defaultAdjustment: 'qfq',
      provider: 'eastmoney',
      members: [],
      memberCount: 0,
      stockCount: 0,
      etfCount: 0,
      indexCount: 0,
      fundCount: 0,
      readyCount: 0,
      barCount: 0,
      latestTs: null,
    },
  ],
  coverage: SAMPLE_UNIVERSE_MEMBERS.map(member => ({
    symbol: member.symbol,
    name: member.name,
    timeframe: 'daily',
    adjustment: 'qfq',
    provider: 'eastmoney',
    rowCount: 0,
    dataStatus: 'missing',
  })),
  ingestionPlan: {
    provider: 'eastmoney',
    universeId: SAMPLE_UNIVERSE_ID,
    timeframe: 'daily',
    adjustment: 'qfq',
    suggestedLimit: 1260,
    lookbackYears: 5,
    endpoints: [
      'GET /api/v1/research/universes/summary',
      'GET /api/v1/research/universes/{id}/members',
      'POST /api/v1/ingestion/eastmoney/history',
      'POST /api/v1/ingestion/akshare/history',
      'POST /api/v1/ingestion/baostock/history',
    ],
    guardrails: [
      '默认保留近 5 年前复权日线，保证策略回测读取同一价格口径。',
      '每次同步按 symbol/timeframe/adjustment/ts 幂等 upsert。',
      '历史样本不因后续补数被删除，回测窗口由查询条件决定。',
      '回测必须读取本地 TimescaleDB，避免外部行情变化影响复现。',
    ],
  },
};

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function findTemplate(templateId: string) {
  return STRATEGY_TEMPLATES.find(template => template.id === templateId) ?? null;
}

function listCatalogTemplates() {
  return STRATEGY_TEMPLATES.filter(template => template.kind);
}

function findScan(template: StrategyTemplate, scanId: string) {
  return template.parameterScans.find(scan => scan.id === scanId) ?? null;
}

function expandGrid(scan: StrategyParameterScan): Array<Record<string, string | number>> {
  return scan.grid.reduce<Array<Record<string, string | number>>>((acc, item) => {
    const base = acc.length ? acc : [{}];
    return base.flatMap(existing =>
      item.values.map(value => ({
        ...existing,
        [item.key]: value,
      }))
    );
  }, []);
}

function isValidMaCrossoverParams(params: Record<string, string | number>) {
  const fast = asNumber(params.fast_window);
  const slow = asNumber(params.slow_window);
  return fast !== null && slow !== null && fast < slow;
}

async function fetchBacktest(params: {
  symbol: string;
  parameters: Record<string, string | number>;
  strategyId: string;
  limit?: number;
}): Promise<Record<string, unknown>> {
  assertMarketApiEnabled();
  const query = new URLSearchParams({
    fee_bps: String(params.parameters.fee_bps ?? 5),
    period: 'daily',
    adjustment: 'qfq',
    limit: String(params.limit ?? 1260),
  });
  for (const [key, value] of Object.entries(params.parameters)) {
    query.set(key, String(value));
  }
  const response = await fetch(
    `${MARKET_API_BASE_URL}/api/v1/backtests/strategies/${encodeURIComponent(params.strategyId)}/${encodeURIComponent(params.symbol)}?${query.toString()}`,
    { cache: 'no-store' }
  );
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`market API ${response.status}: ${body.slice(0, 180)}`);
  }
  return response.json() as Promise<Record<string, unknown>>;
}

function summarizeBacktest(backtest: Record<string, unknown>): StrategyScanRunResult['metrics'] {
  const summary = backtest.summary && typeof backtest.summary === 'object'
    ? backtest.summary as Record<string, unknown>
    : {};
  return {
    totalReturnPct: asNumber(summary.total_return_pct),
    maxDrawdownPct: asNumber(summary.max_drawdown_pct),
    winRatePct: asNumber(summary.win_rate_pct),
    tradeCount: asNumber(summary.trade_count),
    sharpe: asNumber(summary.sharpe),
  };
}

function chooseBestResult(results: StrategyScanRunResult[]) {
  const successful = results.filter(result => result.status === 'success');
  if (!successful.length) return null;
  return successful
    .slice()
    .sort((a, b) => {
      const aReturn = a.metrics.totalReturnPct ?? Number.NEGATIVE_INFINITY;
      const bReturn = b.metrics.totalReturnPct ?? Number.NEGATIVE_INFINITY;
      if (aReturn !== bReturn) return bReturn - aReturn;
      const aDrawdown = a.metrics.maxDrawdownPct ?? Number.POSITIVE_INFINITY;
      const bDrawdown = b.metrics.maxDrawdownPct ?? Number.POSITIVE_INFINITY;
      return aDrawdown - bDrawdown;
    })[0];
}

async function fetchMarketApiJson<T>(
  pathName: string,
  options: { timeoutMs?: number } = {}
): Promise<T> {
  assertMarketApiEnabled();
  const controller = options.timeoutMs ? new AbortController() : null;
  const timeout = controller && options.timeoutMs
    ? setTimeout(() => controller.abort(), options.timeoutMs)
    : null;
  try {
    const response = await fetch(`${MARKET_API_BASE_URL}${pathName}`, {
      cache: 'no-store',
      signal: controller?.signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`market API ${response.status}: ${body.slice(0, 180)}`);
    }
    return response.json() as Promise<T>;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`market API timeout after ${options.timeoutMs}ms: ${pathName}`);
    }
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function getStrategyUniverseMembersPage(params: {
  universeId?: string;
  page?: number;
  pageSize?: number;
  keyword?: string;
  timeoutMs?: number;
} = {}): Promise<StrategyUniverseMembersPage> {
  const universeId = params.universeId || SAMPLE_UNIVERSE_ID;
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.max(1, Math.min(params.pageSize ?? 10, 100));
  const query = new URLSearchParams({
    page: String(page),
    page_size: String(pageSize),
  });
  const keyword = params.keyword?.trim();
  if (keyword) query.set('keyword', keyword);
  const payload = await fetchMarketApiJson<unknown>(
    `/api/v1/research/universes/${encodeURIComponent(universeId)}/members?${query.toString()}`,
    { timeoutMs: params.timeoutMs }
  );
  return mapResearchUniverseMembersPage(payload, universeId, page, pageSize);
}

export async function runStrategyScreener(params: {
  universeId?: string;
  tradeDate?: string;
  mode?: StrategyScreenerMode;
  limit?: number;
  timeoutMs?: number;
} = {}): Promise<StrategyScreenerResponse> {
  const query = new URLSearchParams({
    universe_id: params.universeId || SAMPLE_UNIVERSE_ID,
    mode: params.mode || 'short_term',
    limit: String(Math.max(1, Math.min(params.limit ?? 20, 100))),
  });
  const tradeDate = params.tradeDate?.trim();
  if (tradeDate) query.set('trade_date', tradeDate);
  const payload = await fetchMarketApiJson<unknown>(
    `/api/v1/research/screeners/a-share/short-term-candidates?${query.toString()}`,
    { timeoutMs: params.timeoutMs }
  );
  return mapScreenerResponse(payload);
}

export async function getStrategyIngestionJobs(params: {
  universeId?: string;
  limit?: number;
} = {}): Promise<StrategyIngestionJobsResponse> {
  const query = new URLSearchParams({
    limit: String(Math.max(1, Math.min(params.limit ?? 20, 100))),
  });
  const universeId = params.universeId?.trim();
  if (universeId) query.set('universe_id', universeId);
  const payload = await fetchMarketApiJson<unknown>(`/api/v1/ingestion/jobs?${query.toString()}`);
  return mapIngestionJobsResponse(payload);
}

export async function controlStrategyIngestionJob(params: {
  jobId: string;
  action: 'pause' | 'resume' | 'stop';
  reason?: string;
}): Promise<StrategyIngestionJobControlResult> {
  assertMarketApiEnabled();
  const jobId = params.jobId.trim();
  if (!jobId) throw new Error('缺少补数任务 ID');
  const response = await fetch(
    `${MARKET_API_BASE_URL}/api/v1/ingestion/jobs/${encodeURIComponent(jobId)}/control`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: params.action, reason: params.reason }),
      cache: 'no-store',
    }
  );
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`market API ${response.status}: ${text.slice(0, 200)}`);
  }
  return mapIngestionJobControlResult(await response.json());
}

export async function runStrategyDataQualityScan(params: {
  universeId?: string;
  symbols?: string[];
  timeframe?: string;
  adjustment?: string;
  lookbackYears?: number;
  persist?: boolean;
} = {}): Promise<StrategyDataQualityScan> {
  assertMarketApiEnabled();
  const response = await fetch(`${MARKET_API_BASE_URL}/api/v1/foundation/data-quality/scan`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      universe_id: params.universeId || SAMPLE_UNIVERSE_ID,
      symbols: params.symbols?.length ? params.symbols : undefined,
      timeframe: params.timeframe || 'daily',
      adjustment: params.adjustment || 'qfq',
      lookback_years: params.lookbackYears ?? FALLBACK_RESEARCH_STATE.ingestionPlan.lookbackYears,
      persist: params.persist !== false,
    }),
    cache: 'no-store',
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`market API ${response.status}: ${text.slice(0, 200)}`);
  }
  return mapDataQualityScan(await response.json());
}

export async function getStrategySectorCapitalFlow(params: {
  universeId?: string;
  limit?: number;
  sector?: string;
  detailDays?: number;
} = {}): Promise<StrategySectorCapitalFlowResponse> {
  const query = new URLSearchParams({
    universe_id: params.universeId || SAMPLE_UNIVERSE_ID,
    limit: String(Math.max(1, Math.min(params.limit ?? 40, 120))),
  });
  if (params.sector) {
    query.set('sector', params.sector);
  }
  if (params.detailDays) {
    query.set('detail_days', String(Math.max(5, Math.min(params.detailDays, 60))));
  }
  const payload = await fetchMarketApiJson<unknown>(
    `/api/v1/research/sector-capital-flow?${query.toString()}`
  );
  return mapSectorCapitalFlowResponse(payload);
}

async function getStrategyResearchState(): Promise<StrategyResearchState> {
  try {
    const universesPayload = asRecord(
      await fetchMarketApiJson<unknown>('/api/v1/research/universes/summary', { timeoutMs: 2500 })
    );
    const universes = Array.isArray(universesPayload.universes)
      ? universesPayload.universes.map(mapResearchUniverse)
      : [];
    const primaryUniverse =
      universes.find((universe) => universe.id === SAMPLE_UNIVERSE_ID) ??
      universes.find((universe) => universe.stockCount > 0) ??
      universes[0] ??
      FALLBACK_RESEARCH_STATE.universes[0];
    const initialMembersPage = await getStrategyUniverseMembersPage({
      universeId: primaryUniverse.id,
      page: 1,
      pageSize: 10,
      timeoutMs: 4500,
    });
    const hydratedUniverses = universes.map((universe) => (
      universe.id === primaryUniverse.id
        ? {
            ...universe,
            members: initialMembersPage.members,
            memberCount: initialMembersPage.total || universe.memberCount,
          }
        : { ...universe, members: [] }
    ));
    const coverage = initialMembersPage.members.map((member): StrategyDataCoverageItem => ({
      symbol: member.symbol,
      name: member.name,
      timeframe: primaryUniverse.defaultTimeframe,
      adjustment: primaryUniverse.defaultAdjustment,
      provider: member.dataProvider ?? primaryUniverse.provider,
      firstTs: member.firstTs ?? null,
      lastTs: member.lastTs ?? null,
      rowCount: member.rowCount,
      dataStatus: member.dataStatus,
    }));

    return {
      ...FALLBACK_RESEARCH_STATE,
      primaryUniverseId: primaryUniverse.id,
      source: 'market-api',
      universes: hydratedUniverses.length ? hydratedUniverses : FALLBACK_RESEARCH_STATE.universes,
      coverage: coverage.length ? coverage : FALLBACK_RESEARCH_STATE.coverage,
      ingestionPlan: {
        ...FALLBACK_RESEARCH_STATE.ingestionPlan,
        universeId: primaryUniverse.id,
        timeframe: primaryUniverse.defaultTimeframe,
        adjustment: primaryUniverse.defaultAdjustment,
        provider: primaryUniverse.provider,
        lookbackYears: FALLBACK_RESEARCH_STATE.ingestionPlan.lookbackYears,
      },
      error: null,
    };
  } catch (error) {
    return {
      ...FALLBACK_RESEARCH_STATE,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function getStrategyFoundationState(): Promise<StrategyFoundationState> {
  try {
    const [statusResult, factorsResult, calendarResult] = await Promise.allSettled([
      fetchMarketApiJson<unknown>('/api/v1/foundation/status', { timeoutMs: 2000 }),
      fetchMarketApiJson<unknown>('/api/v1/foundation/factors', { timeoutMs: 2000 }),
      fetchMarketApiJson<unknown>('/api/v1/foundation/trading-calendar?market=CN-A&limit=30', { timeoutMs: 2500 }),
    ]);
    const failures = [statusResult, factorsResult, calendarResult]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason instanceof Error ? result.reason.message : String(result.reason));
    if (
      statusResult.status === 'rejected' &&
      factorsResult.status === 'rejected' &&
      calendarResult.status === 'rejected'
    ) {
      throw new Error(failures.join('；') || '基础组件接口暂不可用');
    }
    const statusPayload = statusResult.status === 'fulfilled' ? statusResult.value : {};
    const factorsPayload = factorsResult.status === 'fulfilled' ? factorsResult.value : {};
    const calendarPayload = calendarResult.status === 'fulfilled' ? calendarResult.value : {};
    const statusRecord = asRecord(statusPayload);
    const factorsRecord = asRecord(factorsPayload);
    const calendarRecord = asRecord(calendarPayload);
    return {
      source: 'market-api',
      components: Array.isArray(statusRecord.components)
        ? statusRecord.components.map(mapFoundationComponent)
        : FALLBACK_FOUNDATION_STATE.components,
      factors: Array.isArray(factorsRecord.factors)
        ? factorsRecord.factors.map(mapFactorDefinition)
        : [],
      calendarDays: Array.isArray(calendarRecord.days)
        ? calendarRecord.days.map(mapTradingCalendarDay)
        : [],
      latestQualityScan: null,
      error: failures.length ? failures.join('；') : null,
    };
  } catch (error) {
    return {
      ...FALLBACK_FOUNDATION_STATE,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function isStrategyCapability(capabilityId?: string | null): capabilityId is QuantCapabilityId {
  return capabilityId === 'strategy_research' || capabilityId === 'backtest_review' || capabilityId === 'portfolio_risk';
}

function toWorkspaceRef(project: Project): StrategyWorkspaceRef {
  return {
    id: project.id,
    name: project.name,
    status: project.status ?? null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt ?? null,
    capabilityId: project.quantCapabilityId ?? null,
    initialPrompt: project.initialPrompt ?? null,
  };
}

function matchesTemplate(project: StrategyWorkspaceRef, template: StrategyTemplate) {
  if (project.capabilityId === template.capabilityId) return true;
  const prompt = `${project.name} ${project.initialPrompt ?? ''}`.toLowerCase();
  return template.defaultSymbols.some(symbol => prompt.includes(symbol.toLowerCase())) ||
    template.parameterSchema.some(param => prompt.includes(param.key.toLowerCase()));
}

export async function getStrategyDashboardData(): Promise<StrategyDashboardData> {
  const projects = serializeProjects(await getAllProjects().catch(() => []));
  const [scanRuns, scanJobs, research, foundation] = await Promise.all([
    listScanRuns(),
    listScanJobs(),
    getStrategyResearchState(),
    getStrategyFoundationState(),
  ]);
  const strategyWorkspaces = projects
    .filter(project => isStrategyCapability(project.quantCapabilityId))
    .map(toWorkspaceRef);

  const templates = listCatalogTemplates().map((template): StrategyCatalogItem => ({
    ...template,
    readiness: readinessFor(template),
    linkedWorkspaces: strategyWorkspaces.filter(project => matchesTemplate(project, template)),
    latestScanRun: scanRuns.find(run => run.templateId === template.id) ?? null,
  }));

  const dependencySet = new Set(templates.flatMap(template => template.dataDependencies));
  const parameterScans = templates.reduce((sum, template) => sum + template.parameterScans.length, 0);
  const archivedReports = templates.reduce((sum, template) => sum + template.backtestArchives.length, 0);
  const activeVersions = templates.reduce(
    (sum, template) => sum + template.versions.filter(version => version.status === 'active').length,
    0
  );
  const trackedSymbols = research.universes.reduce(
    (sum, universe) => sum + universe.memberCount,
    0
  );
  const syncedSymbols = research.universes.reduce((sum, universe) => sum + universe.readyCount, 0);
  const syncedBars = research.universes.reduce((sum, universe) => sum + universe.barCount, 0);

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      templates: templates.length,
      readyTemplates: templates.filter(template => template.status === 'ready').length,
      plannedTemplates: templates.filter(template => template.status === 'planned').length,
      strategyWorkspaces: strategyWorkspaces.length,
      backtestWorkspaces: strategyWorkspaces.filter(project => project.capabilityId === 'backtest_review').length,
      dataDependencies: dependencySet.size,
      parameterScans,
      archivedReports,
      activeVersions,
      researchUniverses: research.universes.length,
      trackedSymbols,
      syncedSymbols,
      syncedBars,
    },
    templates,
    workspaces: strategyWorkspaces,
    scanRuns,
    scanJobs,
    research,
    foundation,
    factorCatalog: STRATEGY_FACTOR_CATALOG,
  };
}

export function buildStrategyPrompt(templateId: string, symbol?: string) {
  const template = STRATEGY_TEMPLATES.find(item => item.id === templateId) ?? STRATEGY_TEMPLATES[0];
  const target = symbol?.trim() || template.defaultSymbols[0];
  const capability = getQuantCapability(template.capabilityId);
  return {
    name: `${template.name} · ${target}`,
    prompt: `${template.promptSeed}\n\n策略模板：${template.name}\n目标标的：${target}\n能力模块：${capability.name}\n必须展示参数、数据来源、风险限制和验证结论边界。`,
    capabilityId: capability.id,
  };
}

export async function ingestStrategyUniverseHistory(params: {
  universeId?: string;
  symbols?: string[];
  limit?: number;
  lookbackYears?: number;
  period?: string;
  adjustment?: string;
} = {}): Promise<StrategyHistoryIngestionResult> {
  assertMarketApiEnabled();
  const body = {
    universe_id: params.universeId || SAMPLE_UNIVERSE_ID,
    symbols: params.symbols?.length ? params.symbols : undefined,
    period: params.period || 'daily',
    adjustment: params.adjustment || 'qfq',
    limit: params.limit ?? FALLBACK_RESEARCH_STATE.ingestionPlan.suggestedLimit,
    lookback_years: params.lookbackYears ?? FALLBACK_RESEARCH_STATE.ingestionPlan.lookbackYears,
  };
  const response = await fetch(`${MARKET_API_BASE_URL}/api/v1/ingestion/eastmoney/history`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`market API ${response.status}: ${text.slice(0, 200)}`);
  }
  return response.json() as Promise<StrategyHistoryIngestionResult>;
}

export async function ingestStrategyUniverseHistoryBatch(params: {
  universeId?: string;
  offset?: number;
  batchSize?: number;
  limit?: number;
  lookbackYears?: number;
  start?: string;
  end?: string;
  period?: string;
  adjustment?: string;
  includeValuationFactors?: boolean;
} = {}): Promise<StrategyHistoryIngestionResult> {
  assertMarketApiEnabled();
  const body = {
    universe_id: params.universeId || SAMPLE_UNIVERSE_ID,
    offset: Math.max(0, params.offset ?? 0),
    batch_size: Math.max(1, Math.min(params.batchSize ?? 25, 200)),
    period: params.period || 'daily',
    adjustment: params.adjustment || 'qfq',
    limit: params.limit ?? FALLBACK_RESEARCH_STATE.ingestionPlan.suggestedLimit,
    lookback_years: params.lookbackYears ?? FALLBACK_RESEARCH_STATE.ingestionPlan.lookbackYears,
    start: params.start || undefined,
    end: params.end || undefined,
    include_valuation_factors: params.includeValuationFactors === true,
    request_delay_seconds: 0.2,
  };
  const response = await fetch(`${MARKET_API_BASE_URL}/api/v1/ingestion/baostock/history/batch`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`market API ${response.status}: ${text.slice(0, 200)}`);
  }
  return response.json() as Promise<StrategyHistoryIngestionResult>;
}

export async function startStrategyUniverseHistoryAutoFill(params: {
  universeId?: string;
  offset?: number;
  batchSize?: number;
  limit?: number;
  lookbackYears?: number;
  start?: string;
  end?: string;
  period?: string;
  adjustment?: string;
  maxBatches?: number;
  includeValuationFactors?: boolean;
} = {}): Promise<StrategyAutoFillIngestionStartResult> {
  assertMarketApiEnabled();
  const body = {
    universe_id: params.universeId || SAMPLE_UNIVERSE_ID,
    offset: Math.max(0, params.offset ?? 0),
    batch_size: Math.max(1, Math.min(params.batchSize ?? 25, 200)),
    period: params.period || 'daily',
    adjustment: params.adjustment || 'qfq',
    limit: params.limit ?? FALLBACK_RESEARCH_STATE.ingestionPlan.suggestedLimit,
    lookback_years: params.lookbackYears ?? FALLBACK_RESEARCH_STATE.ingestionPlan.lookbackYears,
    start: params.start || undefined,
    end: params.end || undefined,
    include_valuation_factors: params.includeValuationFactors === true,
    request_delay_seconds: 0.2,
    batch_delay_seconds: 0.2,
    max_batches: params.maxBatches,
  };
  const response = await fetch(`${MARKET_API_BASE_URL}/api/v1/ingestion/baostock/history/autofill`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`market API ${response.status}: ${text.slice(0, 200)}`);
  }
  return response.json() as Promise<StrategyAutoFillIngestionStartResult>;
}

export async function addStrategyUniverseMember(params: {
  universeId?: string;
  query: string;
  syncHistory?: boolean;
}): Promise<StrategyUniverseMemberAddResult> {
  assertMarketApiEnabled();
  const universeId = params.universeId || SAMPLE_UNIVERSE_ID;
  const response = await fetch(
    `${MARKET_API_BASE_URL}/api/v1/research/universes/${encodeURIComponent(universeId)}/members`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: params.query }),
      cache: 'no-store',
    }
  );
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`market API ${response.status}: ${text.slice(0, 200)}`);
  }

  const payload = asRecord(await response.json());
  const member = mapResearchMember(payload.member);
  let ingestion: StrategyHistoryIngestionResult | null = null;
  if (params.syncHistory === true) {
    ingestion = await ingestStrategyUniverseHistory({
      universeId,
      symbols: [member.symbol],
    });
  }

  return {
    universe_id: asString(payload.universe_id, universeId),
    member,
    candidates: Array.isArray(payload.candidates)
      ? payload.candidates.map(candidate => asRecord(candidate)).map(candidate => ({
        symbol: asString(candidate.symbol),
        name: typeof candidate.name === 'string' ? candidate.name : null,
        market: asString(candidate.market, 'UNKNOWN'),
        asset_type: asString(candidate.asset_type, 'stock'),
        secid: asString(candidate.secid),
        source: asString(candidate.source, 'eastmoney'),
      }))
      : [],
    ingestion,
  };
}

export async function getStrategySymbolBars(params: {
  symbol: string;
  timeframe?: string;
  adjustment?: string;
  provider?: string | null;
  limit?: number;
  includeMetadata?: boolean;
}): Promise<StrategyLocalKlineResponse> {
  assertMarketApiEnabled();
  const query = new URLSearchParams({
    timeframe: params.timeframe || 'daily',
    adjustment: params.adjustment || 'qfq',
    limit: String(params.limit ?? 240),
    include_metadata: params.includeMetadata ? 'true' : 'false',
  });
  if (params.provider) query.set('provider', params.provider);
  const response = await fetch(
    `${MARKET_API_BASE_URL}/api/v1/research/bars/${encodeURIComponent(params.symbol)}?${query.toString()}`,
    { cache: 'no-store' }
  );
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`market API ${response.status}: ${text.slice(0, 200)}`);
  }
  return mapLocalKlineResponse(await response.json());
}

export async function getStrategySymbolDividends(params: {
  symbol: string;
  limit?: number;
}): Promise<StrategyDividendEventsResponse> {
  assertMarketApiEnabled();
  const query = new URLSearchParams({
    limit: String(params.limit ?? 20),
  });
  const response = await fetch(
    `${MARKET_API_BASE_URL}/api/v1/events/dividends/${encodeURIComponent(params.symbol)}?${query.toString()}`,
    { cache: 'no-store' }
  );
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`market API ${response.status}: ${text.slice(0, 200)}`);
  }
  return mapDividendEventsResponse(await response.json());
}

export async function getStrategyRealtimeQuote(params: {
  symbol: string;
}): Promise<StrategyRealtimeQuote> {
  const symbol = params.symbol.trim();
  if (!symbol) throw new Error('缺少实时行情标的');
  const payload = await fetchMarketApiJson<unknown>(
    `/api/v1/quotes/realtime/${encodeURIComponent(symbol)}`
  );
  return mapRealtimeQuote(payload);
}

export async function getStrategyIntradayBars(params: {
  symbol: string;
  period?: string;
  limit?: number;
  refresh?: boolean;
}): Promise<StrategyLocalKlineResponse> {
  const symbol = params.symbol.trim();
  if (!symbol) throw new Error('缺少分时行情标的');
  const period = params.period || 'minute1';
  if (!['minute1', 'minute5', 'minute15', 'minute30', 'minute60'].includes(period)) {
    throw new Error(`不支持的分时周期：${period}`);
  }
  const query = new URLSearchParams({
    period,
    adjustment: 'none',
    limit: String(Math.max(1, Math.min(params.limit ?? 241, 1000))),
  });
  if (params.refresh) {
    query.set('refresh', 'true');
  }
  const payload = await fetchMarketApiJson<unknown>(
    `/api/v1/quotes/history/${encodeURIComponent(symbol)}?${query.toString()}`
  );
  return mapLocalKlineResponse(payload);
}

export async function runStrategyParameterScan(params: {
  templateId: string;
  scanId: string;
  symbol?: string;
}): Promise<StrategyScanRun> {
  const template = findTemplate(params.templateId);
  if (!template) {
    throw new Error(`Unknown strategy template: ${params.templateId}`);
  }
  const scan = findScan(template, params.scanId);
  if (!scan) {
    throw new Error(`Unknown parameter scan: ${params.scanId}`);
  }
  const startedAt = new Date().toISOString();
  const symbol = params.symbol?.trim() || template.defaultSymbols[0] || '510300';
  const combinations = expandGrid(scan).slice(0, 64);
  const results: StrategyScanRunResult[] = [];

  if (scan.status !== 'available') {
    const run: StrategyScanRun = {
      id: `scan-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      templateId: template.id,
      scanId: scan.id,
      symbol,
      status: 'failed',
      startedAt,
      completedAt: new Date().toISOString(),
      total: combinations.length,
      succeeded: 0,
      failed: combinations.length,
      bestResultId: null,
      objective: scan.objective,
      source: scan.status === 'planned' ? 'parameter scan is planned' : 'parameter scan is blocked',
      results: combinations.map((parameters, index) => ({
        id: `${scan.id}-${index + 1}`,
        parameters,
        status: 'skipped',
        metrics: {},
        error: scan.status === 'planned' ? '扫描仍在规划中' : '扫描被依赖阻断',
      })),
    };
    await writeScanRun(run);
    return run;
  }

  for (const [index, parameters] of combinations.entries()) {
    const id = `${scan.id}-${index + 1}`;
    if (template.backtestStrategyId === 'ma_crossover' && !isValidMaCrossoverParams(parameters)) {
      results.push({
        id,
        parameters,
        status: 'skipped',
        metrics: {},
        error: 'fast_window 必须小于 slow_window',
      });
      continue;
    }

    try {
      const backtest = await fetchBacktest({
        symbol,
        parameters,
        strategyId: template.backtestStrategyId,
        limit: template.backtestLimit,
      });
      results.push({
        id,
        parameters,
        status: 'success',
        metrics: summarizeBacktest(backtest),
      });
    } catch (error) {
      results.push({
        id,
        parameters,
        status: 'failed',
        metrics: {},
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const best = chooseBestResult(results);
  const succeeded = results.filter(result => result.status === 'success').length;
  const failed = results.filter(result => result.status === 'failed').length;
  const run: StrategyScanRun = {
    id: `scan-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    templateId: template.id,
    scanId: scan.id,
    symbol,
    status: succeeded === 0 ? 'failed' : failed > 0 ? 'partial' : 'completed',
    startedAt,
    completedAt: new Date().toISOString(),
    total: results.length,
    succeeded,
    failed,
    bestResultId: best?.id ?? null,
    objective: scan.objective,
    source: `${MARKET_API_BASE_URL}/api/v1/backtests/strategies/${template.backtestStrategyId}/{symbol}`,
    results,
  };
  await writeScanRun(run);
  return run;
}

async function executeScanJob(job: StrategyScanJob) {
  const runningJob: StrategyScanJob = {
    ...job,
    status: 'running',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    error: null,
  };
  await writeScanJob(runningJob);

  try {
    const run = await runStrategyParameterScan({
      templateId: job.templateId,
      scanId: job.scanId,
      symbol: job.symbol,
    });
    await writeScanJob({
      ...runningJob,
      status: run.status === 'failed' ? 'failed' : 'completed',
      runId: run.id,
      completedAt: run.completedAt,
      updatedAt: new Date().toISOString(),
      error: run.status === 'failed' ? '扫描未产生成功结果' : null,
    });
  } catch (error) {
    await writeScanJob({
      ...runningJob,
      status: 'failed',
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function enqueueStrategyParameterScan(params: {
  templateId: string;
  scanId: string;
  symbol?: string;
}): Promise<StrategyScanJob> {
  const template = findTemplate(params.templateId);
  if (!template) {
    throw new Error(`Unknown strategy template: ${params.templateId}`);
  }
  const scan = findScan(template, params.scanId);
  if (!scan) {
    throw new Error(`Unknown parameter scan: ${params.scanId}`);
  }

  const now = new Date().toISOString();
  const job: StrategyScanJob = {
    id: `scan-job-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    templateId: template.id,
    scanId: scan.id,
    symbol: params.symbol?.trim() || template.defaultSymbols[0] || '510300',
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    runId: null,
    error: null,
  };
  await writeScanJob(job);

  setTimeout(() => {
    void executeScanJob(job);
  }, 0);

  return job;
}
