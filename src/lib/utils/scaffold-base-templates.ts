import { baseDashboardWorkbenchCss } from './scaffold-visual-language';

export function baseDashboardPageTemplate(): string {
  return `import fs from 'fs/promises';
import path from 'path';

type JsonRecord = Record<string, unknown>;

const DATA_FILE = 'data_file/final/dashboard-data.json';
const SOURCES_FILE = 'evidence/sources.json';

function asRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as JsonRecord;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function formatNumber(value: unknown, digits = 2): string {
  const number = numeric(value);
  if (number === null) {
    return '-';
  }
  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: digits,
  }).format(number);
}

function hasNumber(value: unknown): boolean {
  return numeric(value) !== null;
}

function displayNumber(value: unknown, digits = 2, empty = '待接入'): string {
  const number = numeric(value);
  if (number === null) {
    return empty;
  }
  return new Intl.NumberFormat('zh-CN', {
    maximumFractionDigits: digits,
  }).format(number);
}

function formatPercent(value: unknown): string {
  const number = numeric(value);
  if (number === null) {
    return '-';
  }
  return (number > 0 ? '+' : '') + number.toFixed(2) + '%';
}

function displayPercent(value: unknown, empty = '待接入'): string {
  const number = numeric(value);
  if (number === null) {
    return empty;
  }
  return (number > 0 ? '+' : '') + number.toFixed(2) + '%';
}

async function readDashboardData(): Promise<JsonRecord | null> {
  try {
    const content = await fs.readFile(
      path.join(/*turbopackIgnore: true*/ process.cwd(), DATA_FILE),
      'utf8'
    );
    const parsed = JSON.parse(content);
    return asRecord(parsed);
  } catch {
    return null;
  }
}

async function readSourcesEvidence(): Promise<JsonRecord[]> {
  try {
    const content = await fs.readFile(
      path.join(/*turbopackIgnore: true*/ process.cwd(), SOURCES_FILE),
      'utf8'
    );
    const parsed = asRecord(JSON.parse(content));
    return asArray(parsed?.sources)
      .map(asRecord)
      .filter((item): item is JsonRecord => Boolean(item));
  } catch {
    return [];
  }
}

function getBars(data: JsonRecord | null): JsonRecord[] {
  const kline = asRecord(data?.kline) ?? asRecord(data?.history);
  const assets = asArray(data?.assets).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  if (assets.length > 0) {
    const primaryAsset = assets.find((asset) => asArray(asRecord(asset.kline)?.bars).length > 0) ?? assets[0];
    return getBars(primaryAsset);
  }
  const candidates = [
    kline?.bars,
    kline?.data,
    kline?.items,
    data?.bars,
    data?.klines,
    data?.candles,
    Array.isArray(data?.history) ? data?.history : null,
  ];
  for (const candidate of candidates) {
    const bars = asArray(candidate).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
    if (bars.length > 0) {
      return bars;
    }
  }
  return [];
}

function getIndicatorSummary(data: JsonRecord | null): JsonRecord | null {
  const assets = asArray(data?.assets).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  if (assets.length > 0) {
    return getIndicatorSummary(assets[0]);
  }
  const technical = asRecord(data?.technicalIndicators) ?? asRecord(data?.indicators) ?? asRecord(data?.technical);
  return asRecord(technical?.summary) ?? asRecord(data?.summary);
}

function getFundamentalSummary(data: JsonRecord | null): JsonRecord | null {
  const assets = asArray(data?.assets).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  if (assets.length > 0) {
    return getFundamentalSummary(assets[0]);
  }
  const fundamental = asRecord(data?.fundamentalIndicators) ?? asRecord(data?.fundamentals) ?? asRecord(data?.financials);
  return asRecord(fundamental?.summary);
}

function getBacktest(data: JsonRecord | null): JsonRecord | null {
  const assets = asArray(data?.assets).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  if (assets.length > 0) {
    return getBacktest(assets[0]);
  }
  return asRecord(data?.backtest);
}

function getReports(data: JsonRecord | null): JsonRecord[] {
  const assets = asArray(data?.assets).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  if (assets.length > 0) {
    return getReports(assets[0]);
  }
  const financials = asRecord(data?.financials) ?? asRecord(data?.fundamentals);
  return asArray(financials?.reports ?? data?.reports).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
}

function getAnnouncements(data: JsonRecord | null): JsonRecord[] {
  const assets = asArray(data?.assets).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  if (assets.length > 0) {
    return getAnnouncements(assets[0]);
  }
  const announcements = asRecord(data?.announcements) ?? asRecord(data?.events);
  return asArray(announcements?.announcements ?? announcements?.items ?? data?.announcement_events).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
}

function formatMoney(value: unknown): string {
  const number = numeric(value);
  if (number === null) {
    return '-';
  }
  if (Math.abs(number) >= 100000000) {
    return formatNumber(number / 100000000, 2) + ' 亿';
  }
  if (Math.abs(number) >= 10000) {
    return formatNumber(number / 10000, 2) + ' 万';
  }
  return formatNumber(number);
}

function displayMoney(value: unknown, empty = '待接入'): string {
  const number = numeric(value);
  if (number === null) {
    return empty;
  }
  return formatMoney(number);
}

function formatDate(value: unknown): string {
  if (typeof value !== 'string' || !value) {
    return '-';
  }
  return value.slice(0, 10);
}

function formatDateTime(value: unknown): string {
  if (typeof value !== 'string' || !value) {
    return '-';
  }
  const normalized = value.replace('T', ' ').replace('Z', '');
  return normalized.slice(0, 19);
}

function displayDateTime(value: unknown): string {
  const formatted = formatDateTime(value);
  return formatted === '-' ? '等待数据接入' : formatted;
}

function qualityTone(status: unknown): 'quality-ok' | 'quality-warning' | 'quality-error' | 'quality-muted' {
  const normalized = String(status ?? '').toLowerCase();
  if (normalized === 'ok' || normalized.includes('pass')) return 'quality-ok';
  if (normalized === 'warning' || normalized.includes('warn')) return 'quality-warning';
  if (normalized === 'error' || normalized.includes('fail')) return 'quality-error';
  return 'quality-muted';
}

function getComputedMetrics(data: JsonRecord | null): JsonRecord | null {
  const assets = asArray(data?.assets).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  if (assets.length > 0) {
    return getComputedMetrics(assets[0]);
  }
  return asRecord(data?.computedMetrics);
}

function getTechnicalPoints(data: JsonRecord | null): JsonRecord[] {
  const technical = asRecord(data?.technicalIndicators);
  return asArray(technical?.points).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
}

function getLiquidityRows(data: JsonRecord | null): JsonRecord[] {
  const liquidity = asRecord(data?.liquidity);
  return asArray(liquidity?.rows).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
}

function getCorrelationPairs(data: JsonRecord | null): JsonRecord[] {
  const correlation = asRecord(data?.correlation);
  return asArray(correlation?.top_pairs).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
}

function getValuationRows(data: JsonRecord | null): JsonRecord[] {
  const valuation = asRecord(data?.valuation);
  const rows = asArray(valuation?.assets).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  if (rows.length > 0) {
    return rows;
  }
  const scenarios = asArray(valuation?.scenarios).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  if (scenarios.length === 0) {
    return [];
  }
  return [{
    symbol: data?.symbol,
    name: data?.name,
    base_metrics: valuation?.base_metrics ?? valuation?.baseMetrics,
    scenarios,
    warnings: valuation?.warnings,
  }];
}

function getTrendTemplateRows(data: JsonRecord | null): JsonRecord[] {
  const trendTemplate = asRecord(data?.trendTemplate) ?? asRecord(data?.trend_template);
  return asArray(trendTemplate?.rows).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
}

function getVisualization(data: JsonRecord | null): JsonRecord | null {
  return asRecord(data?.visualization);
}

function getVisualizationRows(visualization: JsonRecord | null): JsonRecord[] {
  const required = asArray(visualization?.required_components).map(String);
  const rendered = new Set(asArray(visualization?.rendered_components).map(String));
  const missing = new Set(asArray(visualization?.missing_components).map(String));
  return required.map((name) => ({
    name,
    status: missing.has(name) ? '待补充' : rendered.has(name) ? '已渲染' : '按模板渲染',
  }));
}

function sourceDisplayName(source: unknown, datasetType?: unknown): string {
  const normalized = String(source ?? '').toLowerCase();
  const type = String(datasetType ?? '').toLowerCase();
  if (normalized.includes('eastmoney')) {
    if (/kline|history|历史/.test(type)) return '东方财富历史 K 线接口';
    if (/financial|fundamental|财务/.test(type)) return '东方财富财务数据接口';
    if (/announcement|event|公告/.test(type)) return '东方财富公告事件接口';
    return '东方财富实时行情接口';
  }
  if (normalized.includes('uploaded_image')) return '用户上传持仓截图';
  if (normalized.includes('market_prefetch')) return 'QuantPilot 后端行情预取';
  if (normalized.includes('tencent')) return '腾讯证券行情接口';
  if (normalized.includes('sina')) return '新浪财经行情接口';
  if (normalized.includes('akshare')) return 'AKShare 免费数据接口';
  if (normalized.includes('local')) return '本地计算结果';
  return String(source ?? '未知信源');
}

function endpointLabel(endpoint: unknown): string {
  const value = String(endpoint ?? '');
  if (!value) return '-';
  if (value.includes('/quotes/realtime')) return '实时行情';
  if (value.includes('/quotes/history')) return '历史 K 线';
  if (value.includes('/fundamentals/financials')) return '财务报表';
  if (value.includes('/announcements')) return '公告事件';
  if (value.includes('/indicators')) return '指标计算';
  if (value.includes('/symbols/resolve')) return '标的解析';
  return value.replace(/^https?:\\/\\/127\\.0\\.0\\.1:8000\\/api\\/v1\\//, '/api/market/');
}

function inferSourceChannels(data: JsonRecord | null, sourceEvidence: JsonRecord[]): JsonRecord[] {
  if (sourceEvidence.length > 0) {
    const unique = new Map<string, JsonRecord>();
    for (const source of sourceEvidence) {
      const datasetType = source.dataset_type ?? source.type ?? source.dataset ?? source.name;
      const channel = sourceDisplayName(source.source, datasetType);
      const endpoint = endpointLabel(source.endpoint ?? source.url ?? source.route);
      const key = [channel, endpoint, String(source.symbol ?? source.name ?? '')].join('|');
      if (!unique.has(key)) {
        unique.set(key, {
          channel,
          dataset: String(datasetType ?? '数据集'),
          endpoint,
          as_of: source.as_of ?? source.quote_time ?? source.fetched_at ?? source.updated_at,
          sample_count: source.sample_count ?? source.rows ?? source.count ?? source.records,
          limitation: source.limitation ?? source.note ?? source.warning,
        });
      }
    }
    return Array.from(unique.values()).slice(0, 8);
  }

  const channels: JsonRecord[] = [];
  const rootSource = data?.source ?? asRecord(data?.quote)?.source ?? 'eastmoney';
  if (asRecord(data?.quote)) {
    const quote = asRecord(data?.quote);
    channels.push({
      channel: sourceDisplayName(rootSource, 'realtime'),
      dataset: '实时行情',
      endpoint: '/api/market/quotes/realtime',
      as_of: quote?.quote_time ?? quote?.fetched_at ?? data?.as_of,
    });
  }
  if (asArray(asRecord(data?.kline)?.bars).length > 0 || getBars(data).length > 0) {
    channels.push({
      channel: sourceDisplayName(rootSource, 'history'),
      dataset: '历史 K 线',
      endpoint: '/api/market/quotes/history',
      as_of: data?.as_of,
      sample_count: getBars(data).length,
    });
  }
  if (asRecord(data?.financials) || asRecord(data?.fundamentalIndicators)) {
    channels.push({
      channel: sourceDisplayName(rootSource, 'financials'),
      dataset: '财务与基本面',
      endpoint: '/api/market/fundamentals/financials',
      as_of: asRecord(data?.financials)?.as_of ?? data?.as_of,
    });
  }
  if (asRecord(data?.announcements)) {
    channels.push({
      channel: sourceDisplayName(rootSource, 'announcements'),
      dataset: '公告事件',
      endpoint: '/api/market/announcements',
      as_of: asRecord(data?.announcements)?.as_of ?? data?.as_of,
    });
  }
  if (asRecord(data?.imageExtraction)) {
    channels.push({
      channel: sourceDisplayName('uploaded_image', 'portfolio'),
      dataset: '截图识别',
      endpoint: '上传附件',
      as_of: asRecord(data?.imageExtraction)?.extracted_at ?? data?.as_of,
    });
  }
  return channels;
}

function movingAverage(values: Array<number | null>, windowSize: number, index: number): number | null {
  if (index + 1 < windowSize) {
    return null;
  }
  const windowValues = values.slice(index + 1 - windowSize, index + 1).filter((value): value is number => value !== null);
  if (windowValues.length < windowSize) {
    return null;
  }
  return windowValues.reduce((sum, value) => sum + value, 0) / windowValues.length;
}

function scaleY(value: number, min: number, max: number): number {
  const range = Math.max(max - min, 0.000001);
  return 350 - ((value - min) / range) * 320;
}

function buildLinePath(values: Array<number | null>, min: number, max: number): string {
  const validCount = values.filter((value): value is number => value !== null).length;
  if (validCount < 2) {
    return '';
  }
  let started = false;
  return values
    .map((value, index) => {
      if (value === null) {
        return '';
      }
      const x = 60 + (index / Math.max(values.length - 1, 1)) * 720;
      const y = scaleY(value, min, max);
      const segment = (started ? 'L ' : 'M ') + x.toFixed(2) + ' ' + y.toFixed(2);
      started = true;
      return segment;
    })
    .filter(Boolean)
    .join(' ');
}

function TrendChart({ bars }: { bars: JsonRecord[] }) {
  const visibleBars = bars.slice(-60);
  const hasBars = visibleBars.length > 0;
  const allCloses = bars.map((bar) => numeric(bar.close));
  const visibleOffset = Math.max(0, bars.length - visibleBars.length);
  const highs = visibleBars.map((bar) => numeric(bar.high) ?? numeric(bar.close)).filter((value): value is number => value !== null);
  const lows = visibleBars.map((bar) => numeric(bar.low) ?? numeric(bar.close)).filter((value): value is number => value !== null);
  const volumes = visibleBars.map((bar) => numeric(bar.volume) ?? 0);
  const minPrice = lows.length ? Math.min(...lows) : 0;
  const maxPrice = highs.length ? Math.max(...highs) : 1;
  const maxVolume = Math.max(1, ...volumes);
  const ma5 = allCloses.map((_, index) => movingAverage(allCloses, 5, index)).slice(visibleOffset);
  const ma10 = allCloses.map((_, index) => movingAverage(allCloses, 10, index)).slice(visibleOffset);
  const ma20 = allCloses.map((_, index) => movingAverage(allCloses, 20, index)).slice(visibleOffset);
  const ma60 = allCloses.map((_, index) => movingAverage(allCloses, 60, index)).slice(visibleOffset);
  const priceTicks = [maxPrice, maxPrice - (maxPrice - minPrice) * 0.25, maxPrice - (maxPrice - minPrice) * 0.5, maxPrice - (maxPrice - minPrice) * 0.75, minPrice];
  const dateLabels = visibleBars.length > 0
    ? [
        String(visibleBars[0]?.date ?? '').slice(5) || '-',
        String(visibleBars[Math.floor(visibleBars.length * 0.25)]?.date ?? '').slice(5) || '-',
        String(visibleBars[Math.floor(visibleBars.length * 0.5)]?.date ?? '').slice(5) || '-',
        String(visibleBars[Math.floor(visibleBars.length * 0.75)]?.date ?? '').slice(5) || '-',
        String(visibleBars[visibleBars.length - 1]?.date ?? '').slice(5) || '-',
      ]
    : ['-', '-', '-', '-', '-'];

  return (
    <div className="chart-panel">
      <div className="panel-heading">
        <div>
          <h2>K 线与量价结构</h2>
          <p>OHLC 蜡烛图、MA5/MA10/MA20/MA60、成交量和阶段走势</p>
        </div>
        <span>{bars.length} 条样本</span>
      </div>
      <div className="chart-legend">
        <span className="legend-price">K 线</span>
        <span className="legend-ma5">MA5</span>
        <span className="legend-ma10">MA10</span>
        <span className="legend-ma20">MA20</span>
        <span className="legend-ma60">MA60</span>
      </div>
      {!hasBars ? (
        <div className="chart-empty-state">
          <strong>等待 K 线数据接入</strong>
          <span>生成器已预留 OHLC、均线和成交量区域；数据文件写入后会自动渲染真实走势。</span>
        </div>
      ) : null}
      <svg className="trend-chart" viewBox="0 0 800 400" preserveAspectRatio="none" role="img" aria-label="K 线 OHLC 趋势图">
        <rect x="0" y="0" width="800" height="400" className="chart-bg" />
        <line x1="60" y1="350" x2="780" y2="350" className="axis" />
        <line x1="60" y1="30" x2="780" y2="30" className="axis muted" />
        <line x1="60" y1="110" x2="780" y2="110" className="axis grid" />
        <line x1="60" y1="190" x2="780" y2="190" className="axis grid" />
        <line x1="60" y1="270" x2="780" y2="270" className="axis grid" />
        <line x1="204" y1="30" x2="204" y2="350" className="axis grid" />
        <line x1="348" y1="30" x2="348" y2="350" className="axis grid" />
        <line x1="492" y1="30" x2="492" y2="350" className="axis grid" />
        <line x1="636" y1="30" x2="636" y2="350" className="axis grid" />
        {priceTicks.map((tick, index) => (
          <text key={index} x="56" y={['25', '105', '185', '275', '355'][index] || '185'} className="chart-label chart-price">
            {formatNumber(tick)}
          </text>
        ))}
        {dateLabels.map((label, index) => (
          <text key={index} x={(60 + index * 180).toFixed(0)} y="385" className="chart-label chart-date">
            {label}
          </text>
        ))}
        {visibleBars.map((bar, index) => {
          const open = numeric(bar.open) ?? numeric(bar.close);
          const close = numeric(bar.close) ?? open;
          const high = numeric(bar.high) ?? Math.max(open ?? 0, close ?? 0);
          const low = numeric(bar.low) ?? Math.min(open ?? 0, close ?? 0);
          if (open === null || close === null) {
            return null;
          }
          const x = 60 + (index / Math.max(visibleBars.length - 1, 1)) * 720;
          const yHigh = scaleY(high, minPrice, maxPrice);
          const yLow = scaleY(low, minPrice, maxPrice);
          const yOpen = scaleY(open, minPrice, maxPrice);
          const yClose = scaleY(close, minPrice, maxPrice);
          const candleTop = Math.min(yOpen, yClose);
          const candleHeight = Math.max(Math.abs(yClose - yOpen), 1.5);
          const candleWidth = 6;
          const up = close >= open;
          const candleLabel = \`\${String(bar.date ?? '-')} 开 \${formatNumber(open)} 高 \${formatNumber(high)} 低 \${formatNumber(low)} 收 \${formatNumber(close)}\`;
          return (
            <g
              key={String(bar.date ?? index)}
              className={up ? 'candle-up' : 'candle-down'}
              aria-label={candleLabel}
              data-tooltip={candleLabel}
            >
              <line x1={x.toFixed(1)} x2={x.toFixed(1)} y1={yHigh.toFixed(1)} y2={yLow.toFixed(1)} />
              <rect x={(x - candleWidth / 2).toFixed(1)} y={candleTop.toFixed(1)} width={candleWidth} height={candleHeight.toFixed(1)} rx="1" />
            </g>
          );
        })}
        <path d={buildLinePath(ma5, minPrice, maxPrice)} className="ma-line ma5" />
        <path d={buildLinePath(ma10, minPrice, maxPrice)} className="ma-line ma10" />
        <path d={buildLinePath(ma20, minPrice, maxPrice)} className="ma-line ma20" />
        <path d={buildLinePath(ma60, minPrice, maxPrice)} className="ma-line ma60" />
      </svg>

      <svg className="volume-chart" viewBox="0 0 800 120" preserveAspectRatio="none" role="img" aria-label="成交量柱状图">
        <rect x="0" y="0" width="800" height="120" className="chart-bg" />
        <line x1="60" y1="100" x2="780" y2="100" className="axis" />
        <line x1="60" y1="30" x2="780" y2="30" className="axis muted" />
        <line x1="60" y1="65" x2="780" y2="65" className="axis grid" />
        <line x1="204" y1="0" x2="204" y2="100" className="axis grid" />
        <line x1="348" y1="0" x2="348" y2="100" className="axis grid" />
        <line x1="492" y1="0" x2="492" y2="100" className="axis grid" />
        <line x1="636" y1="0" x2="636" y2="100" className="axis grid" />
        {visibleBars.map((bar, index) => {
          const open = numeric(bar.open) ?? numeric(bar.close) ?? 0;
          const close = numeric(bar.close) ?? open;
          const volume = numeric(bar.volume) ?? 0;
          const barHeight = Math.max(2, (volume / Math.max(maxVolume, 1)) * 80);
          const x = 60 + (index / Math.max(visibleBars.length - 1, 1)) * 720;
          const volumeLabel = \`\${String(bar.date ?? '-')} 成交量 \${formatNumber(volume, 0)}\`;
          return (
            <rect
              key={String(bar.date ?? index)}
              x={(x - 4).toFixed(1)}
              y={(100 - barHeight).toFixed(1)}
              width="8"
              height={barHeight.toFixed(1)}
              rx="1"
              className={close >= open ? 'volume-up' : 'volume-down'}
              aria-label={volumeLabel}
              data-tooltip={volumeLabel}
            />
          );
        })}
      </svg>
    </div>
  );
}

function buildEquityPath(points: JsonRecord[]): string {
  const values = points.map((point) => numeric(point.equity)).filter((value): value is number => value !== null);
  if (values.length < 2) {
    return '';
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = Math.max(max - min, 0.000001);
  return values
    .map((value, index) => {
      const x = 60 + (index / Math.max(values.length - 1, 1)) * 720;
      const y = 85 - ((value - min) / range) * 70;
      return (index === 0 ? 'M ' : 'L ') + x.toFixed(2) + ' ' + y.toFixed(2);
    })
    .join(' ');
}

function BacktestPanel({ backtest }: { backtest: JsonRecord | null }) {
  const summary = asRecord(backtest?.summary);
  const points = asArray(backtest?.equity_curve).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  const trades = asArray(backtest?.trades).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  const tradeCount = numeric(summary?.trade_count) ?? 0;
  const strategyId = String(backtest?.strategy_id ?? '').trim();
  const strategyName = String(backtest?.strategy_name ?? '').trim();
  const visibleTrades = trades.slice(-8).reverse();
  const equityPath = buildEquityPath(points);

  if (!backtest) {
    return null;
  }

  return (
    <section className="backtest-section">
      <div className="panel-heading">
        <div>
          <h2>回测复盘</h2>
          <p>
            {strategyName || strategyId || '策略名称缺失'}{strategyId ? '（' + strategyId + '）' : ''} · 参数窗口 {String(backtest.fast_window ?? '-')} / {String(backtest.slow_window ?? '-')} · 费用 {formatNumber(backtest.fee_bps)} bps
          </p>
        </div>
        <span>策略名称来源：回测数据 · {points.length} 个交易日</span>
      </div>

      <div className="metric-strip four-col backtest-metrics">
        <div className="metric-cell"><span className="metric-label">策略收益</span><span className={'metric-value ' + ((numeric(summary?.total_return_pct) ?? 0) >= 0 ? 'red' : 'green')}>{formatPercent(summary?.total_return_pct)}</span></div>
        <div className="metric-cell"><span className="metric-label">最大回撤</span><span className="metric-value green">{formatPercent(summary?.max_drawdown_pct)}</span></div>
        <div className="metric-cell"><span className="metric-label">胜率</span><span className="metric-value">{formatPercent(summary?.win_rate_pct)}</span></div>
        <div className="metric-cell"><span className="metric-label">已完成交易</span><span className="metric-value">{formatNumber(tradeCount, 0)} 笔</span></div>
      </div>

      <div className="backtest-grid">
        <div className="chart-panel embedded">
          <div className="panel-heading compact">
            <div>
              <h2>策略净值</h2>
              <p>全仓/空仓规则下的净值曲线</p>
            </div>
            <span>净值 {formatNumber(summary?.final_equity, 4)}</span>
          </div>
          <svg className="trend-chart" viewBox="0 0 800 100" preserveAspectRatio="none" role="img" aria-label="回测净值曲线">
            <rect x="0" y="0" width="800" height="100" className="chart-bg" />
            <line x1="60" y1="85" x2="780" y2="85" className="axis" />
            <line x1="60" y1="15" x2="780" y2="15" className="axis muted" />
            <line x1="60" y1="50" x2="780" y2="50" className="axis grid" />
            {equityPath ? <path d={equityPath} className="equity-line" /> : null}
          </svg>
        </div>

        <article className="data-panel">
          <h2>交易明细</h2>
          <p className="panel-note">展示 {visibleTrades.length} / 共 {trades.length} 笔记录，其中 {formatNumber(tradeCount, 0)} 笔已完成。</p>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>买入</th><th>卖出</th><th>收益</th><th>天数</th></tr>
              </thead>
              <tbody>
                {visibleTrades.map((trade, index) => (
                  <tr key={String(trade.entry_date ?? index)}>
                    <td>{String(trade.entry_date ?? '-')}</td>
                    <td>{String(trade.exit_date ?? trade.status ?? '-')}</td>
                    <td className={(numeric(trade.return_pct) ?? 0) >= 0 ? 'red' : 'green'}>{formatPercent(trade.return_pct)}</td>
                    <td>{formatNumber(trade.holding_days, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="empty-state">当前回测暂未建模滑点、停牌、分红再投资和冲击成本，结果用于策略研究参考。</p>
        </article>
      </div>
    </section>
  );
}

function FinancialPanel({
  reports,
  summary,
}: {
  reports: JsonRecord[];
  summary: JsonRecord | null;
}) {
  const recentReports = reports.slice(0, 6);
  const chartReports = recentReports.slice().reverse();
  const maxRevenue = Math.max(
    1,
    ...chartReports.map((report) => numeric(report.revenue) ?? 0)
  );

  return (
    <article className="data-panel financial-panel">
      <div className="panel-heading compact">
        <div>
          <h2>财务趋势</h2>
          <p>营收、归母净利润、ROE、毛利率和净利率</p>
        </div>
        <span>{reports.length} 期</span>
      </div>

      <div className="mini-metric-grid">
        <div className="mini-metric"><span>最新营收</span><strong>{formatMoney(summary?.latest_revenue)}</strong></div>
        <div><span>归母净利</span><strong>{formatMoney(summary?.latest_parent_net_profit)}</strong></div>
        <div><span>平均 ROE</span><strong>{formatPercent(summary?.avg_roe)}</strong></div>
        <div><span>净利率</span><strong>{formatPercent(summary?.latest_net_margin)}</strong></div>
      </div>

      {chartReports.length > 0 ? (
        <div className="financial-bars" aria-label="财务柱状趋势图">
          {chartReports.map((report, index) => {
            const revenue = numeric(report.revenue) ?? 0;
            const profit = numeric(report.parent_net_profit) ?? 0;
            const revenueHeight = Math.max(8, (revenue / maxRevenue) * 100);
            const profitHeight = Math.max(6, Math.min(100, (profit / maxRevenue) * 100));
            return (
              <div className="financial-bar-group" key={String(report.report_date ?? index)}>
                <div className="bar-stack">
                  <span className="bar revenue" style={{ height: revenueHeight + '%' }} />
                  <span className="bar profit" style={{ height: profitHeight + '%' }} />
                </div>
                <small>{formatDate(report.report_date)}</small>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="empty-state">暂无财务摘要。指数或 ETF 标的通常不提供个股财务报表。</p>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>报告期</th><th>营收</th><th>净利润</th><th>ROE</th><th>毛利率</th></tr>
          </thead>
          <tbody>
            {recentReports.map((report, index) => (
              <tr key={String(report.report_date ?? index)}>
                <td>{formatDate(report.report_date)}</td>
                <td>{formatMoney(report.revenue)}</td>
                <td>{formatMoney(report.parent_net_profit)}</td>
                <td>{formatPercent(report.weighted_roe)}</td>
                <td>{formatPercent(report.gross_margin)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </article>
  );
}

function AnnouncementPanel({ announcements }: { announcements: JsonRecord[] }) {
  const recent = announcements.slice(0, 6);

  return (
    <article className="data-panel">
      <div className="panel-heading compact">
        <div>
          <h2>公告事件</h2>
          <p>近期公告标题、日期和事件线索</p>
        </div>
        <span>{announcements.length} 条</span>
      </div>
      {recent.length > 0 ? (
        <ul className="announcement-list">
          {recent.map((item, index) => (
            <li key={String(item.art_code ?? index)}>
              <span>{formatDate(item.notice_date ?? item.display_time)}</span>
              <strong>{String(item.title ?? '未命名公告')}</strong>
              <em>{asArray(item.columns).map(String).join(' / ') || '公告'}</em>
            </li>
          ))}
        </ul>
      ) : (
        <p className="empty-state">暂无公告事件。指数或 ETF 标的通常不提供个股公告列表。</p>
      )}
    </article>
  );
}

function LiquidityPanel({ rows }: { rows: JsonRecord[] }) {
  if (rows.length === 0) {
    return null;
  }

  return (
    <article className="data-panel">
      <div className="panel-heading compact">
        <div>
          <h2>流动性摘要</h2>
          <p>20 日成交额、成交量、换手代理和 Amihud 非流动性</p>
        </div>
        <span>{rows.length} 项</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>标的</th><th>等级</th><th>20 日均额</th><th>换手代理</th><th>Amihud x1e9</th></tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={String(row.symbol ?? index)}>
                <td><strong>{String(row.name ?? row.symbol)}</strong><small>{String(row.symbol ?? '-')}</small></td>
                <td>{String(row.liquidity_score ?? '-')}</td>
                <td>{formatMoney(row.avg_amount_20d)}</td>
                <td>{formatPercent(row.turnover_proxy_pct)}</td>
                <td>{formatNumber(row.amihud_illiquidity_x1e9, 6)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </article>
  );
}

function CorrelationPanel({ pairs }: { pairs: JsonRecord[] }) {
  if (pairs.length === 0) {
    return null;
  }

  return (
    <article className="data-panel">
      <div className="panel-heading compact">
        <div>
          <h2>相关性结构</h2>
          <p>基于对齐日期后的日收益率，展示联动最高的标的组合</p>
        </div>
        <span>{pairs.length} 组</span>
      </div>
      <div className="correlation-list compact-list">
        {pairs.slice(0, 6).map((pair, index) => {
          const correlation = numeric(pair.correlation);
          const width = Math.max(4, Math.abs(correlation ?? 0) * 100);
          return (
            <div className="correlation-row compact-row" key={String(pair.left ?? index) + String(pair.right ?? '')}>
              <div>
                <strong>{String(pair.left ?? '-')} / {String(pair.right ?? '-')}</strong>
                <small>重合样本 {formatNumber(pair.overlap, 0)} 个交易日</small>
              </div>
              <div className="correlation-meter">
                <span style={{ width: width + '%' }} className={(correlation ?? 0) >= 0 ? 'corr-positive' : 'corr-negative'} />
              </div>
              <em>{formatNumber(correlation, 4)}</em>
            </div>
          );
        })}
      </div>
    </article>
  );
}

function ValuationPanel({ rows }: { rows: JsonRecord[] }) {
  if (rows.length === 0) {
    return null;
  }

  return (
    <article className="data-panel">
      <div className="panel-heading compact">
        <div>
          <h2>估值情景</h2>
          <p>防守、中性、进攻三档假设；用于研究，不构成收益承诺</p>
        </div>
        <span>{rows.length} 项</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>标的</th><th>当前价</th><th>PE</th><th>EPS</th><th>中性情景价</th><th>中性空间</th></tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const metrics = asRecord(row.base_metrics) ?? asRecord(row.baseMetrics) ?? {};
              const scenarios = asArray(row.scenarios).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
              const baseScenario = scenarios.find((item) => item.case === 'base') ?? scenarios[1] ?? scenarios[0];
              return (
                <tr key={String(row.symbol ?? index)}>
                  <td><strong>{String(row.name ?? row.symbol ?? '-')}</strong><small>{String(row.symbol ?? '-')}</small></td>
                  <td>{formatNumber(metrics.price)}</td>
                  <td>{formatNumber(metrics.pe_ttm ?? metrics.pe)}</td>
                  <td>{formatNumber(metrics.eps, 4)}</td>
                  <td>{formatNumber(baseScenario?.implied_price)}</td>
                  <td className={(numeric(baseScenario?.upside_pct) ?? 0) >= 0 ? 'red' : 'green'}>{formatPercent(baseScenario?.upside_pct)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </article>
  );
}

function TrendTemplatePanel({ rows }: { rows: JsonRecord[] }) {
  if (rows.length === 0) {
    return null;
  }

  return (
    <article className="data-panel">
      <div className="panel-heading compact">
        <div>
          <h2>趋势模板</h2>
          <p>MA20/MA60、阶段回撤、量能比和样本长度</p>
        </div>
        <span>{rows.length} 项</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>标的</th><th>状态</th><th>分数</th><th>MA20</th><th>MA60</th><th>20 日收益</th><th>120 日回撤</th></tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const metrics = asRecord(row.metrics) ?? {};
              return (
                <tr key={String(row.symbol ?? index)}>
                  <td><strong>{String(row.name ?? row.symbol ?? '-')}</strong><small>{String(row.symbol ?? '-')}</small></td>
                  <td>{String(row.state ?? '-')}</td>
                  <td>{formatNumber(row.score, 0)}</td>
                  <td>{formatNumber(metrics.ma20)}</td>
                  <td>{formatNumber(metrics.ma60)}</td>
                  <td className={(numeric(metrics.return_20d_pct) ?? 0) >= 0 ? 'red' : 'green'}>{formatPercent(metrics.return_20d_pct)}</td>
                  <td className="green">{formatPercent(metrics.max_drawdown_120d_pct)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </article>
  );
}

function VisualizationPlanPanel({ visualization }: { visualization: JsonRecord | null }) {
  const rows = getVisualizationRows(visualization);
  if (!visualization || rows.length === 0) {
    return null;
  }

  return (
    <article className="data-panel">
      <div className="panel-heading compact">
        <div>
          <h2>场景模板</h2>
          <p>{String(visualization.name ?? visualization.template_id ?? 'QuantPilot 场景化看板')}</p>
        </div>
        <span>{String(visualization.template_id ?? '-')}</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>必备组件</th><th>状态</th></tr>
          </thead>
          <tbody>
            {rows.slice(0, 8).map((row, index) => (
              <tr key={String(row.name ?? index)}>
                <td>{String(row.name ?? '-')}</td>
                <td>{String(row.status ?? '-')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </article>
  );
}

function SignalPanel({
  quote,
  latestBar,
  summary,
  computedMetrics,
  data,
}: {
  quote: JsonRecord | null;
  latestBar?: JsonRecord;
  summary: JsonRecord | null;
  computedMetrics: JsonRecord | null;
  data: JsonRecord | null;
}) {
  const latestPrice = numeric(quote?.price ?? latestBar?.close);
  const ma5 = numeric(summary?.ma5 ?? computedMetrics?.ma5);
  const ma20 = numeric(summary?.ma20 ?? computedMetrics?.ma20);
  const ma60 = numeric(summary?.ma60 ?? computedMetrics?.ma60);
  const volume = numeric(latestBar?.volume);
  const avgVolume = numeric(computedMetrics?.avgVolume20d ?? summary?.avg_volume20 ?? summary?.avg_volume_20d);
  const maxDrawdown = numeric(summary?.max_drawdown_pct ?? computedMetrics?.maxDrawdown);
  const volatility = numeric(
    summary?.volatility_20d_annualized_pct ?? computedMetrics?.volatility20d
  );
  const aboveMa20 = latestPrice !== null && ma20 !== null ? latestPrice >= ma20 : null;
  const maTrend = ma5 !== null && ma20 !== null ? ma5 >= ma20 : null;
  const volumeSignal = volume !== null && avgVolume !== null ? volume / Math.max(avgVolume, 1) : null;
  const riskLevel =
    maxDrawdown === null && volatility === null
      ? '待确认'
      : (maxDrawdown !== null && maxDrawdown <= -20) || (volatility !== null && volatility >= 35)
        ? '高'
        : (maxDrawdown !== null && maxDrawdown <= -10) || (volatility !== null && volatility >= 22)
          ? '中'
          : '低';
  const dataQuality = asRecord(data?.data_quality) ?? asRecord(asRecord(data?.kline)?.data_quality);
  const dataQualityStatus = String(dataQuality?.status ?? 'ok');
  const warnings = asArray(dataQuality?.warnings).map(String);

  return (
    <article className="data-panel signal-panel">
      <div className="panel-heading compact">
        <div>
          <h2>量化信号摘要</h2>
          <p>价格位置、均线结构、量能和数据质量</p>
        </div>
        <span className={'quality-pill ' + qualityTone(dataQualityStatus)}>{dataQualityStatus}</span>
      </div>
      <div className="signal-list">
        <div className={'signal-item ' + (aboveMa20 === null ? '' : aboveMa20 ? 'signal-up' : 'signal-down')}>
          <span className="signal-label">价格位置</span>
          <span className={'signal-value ' + (aboveMa20 === null ? '' : aboveMa20 ? 'red' : 'green')}>
            {aboveMa20 === null ? '待确认' : (aboveMa20 ? '站上 MA20' : '低于 MA20')}
            {latestPrice != null && ma20 != null ? <span className="signal-detail"> · {formatNumber(latestPrice)} / {formatNumber(ma20)}</span> : null}
          </span>
        </div>
        <div className={'signal-item ' + (maTrend === null ? '' : maTrend ? 'signal-up' : 'signal-down')}>
          <span className="signal-label">均线结构</span>
          <span className={'signal-value ' + (maTrend === null ? '' : maTrend ? 'red' : 'green')}>
            {maTrend === null ? '待确认' : (maTrend ? '短多排列' : '短线偏弱')}
            {ma5 != null && ma20 != null ? <span className="signal-detail"> · MA5 {formatNumber(ma5)} / MA20 {formatNumber(ma20)}{ma60 != null ? ' / MA60 ' + formatNumber(ma60) : ''}</span> : null}
          </span>
        </div>
        <div className={'signal-item ' + (volumeSignal === null ? '' : volumeSignal >= 1.2 ? 'signal-up' : volumeSignal <= 0.8 ? 'signal-down' : '')}>
          <span className="signal-label">量能状态</span>
          <span className="signal-value">
            {volumeSignal === null ? '待确认' : volumeSignal >= 1.2 ? '放量' : volumeSignal <= 0.8 ? '缩量' : '常态'}
            {volumeSignal != null ? <span className="signal-detail"> · {volumeSignal.toFixed(2)}x</span> : null}
          </span>
        </div>
        <div className={'signal-item signal-risk risk-' + riskLevel}>
          <span className="signal-label">风险结论</span>
          <span className="signal-value">风险等级：{riskLevel}</span>
          <span className="signal-detail">
            最大回撤 {displayPercent(maxDrawdown)} · 20 日年化波动 {displayPercent(volatility)}
          </span>
        </div>
      </div>
      {warnings.length > 0 ? (
        <ul className="warning-list">
          {warnings.slice(0, 3).map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
        </ul>
      ) : (
        <p className="empty-state">未检测到阻断性数据质量警告。</p>
      )}
    </article>
  );
}

export default async function Home() {
  const data = await readDashboardData();
  const sourceEvidence = await readSourcesEvidence();
  const assets = asArray(data?.assets).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  const primaryAsset = assets[0] ?? data;
  const quote = asRecord(primaryAsset?.quote) ?? asRecord(data?.quote);
  const bars = getBars(data);
  const summary = getIndicatorSummary(data);
  const computedMetrics = getComputedMetrics(data);
  const fundamentalSummary = getFundamentalSummary(data);
  const reports = getReports(data);
  const announcements = getAnnouncements(data);
  const backtest = getBacktest(data);
  const liquidityRows = getLiquidityRows(data);
  const correlationPairs = getCorrelationPairs(data);
  const valuationRows = getValuationRows(data);
  const trendTemplateRows = getTrendTemplateRows(data);
  const visualization = getVisualization(data);
  const sourceChannels = inferSourceChannels(data, sourceEvidence);
  const latestBar = bars.at(-1);
  const name = String(primaryAsset?.name ?? quote?.name ?? primaryAsset?.symbol ?? data?.name ?? 'QuantPilot');
  const symbol = String(primaryAsset?.symbol ?? quote?.symbol ?? data?.symbol ?? '-');
  const change = numeric(quote?.change_percent ?? latestBar?.change_percent);
  const isUp = (change ?? 0) >= 0;
  const latestPrice = quote?.price ?? latestBar?.close;
  const previousClose = quote?.previous_close ?? latestBar?.previous_close;
  const todayOpen = quote?.open ?? latestBar?.open;
  const todayHigh = quote?.high ?? latestBar?.high;
  const todayLow = quote?.low ?? latestBar?.low;
  const todayVolume = quote?.volume ?? latestBar?.volume;
  const todayAmount = quote?.amount ?? latestBar?.amount;
  const todayTurnover = quote?.turnover ?? latestBar?.turnover ?? computedMetrics?.turnoverRate;
  const todayAmplitude = quote?.amplitude ?? latestBar?.amplitude;
  const conclusion = asRecord(data?.conclusion);
  const conclusionItems = asArray(conclusion?.summary).map(String).filter(Boolean);
  const hasQuoteData = [
    latestPrice,
    change,
    previousClose,
    todayOpen,
    todayHigh,
    todayLow,
    todayAmount,
    todayTurnover,
  ].some(hasNumber);

  return (
    <main className="dashboard-shell" data-visual-language="financial-workbench" data-market-proxy="/api/market" data-source-file={DATA_FILE}>
      <section className="hero-panel">
        <div className="top-bar">
          <span className="source-pill">{String(data?.source ?? quote?.source ?? 'eastmoney')}</span>
          <span className="freshness">数据更新于 {displayDateTime(quote?.quote_time ?? data?.as_of)}</span>
        </div>

        <div className="price-header">
          <div className="id-area">
            <span className="eyebrow">A 股实时诊断</span>
            <span className="name">{name}</span>
            <span className="symbol">{symbol} · {String(quote?.market ?? data?.market ?? '待识别市场')}</span>
          </div>
          <div className="quote-area">
            <span className={'price ' + (hasNumber(latestPrice) ? '' : 'is-missing')}>{displayNumber(latestPrice)}</span>
            <span className={'change ' + (hasNumber(change) ? (isUp ? 'up' : 'down') : 'neutral')}>{displayPercent(change)}</span>
            <span className="quote-note">{hasQuoteData ? '涨跌额 ' + formatNumber(quote?.change_amount ?? latestBar?.change_amount) : '等待行情、K 线或财务数据写入'}</span>
          </div>
        </div>

        <div className="meta-row">
          <div className="meta-item"><span className="meta-label">昨收</span><span className="meta-value">{displayNumber(previousClose)}</span></div>
          <div className="meta-item"><span className="meta-label">今开</span><span className="meta-value">{displayNumber(todayOpen)}</span></div>
          <div className="meta-item"><span className="meta-label">最高</span><span className="meta-value red">{displayNumber(todayHigh)}</span></div>
          <div className="meta-item"><span className="meta-label">最低</span><span className="meta-value green">{displayNumber(todayLow)}</span></div>
          <div className="meta-item"><span className="meta-label">振幅</span><span className="meta-value">{displayPercent(todayAmplitude)}</span></div>
          <div className="meta-item"><span className="meta-label">成交额</span><span className="meta-value">{displayMoney(todayAmount)}</span></div>
          <span className="meta-source">行情源：{String(quote?.source ?? data?.source ?? 'eastmoney')}</span>
        </div>

        <div className="insight-strip">
          <article>
            <span>趋势判断</span>
            <strong>{String(summary?.trend_state ?? '等待更多行情确认')}</strong>
          </article>
          <article>
            <span>量能与换手</span>
            <strong>成交量 {displayNumber(todayVolume, 0)} · 换手 {displayPercent(todayTurnover)}</strong>
          </article>
          <article>
            <span>研究结论</span>
            <strong>{String(conclusion?.primary_view ?? conclusionItems[0] ?? '仅作研究展示，不构成交易指令。')}</strong>
          </article>
        </div>
      </section>

      <section className="chart-zone">
        <TrendChart bars={bars} />
        <SignalPanel
          quote={quote}
          latestBar={latestBar}
          summary={summary}
          computedMetrics={computedMetrics}
          data={data}
        />
      </section>

      <div className="metric-strip">
        <div className="metric-cell">
          <span className="metric-label">最新价</span>
          <span className="metric-value">{displayNumber(latestPrice)}</span>
        </div>
        <div className="metric-cell">
          <span className="metric-label">涨跌幅</span>
          <span className={'metric-value ' + (hasNumber(change) ? (isUp ? 'red' : 'green') : '')}>{displayPercent(change)}</span>
        </div>
        <div className="metric-cell">
          <span className="metric-label">PE-TTM</span>
          <span className="metric-value">{displayNumber(quote?.pe_ttm ?? quote?.pe ?? summary?.pe_ttm)}</span>
        </div>
        <div className="metric-cell">
          <span className="metric-label">总市值</span>
          <span className="metric-value">{displayMoney(quote?.total_market_cap ?? quote?.market_cap ?? summary?.market_cap)}</span>
        </div>
        <div className="metric-cell">
          <span className="metric-label">换手率</span>
          <span className="metric-value">{displayPercent(todayTurnover)}</span>
        </div>
        <div className="metric-cell">
          <span className="metric-label">MA20</span>
          <span className="metric-value">{displayNumber(summary?.ma20 ?? computedMetrics?.ma20)}</span>
        </div>
      </div>

      <BacktestPanel backtest={backtest} />

      <div className="metric-strip four-col">
        <div className="metric-cell">
          <span className="metric-label">最新营收</span>
          <span className="metric-value">{formatMoney(fundamentalSummary?.latest_revenue)}</span>
        </div>
        <div className="metric-cell">
          <span className="metric-label">归母净利润</span>
          <span className="metric-value">{formatMoney(fundamentalSummary?.latest_parent_net_profit)}</span>
        </div>
        <div className="metric-cell">
          <span className="metric-label">平均毛利率</span>
          <span className="metric-value">{formatPercent(fundamentalSummary?.avg_gross_margin)}</span>
        </div>
        <div className="metric-cell">
          <span className="metric-label">平均净利率</span>
          <span className="metric-value">{formatPercent(fundamentalSummary?.avg_net_margin)}</span>
        </div>
      </div>

      <section className="content-grid">
        <article className="data-panel">
          <div className="panel-heading compact">
            <div>
              <h2>数据信源渠道</h2>
              <p>展示本次看板实际使用的外部或本地数据渠道。</p>
            </div>
          </div>
          {sourceChannels.length > 0 ? (
            <div className="source-channel-list">
              {sourceChannels.map((source, index) => (
                <div key={index} className="source-channel">
                  <strong>{String(source.channel)}</strong>
                  <span>{String(source.dataset ?? '数据集')}</span>
                  <small>{String(source.endpoint ?? '-')}</small>
                  <em>时间：{formatDate(source.as_of)}{source.sample_count ? ' · 样本 ' + String(source.sample_count) : ''}</em>
                </div>
              ))}
            </div>
          ) : (
            <p className="empty-state">暂无可展示的信源渠道，需检查 evidence/sources.json。</p>
          )}
          <p className="evidence-note">技术证据：{SOURCES_FILE} · {DATA_FILE}</p>
        </article>
        <article className="data-panel">
          <h2>最近 K 线</h2>
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>日期</th><th>开盘</th><th>最高</th><th>最低</th><th>收盘</th><th>涨跌幅</th><th>成交额</th><th>成交量</th></tr>
              </thead>
              <tbody>
                {bars.slice(-10).reverse().map((bar, index) => (
                  <tr key={String(bar.date ?? index)}>
                    <td>{String(bar.date ?? '-')}</td>
                    <td>{formatNumber(bar.open)}</td>
                    <td>{formatNumber(bar.high)}</td>
                    <td>{formatNumber(bar.low)}</td>
                    <td>{formatNumber(bar.close)}</td>
                    <td className={(numeric(bar.change_percent) ?? 0) >= 0 ? 'red' : 'green'}>{formatPercent(bar.change_percent)}</td>
                    <td>{formatMoney(bar.amount)}</td>
                    <td>{formatNumber(bar.volume, 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </article>
      </section>

      <section className="content-grid wide">
        <FinancialPanel reports={reports} summary={fundamentalSummary} />
        <AnnouncementPanel announcements={announcements} />
      </section>

      <section className="content-grid wide">
        <LiquidityPanel rows={liquidityRows} />
        <CorrelationPanel pairs={correlationPairs} />
      </section>

      <section className="content-grid wide">
        <ValuationPanel rows={valuationRows} />
        <TrendTemplatePanel rows={trendTemplateRows} />
      </section>

      <section className="content-grid wide">
        <VisualizationPlanPanel visualization={visualization} />
      </section>
    </main>
  );
}
`;
}
export function baseDashboardCssTemplate(): string {
  return `:root {
  color-scheme: light;
  --bg: #f2f3f7;
  --ink: #1a1e2b;
  --muted: #5f6b7f;
  --line: #d8dce6;
  --line-light: #e9ecf2;
  --panel: #ffffff;
  --red: #d9363e;
  --green: #0e9d5d;
  --blue: #2b6de5;
  --gold: #b88719;
  --purple: #7c3aed;
  --teal: #0f8f88;
  --amber-bg: #fff8e5;
  --red-bg: #fef2f2;
  --green-bg: #f0fdf4;
  --blue-bg: #eef4ff;
  --surface-1: #f7f8fb;
  --surface-2: #fafbfd;
  --shadow-sm: 0 1px 2px rgba(15,23,42,0.04);
  --shadow-md: 0 4px 12px rgba(15,23,42,0.06);
  --red-fill: #fef0ef;
  --green-fill: #edf9f2;
  --volume-up-fill: #f2c4c0;
  --volume-down-fill: #b0e0c6;
}

*,
*::before,
*::after {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-height: 100vh;
  overflow-x: hidden;
  background: var(--bg);
  color: var(--ink);
  font-family:
    -apple-system, BlinkMacSystemFont, "Segoe UI",
    "PingFang SC", "Microsoft YaHei",
    "Helvetica Neue", Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  font-variant-numeric: tabular-nums;
}

button,
input,
select,
textarea {
  font: inherit;
}

/* ==================== SHELL ==================== */

.dashboard-shell {
  width: min(1360px, calc(100vw - 40px));
  margin: 0 auto;
  padding: 24px 0 56px;
}

.hero-panel {
  margin-bottom: 16px;
  padding: 20px;
  border: 1px solid rgba(43, 109, 229, 0.16);
  border-radius: 8px;
  background:
    linear-gradient(135deg, rgba(255, 255, 255, 0.96), rgba(247, 250, 255, 0.98)),
    var(--panel);
  box-shadow: var(--shadow-md);
}

.eyebrow {
  display: inline-flex;
  width: fit-content;
  margin: 0 0 4px;
  padding: 4px 9px;
  border: 1px solid rgba(43, 109, 229, 0.18);
  border-radius: 999px;
  color: var(--blue);
  background: rgba(43, 109, 229, 0.08);
  font-size: 13px;
  font-weight: 700;
}

/* ==================== TOP BAR ==================== */

.top-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 0;
  margin-bottom: 12px;
  font-size: 13px;
  color: var(--muted);
}

.source-pill {
  display: inline-flex;
  width: fit-content;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border: 1px solid rgba(184, 135, 25, 0.24);
  border-radius: 999px;
  color: #805600;
  background: #fff9e8;
  font-weight: 700;
}

.source-pill::before {
  content: "";
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--gold);
}

.top-bar .freshness {
  display: flex;
  align-items: center;
  gap: 6px;
}

.top-bar .freshness::before {
  content: "";
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--green);
}

/* ==================== PRICE HEADER ==================== */

.price-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 20px;
  margin-bottom: 4px;
}

.price-header .id-area {
  display: grid;
  gap: 6px;
  min-width: 0;
}

.price-header .id-area .name {
  font-size: clamp(34px, 4vw, 52px);
  font-weight: 900;
  line-height: 1;
  word-break: break-word;
}

.price-header .id-area .symbol {
  font-size: 15px;
  color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.price-header .quote-area {
  display: flex;
  align-items: flex-end;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 8px 10px;
  flex-shrink: 0;
  text-align: right;
  max-width: 520px;
}

.price-header .quote-area .price {
  font-size: clamp(36px, 4.2vw, 58px);
  font-weight: 900;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  letter-spacing: 0;
  line-height: 1;
  white-space: nowrap;
}

.price-header .quote-area .price.is-missing {
  font-size: clamp(22px, 2.2vw, 30px);
  color: var(--muted);
  font-family: inherit;
}

.price-header .quote-area .change {
  font-size: 16px;
  font-weight: 700;
  padding: 4px 10px;
  border-radius: 4px;
  color: #fff;
}

.price-header .quote-area .change.up {
  background: var(--red);
}

.price-header .quote-area .change.down {
  background: var(--green);
}

.price-header .quote-area .change.neutral {
  color: var(--muted);
  background: var(--surface-1);
  border: 1px solid var(--line);
}

.quote-note {
  width: 100%;
  color: var(--muted);
  font-size: 13px;
}

/* ==================== META ROW ==================== */

.meta-row {
  display: grid;
  grid-template-columns: repeat(6, minmax(110px, 1fr)) auto;
  align-items: stretch;
  gap: 10px;
  margin: 16px 0 0;
}

.meta-row .meta-item {
  display: grid;
  gap: 7px;
  min-height: 70px;
  padding: 12px;
  border: 1px solid rgba(216, 220, 230, 0.9);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.74);
  font-size: 14px;
}

.meta-row .meta-item .meta-label {
  color: var(--muted);
}

.meta-row .meta-item .meta-value {
  font-weight: 600;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 18px;
  overflow-wrap: anywhere;
}

.meta-row .meta-source {
  align-self: center;
  justify-self: end;
  color: var(--muted);
  font-size: 12px;
  white-space: nowrap;
}

.insight-strip {
  display: grid;
  grid-template-columns: 1.15fr 0.9fr 1.35fr;
  gap: 12px;
  margin-top: 14px;
}

.insight-strip article {
  min-height: 88px;
  padding: 14px;
  border: 1px solid rgba(43, 109, 229, 0.12);
  border-radius: 8px;
  background: #f8fbff;
}

.insight-strip span {
  display: block;
  margin-bottom: 8px;
  color: var(--blue);
  font-size: 13px;
  font-weight: 800;
}

.insight-strip strong {
  display: block;
  color: #1f2937;
  font-size: 15px;
  line-height: 1.65;
}

/* ==================== METRIC STRIP ==================== */

.metric-strip {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: 1px;
  margin-bottom: 24px;
  background: var(--line);
  border: 1px solid var(--line);
  border-radius: 8px;
  overflow: hidden;
}

.metric-strip .metric-cell {
  padding: 14px 16px;
  background: var(--panel);
}

.metric-strip .metric-cell .metric-label {
  display: block;
  margin-bottom: 6px;
  color: var(--muted);
  font-size: 13px;
  font-weight: 500;
}

.metric-strip .metric-cell .metric-value {
  font-size: 20px;
  font-weight: 700;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  overflow-wrap: anywhere;
}

.metric-strip.four-col {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

/* ==================== SECTION DIVIDER ==================== */

.section-divider {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 28px 0 14px;
}

.section-divider:first-of-type {
  margin-top: 0;
}

.section-divider h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 700;
  flex-shrink: 0;
}

.section-divider .section-meta {
  font-size: 13px;
  color: var(--muted);
}

.section-divider::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--line);
}

/* ==================== CHART ZONE ==================== */

.chart-zone {
  display: grid;
  grid-template-columns: minmax(0, 1.55fr) minmax(280px, 0.75fr);
  gap: 16px;
  margin-bottom: 24px;
}

.chart-zone > *,
.content-grid > *,
.content-grid.wide > *,
.backtest-grid > *,
.main-grid > *,
.detail-grid > * {
  min-width: 0;
}

.chart-panel {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  padding: 16px;
  box-shadow: var(--shadow-sm);
}

.data-panel {
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  padding: 16px;
  box-shadow: var(--shadow-sm);
  min-width: 0;
  overflow: hidden;
}

/* ==================== TREND CHART ==================== */

.trend-chart {
  width: 100%;
  height: 380px;
  overflow: hidden;
  border: 1px solid var(--line-light);
  border-radius: 6px;
  background: var(--surface-1);
}

.volume-chart {
  width: 100%;
  height: 100px;
  margin-top: 10px;
  border: 1px solid var(--line-light);
  border-radius: 6px;
  background: var(--surface-1);
}

.chart-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin-bottom: 8px;
  font-size: 13px;
  color: var(--muted);
}

.chart-legend span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.chart-legend span::before {
  content: "";
  width: 16px;
  height: 3px;
  border-radius: 999px;
  background: currentColor;
}

.chart-empty-state {
  display: grid;
  gap: 6px;
  margin-bottom: 10px;
  padding: 12px 14px;
  border: 1px dashed rgba(43, 109, 229, 0.28);
  border-radius: 6px;
  color: var(--muted);
  background: #f8fbff;
}

.chart-empty-state strong {
  color: var(--ink);
  font-size: 15px;
}

.chart-empty-state span {
  font-size: 13px;
  line-height: 1.6;
}

.legend-price { color: var(--ink); }
.legend-ma5 { color: var(--blue); }
.legend-ma10 { color: var(--gold); }
.legend-ma20 { color: var(--purple); }
.legend-ma60 { color: var(--teal); }

.chart-bg { fill: var(--surface-1); }

.chart-label {
  fill: var(--muted);
  font-size: 12px;
  paint-order: stroke;
  stroke: var(--surface-1);
  stroke-width: 2;
  vector-effect: non-scaling-stroke;
}

.chart-price {
  text-anchor: end;
  dominant-baseline: central;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
}

.chart-date { text-anchor: middle; }

.axis {
  stroke: var(--line);
  stroke-width: 1.2;
}

.axis.muted { opacity: 0.5; }

.axis.grid {
  opacity: 0.4;
  stroke-dasharray: 2 3;
}

.equity-line {
  fill: none;
  stroke: var(--gold);
  stroke-width: 2.4;
  vector-effect: non-scaling-stroke;
}

.candle-up line,
.candle-up rect {
  fill: var(--red-fill);
  stroke: var(--red);
  stroke-width: 1.2;
  vector-effect: non-scaling-stroke;
}

.candle-down line,
.candle-down rect {
  fill: var(--green-fill);
  stroke: var(--green);
  stroke-width: 1.2;
  vector-effect: non-scaling-stroke;
}

.ma-line {
  fill: none;
  stroke-width: 1.5;
  vector-effect: non-scaling-stroke;
}

.ma5 { stroke: var(--blue); }
.ma10 { stroke: var(--gold); }
.ma20 { stroke: var(--purple); }
.ma60 { stroke: var(--teal); stroke-width: 1.8; }

.volume-up {
  fill: var(--volume-up-fill);
  stroke: var(--red);
  stroke-width: 0.5;
  vector-effect: non-scaling-stroke;
}

.volume-down {
  fill: var(--volume-down-fill);
  stroke: var(--green);
  stroke-width: 0.5;
  vector-effect: non-scaling-stroke;
}

/* ==================== PANEL HEADING ==================== */

.panel-heading {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  align-items: flex-start;
  margin-bottom: 12px;
}

.panel-heading.compact {
  align-items: flex-start;
}

.panel-heading h2 {
  margin: 0 0 4px;
  font-size: 16px;
  font-weight: 700;
}

.panel-heading p {
  margin: 0;
  color: var(--muted);
  font-size: 14px;
}

.panel-heading .pill {
  flex-shrink: 0;
  padding: 3px 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--muted);
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
}

/* ==================== SIGNAL LIST ==================== */

.signal-list {
  display: grid;
  gap: 8px;
}

.signal-list .signal-item {
  padding: 12px;
  border: 1px solid var(--line-light);
  border-radius: 6px;
  background: var(--surface-1);
}

.signal-list .signal-item.signal-up {
  border-color: color-mix(in srgb, var(--red) 28%, var(--line));
  background: var(--red-bg);
}

.signal-list .signal-item.signal-down {
  border-color: color-mix(in srgb, var(--green) 28%, var(--line));
  background: var(--green-bg);
}

.signal-list .signal-item.signal-risk {
  border-color: color-mix(in srgb, var(--gold) 34%, var(--line));
  background: var(--amber-bg);
}

.signal-list .signal-item.signal-risk.risk-高 {
  border-color: color-mix(in srgb, var(--red) 36%, var(--line));
  background: var(--red-bg);
}

.signal-list .signal-item .signal-label {
  display: block;
  margin-bottom: 4px;
  color: var(--muted);
  font-size: 13px;
}

.signal-list .signal-item .signal-value {
  font-size: 18px;
  font-weight: 700;
  white-space: nowrap;
}

.signal-list .signal-item .signal-detail {
  display: block;
  margin-top: 2px;
  font-weight: 400;
  font-size: 13px;
  color: var(--muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

/* ==================== WARNING LIST ==================== */

.warning-list {
  display: grid;
  gap: 6px;
  margin: 10px 0 0;
  padding: 0;
  list-style: none;
}

.warning-list li {
  padding: 8px 10px;
  border: 1px solid color-mix(in srgb, var(--gold) 38%, white);
  border-radius: 6px;
  color: #805600;
  background: var(--amber-bg);
  font-size: 13px;
}

/* ==================== QUALITY PILL ==================== */

.quality-pill {
  font-weight: 700;
}

.quality-ok {
  border-color: color-mix(in srgb, var(--green) 28%, var(--line)) !important;
  color: var(--green) !important;
  background: var(--green-bg);
}

.quality-warning {
  border-color: color-mix(in srgb, var(--gold) 34%, var(--line)) !important;
  color: #805600 !important;
  background: var(--amber-bg);
}

.quality-error {
  border-color: color-mix(in srgb, var(--red) 32%, var(--line)) !important;
  color: var(--red) !important;
  background: var(--red-bg);
}

.quality-muted {
  color: var(--muted) !important;
  background: #f8fafc;
}

/* ==================== BACKTEST ==================== */

.backtest-section {
  margin-bottom: 24px;
  padding: 16px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--panel);
  box-shadow: var(--shadow-sm);
}

.backtest-section .metric-strip {
  margin-bottom: 14px;
}

.backtest-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(280px, 0.8fr);
  gap: 14px;
  margin-top: 14px;
}

.chart-panel.embedded {
  margin-top: 0;
}

/* ==================== CONTENT GRID ==================== */

.content-grid {
  display: grid;
  grid-template-columns: minmax(260px, 0.9fr) minmax(0, 1.4fr);
  gap: 16px;
  margin-bottom: 16px;
}

.content-grid.wide {
  grid-template-columns: minmax(0, 1.35fr) minmax(280px, 0.8fr);
}

/* ==================== SOURCE CHANNELS ==================== */

.source-channel-list {
  display: grid;
  gap: 8px;
}

.source-channel {
  padding: 10px 12px;
  border: 1px solid var(--line-light);
  border-radius: 6px;
  background: var(--surface-1);
  min-width: 0;
}

.source-channel strong {
  display: block;
  margin-bottom: 2px;
  color: var(--ink);
  font-size: 15px;
}

.source-channel span {
  color: var(--muted);
  font-size: 13px;
}

.source-channel small {
  display: block;
  overflow: hidden;
  color: var(--blue);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-top: 2px;
}

.source-channel em {
  display: block;
  margin-top: 2px;
  color: var(--muted);
  font-size: 12px;
  font-style: normal;
  overflow-wrap: anywhere;
}

.evidence-note {
  margin: 10px 0 0;
  color: var(--muted);
  font-size: 12px;
}

/* ==================== MINI METRICS ==================== */

.mini-metric-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin: 12px 0 16px;
}

.mini-metric-grid .mini-metric {
  padding: 10px 12px;
  border: 1px solid var(--line-light);
  border-radius: 6px;
  background: var(--surface-1);
}

.mini-metric-grid .mini-metric span {
  display: block;
  margin-bottom: 6px;
  color: var(--muted);
  font-size: 13px;
}

.mini-metric-grid .mini-metric strong {
  font-size: 18px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  white-space: nowrap;
}

/* ==================== FINANCIAL BARS ==================== */

.financial-bars {
  display: grid;
  grid-template-columns: repeat(6, minmax(34px, 1fr));
  gap: 8px;
  align-items: end;
  height: 180px;
  margin: 8px 0 16px;
  padding: 12px 8px 0;
  border: 1px solid var(--line-light);
  border-radius: 6px;
  background: var(--surface-1);
}

.financial-bar-group {
  display: grid;
  gap: 6px;
  align-items: end;
  min-width: 0;
  height: 100%;
}

.bar-stack {
  position: relative;
  display: flex;
  align-items: end;
  justify-content: center;
  gap: 3px;
  height: 130px;
}

.bar {
  width: 10px;
  min-height: 4px;
  border-radius: 999px 999px 2px 2px;
}

.bar.revenue { background: var(--blue); }
.bar.profit { background: var(--gold); }

.financial-bar-group small {
  overflow: hidden;
  color: var(--muted);
  font-size: 12px;
  text-align: center;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ==================== ANNOUNCEMENTS ==================== */

.announcement-list {
  display: grid;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.announcement-list li {
  padding: 10px 12px;
  border: 1px solid var(--line-light);
  border-radius: 6px;
  background: var(--surface-1);
}

.announcement-list span,
.announcement-list em {
  color: var(--muted);
  font-size: 12px;
  font-style: normal;
}

.announcement-list strong {
  display: block;
  margin: 4px 0;
  font-size: 15px;
  line-height: 1.45;
}

/* ==================== CORRELATION ==================== */

.correlation-list {
  display: grid;
  gap: 10px;
}

.correlation-row {
  display: grid;
  grid-template-columns: minmax(140px, 0.9fr) minmax(100px, 1fr) 56px;
  gap: 10px;
  align-items: center;
  padding: 10px;
  border: 1px solid var(--line-light);
  border-radius: 6px;
  background: var(--surface-1);
}

.correlation-row strong {
  display: block;
  font-size: 14px;
}

.correlation-row small {
  display: block;
  margin-top: 2px;
  color: var(--muted);
  font-size: 12px;
}

.correlation-row .corr-value {
  color: var(--ink);
  font-weight: 700;
  font-size: 15px;
  text-align: right;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.correlation-meter {
  height: 8px;
  overflow: hidden;
  border-radius: 999px;
  background: #eef2f7;
}

.correlation-meter span {
  display: block;
  height: 100%;
  border-radius: inherit;
}

.corr-positive { background: var(--red); }
.corr-negative { background: var(--green); }

/* ==================== EMPTY STATE ==================== */

.empty-state {
  margin: 8px 0 0;
  padding: 12px;
  border: 1px dashed var(--line);
  border-radius: 6px;
  color: var(--muted);
  background: var(--surface-1);
  font-size: 14px;
}

/* ==================== DL ==================== */

dl {
  display: grid;
  gap: 10px;
  margin: 0;
}

dl div {
  display: grid;
  grid-template-columns: 72px minmax(0, 1fr);
  gap: 10px;
}

dt {
  color: var(--muted);
  font-size: 14px;
}

dd {
  margin: 0;
  word-break: break-word;
  font-size: 14px;
}

/* ==================== TABLES ==================== */

.table-wrap {
  overflow-x: auto;
  overflow-y: hidden;
  width: 100%;
  max-width: 100%;
}

table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}

td {
  padding: 9px 10px;
  border-bottom: 1px solid var(--line-light);
  text-align: left;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

th {
  padding: 9px 10px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  white-space: nowrap;
  position: sticky;
  top: 0;
  z-index: 1;
  color: var(--muted);
  font-weight: 600;
  font-size: 13px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  background: var(--panel);
}

tbody tr:nth-child(even) {
  background: #f8fafc;
}

tbody tr:hover {
  background: #f1f5f9;
}

/* ==================== SEMANTIC COLORS ==================== */

.red { color: var(--red); }
.green { color: var(--green); }

/* ==================== RESPONSIVE ==================== */

@media (max-width: 800px) {
  .dashboard-shell {
    width: min(100vw - 24px, 720px);
    padding-top: 12px;
  }

  .hero-panel {
    margin-bottom: 12px;
    padding: 12px;
  }

  .top-bar {
    align-items: flex-start;
    flex-direction: column;
    gap: 8px;
  }

  .price-header {
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }

  .price-header .quote-area {
    text-align: left;
    justify-content: flex-start;
    align-items: center;
    max-width: 100%;
  }

  .price-header .quote-area .price {
    font-size: 28px;
  }

  .price-header .quote-area .price.is-missing {
    font-size: 20px;
  }

  .price-header .quote-area .change {
    font-size: 14px;
  }

  .price-header .id-area .name {
    font-size: 28px;
    line-height: 1.05;
  }

  .metric-strip {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .metric-strip.four-col {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .meta-row {
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 8px;
  }

  .meta-row .meta-item {
    min-height: 56px;
    padding: 8px;
    gap: 4px;
    font-size: 12px;
  }

  .meta-row .meta-item .meta-value {
    font-size: 14px;
  }

  .insight-strip {
    grid-template-columns: 1fr;
    gap: 8px;
  }

  .insight-strip article {
    min-height: auto;
    padding: 10px;
  }

  .insight-strip article:nth-child(n + 2) {
    display: none;
  }

  .meta-row .meta-source {
    justify-self: start;
    grid-column: 1 / -1;
  }

  .chart-zone,
  .backtest-grid {
    grid-template-columns: 1fr;
  }

  .chart-zone > *,
  .backtest-grid > * {
    min-width: 0;
  }

  .content-grid,
  .content-grid.wide {
    grid-template-columns: 1fr;
  }

  .content-grid > *,
  .content-grid.wide > * {
    min-width: 0;
  }

  .trend-chart {
    height: 260px;
  }

  .panel-heading {
    flex-direction: column;
    gap: 8px;
  }
}

@media (max-width: 520px) {
  .metric-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .metric-strip.four-col {
    grid-template-columns: 1fr;
  }

  .mini-metric-grid {
    grid-template-columns: 1fr;
  }

  .mini-metric-grid > * {
    min-width: 0;
  }

  .chart-panel,
  .data-panel {
    padding: 12px;
  }

  .price-header .quote-area .price {
    font-size: 24px;
  }

  .financial-bars {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }

  .correlation-row {
    grid-template-columns: minmax(0, 1fr) 56px;
    overflow-x: auto;
  }

  .table-wrap {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }
}

${baseDashboardWorkbenchCss()}
`;
}
export function generatedDevScriptContents(): string {
  return `#!/usr/bin/env node

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const projectRoot = path.join(__dirname, '..');
const isWindows = process.platform === 'win32';

function parseCliArgs(argv) {
  const passthrough = [];
  let preferredPort;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--port' || arg === '-p') {
      const value = argv[i + 1];
      if (value && !value.startsWith('-')) {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isNaN(parsed)) {
          preferredPort = parsed;
        }
        i += 1;
        continue;
      }
    } else if (arg.startsWith('--port=')) {
      const value = arg.slice('--port='.length);
      const parsed = Number.parseInt(value, 10);
      if (!Number.isNaN(parsed)) {
        preferredPort = parsed;
      }
      continue;
    } else if (arg.startsWith('-p=')) {
      const value = arg.slice('-p='.length);
      const parsed = Number.parseInt(value, 10);
      if (!Number.isNaN(parsed)) {
        preferredPort = parsed;
      }
      continue;
    }

    passthrough.push(arg);
  }

  return { preferredPort, passthrough };
}

function resolvePort(preferredPort) {
  const candidates = [
    preferredPort,
    process.env.PORT,
    process.env.WEB_PORT,
    process.env.PREVIEW_PORT_START,
    4100,
  ];

  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) {
      continue;
    }

    const numeric =
      typeof candidate === 'number'
        ? candidate
        : Number.parseInt(String(candidate), 10);

    if (!Number.isNaN(numeric) && numeric > 0 && numeric <= 65535) {
      return numeric;
    }
  }

  return 4100;
}

(async () => {
  const argv = process.argv.slice(2);
  const { preferredPort, passthrough } = parseCliArgs(argv);
  const port = resolvePort(preferredPort);
  const url =
    process.env.NEXT_PUBLIC_APP_URL || \`http://localhost:\${port}\`;

  process.env.PORT = String(port);
  process.env.WEB_PORT = String(port);
  process.env.NEXT_PUBLIC_APP_URL = url;

  console.log(\`🚀 Starting Next.js dev server on \${url}\`);

  const hasProductionBuild = fs.existsSync(path.join(projectRoot, '.next', 'BUILD_ID'));
  const commandArgs = hasProductionBuild
    ? ['next', 'start', '--port', String(port), ...passthrough]
    : ['next', 'dev', '--port', String(port), ...passthrough];
  const runtimeEnv = {
    ...process.env,
    PORT: String(port),
    WEB_PORT: String(port),
    NEXT_PUBLIC_APP_URL: url,
    QUANTPILOT_WORKSPACE_ROOT:
      process.env.QUANTPILOT_WORKSPACE_ROOT || path.resolve(projectRoot, '../../..'),
    NEXT_TELEMETRY_DISABLED: '1',
  };

  const child = spawn(
    'npx',
    commandArgs,
    {
      cwd: projectRoot,
      stdio: 'inherit',
      shell: isWindows,
      env: runtimeEnv,
    }
  );

  child.on('exit', (code) => {
    if (typeof code === 'number' && code !== 0) {
      console.error(\`❌ Next.js dev server exited with code \${code}\`);
      process.exit(code);
    }
  });

  child.on('error', (error) => {
    console.error('❌ Failed to start Next.js dev server');
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
})();
`;
}
