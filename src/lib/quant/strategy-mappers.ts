import { SAMPLE_UNIVERSE_ID } from './strategy-catalog';
import type {
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

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
      .map(item => String(item).trim())
      .filter(item => item && !['-', '--', '无', '暂无'].includes(item))
    : [];
}

export function asBoolean(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 't', 'yes', 'y'].includes(normalized)) return true;
    if (['0', 'false', 'f', 'no', 'n'].includes(normalized)) return false;
  }
  return null;
}

export function compactUniqueStrings(values: Array<string | null | undefined>): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  values.forEach((value) => {
    const text = value?.trim();
    if (!text || seen.has(text)) return;
    seen.add(text);
    result.push(text);
  });
  return result;
}

export function inferSampleSectorTags(name?: string | null): string[] {
  const value = name ?? '';
  if (/银行/.test(value)) return ['银行'];
  if (/证券|国泰君安|华泰|广发/.test(value)) return ['证券'];
  if (/保险|中国平安|太保/.test(value)) return ['保险'];
  if (/茅台|五粮液|泸州老窖|汾酒|今世缘/.test(value)) return ['白酒'];
  if (/通富|圣邦|紫光|华润微|中芯|韦尔|兆易|卓胜|汇顶/.test(value)) return ['半导体'];
  if (/三七|完美世界|世纪华通|掌趣|昆仑万维/.test(value)) return ['游戏'];
  if (/宁德|比亚迪|电池|先导智能/.test(value)) return ['新能源车'];
  if (/美的|格力|家电|三花/.test(value)) return ['家电'];
  if (/黄金/.test(value)) return ['黄金珠宝'];
  if (/联通|中兴|通信|移远|广和通/.test(value)) return ['通信服务'];
  if (/石油|石化|石化|荣盛石化|东方盛虹/.test(value)) return ['石油石化'];
  if (/医药|恒瑞/.test(value)) return ['医药'];
  if (/电力|长江电力/.test(value)) return ['电力'];
  if (/光伏|隆基/.test(value)) return ['光伏'];
  return [];
}

export function dataStatus(value: unknown): StrategyUniverseMember['dataStatus'] {
  return value === 'ready' || value === 'stale' || value === 'missing' ? value : 'missing';
}

export function trendStatus(value: unknown): StrategyUniverseMember['trendStatus'] {
  return value === 'bullish' || value === 'bearish' || value === 'sideways' || value === 'insufficient'
    ? value
    : 'insufficient';
}

export function mapResearchMember(value: unknown): StrategyUniverseMember {
  const record = asRecord(value);
  const concepts = asStringArray(record.concepts);
  const sectorTags = asStringArray(record.sector_tags);
  const industry = typeof record.industry === 'string' ? record.industry : null;
  const region = typeof record.region === 'string' ? record.region : null;
  const sectorHint = typeof record.sector_hint === 'string' ? record.sector_hint : null;
  const name = typeof record.name === 'string' ? record.name : null;
  return {
    symbol: asString(record.symbol),
    code: asString(record.code),
    name,
    industry,
    region,
    concepts,
    sectorHint,
    sectorTags: sectorTags.length
      ? sectorTags
      : compactUniqueStrings([industry, ...concepts.slice(0, 3), region, ...inferSampleSectorTags(name)]),
    exchange: asString(record.exchange, 'UNKNOWN'),
    assetType: asString(record.asset_type, 'stock'),
    currency: asString(record.currency, 'CNY'),
    timezone: asString(record.timezone, 'Asia/Shanghai'),
    secid: typeof record.secid === 'string' ? record.secid : null,
    provider: asString(record.provider, 'eastmoney'),
    securityStatus: asString(record.security_status, 'active'),
    role: asString(record.role, 'member'),
    weight: asNumber(record.weight),
    rowCount: asNumber(record.row_count) ?? 0,
    firstTs: typeof record.first_ts === 'string' ? record.first_ts : null,
    lastTs: typeof record.last_ts === 'string' ? record.last_ts : null,
    dataProvider: typeof record.data_provider === 'string' ? record.data_provider : null,
    latestClose: asNumber(record.latest_close),
    latestChangePct: asNumber(record.latest_change_pct),
    latestAmount: asNumber(record.latest_amount),
    latestTurnover: asNumber(record.latest_turnover),
    strength20dPct: asNumber(record.strength_20d_pct),
    strength60dPct: asNumber(record.strength_60d_pct),
    ma20: asNumber(record.ma20),
    ma60: asNumber(record.ma60),
    trendStatus: trendStatus(record.trend_status),
    avgAmount20d: asNumber(record.avg_amount_20d),
    avgVolume20d: asNumber(record.avg_volume_20d),
    avgTurnover20d: asNumber(record.avg_turnover_20d),
    tradeStatus: typeof record.trade_status === 'string' ? record.trade_status : null,
    isSt: asBoolean(record.is_st),
    limitUp: asBoolean(record.limit_up),
    limitDown: asBoolean(record.limit_down),
    peTtm: asNumber(record.pe_ttm),
    pbMrq: asNumber(record.pb_mrq),
    psTtm: asNumber(record.ps_ttm),
    pcfNcfTtm: asNumber(record.pcf_ncf_ttm),
    dataStatus: dataStatus(record.data_status),
  };
}

