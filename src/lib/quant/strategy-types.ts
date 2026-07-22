import type { QuantCapabilityId } from '@/lib/domains/finance/capabilities';

export type StrategyStatus = 'ready' | 'planned' | 'research';
export type StrategyRiskLevel = 'low' | 'medium' | 'high';
export type StrategyTemplateKind = 'stock_selection' | 'trade_price';

export interface StrategyRule {
  label: string;
  description: string;
  dataStatus?: 'ready' | 'needs_data' | 'manual';
}

export interface StrategyDataReadiness {
  ready: string[];
  missing: string[];
  notes: string[];
}

export interface StrategyParameter {
  key: string;
  label: string;
  value: string | number;
  unit?: string;
  description: string;
}

export interface StrategyParameterScan {
  id: string;
  name: string;
  status: 'available' | 'planned' | 'blocked';
  objective: string;
  grid: Array<{
    key: string;
    values: Array<string | number>;
    unit?: string;
  }>;
  metrics: string[];
  guardrails: string[];
  sampleSize: number;
}

export interface StrategyVersionRecord {
  version: string;
  status: 'active' | 'draft' | 'archived';
  updatedAt: string;
  changes: string[];
  parameterSnapshot: Record<string, string | number>;
}

export interface StrategyBacktestArchive {
  id: string;
  title: string;
  status: 'available' | 'pending' | 'missing';
  symbol: string;
  period: string;
  metrics: {
    totalReturnPct?: number;
    maxDrawdownPct?: number;
    winRatePct?: number;
    tradeCount?: number;
  };
  source: string;
  linkedWorkspaceId?: string;
  limitations: string[];
}

export interface StrategyScanRunResult {
  id: string;
  parameters: Record<string, string | number>;
  status: 'success' | 'failed' | 'skipped';
  metrics: {
    totalReturnPct?: number | null;
    maxDrawdownPct?: number | null;
    winRatePct?: number | null;
    tradeCount?: number | null;
    sharpe?: number | null;
  };
  error?: string;
}

export interface StrategyScanRun {
  id: string;
  templateId: string;
  scanId: string;
  symbol: string;
  status: 'completed' | 'failed' | 'partial';
  startedAt: string;
  completedAt: string;
  total: number;
  succeeded: number;
  failed: number;
  bestResultId?: string | null;
  objective: string;
  source: string;
  results: StrategyScanRunResult[];
}

export interface StrategyScanJob {
  id: string;
  templateId: string;
  scanId: string;
  symbol: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  runId?: string | null;
  error?: string | null;
}

export interface StrategyUniverseMember {
  symbol: string;
  code: string;
  name?: string | null;
  industry?: string | null;
  region?: string | null;
  concepts: string[];
  sectorHint?: string | null;
  sectorTags: string[];
  exchange: string;
  assetType: string;
  currency: string;
  timezone: string;
  secid?: string | null;
  provider: string;
  securityStatus: string;
  role: string;
  weight?: number | null;
  rowCount: number;
  firstTs?: string | null;
  lastTs?: string | null;
  dataProvider?: string | null;
  latestClose?: number | null;
  latestChangePct?: number | null;
  latestAmount?: number | null;
  latestTurnover?: number | null;
  strength20dPct?: number | null;
  strength60dPct?: number | null;
  ma20?: number | null;
  ma60?: number | null;
  trendStatus: 'bullish' | 'bearish' | 'sideways' | 'insufficient';
  avgAmount20d?: number | null;
  avgVolume20d?: number | null;
  avgTurnover20d?: number | null;
  tradeStatus?: string | null;
  isSt?: boolean | null;
  limitUp?: boolean | null;
  limitDown?: boolean | null;
  peTtm?: number | null;
  pbMrq?: number | null;
  psTtm?: number | null;
  pcfNcfTtm?: number | null;
  dataStatus: 'ready' | 'missing' | 'stale';
}

export interface StrategyUniverse {
  id: string;
  name: string;
  description?: string | null;
  status: string;
  source: string;
  tags: string[];
  defaultTimeframe: string;
  defaultAdjustment: string;
  provider: string;
  members: StrategyUniverseMember[];
  memberCount: number;
  stockCount: number;
  etfCount: number;
  indexCount: number;
  fundCount: number;
  readyCount: number;
  barCount: number;
  latestTs?: string | null;
}

