import path from 'path';
import { QuantRunPlan } from '@/lib/domains/finance/workspace';
import { type JsonRecord, asRecord } from './values';
import {
  inferHistoryLimit,
  pickScreenerCandidateCode,
  screenerLimitForQuestion,
  screenerModeForQuestion,
  screenerTradeDateForQuestion,
  uniqueSymbols,
} from './planning';
import { SCREENER_FETCH_TIMEOUT_MS, fetchJson, writeJson } from './transport';
import { buildFundamentalMetricComparison } from './fundamentals';
import { calculateMetrics } from './technical';
import { buildLiquiditySummary } from './portfolio';

export async function fetchScreenerSeedSymbols(params: {
  projectPath: string;
  runId: string;
  plan: QuantRunPlan;
  rawFiles: string[];
  warnings: string[];
}): Promise<{ symbols: string[]; screener: JsonRecord | null }> {
  const mode = screenerModeForQuestion(params.plan.question);
  const limit = screenerLimitForQuestion(params.plan.question);
  const tradeDate = screenerTradeDateForQuestion(params.plan.question);
  const query = new URLSearchParams({
    mode,
    limit: String(limit),
  });
  if (tradeDate) {
    query.set('trade_date', tradeDate);
  }
  const screener = await fetchJson(
    `/api/v1/research/screeners/a-share/short-term-candidates?${query.toString()}`,
    {},
    { timeoutMs: SCREENER_FETCH_TIMEOUT_MS }
  );
  const rawPath = path.join(params.projectPath, 'data_file', 'raw', params.runId, 'a-share-screener.json');
  await writeJson(rawPath, screener);
  params.rawFiles.push(path.relative(params.projectPath, rawPath).replaceAll(path.sep, '/'));

  const candidates = Array.isArray(screener.candidates) ? screener.candidates : [];
  const symbols = uniqueSymbols(
    candidates
      .map(pickScreenerCandidateCode)
      .filter((symbol): symbol is string => Boolean(symbol))
  ).slice(0, limit);

  const dataQuality = asRecord(screener.data_quality);
  const missingFields = Array.isArray(dataQuality?.missing_fields)
    ? dataQuality.missing_fields.filter((field): field is string => typeof field === 'string')
    : [];
  const notes = Array.isArray(screener.notes)
    ? screener.notes.filter((note): note is string => typeof note === 'string')
    : [];
  if (missingFields.length > 0) {
    params.warnings.push(`选股接口缺少字段：${missingFields.join('、')}`);
  }
  if (notes.length > 0) {
    params.warnings.push(...notes.map((note) => `选股接口说明：${note}`));
  }

  return { symbols, screener };
}

function finalDataFromResponses(params: {
  symbol: string;
  quote: JsonRecord;
  kline?: JsonRecord | null;
  technicalIndicators?: JsonRecord | null;
  backtest?: JsonRecord | null;
  financials?: JsonRecord | null;
  fundamentalIndicators?: JsonRecord | null;
  announcements?: JsonRecord | null;
  requestedTimeRange?: string | null;
}): JsonRecord {
  const quote = params.quote;
  const assetType = typeof quote.asset_type === 'string' ? quote.asset_type : 'stock';
  const kline = params.kline ?? {
    symbol: params.symbol,
    asset_type: assetType,
    bars: [],
    fetched_at: quote.fetched_at,
    data_quality: { status: 'warning', missing_fields: ['bars'], warnings: ['未获取历史 K 线。'] },
  };
  const financials = params.financials ?? {
    symbol: params.symbol,
    asset_type: assetType,
    reports: [],
    fetched_at: quote.fetched_at,
    data_quality: {
      status: assetType === 'stock' ? 'warning' : 'ok',
      missing_fields: assetType === 'stock' ? ['reports'] : [],
      warnings: assetType === 'stock' ? ['未获取财务摘要。'] : [`${assetType} 标的默认不获取个股财务摘要。`],
    },
  };
  const announcements = params.announcements ?? {
    symbol: params.symbol,
    asset_type: assetType,
    announcements: [],
    fetched_at: quote.fetched_at,
    data_quality: {
      status: assetType === 'stock' ? 'warning' : 'ok',
      missing_fields: assetType === 'stock' ? ['announcements'] : [],
      warnings: assetType === 'stock' ? ['未获取公告事件。'] : [`${assetType} 标的默认不获取个股公告事件。`],
    },
  };

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    symbol: String(quote.symbol ?? params.symbol),
    name: typeof quote.name === 'string' ? quote.name : null,
    secid: quote.secid,
    market: quote.market,
    asset_type: assetType,
    source: quote.source ?? 'eastmoney',
    currency: quote.currency ?? 'CNY',
    timezone: quote.timezone ?? 'Asia/Shanghai',
    as_of: quote.as_of ?? quote.quote_time ?? quote.fetched_at,
    quote,
    kline,
    technicalIndicators: params.technicalIndicators ?? null,
    backtest: params.backtest ?? null,
    financials,
    fundamentalIndicators: params.fundamentalIndicators ?? null,
    fundamentalMetricComparison: buildFundamentalMetricComparison(
      financials,
      params.requestedTimeRange,
    ),
    announcements,
    computedMetrics: calculateMetrics(kline),
    liquidity: buildLiquiditySummary([]),
  };
}