export function mapResearchUniverse(value: unknown): StrategyUniverse {
  const record = asRecord(value);
  const members = Array.isArray(record.members) ? record.members.map(mapResearchMember) : [];
  return {
    id: asString(record.id, SAMPLE_UNIVERSE_ID),
    name: asString(record.name, 'A 股股票池'),
    description: typeof record.description === 'string' ? record.description : null,
    status: asString(record.status, 'active'),
    source: asString(record.source, 'seed'),
    tags: asStringArray(record.tags),
    defaultTimeframe: asString(record.default_timeframe, 'daily'),
    defaultAdjustment: asString(record.default_adjustment, 'qfq'),
    provider: asString(record.provider, 'eastmoney'),
    members,
    memberCount: asNumber(record.member_count) ?? members.length,
    stockCount: asNumber(record.stock_count) ?? 0,
    etfCount: asNumber(record.etf_count) ?? 0,
    indexCount: asNumber(record.index_count) ?? 0,
    fundCount: asNumber(record.fund_count) ?? 0,
    readyCount: asNumber(record.ready_count) ?? 0,
    barCount: asNumber(record.bar_count) ?? 0,
    latestTs: typeof record.latest_ts === 'string' ? record.latest_ts : null,
  };
}

export function mapResearchUniverseMembersPage(
  value: unknown,
  fallbackUniverseId: string,
  fallbackPage: number,
  fallbackPageSize: number
): StrategyUniverseMembersPage {
  const record = asRecord(value);
  const members = Array.isArray(record.members) ? record.members.map(mapResearchMember) : [];
  const total = asNumber(record.total) ?? members.length;
  const pageSize = asNumber(record.page_size) ?? fallbackPageSize;
  return {
    universeId: asString(record.universe_id, fallbackUniverseId),
    page: asNumber(record.page) ?? fallbackPage,
    pageSize,
    total,
    totalPages: asNumber(record.total_pages) ?? Math.max(1, Math.ceil(total / pageSize)),
    keyword: typeof record.keyword === 'string' ? record.keyword : null,
    members,
    fetchedAt: asString(record.fetched_at, new Date().toISOString()),
  };
}

export function screenerMode(value: unknown): StrategyScreenerMode {
  return value === 'limit_up_relay' || value === 'trend_liquidity' || value === 'short_term'
    ? value
    : 'short_term';
}

