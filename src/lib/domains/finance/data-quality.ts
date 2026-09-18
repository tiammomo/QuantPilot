type JsonRecord = Record<string, unknown>;

export interface QuantDataIssue {
  code: string;
  path: string;
  severity: 'warning' | 'error';
}

export interface QuantDataAssessment {
  version: 1;
  status: 'passed' | 'warning' | 'failed';
  usable: boolean;
  rowCount: number | null;
  issues: QuantDataIssue[];
  issueCount: number;
}

const record = (value: unknown): JsonRecord | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;

function number(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.length > 128
    || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:$|[T ])/.test(value)) return null;
  const day = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== value.slice(0, 10)) return null;
  // Date-only values are compared as calendar dates, without a host-local timezone.
  const parsed = Date.parse(value.length === 10 ? `${value}T00:00:00Z` : value);
  return Number.isFinite(parsed) ? parsed : null;
}

function securityCode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(?:(?:SH|SZ|BJ)[.:])?(\d{6})(?:[.](?:SH|SZ|BJ))?$/i);
  return match?.[1] ?? null;
}

function explicitMarket(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(SH|SZ|BJ)[.:]\d{6}$|^\d{6}[.](SH|SZ|BJ)$/i.exec(value);
  return (match?.[1] ?? match?.[2])?.toUpperCase() ?? null;
}