export interface StrategyUniverseMembersPage {
  universeId: string;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  keyword?: string | null;
  members: StrategyUniverseMember[];
  fetchedAt: string;
}

export type StrategyScreenerMode = 'short_term' | 'limit_up_relay' | 'trend_liquidity';

export interface StrategyScreenerCandidate {
  symbol: string;
  code: string;
  name?: string | null;
  exchange: string;
  sectorTags: string[];
  tradeDate: string;
  close?: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  previousClose?: number | null;
  changePercent?: number | null;
  amount?: number | null;
  turnover?: number | null;
  ma5?: number | null;
  ma10?: number | null;
  ma20?: number | null;
  ma30?: number | null;
  ma60?: number | null;
  strength20dPct?: number | null;
  amountRatio20d?: number | null;
  limitUpCount4d: number;
  limitUpCount10d: number;
  latestLimitUpDate?: string | null;
  isLimitUp?: boolean | null;
  isSt?: boolean | null;
  sampleCount: number;
  score?: number | null;
  signals: string[];
  warnings: string[];
  missingFields: string[];
}

export interface StrategyAnalyticsExecutionMetadata {
  engine: 'clickhouse' | 'timescaledb';
  status: 'hit' | 'fallback' | 'disabled' | 'error';
  basis: string;
  targetTradeDate?: string | null;
  clickhouseTradeDate?: string | null;
  autoSyncStatus: 'not_needed' | 'synced' | 'skipped' | 'error';
  autoSyncRowsWritten: number;
  message?: string | null;
}

export interface StrategyScreenerResponse {
  universeId: string;
  mode: StrategyScreenerMode;
  tradeDate?: string | null;
  timeframe: string;
  adjustment: string;
  scannedSymbols: number;
  totalCandidates: number;
  limit: number;
  candidates: StrategyScreenerCandidate[];
  dataBasis: string;
  analytics: StrategyAnalyticsExecutionMetadata;
  source: string;
  notes: string[];
  cacheStatus: string;
  cacheTtlSeconds?: number | null;
  fetchedAt: string;
}

export interface StrategyDataCoverageItem {
  symbol: string;
  name?: string | null;
  timeframe: string;
  adjustment: string;
  provider: string;
  firstTs?: string | null;
  lastTs?: string | null;
  rowCount: number;
  dataStatus: 'ready' | 'missing' | 'stale';
}

export interface StrategyLocalKlineBar {
  ts: string;
  open: number;
  high: number;
  low: number;
  close: number;
  previousClose?: number | null;
  volume: number;
  amount?: number | null;
  amplitude?: number | null;
  changePercent?: number | null;
  changeAmount?: number | null;
  turnover?: number | null;
  tradeStatus?: string | null;
  isSt?: boolean | null;
  limitUp?: boolean | null;
  limitDown?: boolean | null;
  provider: string;
  metadata?: Record<string, unknown>;
}

export interface StrategyDividendEvent {
  symbol: string;
  name?: string | null;
  reportDate?: string | null;
  planNoticeDate?: string | null;
  equityRecordDate?: string | null;
  exDividendDate?: string | null;
  noticeDate?: string | null;
  assignProgress?: string | null;
  planProfile?: string | null;
  pretaxBonusRmb?: number | null;
  bonusRatio?: number | null;
  transferRatio?: number | null;
  dividendYield?: number | null;
}

export interface StrategyDividendEventsResponse {
  symbol: string;
  events: StrategyDividendEvent[];
  source: string;
  fetchedAt: string;
}

export interface StrategySectorCapitalFlowItem {
  sector: string;
  memberCount: number;
  coveredCount: number;
  risingCount: number;
  fallingCount: number;
  limitUpCount: number;
  limitDownCount: number;
  risingRatio?: number | null;
  latestAmount?: number | null;
  avgAmount20d?: number | null;
  amountRatio20d?: number | null;
  avgTurnover20d?: number | null;
  strength20dPct?: number | null;
  strength5dPct?: number | null;
  contributionRatio?: number | null;
  netAmountRatio?: number | null;
  proxyNetAmount?: number | null;
  signal: 'warming' | 'cooling' | 'neutral' | 'insufficient';
  topSymbols: string[];
  dataBasis: string;
}