export function mapScreenerCandidate(value: unknown): StrategyScreenerCandidate {
  const record = asRecord(value);
  return {
    symbol: asString(record.symbol),
    code: asString(record.code),
    name: typeof record.name === 'string' ? record.name : null,
    exchange: asString(record.exchange, 'UNKNOWN'),
    sectorTags: asStringArray(record.sector_tags),
    tradeDate: asString(record.trade_date),
    close: asNumber(record.close),
    open: asNumber(record.open),
    high: asNumber(record.high),
    low: asNumber(record.low),
    previousClose: asNumber(record.previous_close),
    changePercent: asNumber(record.change_percent),
    amount: asNumber(record.amount),
    turnover: asNumber(record.turnover),
    ma5: asNumber(record.ma5),
    ma10: asNumber(record.ma10),
    ma20: asNumber(record.ma20),
    ma30: asNumber(record.ma30),
    ma60: asNumber(record.ma60),
    strength20dPct: asNumber(record.strength_20d_pct),
    amountRatio20d: asNumber(record.amount_ratio_20d),
    limitUpCount4d: asNumber(record.limit_up_count_4d) ?? 0,
    limitUpCount10d: asNumber(record.limit_up_count_10d) ?? 0,
    latestLimitUpDate: typeof record.latest_limit_up_date === 'string' ? record.latest_limit_up_date : null,
    isLimitUp: asBoolean(record.is_limit_up),
    isSt: asBoolean(record.is_st),
    sampleCount: asNumber(record.sample_count) ?? 0,
    score: asNumber(record.score),
    signals: asStringArray(record.signals),
    warnings: asStringArray(record.warnings),
    missingFields: asStringArray(record.missing_fields),
  };
}

export function mapAnalyticsExecutionMetadata(value: unknown, fallbackBasis: string): StrategyAnalyticsExecutionMetadata {
  const record = asRecord(value);
  const engine = record.engine === 'clickhouse' ? 'clickhouse' : 'timescaledb';
  const status =
    record.status === 'hit' ||
    record.status === 'fallback' ||
    record.status === 'disabled' ||
    record.status === 'error'
      ? record.status
      : engine === 'clickhouse'
        ? 'hit'
        : 'fallback';
  const autoSyncStatus =
    record.auto_sync_status === 'synced' ||
    record.auto_sync_status === 'skipped' ||
    record.auto_sync_status === 'error'
      ? record.auto_sync_status
      : 'not_needed';
  return {
    engine,
    status,
    basis: asString(record.basis, fallbackBasis),
    targetTradeDate: typeof record.target_trade_date === 'string' ? record.target_trade_date : null,
    clickhouseTradeDate: typeof record.clickhouse_trade_date === 'string' ? record.clickhouse_trade_date : null,
    autoSyncStatus,
    autoSyncRowsWritten: asNumber(record.auto_sync_rows_written) ?? 0,
    message: typeof record.message === 'string' ? record.message : null,
  };
}

export function mapScreenerResponse(value: unknown): StrategyScreenerResponse {
  const record = asRecord(value);
  const candidates = Array.isArray(record.candidates)
    ? record.candidates.map(mapScreenerCandidate)
    : [];
  const dataBasis = asString(record.data_basis, 'timescaledb.stock_bars');
  return {
    universeId: asString(record.universe_id, SAMPLE_UNIVERSE_ID),
    mode: screenerMode(record.mode),
    tradeDate: typeof record.trade_date === 'string' ? record.trade_date : null,
    timeframe: asString(record.timeframe, 'daily'),
    adjustment: asString(record.adjustment, 'qfq'),
    scannedSymbols: asNumber(record.scanned_symbols) ?? 0,
    totalCandidates: asNumber(record.total_candidates) ?? candidates.length,
    limit: asNumber(record.limit) ?? candidates.length,
    candidates,
    dataBasis,
    analytics: mapAnalyticsExecutionMetadata(record.analytics, dataBasis),
    source: asString(record.source, 'quantpilot-market-api'),
    notes: asStringArray(record.notes),
    cacheStatus: asString(record.cache_status, 'bypass'),
    cacheTtlSeconds: asNumber(record.cache_ttl_seconds),
    fetchedAt: asString(record.fetched_at, new Date().toISOString()),
  };
}

