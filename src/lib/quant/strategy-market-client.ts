import { SAMPLE_UNIVERSE_ID } from './strategy-catalog';
import type {
  StrategyUniverseMembersPage,
  StrategyScreenerMode,
  StrategyScreenerResponse,
  StrategyDividendEventsResponse,
  StrategySectorCapitalFlowResponse,
  StrategyLocalKlineResponse,
  StrategyRealtimeQuote,
  StrategyHistoryIngestionResult,
  StrategyAutoFillIngestionStartResult,
  StrategyIngestionJobControlResult,
  StrategyIngestionJobsResponse,
  StrategyDataQualityScan,
  StrategyUniverseMemberAddResult,
} from './strategy-types';
import {
  asRecord,
  asString,
  mapResearchMember,
  mapResearchUniverseMembersPage,
  mapScreenerResponse,
  mapDividendEventsResponse,
  mapSectorCapitalFlowResponse,
  mapLocalKlineResponse,
  mapRealtimeQuote,
  mapIngestionJobsResponse,
  mapDataQualityScan,
  mapIngestionJobControlResult,
} from './strategy-mappers';
import { assertMarketApiEnabled, fetchMarketApiJson, marketAdminHeaders } from './strategy-market-api';
import { FALLBACK_RESEARCH_STATE } from './strategy-research-defaults';

export async function getStrategyUniverseMembersPage(
  params: {
    universeId?: string;
    page?: number;
    pageSize?: number;
    keyword?: string;
    timeoutMs?: number;
  } = {}
): Promise<StrategyUniverseMembersPage> {
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

export async function runStrategyScreener(
  params: {
    universeId?: string;
    tradeDate?: string;
    mode?: StrategyScreenerMode;
    limit?: number;
    timeoutMs?: number;
  } = {}
): Promise<StrategyScreenerResponse> {
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

export async function getStrategyIngestionJobs(
  params: {
    universeId?: string;
    limit?: number;
  } = {}
): Promise<StrategyIngestionJobsResponse> {
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
  const responseData = await fetchMarketApiJson<unknown>(
    `/api/v1/ingestion/jobs/${encodeURIComponent(jobId)}/control`,
    {
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...marketAdminHeaders() },
        body: JSON.stringify({ action: params.action, reason: params.reason }),
        cache: 'no-store',
      },
      errorBodyLimit: 200,
    }
  );

  return mapIngestionJobControlResult(responseData);
}

export async function runStrategyDataQualityScan(
  params: {
    universeId?: string;
    symbols?: string[];
    timeframe?: string;
    adjustment?: string;
    lookbackYears?: number;
    persist?: boolean;
  } = {}
): Promise<StrategyDataQualityScan> {
  assertMarketApiEnabled();
  const responseData = await fetchMarketApiJson<unknown>(`/api/v1/foundation/data-quality/scan`, {
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...marketAdminHeaders() },
      body: JSON.stringify({
        universe_id: params.universeId || SAMPLE_UNIVERSE_ID,
        symbols: params.symbols?.length ? params.symbols : undefined,
        timeframe: params.timeframe || 'daily',
        adjustment: params.adjustment || 'qfq',
        lookback_years: params.lookbackYears ?? FALLBACK_RESEARCH_STATE.ingestionPlan.lookbackYears,
        persist: params.persist !== false,
      }),
      cache: 'no-store',
    },
    errorBodyLimit: 200,
  });

  return mapDataQualityScan(responseData);
}

export async function getStrategySectorCapitalFlow(
  params: {
    universeId?: string;
    limit?: number;
    sector?: string;
    detailDays?: number;
  } = {}
): Promise<StrategySectorCapitalFlowResponse> {
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
  const payload = await fetchMarketApiJson<unknown>(`/api/v1/research/sector-capital-flow?${query.toString()}`);
  return mapSectorCapitalFlowResponse(payload);
}

