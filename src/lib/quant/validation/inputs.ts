import path from 'path';
import { readTextFile } from './files';

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

export function hasAnyKeyDeep(value: unknown, keys: string[]): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => hasAnyKeyDeep(entry, keys));
  }
  const record = asRecord(value);
  if (!record) {
    return false;
  }
  return Object.entries(record).some(([key, nestedValue]) => keys.includes(key) || hasAnyKeyDeep(nestedValue, keys));
}

export function pickString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

export function normalizeTextForIntent(value: unknown): string {
  if (typeof value === 'string') {
    return value.replace(/\s+/g, '');
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeTextForIntent(item)).join('');
  }
  const record = asRecord(value);
  if (record) {
    return Object.values(record).map((item) => normalizeTextForIntent(item)).join('');
  }
  return '';
}

export function hasExplicitTradingPlanIntent(taskText: string): boolean {
  return /交易计划|买入区间|买点|卖点|入场|出场|止损|止盈|目标价|仓位|建仓|加仓|减仓|卖出|买入|(?:要|想|准备)买|推荐.*(?:买|交易)|怎么操作|如何操作|操作建议|短线.*(?:买|卖|交易|计划)|(?:1|3|5|一|三|五)个交易日.*(?:计划|操作)|持仓.*(?:调仓|减仓|加仓)/.test(
    taskText
  );
}

export function inferExpectedTemplateFromTask(runPlan: Record<string, unknown> | null): string | null {
  if (!runPlan) {
    return null;
  }

  const capabilityId = pickString(runPlan.capabilityId);
  if (!capabilityId) return null;
  if (capabilityId === 'stock_diagnosis') {
    return 'single-stock-diagnosis';
  }
  if (capabilityId === 'strategy_research') {
    return 'strategy-research';
  }
  if (capabilityId === 'portfolio_risk') {
    return 'holding-analysis';
  }
  if (capabilityId === 'asset_comparison') {
    return 'stock-selection';
  }
  if (capabilityId === 'sector_rotation') {
    return 'sector-rotation';
  }
  if (capabilityId === 'backtest_review') {
    return 'backtest-review';
  }
  if (capabilityId === 'technical_analysis') {
    return 'technical-timing';
  }
  if (capabilityId === 'fundamental_analysis') {
    return 'fundamental-research';
  }
  return null;
}

