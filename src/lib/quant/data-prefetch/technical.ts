import { type JsonRecord, asRecord, extractBarsFromAsset, mean, numeric, round } from './values';

export function calculateMetrics(kline: JsonRecord | null): JsonRecord {
  const bars = Array.isArray(kline?.bars) ? kline.bars.map(asRecord).filter(Boolean) as JsonRecord[] : [];
  const closes = bars.map((bar) => numeric(bar.close)).filter((value): value is number => value !== null);
  const volumes = bars.map((bar) => numeric(bar.volume)).filter((value): value is number => value !== null);
  const amounts = bars.map((bar) => numeric(bar.amount)).filter((value): value is number => value !== null);
  const highs = bars.map((bar) => numeric(bar.high)).filter((value): value is number => value !== null);
  const lows = bars.map((bar) => numeric(bar.low)).filter((value): value is number => value !== null);

  const firstClose = closes[0] ?? null;
  const lastClose = closes.at(-1) ?? null;
  const returns = closes.slice(1).map((close, index) => {
    const previous = closes[index];
    return previous ? (close - previous) / previous : 0;
  });
  const avgReturn = mean(returns) ?? 0;
  const variance = returns.length
    ? mean(returns.map((value) => (value - avgReturn) ** 2)) ?? 0
    : 0;
  let peak = closes[0] ?? 0;
  let maxDrawdown = 0;
  for (const close of closes) {
    peak = Math.max(peak, close);
    if (peak > 0) {
      maxDrawdown = Math.min(maxDrawdown, ((close - peak) / peak) * 100);
    }
  }

  return {
    periodReturn:
      firstClose && lastClose ? round(((lastClose - firstClose) / firstClose) * 100) : null,
    return20d: calculateWindowReturn(closes, 20),
    return60d: calculateWindowReturn(closes, 60),
    return120d: calculateWindowReturn(closes, 120),
    periodHigh: highs.length ? round(Math.max(...highs)) : null,
    periodLow: lows.length ? round(Math.min(...lows)) : null,
    maxDrawdown: round(maxDrawdown),
    volatility20d: round(Math.sqrt(variance) * Math.sqrt(252) * 100),
    avgVolume20d: round(mean(volumes.slice(-20))),
    avgAmount20d: round(mean(amounts.slice(-20))),
    ma5: round(mean(closes.slice(-5))),
    ma10: round(mean(closes.slice(-10))),
    ma20: round(mean(closes.slice(-20))),
    ma60: round(mean(closes.slice(-60))),
  };
}

function calculateWindowReturn(closes: number[], windowSize: number): number | null {
  const latest = closes.at(-1);
  const baseline = closes.length > windowSize ? closes.at(-1 - windowSize) : closes[0];
  if (!latest || !baseline || baseline <= 0) {
    return null;
  }
  return round(((latest - baseline) / baseline) * 100);
}

export function firstDateFromBars(bars: JsonRecord[]): string | null {
  const first = bars[0];
  const value = first?.date ?? first?.time ?? first?.trade_date;
  return typeof value === 'string' ? value.slice(0, 10) : null;
}

export function lastDateFromBars(bars: JsonRecord[]): string | null {
  const last = bars.at(-1);
  const value = last?.date ?? last?.time ?? last?.trade_date;
  return typeof value === 'string' ? value.slice(0, 10) : null;
}

export function ensureTechnicalSummary(asset: JsonRecord): JsonRecord {
  const quote = asRecord(asset.quote);
  const kline = asRecord(asset.kline) ?? asRecord(asset.history);
  const bars = extractBarsFromAsset(asset);
  const metrics = asRecord(asset.computedMetrics) ?? calculateMetrics(kline);
  const technicalIndicators = asRecord(asset.technicalIndicators) ?? {};
  const existingSummary = asRecord(technicalIndicators.summary) ?? {};
  const latestClose = numeric(existingSummary.latest_close) ?? numeric(quote?.price) ?? numeric(bars.at(-1)?.close);
  const ma5 = numeric(existingSummary.ma5) ?? numeric(metrics.ma5);
  const ma10 = numeric(existingSummary.ma10) ?? numeric(metrics.ma10);
  const ma20 = numeric(existingSummary.ma20) ?? numeric(metrics.ma20);
  const ma60 = numeric(existingSummary.ma60) ?? numeric(metrics.ma60);
  const return20d = numeric(existingSummary.return_20d_pct) ?? numeric(metrics.return20d);
  const return60d = numeric(existingSummary.return_60d_pct) ?? numeric(metrics.return60d);
  const return120d =
    numeric(existingSummary.return_120d_pct) ??
    numeric(existingSummary.period_return_pct) ??
    numeric(metrics.return120d) ??
    numeric(metrics.periodReturn);
  const maxDrawdown = numeric(existingSummary.max_drawdown_pct) ?? numeric(metrics.maxDrawdown);
  const volatility = numeric(existingSummary.volatility_20d_annualized_pct) ?? numeric(existingSummary.volatility_annualized_pct) ?? numeric(metrics.volatility20d);
  const avgVolume = numeric(existingSummary.avg_volume20) ?? numeric(metrics.avgVolume20d);
  const symbol = String(asset.symbol ?? quote?.symbol ?? '');
  const name = String(asset.name ?? quote?.name ?? symbol);

  let trendState = '趋势待确认：K 线或均线样本不足。';
  const availableMovingAverages = [ma5, ma10, ma20, ma60].filter(
    (value): value is number => value !== null
  );
  if (latestClose !== null && availableMovingAverages.length >= 3) {
    const averageLabel = ma60 === null ? 'MA5/MA10/MA20' : 'MA5/MA10/MA20/MA60';
    if (availableMovingAverages.every((average) => latestClose >= average)) {
      trendState = `趋势偏强：最新价站上 ${averageLabel}。`;
    } else if (availableMovingAverages.every((average) => latestClose < average)) {
      trendState = `趋势偏弱：最新价低于 ${averageLabel}。`;
    } else {
      trendState = '震荡观察：最新价处于均线区间内，需要等待方向确认。';
    }
  }

  const summary = {
    symbol,
    name,
    sample_window: bars.length
      ? `${firstDateFromBars(bars) ?? '-'} 至 ${lastDateFromBars(bars) ?? '-'}，${bars.length} 根日 K`
      : '暂无历史 K 线样本',
    return_20d_pct: round(return20d),
    return_60d_pct: round(return60d),
    return_120d_pct: round(return120d),
    period_return_pct: round(numeric(existingSummary.period_return_pct) ?? numeric(metrics.periodReturn)),
    max_drawdown_pct: round(maxDrawdown),
    volatility_20d_annualized_pct: round(volatility),
    ma5: round(ma5),
    ma10: round(ma10),
    ma20: round(ma20),
    ma60: round(ma60),
    latest_close: round(latestClose),
    trend_state: String(existingSummary.trend_state ?? trendState),
    volume_note: avgVolume === null
      ? '缺少连续成交量，量能指标待补充。'
      : `20 日均量约 ${round(avgVolume, 0)} 手。`,
  };

  asset.technicalIndicators = {
    ...technicalIndicators,
    symbol,
    summary,
    computedMetrics: metrics,
    data_quality: technicalIndicators.data_quality ?? {
      status: bars.length >= 20 ? 'ok' : 'warning',
      warnings: bars.length >= 20 ? [] : ['历史 K 线样本少于 20 条，技术指标稳定性较弱。'],
    },
  };
  return summary;
}
