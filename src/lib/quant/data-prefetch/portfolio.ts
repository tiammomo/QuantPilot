import { type JsonRecord, asRecord, extractBarsFromAsset, mean, numeric, round } from './values';

function dateKeyForBar(bar: JsonRecord, index: number): string {
  const raw = bar.date ?? bar.time ?? bar.trade_date ?? index;
  return String(raw).slice(0, 10);
}

function buildReturnSeries(asset: JsonRecord): Map<string, number> {
  const bars = extractBarsFromAsset(asset);
  const ordered = bars
    .map((bar, index) => ({
      date: dateKeyForBar(bar, index),
      close: numeric(bar.close),
    }))
    .filter((item): item is { date: string; close: number } => item.close !== null && item.close > 0);

  const series = new Map<string, number>();
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const current = ordered[index];
    if (previous.close > 0) {
      series.set(current.date, Math.log(current.close / previous.close));
    }
  }
  return series;
}

function pearson(left: number[], right: number[]): number | null {
  if (left.length < 3 || left.length !== right.length) {
    return null;
  }
  const leftMean = mean(left);
  const rightMean = mean(right);
  if (leftMean === null || rightMean === null) {
    return null;
  }
  let numerator = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < left.length; index += 1) {
    const leftDiff = left[index] - leftMean;
    const rightDiff = right[index] - rightMean;
    numerator += leftDiff * rightDiff;
    leftVariance += leftDiff ** 2;
    rightVariance += rightDiff ** 2;
  }
  const denominator = Math.sqrt(leftVariance * rightVariance);
  return denominator === 0 ? null : numerator / denominator;
}

export function buildCorrelationSummary(assets: JsonRecord[]): JsonRecord {
  const series = new Map<string, Map<string, number>>();
  const sampleLengths: Record<string, number> = {};
  for (const asset of assets) {
    const symbol = String(asset.symbol ?? asRecord(asset.quote)?.symbol ?? '');
    if (!symbol) {
      continue;
    }
    const returns = buildReturnSeries(asset);
    if (returns.size > 0) {
      series.set(symbol, returns);
      sampleLengths[symbol] = returns.size;
    }
  }

  const symbols = Array.from(series.keys());
  const matrix: JsonRecord[] = [];
  const topPairs: JsonRecord[] = [];
  for (const left of symbols) {
    const row: JsonRecord = { symbol: left };
    for (const right of symbols) {
      const leftSeries = series.get(left)!;
      const rightSeries = series.get(right)!;
      const commonDates = Array.from(leftSeries.keys()).filter((date) => rightSeries.has(date));
      const leftValues = commonDates.map((date) => leftSeries.get(date)!);
      const rightValues = commonDates.map((date) => rightSeries.get(date)!);
      const correlation = pearson(leftValues, rightValues);
      row[right] = round(correlation, 4);
      if (left < right) {
        topPairs.push({
          left,
          right,
          correlation: round(correlation, 4),
          overlap: commonDates.length,
        });
      }
    }
    matrix.push(row);
  }

  topPairs.sort((a, b) => Math.abs(numeric(b.correlation) ?? -1) - Math.abs(numeric(a.correlation) ?? -1));
  return {
    method: 'pearson_log_return',
    symbols,
    sample_lengths: sampleLengths,
    matrix,
    top_pairs: topPairs.slice(0, 10),
    data_quality: {
      status: symbols.length >= 2 ? 'ok' : 'warning',
      warnings: symbols.length >= 2 ? [] : ['相关性计算至少需要两个有历史 K 线的标的。'],
    },
  };
}