export async function fetchSymbolDataset(params: {
  projectPath: string;
  runId: string;
  symbol: string;
  plan: QuantRunPlan;
  rawFiles: string[];
  warnings: string[];
}): Promise<JsonRecord> {
  const symbolRawDir = path.join(params.projectPath, 'data_file', 'raw', params.runId, params.symbol);
  const historyLimit = inferHistoryLimit(params.plan);
  const quote = await fetchJson(`/api/v1/quotes/realtime/${params.symbol}`);
  const assetType = typeof quote.asset_type === 'string' ? quote.asset_type : 'stock';
  const quotePath = path.join(symbolRawDir, 'quote.json');
  await writeJson(quotePath, quote);
  params.rawFiles.push(path.relative(params.projectPath, quotePath).replaceAll(path.sep, '/'));

  let kline: JsonRecord | null = null;
  let technicalIndicators: JsonRecord | null = null;
  let backtest: JsonRecord | null = null;
  let financials: JsonRecord | null = null;
  let fundamentalIndicators: JsonRecord | null = null;
  let announcements: JsonRecord | null = null;

  if (params.plan.dataRequirements.some((endpoint) => endpoint.includes('/quotes/history/'))) {
    try {
      kline = await fetchJson(`/api/v1/quotes/history/${params.symbol}?period=daily&adjustment=qfq&limit=${historyLimit}`);
      const filePath = path.join(symbolRawDir, 'kline-daily-qfq.json');
      await writeJson(filePath, kline);
      params.rawFiles.push(path.relative(params.projectPath, filePath).replaceAll(path.sep, '/'));
    } catch (error) {
      params.warnings.push(`${params.symbol} 历史 K 线预取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (
    params.plan.dataRequirements.some((endpoint) => endpoint.includes('/indicators/technical/')) ||
    params.plan.capabilityId === 'asset_comparison' ||
    params.plan.requestedCapabilityId === 'asset_comparison'
  ) {
    try {
      technicalIndicators = await fetchJson(
        `/api/v1/indicators/technical/${params.symbol}?period=daily&adjustment=qfq&limit=${historyLimit}`
      );
      const filePath = path.join(symbolRawDir, 'technical-indicators.json');
      await writeJson(filePath, technicalIndicators);
      params.rawFiles.push(path.relative(params.projectPath, filePath).replaceAll(path.sep, '/'));
    } catch (error) {
      params.warnings.push(`${params.symbol} 技术指标预取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (params.plan.dataRequirements.some((endpoint) => endpoint.includes('/backtests/ma-crossover/'))) {
    try {
      backtest = await fetchJson(
        `/api/v1/backtests/ma-crossover/${params.symbol}?fast_window=20&slow_window=60&period=daily&adjustment=qfq&limit=250&fee_bps=5`
      );
      const experiment = asRecord(backtest.experiment);
      const experimentId = typeof experiment?.experiment_id === 'string'
        && /^sha256:[a-f0-9]{64}$/.test(experiment.experiment_id)
        ? experiment.experiment_id.slice('sha256:'.length) : null;
      const filePath = path.join(symbolRawDir,
        experimentId ? `backtest-ma-crossover-${experimentId}.json` : 'backtest-ma-crossover.json');
      await writeJson(filePath, backtest);
      const artifactPath = path.relative(params.projectPath, filePath).replaceAll(path.sep, '/');
      params.rawFiles.push(artifactPath);
      if (experiment) {
        const { experiment: _capturedInputs, ...researchBacktest } = backtest;
        const hashes = Object.fromEntries(
          ['experiment_id', 'data_sha256', 'result_sha256']
            .filter(key => typeof experiment[key] === 'string' && /^sha256:[a-f0-9]{64}$/.test(experiment[key]))
            .map(key => [key, experiment[key]])
        );
        backtest = {
          ...researchBacktest,
          experiment_ref: { artifact_path: artifactPath, ...hashes },
        };
      }
    } catch (error) {
      params.warnings.push(`${params.symbol} 均线突破回测预取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (
    assetType === 'stock' &&
    params.plan.dataRequirements.some((endpoint) => endpoint.includes('/fundamentals/financials/'))
  ) {
    try {
      financials = await fetchJson(`/api/v1/fundamentals/financials/${params.symbol}?limit=8`);
      const filePath = path.join(symbolRawDir, 'financials.json');
      await writeJson(filePath, financials);
      params.rawFiles.push(path.relative(params.projectPath, filePath).replaceAll(path.sep, '/'));
    } catch (error) {
      params.warnings.push(`${params.symbol} 财务摘要预取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (
    assetType === 'stock' &&
    params.plan.dataRequirements.some((endpoint) => endpoint.includes('/indicators/fundamental/'))
  ) {
    try {
      fundamentalIndicators = await fetchJson(`/api/v1/indicators/fundamental/${params.symbol}?limit=8`);
      const filePath = path.join(symbolRawDir, 'fundamental-indicators.json');
      await writeJson(filePath, fundamentalIndicators);
      params.rawFiles.push(path.relative(params.projectPath, filePath).replaceAll(path.sep, '/'));
    } catch (error) {
      params.warnings.push(`${params.symbol} 财务衍生指标预取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (
    assetType === 'stock' &&
    params.plan.dataRequirements.some((endpoint) => endpoint.includes('/events/announcements/'))
  ) {
    try {
      announcements = await fetchJson(`/api/v1/events/announcements/${params.symbol}?limit=20`);
      const filePath = path.join(symbolRawDir, 'announcements.json');
      await writeJson(filePath, announcements);
      params.rawFiles.push(path.relative(params.projectPath, filePath).replaceAll(path.sep, '/'));
    } catch (error) {
      params.warnings.push(`${params.symbol} 公告事件预取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return finalDataFromResponses({
    symbol: params.symbol,
    quote,
    kline,
    technicalIndicators,
    backtest,
    financials,
    fundamentalIndicators,
    announcements,
    requestedTimeRange: params.plan.timeRange,
  });
}