export interface StrategySectorCapitalFlowMarketSummary {
  sectorCount: number;
  warmingCount: number;
  coolingCount: number;
  neutralCount: number;
  insufficientCount: number;
  coveredSymbolCount: number;
  totalLatestAmount?: number | null;
  proxyNetAmount?: number | null;
  risingRatio?: number | null;
  amountRatio20d?: number | null;
  avgTurnover20d?: number | null;
  strongestSectors: string[];
  weakestSectors: string[];
  analysis: string[];
}

export interface StrategySectorCapitalFlowTrendPoint {
  tradeDate: string;
  latestAmount?: number | null;
  proxyNetAmount?: number | null;
  risingRatio?: number | null;
  amountRatio20d?: number | null;
  limitUpCount: number;
}

export interface StrategySectorCapitalFlowMember {
  symbol: string;
  name?: string | null;
  latestAmount?: number | null;
  proxyNetAmount?: number | null;
  latestChangePercent?: number | null;
  strength20dPct?: number | null;
  turnover?: number | null;
  limitUp?: boolean | null;
}

export interface StrategySectorCapitalFlowDetail {
  sector: string;
  item: StrategySectorCapitalFlowItem;
  trend: StrategySectorCapitalFlowTrendPoint[];
  topMembers: StrategySectorCapitalFlowMember[];
  analysis: string[];
}

export interface StrategySectorCapitalFlowResponse {
  universeId: string;
  items: StrategySectorCapitalFlowItem[];
  marketSummary?: StrategySectorCapitalFlowMarketSummary | null;
  detail?: StrategySectorCapitalFlowDetail | null;
  source: string;
  proxyNote: string;
  cacheStatus: string;
  cacheTtlSeconds?: number | null;
  fetchedAt: string;
}

export interface StrategyLocalKlineSummary {
  rowCount: number;
  firstTs?: string | null;
  lastTs?: string | null;
  latestClose?: number | null;
  previousClose?: number | null;
  returnPct?: number | null;
  high?: number | null;
  low?: number | null;
  totalVolume?: number | null;
  totalAmount?: number | null;
}

export interface StrategyLocalKlineResponse {
  symbol: string;
  code?: string | null;
  name?: string | null;
  exchange: string;
  assetType: string;
  currency: string;
  timezone: string;
  secid?: string | null;
  provider?: string | null;
  dataProvider?: string | null;
  timeframe: string;
  adjustment: string;
  bars: StrategyLocalKlineBar[];
  summary: StrategyLocalKlineSummary;
  fetchedAt: string;
}

export interface StrategyRealtimeQuote {
  symbol: string;
  secid?: string | null;
  name?: string | null;
  assetType: string;
  market: string;
  source: string;
  currency: string;
  timezone: string;
  price?: number | null;
  open?: number | null;
  high?: number | null;
  low?: number | null;
  previousClose?: number | null;
  changePercent?: number | null;
  changeAmount?: number | null;
  amplitude?: number | null;
  turnover?: number | null;
  volume?: number | null;
  amount?: number | null;
  marketCap?: number | null;
  floatMarketCap?: number | null;
  peTtm?: number | null;
  pbMrq?: number | null;
  industry?: string | null;
  region?: string | null;
  concepts: string[];
  quoteTime?: string | null;
  asOf?: string | null;
  fetchedAt: string;
  cacheStatus?: string | null;
  cacheTtlSeconds?: number | null;
  dataQualityStatus?: string | null;
}

export interface StrategyIngestionPlan {
  provider: string;
  universeId: string;
  timeframe: string;
  adjustment: string;
  suggestedLimit: number;
  lookbackYears: number;
  endpoints: string[];
  guardrails: string[];
}

export interface StrategyResearchState {
  primaryUniverseId: string;
  universes: StrategyUniverse[];
  coverage: StrategyDataCoverageItem[];
  ingestionPlan: StrategyIngestionPlan;
  source: 'market-api' | 'fallback';
  error?: string | null;
}

