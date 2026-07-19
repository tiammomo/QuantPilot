#!/usr/bin/env node

const http = require('http');

const port = Number.parseInt(process.env.PORT || process.env.QUANTPILOT_CONTRACT_MARKET_PORT || '8000', 10);
const host = process.env.QUANTPILOT_CONTRACT_MARKET_HOST || '127.0.0.1';
const now = new Date().toISOString();
const asOf = now.slice(0, 10);

const securities = [
  { symbol: '600519', name: '贵州茅台', asset_type: 'stock', market: 'SH', price: 1253.0 },
  { symbol: '000300', name: '沪深300', asset_type: 'index', market: 'SH', price: 4520.4 },
  { symbol: '510300', name: '沪深300ETF华泰柏瑞', asset_type: 'etf', market: 'SH', price: 4.72 },
  { symbol: '000001', name: '平安银行', asset_type: 'stock', market: 'SZ', price: 11.86 },
  { symbol: '300750', name: '宁德时代', asset_type: 'stock', market: 'SZ', price: 315.2 },
  { symbol: '600126', name: '杭钢股份', asset_type: 'stock', market: 'SH', price: 9.18 },
  { symbol: '601816', name: '京沪高铁', asset_type: 'stock', market: 'SH', price: 5.62 },
  { symbol: '002555', name: '三七互娱', asset_type: 'stock', market: 'SZ', price: 18.74 },
  { symbol: '600916', name: '中国黄金', asset_type: 'stock', market: 'SH', price: 8.96 },
  { symbol: '002624', name: '完美世界', asset_type: 'stock', market: 'SZ', price: 15.43 },
  { symbol: '600030', name: '中信证券', asset_type: 'stock', market: 'SH', price: 28.65 },
];

const bySymbol = new Map(securities.map((security) => [security.symbol, security]));
const exactAliases = new Map([
  ['沪深300ETF', '510300'],
  ['300ETF', '510300'],
  ...securities.flatMap((security) => [
    [security.symbol, security.symbol],
    [security.name, security.symbol],
  ]),
]);

function round(value, digits = 4) {
  return Number(value.toFixed(digits));
}

function dataQuality(status = 'ok', warnings = []) {
  return { status, missing_fields: [], warnings };
}

function securityFor(value) {
  const symbol = exactAliases.get(String(value || '').trim());
  return symbol ? bySymbol.get(symbol) : null;
}

function identity(security) {
  return {
    symbol: security.symbol,
    name: security.name,
    secid: `${security.market === 'SH' ? '1' : '0'}.${security.symbol}`,
    asset_type: security.asset_type,
    market: security.market,
    source: 'contract_snapshot',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
  };
}

function quote(security) {
  const price = security.price;
  return {
    ...identity(security),
    price: String(price),
    open: String(round(price * 0.994, 3)),
    high: String(round(price * 1.012, 3)),
    low: String(round(price * 0.982, 3)),
    previous_close: String(round(price * 0.997, 3)),
    change_percent: '0.30',
    change_amount: String(round(price * 0.003, 3)),
    amplitude: '3.00',
    turnover: '1.28',
    volume: 1850000,
    amount: String(round(price * 1850000, 2)),
    market_cap: String(round(price * 1000000000, 2)),
    float_market_cap: String(round(price * 820000000, 2)),
    pe_ttm: security.asset_type === 'stock' ? '18.50' : null,
    pb_mrq: security.asset_type === 'stock' ? '2.60' : null,
    industry: security.asset_type === 'stock' ? '合同快照行业' : null,
    region: security.asset_type === 'stock' ? '中国' : null,
    concepts: [],
    quote_time: now,
    as_of: now,
    fetched_at: now,
    data_quality: dataQuality(),
  };
}