/** Observed-data consistency only: this does not certify historical availability or freshness. */
export function assessQuantDataResponse(input: {
  path: string;
  query?: Record<string, unknown>;
  payload: unknown;
}): QuantDataAssessment {
  const issues: QuantDataIssue[] = [];
  let issueCount = 0;
  let failed = false;
  let usable = true;
  let rowCount: number | null = null;
  const issue = (code: string, path: string, severity: QuantDataIssue['severity'] = 'error') => {
    issueCount += 1;
    failed ||= severity === 'error';
    if (issues.length < 24) issues.push({ code, path, severity });
  };
  const payload = record(input.payload);
  if (!payload) issue('response_not_object', '$');
  else {
    if (payload.ok === false || payload.success === false || payload.error != null) issue('api_error_payload', '$');
    const quality = record(payload.data_quality);
    if (payload.data_quality !== undefined && (!quality || !['ok', 'warning', 'error'].includes(String(quality.status)))) {
      issue('quality_status_invalid', 'data_quality.status');
    }
    if (quality?.status === 'error') issue('source_quality_error', 'data_quality.status');
    else if (quality?.status === 'warning') issue('source_quality_warning', 'data_quality.status', 'warning');
    if (payload.stale === true || quality?.stale === true) issue('source_stale', 'data_quality', 'warning');

    const entityEndpoint = /^\/api\/v1\/(?:quotes\/(?:history|realtime)|research\/bars|indicators\/(?:technical|fundamental)|fundamentals\/financials|events\/(?:announcements|dividends)|backtests\/(?:ma-crossover|strategies\/[^/]+))\/([^/]+)$/.exec(input.path);
    const expected = entityEndpoint ? securityCode(decodeURIComponent(entityEndpoint[1])) : null;
    if (expected) {
      const actual = securityCode(payload.symbol);
      if (!actual) issue('symbol_missing', 'symbol');
      else if (actual !== expected) issue('symbol_mismatch', 'symbol');
      const expectedMarket = explicitMarket(decodeURIComponent(entityEndpoint![1]));
      const symbolMarket = explicitMarket(payload.symbol);
      const declaredMarket = payload.market ?? payload.exchange;
      const actualMarket = typeof declaredMarket === 'string' && /^(SH|SZ|BJ)$/i.test(declaredMarket)
        ? declaredMarket.toUpperCase() : symbolMarket;
      if (expectedMarket && !actualMarket) issue('market_missing', 'market');
      else if ((expectedMarket && actualMarket !== expectedMarket)
        || (symbolMarket && actualMarket !== symbolMarket)) issue('market_mismatch', 'market');
    }
    if (/^\/api\/v1\/quotes\/realtime\/[^/]+$/.test(input.path)) {
      if (payload.price == null || payload.price === '0' || payload.price === 0) {
        usable = false;
        issue('quote_price_missing', 'price', 'warning');
      } else {
        const price = number(payload.price);
        if (price === null || price < 0) issue('quote_price_invalid', 'price');
      }
    }
    for (const key of ['adjustment', 'period'] as const) {
      const requested = input.query?.[key];
      const actual = payload[key] ?? (key === 'period' ? payload.timeframe : undefined);
      if (typeof requested === 'string' && actual !== undefined && actual !== requested) {
        issue(`${key}_mismatch`, key);
      }
    }

    if (/^\/api\/v1\/(?:quotes\/history|research\/bars)\//.test(input.path)) {
      if (!Array.isArray(payload.bars)) issue('bars_missing', 'bars');
      else {
        rowCount = payload.bars.length;
        if (!rowCount) {
          usable = false;
          issue('empty_series', 'bars', 'warning');
        }
        if (rowCount > 20_000) issue('series_limit_exceeded', 'bars');
        let previous: number | null = null;
        const seen = new Set<number>();
        const asOf = timestamp(payload.as_of);
        const asOfEnd = asOf !== null && typeof payload.as_of === 'string' && payload.as_of.length === 10
          ? asOf + 86_400_000 - 1 : asOf;
        for (const [index, value] of payload.bars.slice(0, 20_000).entries()) {
          const bar = record(value);
          const prefix = `bars[${index}]`;
          if (!bar) { issue('bar_not_object', prefix); continue; }
          const time = timestamp(bar.date ?? bar.ts ?? bar.trade_date);
          if (time === null) issue('bar_time_invalid', `${prefix}.date`);
          else {
            if (seen.has(time)) issue('duplicate_bar_time', `${prefix}.date`);
            else if (previous !== null && time < previous) issue('bar_time_out_of_order', `${prefix}.date`);
            if (asOfEnd !== null && time > asOfEnd) issue('bar_after_as_of', `${prefix}.date`);
            seen.add(time);
            previous = time;
          }
          const prices: Record<string, number> = {};
          for (const field of ['open', 'high', 'low', 'close', 'volume', 'amount']) {
            if (bar[field] === undefined || bar[field] === null) {
              if (field === 'close') { usable = false; issue('close_missing', `${prefix}.close`, 'warning'); }
              continue;
            }
            const parsed = number(bar[field]);
            if (parsed === null || parsed < 0) issue('invalid_market_number', `${prefix}.${field}`);
            else prices[field] = parsed;
          }
          if (prices.high !== undefined && prices.low !== undefined && prices.high < prices.low) {
            issue('invalid_ohlc_range', prefix);
          }
          for (const field of ['open', 'close']) {
            if (prices[field] !== undefined && (
              (prices.high !== undefined && prices[field] > prices.high)
              || (prices.low !== undefined && prices[field] < prices.low)
            )) issue('price_outside_ohlc_range', `${prefix}.${field}`);
          }
        }
      }
    }
  }
  return {
    version: 1,
    status: failed ? 'failed' : issueCount ? 'warning' : 'passed',
    usable: usable && !failed,
    rowCount,
    issues,
    issueCount,
  };
}

export function assessQuantDashboardData(value: unknown): QuantDataAssessment[] {
  const root = record(value);
  if (!root) return [];
  const datasets = [root, ...(Array.isArray(root.assets) ? root.assets.map(record).filter(Boolean) as JsonRecord[] : [])];
  return datasets.flatMap(dataset => {
    const kline = record(dataset.kline ?? dataset.history);
    if (!kline) return [];
    return [assessQuantDataResponse({
      path: `/api/v1/quotes/history/${String(dataset.symbol ?? '')}`,
      payload: kline,
    })];
  });
}