export function buildLiquiditySummary(assets: JsonRecord[]): JsonRecord {
  const rows = assets.map((asset) => {
    const quote = asRecord(asset.quote);
    const bars = extractBarsFromAsset(asset);
    const recent = bars.slice(-20);
    const volumes = recent.map((bar) => numeric(bar.volume)).filter((value): value is number => value !== null);
    const amounts = recent.map((bar) => numeric(bar.amount)).filter((value): value is number => value !== null);
    const latestAmount = numeric(quote?.amount) ?? amounts.at(-1) ?? null;
    const avgAmount20 = mean(amounts);
    const avgVolume20 = mean(volumes);
    const marketCap = numeric(quote?.float_market_cap) ?? numeric(quote?.market_cap);
    const turnoverProxyPct = marketCap && (latestAmount ?? avgAmount20)
      ? ((latestAmount ?? avgAmount20 ?? 0) / marketCap) * 100
      : null;

    let previousClose: number | null = null;
    const amihudValues: number[] = [];
    for (const bar of bars.slice(-60)) {
      const close = numeric(bar.close);
      const amount = numeric(bar.amount);
      if (close !== null && previousClose !== null && previousClose > 0 && amount !== null && amount > 0) {
        amihudValues.push(Math.abs(close / previousClose - 1) / amount);
      }
      if (close !== null) {
        previousClose = close;
      }
    }
    const amihud = mean(amihudValues);
    const warnings: string[] = [];
    if (bars.length < 20) {
      warnings.push('K 线样本少于 20 条，流动性均值稳定性较弱。');
    }
    if (avgAmount20 === null) {
      warnings.push('缺少成交额字段，无法计算 20 日平均成交额。');
    }
    if (amihud === null) {
      warnings.push('缺少连续收盘价或成交额，无法计算 Amihud 非流动性。');
    }

    return {
      symbol: String(asset.symbol ?? quote?.symbol ?? ''),
      name: String(asset.name ?? quote?.name ?? asset.symbol ?? ''),
      sample_size: bars.length,
      latest_amount: round(latestAmount),
      avg_amount_20d: round(avgAmount20),
      avg_volume_20d: round(avgVolume20),
      turnover_proxy_pct: round(turnoverProxyPct, 4),
      amihud_illiquidity_x1e9: round(amihud === null ? null : amihud * 1_000_000_000, 6),
      liquidity_score:
        avgAmount20 === null ? 'unknown' : avgAmount20 >= 1_000_000_000 ? 'high' : avgAmount20 >= 100_000_000 ? 'medium' : 'low',
      warnings,
    };
  });

  return {
    method: 'amount_volume_amihud_proxy',
    window: '20d',
    rows,
    data_quality: {
      status: rows.some((row) => Array.isArray(row.warnings) && row.warnings.length > 0) ? 'warning' : 'ok',
      warnings: rows.flatMap((row) => (Array.isArray(row.warnings) ? row.warnings : [])),
    },
  };
}

export function buildHoldingRows(assets: JsonRecord[]): JsonRecord[] {
  const equalWeight = assets.length > 0 ? 1 / assets.length : 0;
  return assets.map((asset) => {
    const quote = asRecord(asset.quote);
    const symbol = String(asset.symbol ?? quote?.symbol ?? '');
    const price = numeric(quote?.price);
    const marketValue = price === null ? null : round(price * equalWeight * 10_000);
    return {
      symbol,
      name: String(asset.name ?? quote?.name ?? symbol),
      shares: null,
      cost_price: null,
      current_price: price,
      market_value: marketValue,
      weight: round(equalWeight * 100, 2),
      pnl: null,
      pnl_pct: null,
      source: 'market_prefetch',
      data_gaps: ['shares', 'cost_price', 'actual_market_value'],
    };
  });
}

export function buildPortfolioSummary(assets: JsonRecord[]): JsonRecord {
  const holdings = buildHoldingRows(assets);
  const weights = holdings.map((holding) => numeric(holding.weight)).filter((value): value is number => value !== null);
  const maxWeight = weights.length ? Math.max(...weights) : null;
  return {
    generated_from: 'symbols_without_broker_position_detail',
    total_asset: null,
    market_value: null,
    cash: null,
    position_pct: null,
    floating_pnl: null,
    floating_pnl_pct: null,
    concentration: {
      max_weight_pct: maxWeight,
      top3_weight_pct: round(weights.sort((a, b) => b - a).slice(0, 3).reduce((sum, value) => sum + value, 0)),
      method: 'equal_weight_proxy_until_user_position_fields_are_confirmed',
    },
    data_gaps: ['total_asset', 'cash', 'shares', 'cost_price', 'actual_weight'],
    warnings: [
      '平台只能从用户问题和行情接口预取标的，真实持仓数量、成本、现金和权重需要用户补充或由截图识别后确认。',
    ],
  };
}