export function mapCoverageItem(value: unknown): StrategyDataCoverageItem {
  const record = asRecord(value);
  return {
    symbol: asString(record.symbol),
    name: typeof record.name === 'string' ? record.name : null,
    timeframe: asString(record.timeframe, 'daily'),
    adjustment: asString(record.adjustment, 'qfq'),
    provider: asString(record.provider, 'eastmoney'),
    firstTs: typeof record.first_ts === 'string' ? record.first_ts : null,
    lastTs: typeof record.last_ts === 'string' ? record.last_ts : null,
    rowCount: asNumber(record.row_count) ?? 0,
    dataStatus: dataStatus(record.data_status),
  };
}

export function mapLocalKlineBar(value: unknown): StrategyLocalKlineBar {
  const record = asRecord(value);
  const metadata = asRecord(record.metadata);
  return {
    ts: asString(record.ts, asString(record.date)),
    open: asNumber(record.open) ?? 0,
    high: asNumber(record.high) ?? 0,
    low: asNumber(record.low) ?? 0,
    close: asNumber(record.close) ?? 0,
    previousClose: asNumber(record.previous_close),
    volume: asNumber(record.volume) ?? 0,
    amount: asNumber(record.amount),
    amplitude: asNumber(record.amplitude),
    changePercent: asNumber(record.change_percent),
    changeAmount: asNumber(record.change_amount),
    turnover: asNumber(record.turnover),
    tradeStatus: typeof record.trade_status === 'string' ? record.trade_status : null,
    isSt: asBoolean(record.is_st),
    limitUp: asBoolean(record.limit_up),
    limitDown: asBoolean(record.limit_down),
    provider: asString(record.provider, asString(record.source, asString(metadata.source, 'unknown'))),
    metadata: Object.keys(metadata).length ? metadata : undefined,
  };
}

export function mapDividendEvent(value: unknown): StrategyDividendEvent {
  const record = asRecord(value);
  return {
    symbol: asString(record.symbol),
    name: typeof record.name === 'string' ? record.name : null,
    reportDate: typeof record.report_date === 'string' ? record.report_date : null,
    planNoticeDate: typeof record.plan_notice_date === 'string' ? record.plan_notice_date : null,
    equityRecordDate: typeof record.equity_record_date === 'string' ? record.equity_record_date : null,
    exDividendDate: typeof record.ex_dividend_date === 'string' ? record.ex_dividend_date : null,
    noticeDate: typeof record.notice_date === 'string' ? record.notice_date : null,
    assignProgress: typeof record.assign_progress === 'string' ? record.assign_progress : null,
    planProfile: typeof record.plan_profile === 'string' ? record.plan_profile : null,
    pretaxBonusRmb: asNumber(record.pretax_bonus_rmb),
    bonusRatio: asNumber(record.bonus_ratio),
    transferRatio: asNumber(record.transfer_ratio),
    dividendYield: asNumber(record.dividend_yield),
  };
}

export function mapDividendEventsResponse(value: unknown): StrategyDividendEventsResponse {
  const record = asRecord(value);
  return {
    symbol: asString(record.symbol),
    events: Array.isArray(record.events) ? record.events.map(mapDividendEvent) : [],
    source: asString(record.source, 'eastmoney'),
    fetchedAt: asString(record.fetched_at, new Date().toISOString()),
  };
}