export async function ingestStrategyUniverseHistory(
  params: {
    universeId?: string;
    symbols?: string[];
    limit?: number;
    lookbackYears?: number;
    period?: string;
    adjustment?: string;
  } = {}
): Promise<StrategyHistoryIngestionResult> {
  assertMarketApiEnabled();
  const body = {
    universe_id: params.universeId || SAMPLE_UNIVERSE_ID,
    symbols: params.symbols?.length ? params.symbols : undefined,
    period: params.period || 'daily',
    adjustment: params.adjustment || 'qfq',
    limit: params.limit ?? FALLBACK_RESEARCH_STATE.ingestionPlan.suggestedLimit,
    lookback_years: params.lookbackYears ?? FALLBACK_RESEARCH_STATE.ingestionPlan.lookbackYears,
  };
  const responseData = await fetchMarketApiJson<StrategyHistoryIngestionResult>(`/api/v1/ingestion/eastmoney/history`, {
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...marketAdminHeaders() },
      body: JSON.stringify(body),
      cache: 'no-store',
    },
    errorBodyLimit: 200,
  });

  return responseData;
}

export async function ingestStrategyUniverseHistoryBatch(
  params: {
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
  } = {}
): Promise<StrategyHistoryIngestionResult> {
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
  const responseData = await fetchMarketApiJson<StrategyHistoryIngestionResult>(
    `/api/v1/ingestion/baostock/history/batch`,
    {
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...marketAdminHeaders() },
        body: JSON.stringify(body),
        cache: 'no-store',
      },
      errorBodyLimit: 200,
    }
  );

  return responseData;
}

export async function startStrategyUniverseHistoryAutoFill(
  params: {
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
  } = {}
): Promise<StrategyAutoFillIngestionStartResult> {
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
  const responseData = await fetchMarketApiJson<StrategyAutoFillIngestionStartResult>(
    `/api/v1/ingestion/baostock/history/autofill`,
    {
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...marketAdminHeaders() },
        body: JSON.stringify(body),
        cache: 'no-store',
      },
      errorBodyLimit: 200,
    }
  );

  return responseData;
}

export async function addStrategyUniverseMember(params: {
  universeId?: string;
  query: string;
  syncHistory?: boolean;
}): Promise<StrategyUniverseMemberAddResult> {
  assertMarketApiEnabled();
  const universeId = params.universeId || SAMPLE_UNIVERSE_ID;
  const responseData = await fetchMarketApiJson<unknown>(
    `/api/v1/research/universes/${encodeURIComponent(universeId)}/members`,
    {
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...marketAdminHeaders() },
        body: JSON.stringify({ query: params.query }),
        cache: 'no-store',
      },
      errorBodyLimit: 200,
    }
  );

  const payload = asRecord(responseData);
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
      ? payload.candidates
          .map((candidate) => asRecord(candidate))
          .map((candidate) => ({
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
  const responseData = await fetchMarketApiJson<unknown>(
    `/api/v1/research/bars/${encodeURIComponent(params.symbol)}?${query.toString()}`,
    { init: { cache: 'no-store' }, errorBodyLimit: 200 }
  );

  return mapLocalKlineResponse(responseData);
}

export async function getStrategySymbolDividends(params: {
  symbol: string;
  limit?: number;
}): Promise<StrategyDividendEventsResponse> {
  assertMarketApiEnabled();
  const query = new URLSearchParams({
    limit: String(params.limit ?? 20),
  });
  const responseData = await fetchMarketApiJson<unknown>(
    `/api/v1/events/dividends/${encodeURIComponent(params.symbol)}?${query.toString()}`,
    { init: { cache: 'no-store' }, errorBodyLimit: 200 }
  );

  return mapDividendEventsResponse(responseData);
}

export async function getStrategyRealtimeQuote(params: { symbol: string }): Promise<StrategyRealtimeQuote> {
  const symbol = params.symbol.trim();
  if (!symbol) throw new Error('缺少实时行情标的');
  const payload = await fetchMarketApiJson<unknown>(`/api/v1/quotes/realtime/${encodeURIComponent(symbol)}`);
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