export interface StrategyHistoryIngestionResult {
  job_id: string;
  status: 'completed' | 'partial' | 'failed';
  provider?: string;
  universe_id?: string | null;
  total_symbols: number;
  completed_symbols: number;
  failed_symbols: number;
  rows_received: number;
  rows_upserted: number;
  batch_offset?: number | null;
  batch_size?: number | null;
  next_offset?: number | null;
  universe_total_symbols?: number | null;
  symbols: Array<{
    symbol: string;
    name?: string | null;
    secid?: string | null;
    status: 'success' | 'failed' | 'skipped';
    bars_received: number;
    rows_upserted: number;
    first_date?: string | null;
    last_date?: string | null;
    error?: string | null;
    skip_reason?: string | null;
    coverage_row_count?: number | null;
    coverage_first_date?: string | null;
    coverage_last_date?: string | null;
    missing_fields?: string[];
  }>;
}

export interface StrategyAutoFillIngestionStartResult {
  job_id: string;
  status: string;
  provider?: string;
  universe_id?: string | null;
  batch_size: number;
  next_offset: number;
  universe_total_symbols: number;
  started_at: string;
  metadata?: Record<string, unknown>;
}

export interface StrategyIngestionJob {
  id: string;
  universeId?: string | null;
  provider: string;
  timeframe: string;
  adjustment: string;
  status: string;
  totalSymbols: number;
  completedSymbols: number;
  failedSymbols: number;
  rowsReceived: number;
  rowsUpserted: number;
  error?: string | null;
  metadata: Record<string, unknown>;
  batchOffset?: number | null;
  batchSize?: number | null;
  nextOffset?: number | null;
  universeTotalSymbols?: number | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StrategyIngestionJobControlResult {
  jobId: string;
  action: 'pause' | 'resume' | 'stop';
  status: string;
  control: string;
  updatedAt: string;
}

export interface StrategyIngestionJobsResponse {
  jobs: StrategyIngestionJob[];
  fetchedAt: string;
}

export interface StrategyFoundationComponent {
  id: string;
  name: string;
  status: 'ready' | 'partial' | 'missing';
  count: number;
  detail?: string | null;
}

export interface StrategyFactorDefinition {
  factorKey: string;
  name: string;
  category: string;
  frequency: string;
  valueType: string;
  unit?: string | null;
  description: string;
  formula?: string | null;
  dependencies: string[];
  status: string;
  provider: string;
  metadata: Record<string, unknown>;
  updatedAt?: string | null;
}

export interface StrategyTradingCalendarDay {
  market: string;
  tradeDate: string;
  isOpen: boolean;
  session: string;
  source: string;
  metadata: Record<string, unknown>;
}

export interface StrategyDataQualityIssue {
  symbol?: string | null;
  name?: string | null;
  severity: 'ok' | 'warning' | 'error';
  issueType: string;
  message: string;
  metrics: Record<string, unknown>;
}

export interface StrategyDataQualityScan {
  id: string;
  universeId?: string | null;
  symbol?: string | null;
  scope: string;
  timeframe: string;
  adjustment: string;
  status: string;
  severity: 'ok' | 'warning' | 'error';
  checkedSymbols: number;
  passedSymbols: number;
  warningSymbols: number;
  failedSymbols: number;
  checkedRows: number;
  issueCount: number;
  issues: StrategyDataQualityIssue[];
  metrics: Record<string, unknown>;
  startedAt: string;
  completedAt: string;
}

export interface StrategyFoundationState {
  source: 'market-api' | 'fallback';
  components: StrategyFoundationComponent[];
  factors: StrategyFactorDefinition[];
  calendarDays: StrategyTradingCalendarDay[];
  latestQualityScan?: StrategyDataQualityScan | null;
  error?: string | null;
}

export type StrategyFactorCatalogStatus = 'ready' | 'partial' | 'needs_data';
export type StrategyFactorCatalogDirection =
  | 'higher_is_better'
  | 'lower_is_better'
  | 'middle_is_better'
  | 'event_driven';

export interface StrategyFactorCatalogItem {
  id: string;
  name: string;
  category: string;
  horizon: string;
  direction: StrategyFactorCatalogDirection;
  status: StrategyFactorCatalogStatus;
  priority: number;
  formula: string;
  rationale: string;
  currentData: string[];
  missingData: string[];
  enrichmentPlan: string[];
  useCases: string[];
  guardrails: string[];
  sourceFrameworks: string[];
}

export interface StrategyFactorCatalogCategory {
  id: string;
  name: string;
  description: string;
  factors: StrategyFactorCatalogItem[];
}

export interface StrategyFactorCatalogEnrichmentItem {
  id: string;
  title: string;
  priority: 'P0' | 'P1' | 'P2';
  currentGap: string;
  targetTables: string[];
  providerOptions: string[];
  unlocks: string[];
}

export interface StrategyFactorResearchWorkflowStep {
  id: string;
  stage: string;
  title: string;
  objective: string;
  inputs: string[];
  outputs: string[];
  qualityGate: string;
}

export interface StrategyFactorDataLayer {
  id: string;
  name: string;
  status: StrategyFactorCatalogStatus;
  priority: 'P0' | 'P1' | 'P2';
  tables: string[];
  availableData: string[];
  factorIdeas: string[];
  dataGaps: string[];
  nextAction: string;
}

export interface StrategyFactorStrategyBlueprint {
  id: string;
  name: string;
  status: StrategyFactorCatalogStatus;
  horizon: string;
  factorInputs: string[];
  strategyIdea: string;
  validationPath: string[];
  riskControls: string[];
}

export interface StrategyFactorCatalogState {
  source: 'built-in-research';
  methodology: string[];
  workflow: StrategyFactorResearchWorkflowStep[];
  dataLayers: StrategyFactorDataLayer[];
  categories: StrategyFactorCatalogCategory[];
  strategyBlueprints: StrategyFactorStrategyBlueprint[];
  enrichmentPlan: StrategyFactorCatalogEnrichmentItem[];
}

export interface StrategyUniverseMemberAddResult {
  universe_id: string;
  member: StrategyUniverseMember;
  candidates: Array<{
    symbol: string;
    name?: string | null;
    market: string;
    asset_type: string;
    secid: string;
    source: string;
  }>;
  ingestion?: StrategyHistoryIngestionResult | null;
}

export interface StrategyTemplate {
  id: string;
  name: string;
  kind?: StrategyTemplateKind;
  family: string;
  status: StrategyStatus;
  capabilityId: QuantCapabilityId;
  description: string;
  defaultSymbols: string[];
  timeframe: string;
  backtestStrategyId: string;
  backtestLimit?: number;
  dataDependencies: string[];
  parameterSchema: StrategyParameter[];
  parameterScans: StrategyParameterScan[];
  versions: StrategyVersionRecord[];
  backtestArchives: StrategyBacktestArchive[];
  riskControls: string[];
  evaluationMetrics: string[];
  limitations: string[];
  selectionRules?: StrategyRule[];
  rankingRules?: string[];
  entryRules?: StrategyRule[];
  exitRules?: StrategyRule[];
  dataReadiness?: StrategyDataReadiness;
  promptSeed: string;
}

export interface StrategyWorkspaceRef {
  id: string;
  name: string;
  status?: string | null;
  createdAt: string;
  updatedAt?: string | null;
  capabilityId?: QuantCapabilityId | null;
  initialPrompt?: string | null;
}

export interface StrategyCatalogItem extends StrategyTemplate {
  readiness: {
    label: string;
    score: number;
    riskLevel: StrategyRiskLevel;
    summary: string;
  };
  linkedWorkspaces: StrategyWorkspaceRef[];
  latestScanRun: StrategyScanRun | null;
}

export interface StrategyDashboardData {
  generatedAt: string;
  summary: {
    templates: number;
    readyTemplates: number;
    plannedTemplates: number;
    strategyWorkspaces: number;
    backtestWorkspaces: number;
    dataDependencies: number;
    parameterScans: number;
    archivedReports: number;
    activeVersions: number;
    researchUniverses: number;
    trackedSymbols: number;
    syncedSymbols: number;
    syncedBars: number;
  };
  templates: StrategyCatalogItem[];
  workspaces: StrategyWorkspaceRef[];
  scanRuns: StrategyScanRun[];
  scanJobs: StrategyScanJob[];
  research: StrategyResearchState;
  foundation: StrategyFoundationState;
  factorCatalog: StrategyFactorCatalogState;
}