export function mapSectorCapitalFlowItem(value: unknown): StrategySectorCapitalFlowItem {
  const record = asRecord(value);
  const signal = asString(record.signal, 'insufficient');
  return {
    sector: asString(record.sector),
    memberCount: asNumber(record.member_count) ?? 0,
    coveredCount: asNumber(record.covered_count) ?? 0,
    risingCount: asNumber(record.rising_count) ?? 0,
    fallingCount: asNumber(record.falling_count) ?? 0,
    limitUpCount: asNumber(record.limit_up_count) ?? 0,
    limitDownCount: asNumber(record.limit_down_count) ?? 0,
    risingRatio: asNumber(record.rising_ratio),
    latestAmount: asNumber(record.latest_amount),
    avgAmount20d: asNumber(record.avg_amount_20d),
    amountRatio20d: asNumber(record.amount_ratio_20d),
    avgTurnover20d: asNumber(record.avg_turnover_20d),
    strength20dPct: asNumber(record.strength_20d_pct),
    strength5dPct: asNumber(record.strength_5d_pct),
    contributionRatio: asNumber(record.contribution_ratio),
    netAmountRatio: asNumber(record.net_amount_ratio),
    proxyNetAmount: asNumber(record.proxy_net_amount),
    signal: signal === 'warming' || signal === 'cooling' || signal === 'neutral' || signal === 'insufficient'
      ? signal
      : 'insufficient',
    topSymbols: Array.isArray(record.top_symbols) ? record.top_symbols.map(String).filter(Boolean) : [],
    dataBasis: asString(record.data_basis, 'stock_bars_proxy'),
  };
}

export function mapSectorCapitalFlowMarketSummary(value: unknown): StrategySectorCapitalFlowMarketSummary | null {
  const record = asRecord(value);
  if (!Object.keys(record).length) return null;
  return {
    sectorCount: asNumber(record.sector_count) ?? 0,
    warmingCount: asNumber(record.warming_count) ?? 0,
    coolingCount: asNumber(record.cooling_count) ?? 0,
    neutralCount: asNumber(record.neutral_count) ?? 0,
    insufficientCount: asNumber(record.insufficient_count) ?? 0,
    coveredSymbolCount: asNumber(record.covered_symbol_count) ?? 0,
    totalLatestAmount: asNumber(record.total_latest_amount),
    proxyNetAmount: asNumber(record.proxy_net_amount),
    risingRatio: asNumber(record.rising_ratio),
    amountRatio20d: asNumber(record.amount_ratio_20d),
    avgTurnover20d: asNumber(record.avg_turnover_20d),
    strongestSectors: Array.isArray(record.strongest_sectors) ? record.strongest_sectors.map(String).filter(Boolean) : [],
    weakestSectors: Array.isArray(record.weakest_sectors) ? record.weakest_sectors.map(String).filter(Boolean) : [],
    analysis: Array.isArray(record.analysis) ? record.analysis.map(String).filter(Boolean) : [],
  };
}

export function mapSectorCapitalFlowTrendPoint(value: unknown): StrategySectorCapitalFlowTrendPoint {
  const record = asRecord(value);
  return {
    tradeDate: asString(record.trade_date),
    latestAmount: asNumber(record.latest_amount),
    proxyNetAmount: asNumber(record.proxy_net_amount),
    risingRatio: asNumber(record.rising_ratio),
    amountRatio20d: asNumber(record.amount_ratio_20d),
    limitUpCount: asNumber(record.limit_up_count) ?? 0,
  };
}

export function mapSectorCapitalFlowMember(value: unknown): StrategySectorCapitalFlowMember {
  const record = asRecord(value);
  return {
    symbol: asString(record.symbol),
    name: typeof record.name === 'string' ? record.name : null,
    latestAmount: asNumber(record.latest_amount),
    proxyNetAmount: asNumber(record.proxy_net_amount),
    latestChangePercent: asNumber(record.latest_change_percent),
    strength20dPct: asNumber(record.strength_20d_pct),
    turnover: asNumber(record.turnover),
    limitUp: asBoolean(record.limit_up),
  };
}