function bars(security, limit) {
  const count = Math.max(80, Math.min(limit || 120, 300));
  const end = new Date(`${asOf}T00:00:00.000Z`);
  const rows = [];
  for (let index = 0; index < count; index += 1) {
    const date = new Date(end);
    date.setUTCDate(end.getUTCDate() - (count - index - 1));
    const trend = 0.82 + index * 0.00155;
    const wave = Math.sin(index / 7) * 0.018 + Math.cos(index / 17) * 0.011;
    const close = security.price * (trend + wave);
    const previousClose = index === 0 ? close * 0.998 : Number(rows[index - 1].close);
    const open = close * (1 - Math.sin(index / 5) * 0.004);
    const high = Math.max(open, close) * 1.009;
    const low = Math.min(open, close) * 0.991;
    rows.push({
      date: date.toISOString().slice(0, 10),
      open: String(round(open, 4)),
      close: String(round(close, 4)),
      high: String(round(high, 4)),
      low: String(round(low, 4)),
      previous_close: String(round(previousClose, 4)),
      volume: 1000000 + index * 7300,
      amount: String(round(close * (1000000 + index * 7300), 2)),
      amplitude: '1.80',
      change_percent: String(round(((close / previousClose) - 1) * 100, 4)),
      change_amount: String(round(close - previousClose, 4)),
      turnover: '1.20',
      trade_status: '1',
      is_st: false,
      limit_up: false,
      limit_down: false,
      metadata: {},
    });
  }
  return rows;
}

function average(rows, endIndex, window) {
  if (endIndex + 1 < window) return null;
  const values = rows.slice(endIndex + 1 - window, endIndex + 1).map((row) => Number(row.close));
  return round(values.reduce((sum, value) => sum + value, 0) / values.length, 4);
}

function history(security, limit) {
  const rows = bars(security, limit);
  return {
    ...identity(security),
    period: 'daily',
    adjustment: 'qfq',
    bars: rows,
    as_of: asOf,
    fetched_at: now,
    metadata: { data_basis: 'versioned_contract_snapshot', coverage: { row_count: rows.length } },
    data_quality: dataQuality(),
  };
}

function technical(security, limit) {
  const rows = bars(security, limit);
  let peak = 0;
  const points = rows.map((row, index) => {
    const close = Number(row.close);
    peak = Math.max(peak, close);
    return {
      date: row.date,
      close: row.close,
      volume: row.volume,
      ma5: average(rows, index, 5),
      ma10: average(rows, index, 10),
      ma20: average(rows, index, 20),
      ma30: average(rows, index, 30),
      ma60: average(rows, index, 60),
      return_pct: index === 0 ? null : round(((close / Number(rows[index - 1].close)) - 1) * 100, 4),
      drawdown_pct: round(((close / peak) - 1) * 100, 4),
    };
  });
  const last = points.at(-1);
  const first = points[0];
  const maxDrawdown = Math.min(...points.map((point) => point.drawdown_pct));
  return {
    ...identity(security),
    period: 'daily',
    adjustment: 'qfq',
    points,
    summary: {
      latest_close: last.close,
      period_return_pct: round(((Number(last.close) / Number(first.close)) - 1) * 100, 4),
      max_drawdown_pct: maxDrawdown,
      volatility_annualized_pct: 18.2,
      avg_volume20: 2400000,
      ma5: last.ma5,
      ma10: last.ma10,
      ma20: last.ma20,
      ma30: last.ma30,
      ma60: last.ma60,
    },
    as_of: asOf,
    fetched_at: now,
    metadata: { data_basis: 'versioned_contract_snapshot', coverage: { row_count: points.length } },
    data_quality: dataQuality(),
  };
}

function financials(security) {
  const reports = [0, 1, 2, 3].map((offset) => ({
    symbol: security.symbol,
    name: security.name,
    secucode: `${security.symbol}.${security.market}`,
    report_date: `${2026 - Math.floor(offset / 2)}-${offset % 2 === 0 ? '03-31' : '12-31'}T00:00:00Z`,
    data_type: offset % 2 === 0 ? '一季报' : '年报',
    basic_eps: String(round(2.5 - offset * 0.12, 2)),
    revenue: String(52000000000 - offset * 2200000000),
    parent_net_profit: String(24000000000 - offset * 1100000000),
    weighted_roe: String(round(14.8 - offset * 0.6, 2)),
    gross_margin: String(round(62.5 - offset * 0.5, 2)),
    revenue_yoy: String(round(8.4 - offset * 0.4, 2)),
    net_profit_yoy: String(round(7.1 - offset * 0.35, 2)),
    operating_cash_flow_per_share: String(round(3.2 - offset * 0.1, 2)),
    notice_date: `${2026 - Math.floor(offset / 2)}-04-25T00:00:00Z`,
    source: 'contract_snapshot',
  }));
  return {
    symbol: security.symbol,
    asset_type: security.asset_type,
    source: 'contract_snapshot',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    reports,
    as_of: reports[0].report_date,
    fetched_at: now,
    data_quality: dataQuality(),
  };
}