function pickSymbolCode(value: unknown): string | null {
  if (typeof value === 'string' && /^(?:6|0|3|5)\d{5}$/.test(value.trim())) {
    return value.trim();
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const candidates = [
    record.symbol,
    record.code,
    record.security_code,
    record.securityCode,
    record.ticker,
    typeof record.secid === 'string' ? record.secid.split('.').at(-1) : null,
  ];

  for (const candidate of candidates) {
    const symbol = pickString(candidate);
    if (symbol && /^(?:6|0|3|5)\d{5}$/.test(symbol)) {
      return symbol;
    }
  }

  return null;
}

export async function readRunPlan(projectPath: string): Promise<Record<string, unknown> | null> {
  const raw = await readTextFile(path.join(projectPath, '.data-agent', 'finance-run-plan.json'));
  if (!raw) {
    return null;
  }
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

export async function readCurrentQuantRunId(projectPath: string): Promise<string | null> {
  const generationStateRaw = await readTextFile(
    path.join(projectPath, '.data-agent', 'generation-state.json'),
  );
  if (generationStateRaw) {
    try {
      const generationState = asRecord(JSON.parse(generationStateRaw));
      const requestId = pickString(generationState?.requestId);
      if (requestId) {
        return requestId;
      }
    } catch {
      // Fall back to the run plan when generation state is unavailable.
    }
  }

  const runPlan = await readRunPlan(projectPath);
  return pickString(runPlan?.runId);
}

export function extractPlannedSymbols(runPlan: Record<string, unknown> | null): string[] {
  const symbols = Array.isArray(runPlan?.symbols) ? runPlan.symbols : [];
  return Array.from(
    new Set(
      symbols
        .map((symbol) => pickSymbolCode(symbol))
        .filter((symbol): symbol is string => Boolean(symbol && /^(?:6|0|3|5)\d{5}$/.test(symbol)))
    )
  );
}

export function extractFetchedSymbols(data: unknown): string[] {
  const record = asRecord(data);
  if (!record) {
    return [];
  }

  const assets = Array.isArray(record.assets)
    ? record.assets.map(asRecord).filter((asset): asset is Record<string, unknown> => Boolean(asset))
    : [];
  const candidates = assets.length > 0
    ? assets.map((asset) => pickSymbolCode(asset) ?? pickSymbolCode(asRecord(asset.quote)?.symbol))
    : [
        pickSymbolCode(record),
        pickSymbolCode(asRecord(record.quote)),
        ...(Array.isArray(record.symbols) ? record.symbols.map((symbol) => pickSymbolCode(symbol)) : []),
      ];

  return Array.from(
    new Set(candidates.filter((symbol): symbol is string => Boolean(symbol && /^(?:6|0|3|5)\d{5}$/.test(symbol))))
  );
}

export function extractComparisonSymbols(data: unknown): string[] {
  const record = asRecord(data);
  if (!record) {
    return [];
  }

  const comparison = asRecord(record.comparison);
  const rows = Array.isArray(comparison?.rows)
    ? comparison.rows
    : Array.isArray(record.comparison)
      ? record.comparison
      : [];

  return Array.from(
    new Set(
      rows
        .map((row) => pickSymbolCode(row))
        .filter((symbol): symbol is string => Boolean(symbol && /^(?:6|0|3|5)\d{5}$/.test(symbol)))
    )
  );
}

export function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
}

function extractBarsFromDashboardData(data: unknown): Record<string, unknown>[] {
  const record = asRecord(data);
  if (!record) {
    return [];
  }

  const assets = arrayOfRecords(record.assets);
  if (assets.length > 0) {
    return assets.flatMap((asset) => extractBarsFromDashboardData(asset));
  }

  const kline = asRecord(record.kline) ?? asRecord(record.history) ?? asRecord(record.ohlc);
  const candidates = [
    kline?.bars,
    kline?.data,
    kline?.items,
    record.bars,
    record.klines,
    record.candles,
    record.history,
  ];

  for (const candidate of candidates) {
    const bars = arrayOfRecords(candidate);
    if (bars.length > 0) {
      return bars;
    }
  }

  return [];
}

function hasUsableQuote(data: unknown): boolean {
  const record = asRecord(data);
  if (!record) {
    return false;
  }

  const assets = arrayOfRecords(record.assets);
  if (assets.length > 0) {
    return assets.some(hasUsableQuote);
  }

  const quote = asRecord(record.quote);
  return [
    quote?.price,
    quote?.latest,
    quote?.latest_price,
    quote?.close,
    record.price,
    record.latest,
    record.latest_price,
  ].some((value) => numeric(value) !== null);
}

export function inspectDashboardDataPayload(data: unknown) {
  const bars = extractBarsFromDashboardData(data);
  const hasQuote = hasUsableQuote(data);
  const fetchedSymbols = extractFetchedSymbols(data);

  return {
    hasQuote,
    barCount: bars.length,
    fetchedSymbols,
    hasUsableMarketData: hasQuote || bars.length > 0,
  };
}

export function isStructuredEmptyScreenerResult(data: unknown): boolean {
  const record = asRecord(data);
  const screener = asRecord(record?.screener);
  const comparison = asRecord(record?.comparison);
  const ranking = asRecord(record?.selectionRanking);
  const financialQuality = asRecord(record?.financialQuality);
  const tradingPlan = asRecord(record?.tradingPlan);
  const assets = Array.isArray(record?.assets) ? record.assets : null;
  const candidates = Array.isArray(screener?.candidates) ? screener.candidates : null;
  const totalCandidates = numeric(screener?.total_candidates);

  return Boolean(
    record?.status === 'no_candidates' &&
      assets &&
      assets.length === 0 &&
      candidates &&
      candidates.length === 0 &&
      totalCandidates === 0 &&
      pickString(screener?.source) &&
      pickString(screener?.fetched_at ?? screener?.as_of ?? screener?.trade_date) &&
      Array.isArray(comparison?.rows) &&
      Array.isArray(ranking?.rows) &&
      Array.isArray(financialQuality?.rows) &&
      Array.isArray(tradingPlan?.rows) &&
      Array.isArray(record.warnings) &&
      record.warnings.length > 0
  );
}