export function mapSectorCapitalFlowDetail(value: unknown): StrategySectorCapitalFlowDetail | null {
  const record = asRecord(value);
  if (!Object.keys(record).length) return null;
  return {
    sector: asString(record.sector),
    item: mapSectorCapitalFlowItem(record.item),
    trend: Array.isArray(record.trend) ? record.trend.map(mapSectorCapitalFlowTrendPoint) : [],
    topMembers: Array.isArray(record.top_members) ? record.top_members.map(mapSectorCapitalFlowMember) : [],
    analysis: Array.isArray(record.analysis) ? record.analysis.map(String).filter(Boolean) : [],
  };
}

export function mapSectorCapitalFlowResponse(value: unknown): StrategySectorCapitalFlowResponse {
  const record = asRecord(value);
  return {
    universeId: asString(record.universe_id),
    items: Array.isArray(record.items) ? record.items.map(mapSectorCapitalFlowItem) : [],
    marketSummary: mapSectorCapitalFlowMarketSummary(record.market_summary),
    detail: mapSectorCapitalFlowDetail(record.detail),
    source: asString(record.source, 'timescaledb'),
    proxyNote: asString(record.proxy_note),
    cacheStatus: asString(record.cache_status, 'bypass'),
    cacheTtlSeconds: asNumber(record.cache_ttl_seconds),
    fetchedAt: asString(record.fetched_at, new Date().toISOString()),
  };
}

export function mapLocalKlineResponse(value: unknown): StrategyLocalKlineResponse {
  const record = asRecord(value);
  const summary = asRecord(record.summary);
  const bars = Array.isArray(record.bars) ? record.bars.map(mapLocalKlineBar) : [];
  const firstBar = bars[0] ?? null;
  const latestBar = bars.at(-1) ?? null;
  const previousBar = bars.at(-2) ?? null;
  const timeframe = asString(record.timeframe, asString(record.period, 'daily'));
  const isIntraday = timeframe.startsWith('minute');
  const previousClose = asNumber(summary.previous_close) ??
    latestBar?.previousClose ??
    (isIntraday ? null : previousBar?.close ?? null);
  const amountValues = bars.map((bar) => bar.amount).filter((value): value is number => typeof value === 'number');
  return {
    symbol: asString(record.symbol),
    code: typeof record.code === 'string' ? record.code : null,
    name: typeof record.name === 'string' ? record.name : null,
    exchange: asString(record.exchange, asString(record.market, 'UNKNOWN')),
    assetType: asString(record.asset_type, 'stock'),
    currency: asString(record.currency, 'CNY'),
    timezone: asString(record.timezone, 'Asia/Shanghai'),
    secid: typeof record.secid === 'string' ? record.secid : null,
    provider: typeof record.provider === 'string' ? record.provider : asString(record.source, '') || null,
    dataProvider: latestBar?.provider ?? null,
    timeframe,
    adjustment: asString(record.adjustment, 'qfq'),
    bars,
    summary: {
      rowCount: asNumber(summary.row_count) ?? bars.length,
      firstTs: typeof summary.first_ts === 'string' ? summary.first_ts : firstBar?.ts ?? null,
      lastTs: typeof summary.last_ts === 'string' ? summary.last_ts : latestBar?.ts ?? null,
      latestClose: asNumber(summary.latest_close) ?? latestBar?.close ?? null,
      previousClose,
      returnPct: asNumber(summary.return_pct) ??
        (latestBar && previousClose && previousClose !== 0 ? ((latestBar.close - previousClose) / previousClose) * 100 : null),
      high: asNumber(summary.high) ?? (bars.length ? Math.max(...bars.map((bar) => bar.high)) : null),
      low: asNumber(summary.low) ?? (bars.length ? Math.min(...bars.map((bar) => bar.low)) : null),
      totalVolume: asNumber(summary.total_volume) ?? bars.reduce((sum, bar) => sum + bar.volume, 0),
      totalAmount: asNumber(summary.total_amount) ?? (amountValues.length ? amountValues.reduce((sum, value) => sum + value, 0) : null),
    },
    fetchedAt: asString(record.fetched_at, new Date().toISOString()),
  };
}