function fundamentalIndicators(security) {
  const reports = financials(security).reports;
  const points = reports.map((report) => ({
    report_date: report.report_date,
    data_type: report.data_type,
    revenue: report.revenue,
    parent_net_profit: report.parent_net_profit,
    revenue_yoy: report.revenue_yoy,
    net_profit_yoy: report.net_profit_yoy,
    operating_cash_flow_per_share: report.operating_cash_flow_per_share,
    operating_cash_flow_per_share_yoy: '5.20',
    gross_margin: report.gross_margin,
    weighted_roe: report.weighted_roe,
    net_margin: '45.20',
  }));
  return {
    symbol: security.symbol,
    asset_type: security.asset_type,
    source: 'contract_snapshot',
    currency: 'CNY',
    timezone: 'Asia/Shanghai',
    points,
    summary: {
      latest_report_date: points[0].report_date,
      latest_revenue: points[0].revenue,
      latest_parent_net_profit: points[0].parent_net_profit,
      latest_revenue_yoy: points[0].revenue_yoy,
      latest_net_profit_yoy: points[0].net_profit_yoy,
      latest_operating_cash_flow_per_share: points[0].operating_cash_flow_per_share,
      latest_operating_cash_flow_per_share_yoy: points[0].operating_cash_flow_per_share_yoy,
      latest_gross_margin: points[0].gross_margin,
      latest_weighted_roe: points[0].weighted_roe,
      latest_net_margin: points[0].net_margin,
      avg_roe: 13.9,
      avg_gross_margin: 61.8,
      avg_net_margin: 44.6,
      report_count: points.length,
    },
    as_of: points[0].report_date,
    fetched_at: now,
    data_quality: dataQuality(),
  };
}

function announcements(security) {
  return {
    symbol: security.symbol,
    asset_type: security.asset_type,
    source: 'contract_snapshot',
    timezone: 'Asia/Shanghai',
    announcements: [
      {
        art_code: `CONTRACT-${security.symbol}-1`,
        title: `${security.name}定期报告公告`,
        symbol: security.symbol,
        name: security.name,
        notice_date: `${asOf}T00:00:00Z`,
        columns: ['定期报告'],
        url: `https://data.eastmoney.com/notices/detail/${security.symbol}/contract.html`,
        source: 'contract_snapshot',
      },
    ],
    as_of: `${asOf}T00:00:00Z`,
    fetched_at: now,
    data_quality: dataQuality(),
  };
}

function backtest(security) {
  const rows = bars(security, 250);
  const points = technical(security, 250).points;
  const equityCurve = rows.map((row, index) => ({
    date: row.date,
    close: row.close,
    fast_ma: points[index].ma20,
    slow_ma: points[index].ma60,
    position: index >= 60 ? 1 : 0,
    daily_return_pct: points[index].return_pct,
    strategy_return_pct: index >= 60 ? points[index].return_pct : 0,
    equity: String(round(1 + Math.max(0, index - 60) * 0.0014, 6)),
    drawdown_pct: points[index].drawdown_pct,
  }));
  return {
    ...identity(security),
    strategy_id: 'ma_crossover',
    strategy_name: '均线交叉趋势',
    fast_window: 20,
    slow_window: 60,
    fee_bps: '5.0000',
    parameters: { fast_window: 20, slow_window: 60, fee_bps: 5 },
    period: 'daily',
    adjustment: 'qfq',
    side: 'long',
    equity_curve: equityCurve,
    trades: [
      {
        entry_date: equityCurve[60].date,
        entry_price: equityCurve[60].close,
        exit_date: equityCurve[150].date,
        exit_price: equityCurve[150].close,
        return_pct: '8.20',
        holding_days: 90,
        status: 'closed',
      },
      {
        entry_date: equityCurve[170].date,
        entry_price: equityCurve[170].close,
        exit_date: null,
        exit_price: null,
        return_pct: '4.10',
        holding_days: 79,
        status: 'open',
      },
    ],
    summary: {
      start_date: equityCurve[0].date,
      end_date: equityCurve.at(-1).date,
      sample_count: equityCurve.length,
      initial_cash: '1.000000',
      final_equity: equityCurve.at(-1).equity,
      total_return_pct: '26.46',
      benchmark_return_pct: '18.20',
      excess_return_pct: '8.26',
      max_drawdown_pct: '-6.40',
      annualized_return_pct: '24.10',
      volatility_annualized_pct: '16.80',
      sharpe: '1.32',
      trade_count: 2,
      win_rate_pct: '50.00',
      exposure_pct: '76.00',
    },
    as_of: asOf,
    fetched_at: now,
    metadata: { data_basis: 'versioned_contract_snapshot' },
    data_quality: dataQuality(),
  };
}

function screener(url) {
  const requestedLimit = Number.parseInt(url.searchParams.get('limit') || '10', 10);
  return {
    universe_id: 'a-share-contract-universe',
    mode: url.searchParams.get('mode') || 'short_term',
    trade_date: url.searchParams.get('trade_date') || asOf,
    timeframe: 'daily',
    adjustment: 'qfq',
    scanned_symbols: securities.filter((security) => security.asset_type === 'stock').length,
    total_symbols: securities.filter((security) => security.asset_type === 'stock').length,
    eligible_symbols: 0,
    excluded_symbols: securities.filter((security) => security.asset_type === 'stock').length,
    excluded_reasons: { contract_safety_threshold: securities.length },
    safety_complete_symbols: securities.length,
    safety_coverage_pct: 100,
    coverage_warning: null,
    total_candidates: 0,
    limit: requestedLimit,
    candidates: [],
    data_basis: 'versioned_contract_snapshot',
    analytics: { engine: 'contract_snapshot', status: 'ready' },
    source: 'contract_snapshot',
    notes: ['版本化契约行情快照没有满足当前安全条件的候选。'],
    cache_status: 'fixture',
    cache_ttl_seconds: 0,
    fetched_at: now,
    data_quality: dataQuality('warning', ['契约模式使用版本化行情快照。']),
  };
}

function resolveSymbol(url) {
  const query = url.searchParams.get('query') || '';
  const security = securityFor(query);
  return {
    query,
    count: security ? 1 : 0,
    results: security
      ? [{ ...identity(security), query, confidence: 1 }]
      : [],
    source: 'contract_snapshot',
    fetched_at: now,
  };
}

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  response.end(body);
}

async function requestBody(request) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return body ? JSON.parse(body) : {};
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://${host}:${port}`);
    if (url.pathname === '/health') {
      json(response, 200, { status: 'ok', mode: 'versioned_contract_snapshot', as_of: asOf });
      return;
    }
    if (url.pathname === '/api/v1/symbols/resolve') {
      json(response, 200, resolveSymbol(url));
      return;
    }
    if (url.pathname === '/api/v1/research/screeners/a-share/short-term-candidates') {
      json(response, 200, screener(url));
      return;
    }
    if (url.pathname === '/api/v1/quotes/realtime' && request.method === 'POST') {
      const body = await requestBody(request);
      const symbols = Array.isArray(body.symbols) ? body.symbols : [];
      json(response, 200, {
        quotes: symbols.map(securityFor).filter(Boolean).map(quote),
        source: 'contract_snapshot',
        fetched_at: now,
        data_quality: dataQuality(),
      });
      return;
    }

    const match = url.pathname.match(/^\/api\/v1\/(quotes\/realtime|quotes\/history|indicators\/technical|fundamentals\/financials|indicators\/fundamental|events\/announcements|backtests\/ma-crossover)\/([^/]+)$/);
    if (match) {
      const [, endpoint, symbol] = match;
      const security = securityFor(symbol);
      if (!security) {
        json(response, 404, { detail: `unknown contract snapshot symbol: ${symbol}` });
        return;
      }
      const limit = Number.parseInt(url.searchParams.get('limit') || '120', 10);
      const handlers = {
        'quotes/realtime': () => quote(security),
        'quotes/history': () => history(security, limit),
        'indicators/technical': () => technical(security, limit),
        'fundamentals/financials': () => financials(security),
        'indicators/fundamental': () => fundamentalIndicators(security),
        'events/announcements': () => announcements(security),
        'backtests/ma-crossover': () => backtest(security),
      };
      json(response, 200, handlers[endpoint]());
      return;
    }

    json(response, 404, { detail: `contract snapshot endpoint not found: ${url.pathname}` });
  } catch (error) {
    json(response, 500, { detail: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(port, host, () => {
  console.log(`[contract-market] listening on http://${host}:${port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