export function mapRealtimeQuote(value: unknown): StrategyRealtimeQuote {
  const record = asRecord(value);
  const fetchInfo = asRecord(record.fetch);
  const dataQuality = asRecord(record.data_quality);
  return {
    symbol: asString(record.symbol),
    secid: typeof record.secid === 'string' ? record.secid : null,
    name: typeof record.name === 'string' ? record.name : null,
    assetType: asString(record.asset_type, 'stock'),
    market: asString(record.market, 'UNKNOWN'),
    source: asString(record.source, 'unknown'),
    currency: asString(record.currency, 'CNY'),
    timezone: asString(record.timezone, 'Asia/Shanghai'),
    price: asNumber(record.price),
    open: asNumber(record.open),
    high: asNumber(record.high),
    low: asNumber(record.low),
    previousClose: asNumber(record.previous_close),
    changePercent: asNumber(record.change_percent),
    changeAmount: asNumber(record.change_amount),
    amplitude: asNumber(record.amplitude),
    turnover: asNumber(record.turnover),
    volume: asNumber(record.volume),
    amount: asNumber(record.amount),
    marketCap: asNumber(record.market_cap),
    floatMarketCap: asNumber(record.float_market_cap),
    peTtm: asNumber(record.pe_ttm),
    pbMrq: asNumber(record.pb_mrq),
    industry: typeof record.industry === 'string' ? record.industry : null,
    region: typeof record.region === 'string' ? record.region : null,
    concepts: asStringArray(record.concepts),
    quoteTime: typeof record.quote_time === 'string' ? record.quote_time : null,
    asOf: typeof record.as_of === 'string' ? record.as_of : null,
    fetchedAt: asString(record.fetched_at, new Date().toISOString()),
    cacheStatus: typeof fetchInfo.cache_status === 'string' ? fetchInfo.cache_status : null,
    cacheTtlSeconds: asNumber(fetchInfo.cache_ttl_seconds),
    dataQualityStatus: typeof dataQuality.status === 'string' ? dataQuality.status : null,
  };
}

export function mapIngestionJob(value: unknown): StrategyIngestionJob {
  const record = asRecord(value);
  const metadata = asRecord(record.metadata);
  return {
    id: asString(record.id),
    universeId: typeof record.universe_id === 'string' ? record.universe_id : null,
    provider: asString(record.provider, 'unknown'),
    timeframe: asString(record.timeframe, 'daily'),
    adjustment: asString(record.adjustment, 'qfq'),
    status: asString(record.status, 'unknown'),
    totalSymbols: asNumber(record.total_symbols) ?? 0,
    completedSymbols: asNumber(record.completed_symbols) ?? 0,
    failedSymbols: asNumber(record.failed_symbols) ?? 0,
    rowsReceived: asNumber(record.rows_received) ?? 0,
    rowsUpserted: asNumber(record.rows_upserted) ?? 0,
    error: typeof record.error === 'string' ? record.error : null,
    metadata,
    batchOffset: asNumber(metadata.batch_offset),
    batchSize: asNumber(metadata.batch_size),
    nextOffset: asNumber(metadata.next_offset),
    universeTotalSymbols: asNumber(metadata.universe_total_symbols),
    startedAt: typeof record.started_at === 'string' ? record.started_at : null,
    completedAt: typeof record.completed_at === 'string' ? record.completed_at : null,
    createdAt: asString(record.created_at, new Date().toISOString()),
    updatedAt: asString(record.updated_at, new Date().toISOString()),
  };
}

export function mapIngestionJobsResponse(value: unknown): StrategyIngestionJobsResponse {
  const record = asRecord(value);
  return {
    jobs: Array.isArray(record.jobs) ? record.jobs.map(mapIngestionJob) : [],
    fetchedAt: asString(record.fetched_at, new Date().toISOString()),
  };
}

export function foundationStatus(value: unknown): StrategyFoundationComponent['status'] {
  return value === 'ready' || value === 'partial' || value === 'missing' ? value : 'partial';
}

export function mapFoundationComponent(value: unknown): StrategyFoundationComponent {
  const record = asRecord(value);
  return {
    id: asString(record.id),
    name: asString(record.name),
    status: foundationStatus(record.status),
    count: asNumber(record.count) ?? 0,
    detail: typeof record.detail === 'string' ? record.detail : null,
  };
}

export function mapFactorDefinition(value: unknown): StrategyFactorDefinition {
  const record = asRecord(value);
  return {
    factorKey: asString(record.factor_key),
    name: asString(record.name),
    category: asString(record.category, 'unknown'),
    frequency: asString(record.frequency, 'daily'),
    valueType: asString(record.value_type, 'number'),
    unit: typeof record.unit === 'string' ? record.unit : null,
    description: asString(record.description),
    formula: typeof record.formula === 'string' ? record.formula : null,
    dependencies: asStringArray(record.dependencies),
    status: asString(record.status, 'active'),
    provider: asString(record.provider, 'quantpilot'),
    metadata: asRecord(record.metadata),
    updatedAt: typeof record.updated_at === 'string' ? record.updated_at : null,
  };
}

export function mapTradingCalendarDay(value: unknown): StrategyTradingCalendarDay {
  const record = asRecord(value);
  return {
    market: asString(record.market, 'CN-A'),
    tradeDate: asString(record.trade_date),
    isOpen: record.is_open !== false,
    session: asString(record.session, 'regular'),
    source: asString(record.source, 'local'),
    metadata: asRecord(record.metadata),
  };
}

export function dataQualityIssueSeverity(value: unknown): StrategyDataQualityIssue['severity'] {
  return value === 'ok' || value === 'warning' || value === 'error' ? value : 'warning';
}

export function mapDataQualityIssue(value: unknown): StrategyDataQualityIssue {
  const record = asRecord(value);
  return {
    symbol: typeof record.symbol === 'string' ? record.symbol : null,
    name: typeof record.name === 'string' ? record.name : null,
    severity: dataQualityIssueSeverity(record.severity),
    issueType: asString(record.issue_type, 'unknown'),
    message: asString(record.message),
    metrics: asRecord(record.metrics),
  };
}

export function mapDataQualityScan(value: unknown): StrategyDataQualityScan {
  const record = asRecord(value);
  return {
    id: asString(record.id),
    universeId: typeof record.universe_id === 'string' ? record.universe_id : null,
    symbol: typeof record.symbol === 'string' ? record.symbol : null,
    scope: asString(record.scope, 'universe'),
    timeframe: asString(record.timeframe, 'daily'),
    adjustment: asString(record.adjustment, 'qfq'),
    status: asString(record.status, 'completed'),
    severity: dataQualityIssueSeverity(record.severity),
    checkedSymbols: asNumber(record.checked_symbols) ?? 0,
    passedSymbols: asNumber(record.passed_symbols) ?? 0,
    warningSymbols: asNumber(record.warning_symbols) ?? 0,
    failedSymbols: asNumber(record.failed_symbols) ?? 0,
    checkedRows: asNumber(record.checked_rows) ?? 0,
    issueCount: asNumber(record.issue_count) ?? 0,
    issues: Array.isArray(record.issues) ? record.issues.map(mapDataQualityIssue) : [],
    metrics: asRecord(record.metrics),
    startedAt: asString(record.started_at, new Date().toISOString()),
    completedAt: asString(record.completed_at, new Date().toISOString()),
  };
}

export function mapIngestionJobControlResult(value: unknown): StrategyIngestionJobControlResult {
  const record = asRecord(value);
  const action = asString(record.action);
  return {
    jobId: asString(record.job_id),
    action: action === 'pause' || action === 'resume' || action === 'stop' ? action : 'pause',
    status: asString(record.status, 'unknown'),
    control: asString(record.control, 'unknown'),
    updatedAt: asString(record.updated_at, new Date().toISOString()),
  };
}
