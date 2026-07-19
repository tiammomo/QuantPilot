import { DASHBOARD_DATA_READER, DASHBOARD_PAGE_RUNTIME_PRELUDE } from './scaffold-dashboard-runtime-template';
import {
  comparisonWorkbenchCss,
  holdingWorkbenchCss,
  stockSelectionWorkbenchCss,
} from './scaffold-visual-language';

export function comparisonPageTemplate() {
  return `${DASHBOARD_PAGE_RUNTIME_PRELUDE}

${DASHBOARD_DATA_READER}

function getAssets(data: JsonRecord | null): JsonRecord[] {
  return asArray(data?.assets).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
}

function getComparisonRows(data: JsonRecord | null): JsonRecord[] {
  const comparison = asRecord(data?.comparison);
  const rows = asArray(comparison?.rows).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  if (rows.length > 0) return rows;
  return getAssets(data).map((asset) => {
    const quote = asRecord(asset.quote);
    const metrics = asRecord(asset.computedMetrics);
    return {
      symbol: asset.symbol ?? quote?.symbol,
      name: asset.name ?? quote?.name ?? asset.symbol,
      price: quote?.price,
      change_percent: quote?.change_percent,
      period_return: metrics?.periodReturn,
      max_drawdown: metrics?.maxDrawdown,
      volatility20d: metrics?.volatility20d,
      avg_volume_20d: metrics?.avgVolume20d,
      amount: quote?.amount,
      as_of: asset.as_of ?? quote?.quote_time ?? quote?.fetched_at,
      source: asset.source ?? quote?.source,
    };
  });
}

function getLeaders(data: JsonRecord | null): JsonRecord | null {
  return asRecord(asRecord(data?.comparison)?.leaders);
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

function getLiquidityRows(data: JsonRecord | null): JsonRecord[] {
  const liquidity = asRecord(data?.liquidity);
  return asArray(liquidity?.rows).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
}

function tone(value: unknown): 'up' | 'down' | 'neutral' {
  const number = numeric(value);
  if (number === null || number === 0) return 'neutral';
  return number > 0 ? 'up' : 'down';
}

function BarChart({ rows, field, title, subtitle, inverse = false }: {
  rows: JsonRecord[];
  field: string;
  title: string;
  subtitle: string;
  inverse?: boolean;
}) {
  const values = rows.map((row) => numeric(row[field]) ?? 0);
  const maxAbs = Math.max(0.01, ...values.map((value) => Math.abs(value)));

  return (
    <section className="comparison-panel">
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
      </div>
      <svg className="comparison-bars" viewBox="0 0 100 56" preserveAspectRatio="none" role="img" aria-label={title}>
        <line x1="0" y1="44" x2="100" y2="44" className="axis" />
        {rows.map((row, index) => {
          const value = numeric(row[field]) ?? 0;
          const height = Math.max(2, (Math.abs(value) / maxAbs) * 38);
          const x = 8 + index * (84 / Math.max(rows.length, 1));
          const width = Math.min(16, 66 / Math.max(rows.length, 1));
          const y = 44 - height;
          const isPositive = inverse ? value <= 0 : value >= 0;
          return (
            <g key={String(row.symbol ?? index)} className={isPositive ? 'bar-up' : 'bar-down'}>
              <rect x={x.toFixed(2)} y={y.toFixed(2)} width={width.toFixed(2)} height={height.toFixed(2)} rx="1" />
            </g>
          );
        })}
      </svg>
      <div className="chart-value-row">
        {rows.map((row, index) => (
          <span key={String(row.symbol ?? index)}>
            {String(row.symbol ?? '-')} {formatPercent(row[field])}
          </span>
        ))}
      </div>
    </section>
  );
}

function CorrelationPanel({ pairs }: { pairs: JsonRecord[] }) {
  return (
    <section className="comparison-matrix">
      <div className="panel-heading">
        <div>
          <h2>相关性结构</h2>
          <p>基于对齐日期后的日收益率计算 Pearson 相关性，帮助识别联动和分散效果。</p>
        </div>
        <span>{pairs.length} 组</span>
      </div>
      <div className="correlation-list">
        {pairs.length > 0 ? pairs.slice(0, 6).map((pair, index) => {
          const correlation = numeric(pair.correlation);
          const width = Math.max(4, Math.abs(correlation ?? 0) * 100);
          return (
            <div className="correlation-row" key={String(pair.left ?? index) + String(pair.right ?? '')}>
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
        }) : <p className="empty-state">当前数据不足以计算多标的相关性。</p>}
      </div>
    </section>
  );
}

function LiquidityPanel({ rows }: { rows: JsonRecord[] }) {
  return (
    <section className="comparison-matrix">
      <div className="panel-heading">
        <div>
          <h2>流动性与可交易性</h2>
          <p>展示 20 日成交额、换手代理和 Amihud 非流动性，辅助判断样本可交易性。</p>
        </div>
        <span>{rows.length} 项</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>标的</th>
              <th>流动性等级</th>
              <th>20 日均额</th>
              <th>20 日均量</th>
              <th>换手代理</th>
              <th>Amihud x1e9</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={String(row.symbol ?? index)}>
                <td><strong>{String(row.name ?? row.symbol)}</strong><small>{String(row.symbol ?? '-')}</small></td>
                <td>{String(row.liquidity_score ?? '-')}</td>
                <td>{formatMoney(row.avg_amount_20d)}</td>
                <td>{formatNumber(row.avg_volume_20d, 0)}</td>
                <td>{formatPercent(row.turnover_proxy_pct)}</td>
                <td>{formatNumber(row.amihud_illiquidity_x1e9, 6)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ValuationPanel({ rows }: { rows: JsonRecord[] }) {
  if (rows.length === 0) {
    return null;
  }

  return (
    <section className="comparison-matrix">
      <div className="panel-heading">
        <div>
          <h2>估值情景</h2>
          <p>基于 PE/EPS 的防守、中性、进攻三档情景；仅用于研究，不构成收益承诺。</p>
        </div>
        <span>{rows.length} 项</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>标的</th>
              <th>当前价</th>
              <th>PE</th>
              <th>EPS</th>
              <th>中性情景价</th>
              <th>中性空间</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const metrics = asRecord(row.base_metrics) ?? asRecord(row.baseMetrics) ?? {};
              const scenarios = asArray(row.scenarios).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
              const baseScenario = scenarios.find((item) => item.case === 'base') ?? scenarios[1] ?? scenarios[0];
              return (
                <tr key={String(row.symbol ?? index)}>
                  <td><strong>{String(row.name ?? row.symbol)}</strong><small>{String(row.symbol ?? '-')}</small></td>
                  <td>{formatNumber(metrics.price)}</td>
                  <td>{formatNumber(metrics.pe_ttm ?? metrics.pe)}</td>
                  <td>{formatNumber(metrics.eps, 4)}</td>
                  <td>{formatNumber(baseScenario?.implied_price)}</td>
                  <td className={tone(baseScenario?.upside_pct)}>{formatPercent(baseScenario?.upside_pct)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function TrendTemplatePanel({ rows }: { rows: JsonRecord[] }) {
  if (rows.length === 0) {
    return null;
  }

  return (
    <section className="comparison-matrix">
      <div className="panel-heading">
        <div>
          <h2>趋势模板</h2>
          <p>MA20/MA60、阶段回撤和量能比，辅助生成确认、减仓和观察条件。</p>
        </div>
        <span>{rows.length} 项</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>标的</th>
              <th>状态</th>
              <th>分数</th>
              <th>MA20</th>
              <th>MA60</th>
              <th>20 日收益</th>
              <th>120 日回撤</th>
              <th>量能比</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => {
              const metrics = asRecord(row.metrics) ?? {};
              return (
                <tr key={String(row.symbol ?? index)}>
                  <td><strong>{String(row.name ?? row.symbol)}</strong><small>{String(row.symbol ?? '-')}</small></td>
                  <td>{String(row.state ?? '-')}</td>
                  <td>{formatNumber(row.score, 0)}</td>
                  <td>{formatNumber(metrics.ma20)}</td>
                  <td>{formatNumber(metrics.ma60)}</td>
                  <td className={tone(metrics.return_20d_pct)}>{formatPercent(metrics.return_20d_pct)}</td>
                  <td className="down">{formatPercent(metrics.max_drawdown_120d_pct)}</td>
                  <td>{formatNumber(metrics.volume_ratio_20d, 2)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default async function Home() {
  const data = await readDashboardData();
  const rows = getComparisonRows(data);
  const leaders = getLeaders(data);
  const correlationPairs = getCorrelationPairs(data);
  const liquidityRows = getLiquidityRows(data);
  const valuationRows = getValuationRows(data);
  const trendTemplateRows = getTrendTemplateRows(data);
  const requestedSymbols = asArray(data?.requestedSymbols ?? data?.symbols).map(String);
  const bestReturn = asRecord(leaders?.best_return);
  const lowestDrawdown = asRecord(leaders?.lowest_drawdown);
  const lowestVolatility = asRecord(leaders?.lowest_volatility);

  return (
    <main className="comparison-shell" data-visual-language="financial-workbench" data-market-proxy="/api/market" data-source-file={DATA_FILE}>
      <header className="comparison-header">
        <div>
          <p className="eyebrow">QuantPilot 多标的对比</p>
          <h1>多标的相对强弱看板</h1>
          <p>覆盖 {requestedSymbols.length || rows.length} 个标的：{requestedSymbols.join('、') || rows.map((row) => String(row.symbol)).join('、')}</p>
        </div>
        <div className="header-meta">
          <span>样本：最近 60 个交易日</span>
          <span>更新：{String(data?.as_of ?? '-')}</span>
        </div>
      </header>

      <dl className="comparison-metrics">
        <div className="up">
          <dt>收益领先</dt>
          <dd>{String(bestReturn?.name ?? '-')}</dd>
          <dd className="metric-detail">{formatPercent(bestReturn?.value)}</dd>
        </div>
        <div className="neutral">
          <dt>回撤较小</dt>
          <dd>{String(lowestDrawdown?.name ?? '-')}</dd>
          <dd className="metric-detail">{formatPercent(lowestDrawdown?.value)}</dd>
        </div>
        <div className="neutral">
          <dt>波动较低</dt>
          <dd>{String(lowestVolatility?.name ?? '-')}</dd>
          <dd className="metric-detail">{formatPercent(lowestVolatility?.value)}</dd>
        </div>
      </dl>

      <section className="comparison-matrix">
        <div className="panel-heading">
          <div>
            <h2>指标矩阵</h2>
            <p>最新行情、区间收益、波动、回撤和成交额横向比较</p>
          </div>
          <span>{rows.length} 项</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>标的</th>
                <th>最新价</th>
                <th>涨跌幅</th>
                <th>区间收益</th>
                <th>最大回撤</th>
                <th>波动率</th>
                <th>成交额</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={String(row.symbol ?? index)}>
                  <td><strong>{String(row.name ?? row.symbol)}</strong><small>{String(row.symbol ?? '-')}</small></td>
                  <td>{formatNumber(row.price)}</td>
                  <td className={tone(row.change_percent)}>{formatPercent(row.change_percent)}</td>
                  <td className={tone(row.period_return)}>{formatPercent(row.period_return)}</td>
                  <td className="down">{formatPercent(row.max_drawdown)}</td>
                  <td>{formatPercent(row.volatility20d)}</td>
                  <td>{formatMoney(row.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="chart-grid">
        <BarChart rows={rows} field="period_return" title="收益对比" subtitle="同一窗口下的区间收益率" />
        <BarChart rows={rows} field="volatility20d" title="波动率对比" subtitle="20 日收益波动年化口径" />
        <BarChart rows={rows} field="max_drawdown" title="最大回撤对比" subtitle="从区间高点到低点的最大跌幅" inverse />
      </section>

      <section className="comparison-two-column">
        <CorrelationPanel pairs={correlationPairs} />
        <LiquidityPanel rows={liquidityRows} />
      </section>

      <section className="comparison-two-column">
        <ValuationPanel rows={valuationRows} />
        <TrendTemplatePanel rows={trendTemplateRows} />
      </section>

    </main>
  );
}
`;
}
export function stockSelectionPageTemplate() {
  return `${DASHBOARD_PAGE_RUNTIME_PRELUDE}

function tone(value: unknown): 'up' | 'down' | 'neutral' {
  const number = numeric(value);
  if (number === null || number === 0) return 'neutral';
  return number > 0 ? 'up' : 'down';
}

${DASHBOARD_DATA_READER}

function getAssets(data: JsonRecord | null): JsonRecord[] {
  return asArray(data?.assets).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
}

function getComparisonRows(data: JsonRecord | null): JsonRecord[] {
  const comparison = asRecord(data?.comparison);
  const rows = asArray(comparison?.rows).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  if (rows.length > 0) return rows;
  return getAssets(data).map((asset) => {
    const quote = asRecord(asset.quote);
    const metrics = asRecord(asset.computedMetrics);
    const technical = asRecord(asRecord(asset.technicalIndicators)?.summary);
    const financialQuality = asRecord(asset.financialQuality);
    return {
      symbol: asset.symbol ?? quote?.symbol,
      name: asset.name ?? quote?.name ?? asset.symbol,
      price: quote?.price,
      change_percent: quote?.change_percent,
      return_120d_pct: technical?.return_120d_pct ?? metrics?.return120d ?? metrics?.periodReturn,
      max_drawdown: technical?.max_drawdown_pct ?? metrics?.maxDrawdown,
      volatility20d: technical?.volatility_20d_annualized_pct ?? metrics?.volatility20d,
      amount: quote?.amount,
      composite_score: financialQuality?.quality_score,
      selection_view: financialQuality?.quality_label,
      financial_quality_label: financialQuality?.quality_label,
    };
  });
}

function getRowsFrom(data: JsonRecord | null, key: string): JsonRecord[] {
  const record = asRecord(data?.[key]);
  return asArray(record?.rows).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
}

function getConclusion(data: JsonRecord | null): string[] {
  const conclusion = asRecord(data?.conclusion);
  return asArray(conclusion?.summary).map(String).filter(Boolean);
}

function StrategyResearchProtocol({ data }: { data: JsonRecord | null }) {
  const screener = asRecord(data?.screener);
  const candidates = asArray(screener?.candidates)
    .map(asRecord)
    .filter((item): item is JsonRecord => Boolean(item));
  const signalRules = Array.from(new Set(
    candidates.flatMap((candidate) => asArray(candidate.signals).map(String)),
  )).slice(0, 8);
  const warnings = asArray(data?.warnings).map(String).filter(Boolean);
  const conclusion = asRecord(data?.conclusion);
  const hypothesis = candidates.length > 0
    ? '在真实股票池中观察量价、趋势、回撤与流动性共同改善的候选；当前结果只形成待验证假设。'
    : '当前筛选未形成候选，保留原始规则与空结果，不降低安全门槛。';
  return (
    <section className="strategy-protocol" aria-label="策略假设与验证协议">
      <article className="selection-panel">
        <div className="panel-heading"><div><h2>策略假设</h2><p>先定义可证伪假设，再展示候选</p></div><span>未回测</span></div>
        <p>{hypothesis}</p>
      </article>
      <article className="selection-panel">
        <div className="panel-heading"><div><h2>信号规则</h2><p>来自本次真实筛选结果的可审计信号</p></div><span>{signalRules.length} 条</span></div>
        <ul>{(signalRules.length ? signalRules : ['没有候选信号通过当前规则']).map((rule, index) => <li key={index}>{rule}</li>)}</ul>
      </article>
      <article className="selection-panel">
        <div className="panel-heading"><div><h2>样本参数</h2><p>保持筛选口径和覆盖范围可复核</p></div></div>
        <dl className="strategy-parameter-list">
          <div><dt>股票池</dt><dd>{String(screener?.universe_id ?? '待确认')}</dd></div>
          <div><dt>模式</dt><dd>{String(screener?.mode ?? '待确认')}</dd></div>
          <div><dt>交易日</dt><dd>{String(screener?.trade_date ?? data?.as_of ?? '-')}</dd></div>
          <div><dt>扫描/入选</dt><dd>{formatNumber(screener?.scanned_symbols, 0)} / {formatNumber(screener?.total_candidates ?? candidates.length, 0)}</dd></div>
        </dl>
      </article>
      <article className="selection-panel">
        <div className="panel-heading"><div><h2>待验证清单与数据限制</h2><p>没有回测或缺失的数据不会包装成结论</p></div></div>
        <ul>
          <li>尚未完成独立样本外回测、交易成本和参数敏感性检验。</li>
          <li>{String(conclusion?.risk_disclaimer ?? '当前结果不构成投资建议、收益承诺或即时交易指令。')}</li>
          {warnings.slice(0, 4).map((warning, index) => <li key={'warning-' + index}>{warning}</li>)}
        </ul>
      </article>
    </section>
  );
}

function pickMetric(row: JsonRecord, fields: string[]): number | null {
  for (const field of fields) {
    const value = numeric(row[field]);
    if (value !== null) return value;
  }
  return null;
}

function RankingPanel({ rows }: { rows: JsonRecord[] }) {
  return (
    <section className="selection-panel ranking-panel">
      <div className="panel-heading">
        <div>
          <h2>相对强弱与排名依据</h2>
          <p>综合收益、回撤、波动、流动性和财务质量后的研究优先级</p>
        </div>
        <span>{rows.length} 项</span>
      </div>
      <div className="ranking-list">
        {rows.map((row, index) => (
          <article key={String(row.symbol ?? index)} className="ranking-row">
            <span className="rank-badge">{String(row.rank ?? index + 1)}</span>
            <div>
              <strong>{String(row.name ?? row.symbol ?? '-')}</strong>
              <small>{String(row.symbol ?? '-')} · {String(row.view ?? row.selection_view ?? '观察研究')}</small>
            </div>
            <em>{formatNumber(row.score ?? row.composite_score, 0)}</em>
            <p>{String(row.reason ?? row.ranking_reason ?? row.exclusion_reason ?? '等待更多指标确认。')}</p>
          </article>
        ))}
      </div>
    </section>
  );
}

function ComparisonTable({ rows }: { rows: JsonRecord[] }) {
  return (
    <section className="selection-panel">
      <div className="panel-heading">
        <div>
          <h2>多标的指标矩阵</h2>
          <p>统一窗口下的行情、收益、风险、流动性和质量对比</p>
        </div>
        <span>{rows.length} 项</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>标的</th>
              <th>最新价</th>
              <th>涨跌幅</th>
              <th>区间收益</th>
              <th>最大回撤</th>
              <th>波动率</th>
              <th>成交额</th>
              <th>综合分</th>
              <th>研究视图</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={String(row.symbol ?? index)}>
                <td><strong>{String(row.name ?? row.symbol)}</strong><small>{String(row.symbol ?? '-')}</small></td>
                <td>{formatNumber(row.price)}</td>
                <td className={tone(row.change_percent)}>{formatPercent(row.change_percent)}</td>
                <td className={tone(pickMetric(row, ['period_return', 'period_return_pct', 'return_120d_pct', 'return_120d']))}>{formatPercent(pickMetric(row, ['period_return', 'period_return_pct', 'return_120d_pct', 'return_120d']))}</td>
                <td className="down">{formatPercent(pickMetric(row, ['max_drawdown', 'max_drawdown_pct']))}</td>
                <td>{formatPercent(pickMetric(row, ['volatility20d', 'volatility_20d_annualized_pct', 'volatility20d_pct']))}</td>
                <td>{formatMoney(row.amount ?? row.avg_amount_20d)}</td>
                <td>{formatNumber(row.composite_score, 0)}</td>
                <td>{String(row.selection_view ?? row.relative_strength ?? '-')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function BarCompare({ rows, fields, title, subtitle, inverse = false }: {
  rows: JsonRecord[];
  fields: string[];
  title: string;
  subtitle: string;
  inverse?: boolean;
}) {
  const chartRows = rows.slice(0, 8);
  const values = chartRows.map((row) => pickMetric(row, fields) ?? 0);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const range = Math.max(max - min, 0.000001);
  const zeroX = 250 + ((0 - min) / range) * 390;

  return (
    <section className="selection-panel chart-panel core-chart-panel">
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          <p>{subtitle}</p>
        </div>
      </div>
      <svg className="selection-main-chart" viewBox="0 0 720 320" preserveAspectRatio="none" role="img" aria-label={title + '，含坐标轴、标的标签和数值标签'}>
        <rect x="0" y="0" width="720" height="320" className="chart-bg" />
        <line x1="250" y1="44" x2="640" y2="44" className="axis grid" />
        <line x1="250" y1="274" x2="640" y2="274" className="axis" />
        <line x1={zeroX.toFixed(2)} y1="34" x2={zeroX.toFixed(2)} y2="286" className="axis zero-axis" />
        <text x="250" y="304" className="chart-label chart-date">{formatPercent(min)}</text>
        <text x={zeroX.toFixed(2)} y="304" className="chart-label chart-date">0%</text>
        <text x="640" y="304" className="chart-label chart-date">{formatPercent(max)}</text>
        {chartRows.map((row, index) => {
          const value = pickMetric(row, fields) ?? 0;
          const valueX = 250 + ((value - min) / range) * 390;
          const x = Math.min(zeroX, valueX);
          const width = Math.max(3, Math.abs(valueX - zeroX));
          const y = 58 + index * 27;
          const favorable = inverse ? value <= 0 : value >= 0;
          return (
            <g key={String(row.symbol ?? index)}>
              <text x="22" y={(y + 10).toFixed(1)} className="chart-label chart-stock-label">{String(row.name ?? row.symbol ?? '-')}</text>
              <rect
                x={x.toFixed(2)}
                y={y.toFixed(1)}
                width={width.toFixed(2)}
                height="16"
                rx="3"
                className={favorable ? 'bar-up-rect' : 'bar-down-rect'}
              />
              <text x={(valueX + (value >= 0 ? 8 : -8)).toFixed(2)} y={(y + 11).toFixed(1)} className={'chart-label chart-value-label ' + (value >= 0 ? 'value-positive' : 'value-negative')}>
                {formatPercent(value)}
              </text>
            </g>
          );
        })}
      </svg>
      <p className="chart-note">主图按统一横轴缩放，避免只用迷你趋势图造成不可读。</p>
    </section>
  );
}

function FinancialQualityPanel({ rows }: { rows: JsonRecord[] }) {
  return (
    <section className="selection-panel">
      <div className="panel-heading">
        <div>
          <h2>财务质量</h2>
          <p>最近报告期的 ROE、利润率、同比增长和质量标签</p>
        </div>
        <span>{rows.length} 项</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>标的</th><th>ROE</th><th>毛利率</th><th>净利率</th><th>收入同比</th><th>利润同比</th><th>质量分</th><th>标签</th></tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={String(row.symbol ?? index)}>
                <td><strong>{String(row.name ?? row.symbol)}</strong><small>{String(row.symbol ?? '-')}</small></td>
                <td>{formatPercent(row.roe_pct)}</td>
                <td>{formatPercent(row.gross_margin_pct)}</td>
                <td>{formatPercent(row.net_margin_pct)}</td>
                <td className={tone(row.revenue_yoy_pct)}>{formatPercent(row.revenue_yoy_pct)}</td>
                <td className={tone(row.net_profit_yoy_pct)}>{formatPercent(row.net_profit_yoy_pct)}</td>
                <td>{formatNumber(row.quality_score, 0)}</td>
                <td>{String(row.quality_label ?? '-')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default async function Home() {
  const data = await readDashboardData();
  const assets = getAssets(data);
  const rows = getComparisonRows(data);
  const rankingRows = getRowsFrom(data, 'selectionRanking')
    .slice()
    .sort((left, right) => (numeric(left.rank) ?? Number.MAX_SAFE_INTEGER) - (numeric(right.rank) ?? Number.MAX_SAFE_INTEGER));
  const financialRows = getRowsFrom(data, 'financialQuality');
  const conclusion = getConclusion(data);
  const leaders = asRecord(asRecord(data?.comparison)?.leaders);
  const screener = asRecord(data?.screener);
  const warnings = asArray(data?.warnings).map(String).filter(Boolean);
  const visualization = asRecord(data?.visualization);
  const isStrategyResearch = String(visualization?.template_id ?? visualization?.templateId ?? '') === 'strategy-research';
  const noCandidates = data?.status === 'no_candidates' && assets.length === 0 && rows.length === 0;
  const requestedSymbols = asArray(data?.requestedSymbols ?? data?.symbols).map(String);
  const topRanking = rankingRows[0] ?? rows.slice().sort((left, right) => (numeric(right.composite_score) ?? -1) - (numeric(left.composite_score) ?? -1))[0];

  return (
    <main className="selection-shell" data-visual-language="financial-workbench" data-market-proxy="/api/market" data-source-file={DATA_FILE} data-template={isStrategyResearch ? 'strategy-research' : 'stock-selection'}>
      <header className="selection-header">
        <div>
          <p className="eyebrow">{isStrategyResearch ? 'QuantPilot 策略研究' : 'QuantPilot 多标的对比'}</p>
          <h1>{isStrategyResearch ? '可证伪的候选筛选研究' : topRanking ? String(topRanking.name ?? topRanking.symbol) + ' 暂列研究优先级第一' : '多标的研究看板'}</h1>
          <p>覆盖 {requestedSymbols.length || rows.length} 个标的：{requestedSymbols.join('、') || rows.map((row) => String(row.symbol)).join('、')}。以下排序仅用于研究，不构成交易指令。</p>
        </div>
        <div className="header-meta">
          <span>研究用途：{isStrategyResearch ? '假设与候选验证' : '多标的对比'}</span>
          <span>数据口径：真实数据与信源证据</span>
          <span>数据质量与限制：{warnings.length > 0 ? warnings.length + ' 项待核验' : '未发现阻断项'}</span>
        </div>
      </header>

      {noCandidates ? (
        <section className="selection-empty-result" role="status">
          <div>
            <p className="eyebrow">筛选已完成 · 结构化空结果</p>
            <h2>本次没有满足安全条件的候选</h2>
            <p>
              已扫描 {formatNumber(screener?.scanned_symbols, 0)} 个标的，目标 {formatNumber(screener?.limit, 0)} 只；
              平台没有为凑足数量而放宽过滤或编造推荐。
            </p>
          </div>
          <ul>
            {(warnings.length ? warnings : ['可补齐交易日覆盖或调整明确、可审计的筛选条件后重新运行。']).map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <dl className="selection-metrics">
        <div><dt>收益领先</dt><dd>{String(asRecord(leaders?.best_return)?.name ?? '-')}</dd><dd className="metric-detail">{formatPercent(asRecord(leaders?.best_return)?.value)}</dd></div>
        <div><dt>回撤较小</dt><dd>{String(asRecord(leaders?.lowest_drawdown)?.name ?? '-')}</dd><dd className="metric-detail">{formatPercent(asRecord(leaders?.lowest_drawdown)?.value)}</dd></div>
        <div><dt>波动较低</dt><dd>{String(asRecord(leaders?.lowest_volatility)?.name ?? '-')}</dd><dd className="metric-detail">{formatPercent(asRecord(leaders?.lowest_volatility)?.value)}</dd></div>
        <div><dt>标的数量</dt><dd>{rows.length}</dd><dd className="metric-detail">{assets.length} 只已绑定数据</dd></div>
      </dl>

      <ComparisonTable rows={rows} />

      {isStrategyResearch ? <StrategyResearchProtocol data={data} /> : null}

      <section className="chart-grid core-chart-grid">
        <BarCompare rows={rows} fields={['period_return', 'period_return_pct', 'return_120d_pct', 'return_120d']} title="收益对比主图" subtitle="统一样本窗口下的累计收益" />
        <BarCompare rows={rows} fields={['max_drawdown', 'max_drawdown_pct']} title="回撤对比主图" subtitle="回撤越小越稳健" inverse />
        <BarCompare rows={rows} fields={['volatility20d', 'volatility_20d_annualized_pct', 'volatility20d_pct']} title="波动对比主图" subtitle="20 日年化波动率口径" inverse />
      </section>

      <section className="main-grid">
        <RankingPanel rows={rankingRows.length ? rankingRows : rows} />
        <section className="selection-panel conclusion-panel">
          <div className="panel-heading">
            <div>
              <h2>结论摘要</h2>
              <p>事实、计算和限制分层呈现</p>
            </div>
          </div>
          <ul>
            {(conclusion.length ? conclusion : ['真实数据已绑定，等待 Agent 补充更详细的研究解释。']).map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </section>
      </section>

      <FinancialQualityPanel rows={financialRows} />
    </main>
  );
}
`;
}

export function comparisonCss() {
  return `

.comparison-shell {
  width: 100%;
  max-width: 100%;
  min-width: 0;
  min-height: 100vh;
  background: var(--bg);
  color: var(--ink);
  padding: 28px;
}

.comparison-header {
  display: flex;
  justify-content: space-between;
  gap: 24px;
  align-items: flex-end;
  padding: 20px 0 16px;
  border-bottom: 1px solid var(--line);
}

.comparison-header h1 {
  margin: 4px 0 6px;
  font-size: clamp(26px, 2.8vw, 40px);
  letter-spacing: 0;
}

.comparison-header > *,
.panel-heading > * {
  min-width: 0;
}

.comparison-header h1,
.comparison-header p,
.panel-heading h2,
.panel-heading p {
  overflow-wrap: anywhere;
}

.comparison-header p,
.header-meta {
  color: var(--muted);
}

.eyebrow {
  margin: 0;
  color: var(--red);
  font-weight: 700;
  font-size: 14px;
}

.header-meta {
  display: grid;
  gap: 6px;
  text-align: right;
  font-size: 14px;
}

.comparison-metrics,
.chart-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0;
  margin: 0;
  border-bottom: 1px solid var(--line);
}

.comparison-panel,
.comparison-matrix {
  border: 0;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}

.comparison-metrics > div {
  padding: 20px;
}

.comparison-metrics > div + div {
  border-left: 1px solid var(--line);
}

.comparison-metrics dt {
  display: block;
  color: var(--muted);
  margin-bottom: 8px;
  font-size: 14px;
}

.comparison-metrics dd {
  display: block;
  margin: 0;
  font-size: 24px;
  font-weight: 800;
  white-space: normal;
  overflow-wrap: anywhere;
}

.comparison-metrics .metric-detail {
  display: block;
  margin-top: 8px;
  font-size: 22px;
  font-weight: 800;
  white-space: nowrap;
}

.comparison-matrix,
.comparison-panel {
  min-width: 0;
  max-width: 100%;
  margin: 0;
  padding: 20px;
}

.comparison-two-column {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr);
  gap: 14px;
}

.correlation-list {
  display: grid;
  gap: 10px;
}

.correlation-row {
  display: grid;
  grid-template-columns: minmax(160px, 0.9fr) minmax(120px, 1fr) 64px;
  gap: 12px;
  align-items: center;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-1);
}

.correlation-row strong,
.correlation-row small,
.correlation-row em {
  display: block;
}

.correlation-row small {
  margin-top: 2px;
  color: var(--muted);
  font-size: 13px;
}

.correlation-row em {
  color: var(--ink);
  font-style: normal;
  font-weight: 800;
  text-align: right;
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

.corr-positive {
  background: var(--red);
}

.corr-negative {
  background: var(--green);
}

.panel-heading {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  margin-bottom: 14px;
}

.panel-heading h2 {
  margin: 0 0 4px;
  font-size: 17px;
  font-weight: 700;
}

.panel-heading p {
  margin-bottom: 0;
  color: var(--muted);
  font-size: 14px;
}

.panel-heading span {
  flex-shrink: 0;
  padding: 4px 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--muted);
  font-size: 13px;
  font-weight: 600;
}

.compact-list {
  display: grid;
  gap: 10px;
}

.compact-row {
  display: grid;
  grid-template-columns: minmax(140px, 0.9fr) minmax(100px, 1fr) 64px;
  gap: 8px;
  align-items: center;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface-1);
}

.comparison-bars {
  width: 100%;
  height: 220px;
}

.axis {
  stroke: var(--line);
  stroke-width: 0.5;
}

.bar-up rect {
  fill: var(--red);
}

.bar-down rect {
  fill: var(--green);
}

.chart-value-row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  font-size: 14px;
  color: var(--muted);
}

.up {
  color: var(--red);
}

.down {
  color: var(--green);
}

.neutral {
  color: var(--ink);
}

@media (max-width: 900px) {
  .comparison-shell {
    padding: 16px;
  }

  .comparison-header,
  .panel-heading {
    display: block;
  }

  .header-meta {
    margin-top: 14px;
    text-align: left;
  }

  .comparison-metrics,
  .chart-grid,
  .comparison-two-column {
    grid-template-columns: 1fr;
  }

  .comparison-metrics > *,
  .chart-grid > *,
  .comparison-two-column > * {
    min-width: 0;
  }

  .comparison-metrics > div + div {
    border-left: 0;
    border-top: 1px solid var(--line);
  }

  .correlation-row {
    grid-template-columns: minmax(0, 1fr) 56px;
  }

  .correlation-row .correlation-meter {
    grid-column: 1 / -1;
    grid-row: 2;
  }

  .correlation-row em {
    grid-column: 2;
    grid-row: 1;
  }

  .compact-row {
    grid-template-columns: minmax(0, 1fr) 56px;
  }
}

${comparisonWorkbenchCss()}
`;
}

export function stockSelectionCss() {
  return `

.strategy-protocol {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  border-bottom: 1px solid var(--line);
}

.strategy-protocol > *:nth-child(even) {
  border-left: 1px solid var(--line);
}

.strategy-protocol p,
.strategy-protocol li {
  color: var(--muted);
  font-size: 14px;
  line-height: 1.65;
}

.strategy-protocol ul {
  margin: 0;
  padding-left: 20px;
}

.strategy-parameter-list {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  margin: 0;
  border: 1px solid var(--line-light);
}

.strategy-parameter-list > div {
  min-width: 0;
  padding: 10px 12px;
}

.strategy-parameter-list dt {
  color: var(--muted);
  font-size: 12px;
}

.strategy-parameter-list dd {
  margin: 4px 0 0;
  overflow-wrap: anywhere;
  font-weight: 700;
}

.selection-empty-result {
  display: grid;
  grid-template-columns: minmax(0, 1.25fr) minmax(280px, 0.75fr);
  gap: 20px;
  margin-top: 14px; padding: 20px 22px;
  border: 1px solid color-mix(in srgb, var(--gold) 42%, var(--line));
  border-radius: 8px; background: color-mix(in srgb, var(--amber-bg) 78%, white);
  box-shadow: var(--shadow-sm);
}

.selection-empty-result h2 {
  margin: 5px 0 8px; font-size: clamp(21px, 2vw, 28px);
}

.selection-empty-result p {
  margin-bottom: 0; color: var(--muted);
}

.selection-empty-result ul {
  display: grid;
  gap: 6px;
  margin: 0;
  padding-left: 18px;
  color: #805600;
  font-size: 13px;
}

.selection-shell {
  width: 100%;
  max-width: 100%;
  min-width: 0;
  min-height: 100vh;
  background: var(--bg);
  color: var(--ink);
  padding: 28px;
}

@media (max-width: 800px) {
  .strategy-protocol,
  .strategy-parameter-list {
    grid-template-columns: 1fr;
  }

  .strategy-protocol > *:nth-child(even) {
    border-left: 0;
  }
}

.selection-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 24px;
  align-items: end;
  padding: 20px 0 16px;
  border-bottom: 1px solid var(--line);
}

.selection-header h1 {
  margin: 6px 0;
  font-size: clamp(26px, 2.8vw, 42px);
  line-height: 1.1;
  letter-spacing: 0;
}

.selection-header > *,
.panel-heading > * {
  min-width: 0;
}

.selection-header h1,
.selection-header p,
.panel-heading h2,
.panel-heading p,
.ranking-row strong,
.ranking-row small,
.ranking-row p {
  overflow-wrap: anywhere;
}

.selection-header p,
.header-meta {
  color: var(--muted);
}

.header-meta {
  display: grid;
  gap: 6px;
  padding-left: 20px;
  border-left: 1px solid var(--line);
  text-align: right;
  font-size: 13px;
}

.selection-panel {
  min-width: 0;
  max-width: 100%;
  border: 0;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}

.selection-metrics,
.chart-grid,
.main-grid {
  display: grid;
  gap: 0;
  margin: 0;
  border-bottom: 1px solid var(--line);
}

.selection-metrics {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.chart-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.core-chart-grid {
  align-items: stretch;
}

.main-grid {
  grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr);
}

.selection-panel {
  padding: 20px;
}

.selection-metrics dd,
.selection-metrics .metric-detail,
.ranking-row strong,
.ranking-row em {
  display: block;
}

.selection-metrics > div {
  padding: 16px 20px;
}

.selection-metrics > div + div {
  border-left: 1px solid var(--line);
}

.selection-metrics dt {
  color: var(--muted);
  font-size: 13px;
}

.selection-metrics dd {
  margin-top: 8px;
  margin-left: 0;
  font-size: 24px;
  font-weight: 800;
  white-space: normal;
  overflow-wrap: anywhere;
}

.selection-metrics .metric-detail {
  margin-top: 6px;
  font-weight: 800;
}

.selection-panel {
  margin: 0;
}

.main-grid .selection-panel {
  margin-top: 0;
}

.panel-heading {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  margin-bottom: 14px;
}

.panel-heading h2 {
  margin: 0 0 4px;
  font-size: 17px;
  font-weight: 700;
}

.panel-heading p {
  margin-bottom: 0;
  color: var(--muted);
  font-size: 14px;
}

.panel-heading span {
  flex-shrink: 0;
  padding: 4px 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--muted);
  font-size: 13px;
  font-weight: 600;
}

.ranking-list {
  display: grid;
  gap: 10px;
}

.ranking-row {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr) 64px;
  gap: 12px;
  align-items: center;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--surface-1);
}

.ranking-row p {
  grid-column: 2 / -1;
  margin: 0;
  color: var(--muted);
  font-size: 14px;
}

.rank-badge {
  display: grid;
  place-items: center;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  background: var(--ink);
  color: #fff;
  font-weight: 800;
  font-size: 15px;
}

.conclusion-panel ul {
  margin: 0;
  padding-left: 20px;
}

.conclusion-panel li + li {
  margin-top: 10px;
}

.core-chart-panel {
  min-height: 390px;
}

.selection-main-chart {
  display: block;
  width: 100%;
  height: 290px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface-1);
}

.chart-bg {
  fill: var(--surface-1);
}

.chart-label {
  fill: var(--muted);
  font-size: 13px;
  paint-order: stroke;
  stroke: var(--surface-1);
  stroke-width: 3;
  vector-effect: non-scaling-stroke;
}

.chart-stock-label {
  text-anchor: start;
  dominant-baseline: central;
  font-size: 13px;
  font-weight: 700;
}

.chart-date {
  text-anchor: middle;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.chart-value-label {
  dominant-baseline: central;
  font-weight: 800;
  font-size: 13px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}

.value-positive {
  text-anchor: start;
}

.value-negative {
  text-anchor: end;
}

.bar-up-rect {
  fill: var(--red);
}

.bar-down-rect {
  fill: var(--green);
}

.axis {
  stroke: var(--line);
  stroke-width: 0.7;
}

.axis.grid {
  opacity: 0.45;
  stroke-dasharray: 3 4;
}

.zero-axis {
  stroke: var(--ink);
  opacity: 0.32;
}

.chart-note {
  margin: 10px 0 0;
  color: var(--muted);
  font-size: 13px;
}

.component-line {
  margin: 14px 0 0;
  color: var(--muted);
  font-size: 14px;
}

td small {
  display: block;
  margin-top: 2px;
  color: var(--muted);
}

.up {
  color: var(--red);
}

.down {
  color: var(--green);
}

.neutral {
  color: var(--ink);
}

@media (max-width: 980px) {
  .selection-empty-result {
    grid-template-columns: 1fr;
  }

  .selection-shell {
    padding: 10px;
  }

  .selection-header {
    display: block;
    padding: 14px;
  }

  .selection-header h1 {
    margin: 4px 0;
    font-size: 22px;
    line-height: 1.15;
  }

  .selection-header p {
    margin: 0;
    font-size: 13px;
    line-height: 1.55;
  }

  .header-meta {
    margin-top: 10px;
    padding: 8px 0 0;
    border-left: 0;
    border-top: 1px solid var(--line-light);
    text-align: left;
  }

  .selection-metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .selection-metrics > div {
    padding: 10px;
  }

  .selection-metrics > div:nth-child(3) {
    border-left: 0;
    border-top: 1px solid var(--line);
  }

  .selection-metrics > div:nth-child(4) {
    border-top: 1px solid var(--line);
  }

  .selection-metrics dd {
    margin-top: 4px;
    font-size: 17px;
  }

  .selection-metrics .metric-detail {
    margin-top: 3px;
    font-size: 12px;
  }

  .selection-panel {
    margin-top: 10px;
    padding: 12px;
  }

  .panel-heading {
    display: block;
    margin-bottom: 8px;
  }

  .panel-heading h2 {
    font-size: 15px;
  }

  .panel-heading p {
    font-size: 12px;
  }

  .panel-heading span {
    display: inline-block;
    margin-top: 6px;
    padding: 2px 7px;
    font-size: 11px;
  }

  .chart-grid,
  .main-grid {
    grid-template-columns: 1fr;
  }

  .selection-metrics > *,
  .chart-grid > *,
  .main-grid > * {
    min-width: 0;
  }

  .selection-main-chart {
    height: 250px;
  }

  table {
    font-size: 12px;
  }

  th,
  td {
    padding: 7px 8px;
  }
}

${stockSelectionWorkbenchCss()}
`;
}

export function holdingAnalysisPageTemplate() {
  return `${DASHBOARD_PAGE_RUNTIME_PRELUDE}

function tone(value: unknown): 'up' | 'down' | 'neutral' {
  const number = numeric(value);
  if (number === null || number === 0) return 'neutral';
  return number > 0 ? 'up' : 'down';
}

${DASHBOARD_DATA_READER}

function getAssets(data: JsonRecord | null): JsonRecord[] {
  return asArray(data?.assets).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
}

function getHoldings(data: JsonRecord | null): JsonRecord[] {
  const raw = asArray(data?.holdings).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  if (raw.length > 0) {
    return raw.map((h) => ({
      symbol: h.symbol,
      name: h.name,
      weight: h.weight ?? h.position_pct,
      quantity: h.quantity ?? h.shares,
      cost: h.cost ?? h.cost_price,
      current_price: h.current_price ?? h.price,
      market_value: h.market_value ?? h.marketValue,
      pnl: h.pnl ?? h.profit_loss,
      pnl_pct: h.pnl_pct ?? h.profit_loss_pct,
      as_of: h.as_of ?? h.quote_time ?? h.fetched_at,
      source: h.source,
    }));
  }
  return getAssets(data).map((asset) => {
    const quote = asRecord(asset.quote);
    const position = asRecord(asset.position);
    return {
      symbol: asset.symbol ?? quote?.symbol ?? position?.symbol,
      name: asset.name ?? quote?.name ?? position?.name ?? asset.symbol,
      weight: position?.weight ?? asset.weight,
      quantity: position?.quantity ?? position?.shares ?? asset.quantity ?? asset.shares,
      cost: position?.cost ?? position?.cost_price ?? asset.cost ?? asset.cost_price,
      current_price: quote?.price ?? position?.current_price,
      market_value: position?.market_value ?? asset.market_value,
      pnl: position?.pnl ?? asset.pnl,
      pnl_pct: position?.pnl_pct ?? asset.pnl_pct,
      as_of: asset.as_of ?? quote?.quote_time ?? quote?.fetched_at,
      source: asset.source ?? quote?.source,
    };
  });
}

function getPortfolio(data: JsonRecord | null): JsonRecord | null {
  const portfolio = asRecord(data?.portfolio);
  if (portfolio && (numeric(portfolio.total_value) !== null || numeric(portfolio.total_asset) !== null || numeric(portfolio.market_value) !== null)) {
    return portfolio;
  }
  const holdings = getHoldings(data);
  if (holdings.length === 0) return null;
  const totalMarketValue = holdings.reduce((sum, h) => sum + (numeric(h.market_value) ?? 0), 0);
  const totalCost = holdings.reduce((sum, h) => sum + (numeric(h.cost) ?? 0) * (numeric(h.quantity) ?? 0), 0);
  const hasCostData = holdings.some((h) => numeric(h.cost) !== null && numeric(h.quantity) !== null);
  const totalPnl = hasCostData ? totalMarketValue - totalCost : null;
  return {
    total_value: totalMarketValue,
    cost_basis: hasCostData ? totalCost : null,
    total_pnl: totalPnl,
    total_pnl_pct: hasCostData && totalCost > 0 ? (totalPnl! / totalCost) * 100 : null,
    holdings_count: holdings.length,
    as_of: holdings[0]?.as_of ?? data?.as_of,
  };
}

function getRiskMetrics(data: JsonRecord | null): JsonRecord | null {
  return asRecord(data?.risk) ?? asRecord(data?.risk_metrics);
}

function getComparisonRows(data: JsonRecord | null): JsonRecord[] {
  const comparison = asRecord(data?.comparison);
  const rows = asArray(comparison?.rows).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  if (rows.length > 0) return rows;
  return getAssets(data).map((asset) => {
    const quote = asRecord(asset.quote);
    const metrics = asRecord(asset.computedMetrics);
    const technical = asRecord(asRecord(asset.technicalIndicators)?.summary);
    return {
      symbol: asset.symbol ?? quote?.symbol,
      name: asset.name ?? quote?.name ?? asset.symbol,
      price: quote?.price,
      change_percent: quote?.change_percent,
      period_return: technical?.return_120d_pct ?? metrics?.periodReturn,
      max_drawdown: technical?.max_drawdown_pct ?? metrics?.maxDrawdown,
      volatility20d: technical?.volatility_20d_annualized_pct ?? metrics?.volatility20d,
      avg_volume_20d: metrics?.avgVolume20d,
      amount: quote?.amount,
      as_of: asset.as_of ?? quote?.quote_time ?? quote?.fetched_at,
    };
  });
}

function getSparklineBars(asset: JsonRecord): JsonRecord[] {
  return asArray(asRecord(asset.kline)?.bars).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
}

function getPortfolioReturnSeries(assets: JsonRecord[]) {
  const colors = ['#2563eb', '#dc2626', '#16a34a', '#d97706', '#7c3aed', '#0891b2'];
  return assets.map((asset, assetIndex) => {
    const bars = getSparklineBars(asset).slice(-60);
    const firstClose = bars.map((bar) => numeric(bar.close)).find((value): value is number => value !== null && value > 0) ?? null;
    const points: Array<{ date: string; value: number }> = [];
    if (firstClose !== null) {
      for (const bar of bars) {
        const close = numeric(bar.close);
        if (close === null) continue;
        points.push({
          date: String(bar.date ?? bar.trade_date ?? bar.datetime ?? ''),
          value: ((close / firstClose) - 1) * 100,
        });
      }
    }
    return {
      name: String(asset.name ?? asRecord(asset.quote)?.name ?? asset.symbol ?? '标的'),
      symbol: String(asset.symbol ?? asRecord(asset.quote)?.symbol ?? '-'),
      color: colors[assetIndex % colors.length],
      points,
    };
  }).filter((series) => series.points.length >= 2);
}

function shortChartDate(value: string): string {
  const date = value.includes('T') ? value.split('T')[0] : value;
  return date.length >= 10 ? date.slice(5, 10).replace('-', '/') : date || '-';
}

function weightBarWidth(weight: unknown, maxWeight: number): number {
  return Math.max(4, Math.min(100, ((numeric(weight) ?? 0) / Math.max(maxWeight, 0.01)) * 100));
}

function PortfolioReturnChart({ assets }: { assets: JsonRecord[] }) {
  const series = getPortfolioReturnSeries(assets);
  const values = series.flatMap((item) => item.points.map((point) => point.value));
  const rawMin = values.length ? Math.min(0, ...values) : -1;
  const rawMax = values.length ? Math.max(0, ...values) : 1;
  const rawRange = Math.max(rawMax - rawMin, 1);
  const minValue = rawMin - rawRange * 0.1;
  const maxValue = rawMax + rawRange * 0.1;
  const range = Math.max(maxValue - minValue, 0.000001);
  const left = 54;
  const right = 744;
  const top = 20;
  const bottom = 218;
  const chartWidth = right - left;
  const chartHeight = bottom - top;
  const yFor = (value: number) => bottom - ((value - minValue) / range) * chartHeight;
  const yTicks = Array.from({ length: 5 }, (_, index) => maxValue - (range * index) / 4);
  const reference = series[0]?.points ?? [];
  const dateTicks = reference.length > 0
    ? [reference[0], reference[Math.floor((reference.length - 1) / 2)], reference[reference.length - 1]]
    : [];

  return (
    <section className="holding-panel portfolio-chart-panel" aria-labelledby="portfolio-return-heading">
      <div className="panel-heading">
        <div>
          <h2 id="portfolio-return-heading">持仓累计收益对比主图</h2>
          <p>以各标的近 60 个交易日首个收盘价归一为 0%，在统一尺度下比较收益路径与回撤压力。</p>
        </div>
        <span>统一基准</span>
      </div>
      {series.length > 0 ? (
        <div className="portfolio-chart-wrap">
          <svg className="portfolio-main-chart" viewBox="0 0 760 264" preserveAspectRatio="none" role="img" aria-labelledby="portfolio-chart-title portfolio-chart-description">
            <title id="portfolio-chart-title">多标的近 60 个交易日累计收益对比主图</title>
            <desc id="portfolio-chart-description">带百分比纵轴、日期横轴、零收益基准线和标的图例的累计收益折线图。</desc>
            {yTicks.map((tick) => {
              const y = yFor(tick);
              return (
                <g key={'y-' + tick.toFixed(4)} aria-hidden="true">
                  <line x1={left} x2={right} y1={y} y2={y} className="portfolio-chart-grid" />
                  <text x={left - 8} y={y + 4} textAnchor="end" className="portfolio-chart-axis-label">{formatPercent(tick)}</text>
                </g>
              );
            })}
            <line x1={left} x2={right} y1={yFor(0)} y2={yFor(0)} className="portfolio-chart-zero" aria-hidden="true" />
            {dateTicks.map((point, index) => {
              const x = left + (index / Math.max(dateTicks.length - 1, 1)) * chartWidth;
              return (
                <g key={'x-' + index} aria-hidden="true">
                  <line x1={x} x2={x} y1={top} y2={bottom} className="portfolio-chart-grid portfolio-chart-grid-vertical" />
                  <text x={x} y={bottom + 24} textAnchor={index === 0 ? 'start' : index === dateTicks.length - 1 ? 'end' : 'middle'} className="portfolio-chart-axis-label">{shortChartDate(point.date)}</text>
                </g>
              );
            })}
            {series.map((item) => {
              const points = item.points.map((point, pointIndex) => {
                const x = left + (pointIndex / Math.max(item.points.length - 1, 1)) * chartWidth;
                return x.toFixed(2) + ',' + yFor(point.value).toFixed(2);
              }).join(' ');
              return (
                <polyline key={item.symbol} points={points} className="portfolio-return-line" style={{ stroke: item.color }}>
                  <title>{item.name + '（' + item.symbol + '）累计收益'}</title>
                </polyline>
              );
            })}
          </svg>
          <div className="portfolio-chart-legend" aria-label="累计收益图例">
            {series.map((item) => {
              const latest = item.points[item.points.length - 1]?.value;
              return (
                <span key={item.symbol}>
                  <i style={{ background: item.color }} aria-hidden="true" />
                  <b>{item.name}</b>
                  <em className={tone(latest)}>{formatPercent(latest)}</em>
                </span>
              );
            })}
          </div>
        </div>
      ) : (
        <p className="chart-empty">当前真实 K 线不足，暂不能计算累计收益路径。</p>
      )}
    </section>
  );
}

function ConcentrationPanel({ holdings }: { holdings: JsonRecord[] }) {
  const maxWeight = Math.max(0.01, ...holdings.map((h) => numeric(h.weight) ?? 0));
  return (
    <section className="holding-panel">
      <div className="panel-heading">
        <div>
          <h2>仓位集中度</h2>
          <p>按持仓权重从高到低排列；集中度过高可能放大单只标的风险。</p>
        </div>
        <span>{holdings.length} 只</span>
      </div>
      <div className="concentration-list">
        {holdings.map((holding, index) => {
          const weight = numeric(holding.weight) ?? 0;
          const pnlPct = numeric(holding.pnl_pct);
          return (
            <div key={String(holding.symbol ?? index)} className="concentration-row">
              <span className="concentration-label">{String(holding.name ?? holding.symbol ?? '-')}</span>
              <div className="concentration-bar-track">
                <i className={weight >= 20 ? 'bar-heavy' : weight >= 10 ? 'bar-moderate' : 'bar-light'} style={{ width: weightBarWidth(weight, maxWeight) + '%' }} />
              </div>
              <strong className="concentration-pct">{formatPercent(weight)}</strong>
              <em className={tone(pnlPct)}>{formatPercent(pnlPct)}</em>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function HoldingsTable({ holdings }: { holdings: JsonRecord[] }) {
  return (
    <section className="holding-panel">
      <div className="panel-heading">
        <div>
          <h2>持仓明细</h2>
          <p>逐只展示持仓数量、成本、现价、市值和浮动盈亏</p>
        </div>
        <span>{holdings.length} 只</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>标的</th>
              <th>数量</th>
              <th>成本价</th>
              <th>现价</th>
              <th>市值</th>
              <th>浮动盈亏</th>
              <th>盈亏%</th>
              <th>权重</th>
            </tr>
          </thead>
          <tbody>
            {holdings.map((holding, index) => {
              const pnl = numeric(holding.pnl);
              const pnlPct = numeric(holding.pnl_pct);
              return (
                <tr key={String(holding.symbol ?? index)}>
                  <td><strong>{String(holding.name ?? holding.symbol)}</strong><small>{String(holding.symbol ?? '-')}</small></td>
                  <td>{formatNumber(holding.quantity, 0)}</td>
                  <td>{formatNumber(holding.cost)}</td>
                  <td>{formatNumber(holding.current_price)}</td>
                  <td>{formatMoney(holding.market_value)}</td>
                  <td className={tone(pnl)}>{formatMoney(pnl)}</td>
                  <td className={tone(pnlPct)}>{formatPercent(pnlPct)}</td>
                  <td>{formatPercent(holding.weight)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ComparisonMetricsPanel({ rows }: { rows: JsonRecord[] }) {
  if (rows.length < 2) return null;
  return (
    <section className="holding-panel">
      <div className="panel-heading">
        <div>
          <h2>多标的指标对比</h2>
          <p>统一窗口下的行情、收益、波动和回撤横向比较</p>
        </div>
        <span>{rows.length} 项</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>标的</th>
              <th>最新价</th>
              <th>涨跌幅</th>
              <th>区间收益</th>
              <th>最大回撤</th>
              <th>波动率</th>
              <th>20 日均额</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={String(row.symbol ?? index)}>
                <td><strong>{String(row.name ?? row.symbol)}</strong><small>{String(row.symbol ?? '-')}</small></td>
                <td>{formatNumber(row.price)}</td>
                <td className={tone(row.change_percent)}>{formatPercent(row.change_percent)}</td>
                <td className={tone(row.period_return)}>{formatPercent(row.period_return)}</td>
                <td className="down">{formatPercent(row.max_drawdown)}</td>
                <td>{formatPercent(row.volatility20d)}</td>
                <td>{formatMoney(row.avg_volume_20d ?? row.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CorrelationLiquidityRiskPanel({ data }: { data: JsonRecord | null }) {
  const correlation = asRecord(data?.correlation);
  const pairs = asArray(correlation?.top_pairs)
    .map(asRecord)
    .filter((item): item is JsonRecord => Boolean(item));
  const liquidity = asRecord(data?.liquidity);
  const liquidityRows = asArray(liquidity?.rows)
    .map(asRecord)
    .filter((item): item is JsonRecord => Boolean(item));
  if (pairs.length === 0 && liquidityRows.length === 0) return null;
  return (
    <section className="holding-panel">
      <div className="panel-heading">
        <div>
          <h2>相关性与流动性风险</h2>
          <p>相关性基于对齐收益率；流动性为成交额和 Amihud 代理，不等同极端行情可成交性。</p>
        </div>
        <span>风险证据</span>
      </div>
      <div className="holding-risk-evidence-grid">
        <div className="correlation-list">
          {pairs.slice(0, 6).map((pair, index) => {
            const value = numeric(pair.correlation);
            return (
              <div className="correlation-row" key={String(pair.left ?? index) + String(pair.right ?? '')}>
                <div><strong>{String(pair.left ?? '-')} / {String(pair.right ?? '-')}</strong><small>重合样本 {formatNumber(pair.overlap, 0)}</small></div>
                <div className="correlation-meter"><span style={{ width: Math.max(4, Math.abs(value ?? 0) * 100) + '%' }} className={(value ?? 0) >= 0 ? 'corr-positive' : 'corr-negative'} /></div>
                <em>{formatNumber(value, 4)}</em>
              </div>
            );
          })}
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>标的</th><th>20 日均额</th><th>换手代理</th><th>流动性</th></tr></thead>
            <tbody>
              {liquidityRows.map((row, index) => (
                <tr key={String(row.symbol ?? index)}>
                  <td><strong>{String(row.name ?? row.symbol ?? '-')}</strong><small>{String(row.symbol ?? '-')}</small></td>
                  <td>{formatMoney(row.avg_amount_20d)}</td>
                  <td>{formatPercent(row.turnover_proxy_pct)}</td>
                  <td>{String(row.liquidity_score ?? '-')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function PortfolioDataGapsPanel({ portfolio }: { portfolio: JsonRecord | null }) {
  const gaps = asArray(portfolio?.data_gaps).map(String).filter(Boolean);
  const warnings = asArray(portfolio?.warnings).map(String).filter(Boolean);
  if (gaps.length === 0 && warnings.length === 0) return null;
  return (
    <section className="holding-panel portfolio-gap-panel">
      <div className="panel-heading">
        <div><h2>数据缺口与能力边界</h2><p>缺失的真实持仓字段不会用行情代理伪装为已确认数据</p></div>
        <span>{gaps.length} 项缺口</span>
      </div>
      <div className="portfolio-gap-grid">
        {gaps.map((gap) => <span key={gap}>{gap}</span>)}
      </div>
      <ul>{warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
    </section>
  );
}

function RiskPanel({ risk }: { risk: JsonRecord | null }) {
  if (!risk) return null;
  const var95 = numeric(risk?.var_95_pct ?? risk?.VaR_95);
  const var99 = numeric(risk?.var_99_pct ?? risk?.VaR_99);
  const expectedShortfall = numeric(risk?.expected_shortfall ?? risk?.cvar_95);
  const correlation = asArray(risk?.correlation_top_pairs).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  return (
    <section className="holding-panel">
      <div className="panel-heading">
        <div>
          <h2>组合风险估算</h2>
          <p>基于历史收益的 VaR、CVaR 和相关性评估；未建模极端事件和流动性冲击。</p>
        </div>
        <span>仅供参考</span>
      </div>
      <dl className="risk-strip">
        <div><dt>VaR 95%</dt><dd>{formatPercent(var95)}</dd></div>
        <div><dt>VaR 99%</dt><dd>{formatPercent(var99)}</dd></div>
        <div><dt>Expected Shortfall</dt><dd>{formatPercent(expectedShortfall)}</dd></div>
        <div><dt>计算区间</dt><dd>{String(risk?.window ?? risk?.sample_window ?? '-')}</dd></div>
      </dl>
      {correlation.length > 0 && (
        <div className="correlation-list" style={{ marginTop: 14 }}>
          {correlation.slice(0, 4).map((pair, index) => {
            const corr = numeric(pair.correlation);
            return (
              <div className="correlation-row" key={String(pair.left ?? index) + String(pair.right ?? '')}>
                <div><strong>{String(pair.left ?? '-')} / {String(pair.right ?? '-')}</strong></div>
                <div className="correlation-meter"><span style={{ width: Math.max(4, Math.abs(corr ?? 0) * 100) + '%' }} className={(corr ?? 0) >= 0 ? 'corr-positive' : 'corr-negative'} /></div>
                <em>{formatNumber(corr, 4)}</em>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

export default async function Home() {
  const data = await readDashboardData();
  const portfolio = getPortfolio(data);
  const holdings = getHoldings(data);
  const assets = getAssets(data);
  const comparisonRows = getComparisonRows(data);
  const risk = getRiskMetrics(data);
  const requestedSymbols = asArray(data?.requestedSymbols ?? data?.symbols).map(String);
  const totalPnl = numeric(portfolio?.total_pnl);
  const totalPnlPct = numeric(portfolio?.total_pnl_pct);

  return (
    <main className="holding-shell" data-visual-language="financial-workbench" data-market-proxy="/api/market" data-source-file={DATA_FILE} data-template="holding-analysis">
      <header className="holding-header">
        <div>
          <p className="eyebrow">QuantPilot 持仓分析</p>
          <h1>组合持仓风险看板</h1>
          <p>覆盖 {holdings.length} 只持仓：{holdings.map((h) => String(h.name ?? h.symbol)).join('、')}。以下分析仅用于研究，不构成交易指令。</p>
        </div>
        <div className="header-meta">
          <span>持仓 {String(portfolio?.holdings_count ?? holdings.length)} 只</span>
          <span>覆盖 {requestedSymbols.length || assets.length} 个标的</span>
          <span>数据截至 {String(portfolio?.as_of ?? holdings[0]?.as_of ?? '-')}</span>
          <span>数据信源：已记录</span>
        </div>
      </header>

      <dl className="portfolio-metrics">
        <div><dt>组合市值</dt><dd>{formatMoney(portfolio?.total_value)}</dd></div>
        <div><dt>持仓成本</dt><dd>{formatMoney(portfolio?.cost_basis)}</dd></div>
        <div><dt>浮动盈亏</dt><dd className={tone(totalPnl)}>{formatMoney(totalPnl)}</dd></div>
        <div><dt>盈亏幅度</dt><dd className={tone(totalPnlPct)}>{formatPercent(totalPnlPct)}</dd></div>
      </dl>

      <PortfolioReturnChart assets={assets} />

      <section className="holding-main-grid">
        <HoldingsTable holdings={holdings} />
        <ConcentrationPanel holdings={holdings} />
      </section>

      <ComparisonMetricsPanel rows={comparisonRows} />

      <CorrelationLiquidityRiskPanel data={data} />

      <PortfolioDataGapsPanel portfolio={asRecord(data?.portfolio)} />

      <RiskPanel risk={risk} />
    </main>
  );
}
`;
}

export function holdingAnalysisCss() {
  return `

.holding-risk-evidence-grid {
  display: grid;
  grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.15fr);
  gap: 18px;
  align-items: start;
}

.portfolio-gap-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.portfolio-gap-grid span {
  padding: 5px 9px;
  border: 1px solid color-mix(in srgb, var(--gold) 36%, var(--line));
  border-radius: 999px;
  color: #805600;
  background: var(--amber-bg);
  font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
}

.portfolio-gap-panel ul {
  margin: 12px 0 0;
  padding-left: 20px;
  color: var(--muted);
  font-size: 13px;
  line-height: 1.65;
}

.holding-shell {
  min-height: 100vh;
  background: var(--bg);
  color: var(--ink);
  padding: 28px;
}

.holding-header {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: 24px;
  padding: 20px 0 16px;
  border-bottom: 1px solid var(--line);
}

@media (max-width: 800px) {
  .holding-risk-evidence-grid {
    grid-template-columns: 1fr;
  }
}

.holding-header h1 {
  margin: 4px 0 6px;
  font-size: clamp(26px, 2.8vw, 40px);
  letter-spacing: 0;
}

.holding-header p {
  color: var(--muted);
}

.portfolio-metrics,
.risk-strip {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 0;
  margin: 0;
  border-bottom: 1px solid var(--line);
}

.portfolio-metrics > div,
.risk-strip > div {
  padding: 16px;
}

.portfolio-metrics > div + div,
.risk-strip > div + div {
  border-left: 1px solid var(--line);
}

.portfolio-metrics dt,
.risk-strip dt {
  display: block;
  margin-bottom: 6px;
  color: var(--muted);
  font-size: 14px;
}

.portfolio-metrics dd,
.risk-strip dd {
  display: block;
  margin: 0;
  font-size: 24px;
  font-weight: 800;
  white-space: nowrap;
}

.header-meta {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px 18px;
  padding-left: 20px;
  border-left: 1px solid var(--line);
  color: var(--muted);
  font-size: 14px;
}

.portfolio-chart-panel { margin: 0; }
.portfolio-chart-wrap {
  min-width: 0; overflow: hidden;
  padding: 8px 10px 10px;
  border: 1px solid var(--line);
  border-radius: 7px; background: var(--surface-1);
}
.portfolio-main-chart {
  display: block; width: 100%; height: 300px;
}
.portfolio-chart-grid {
  stroke: var(--line); stroke-width: 1;
  vector-effect: non-scaling-stroke;
}
.portfolio-chart-grid-vertical {
  stroke-dasharray: 3 5; opacity: 0.7;
}
.portfolio-chart-zero {
  stroke: var(--muted); stroke-width: 1.25; stroke-dasharray: 6 5;
  vector-effect: non-scaling-stroke;
}
.portfolio-chart-axis-label {
  fill: var(--muted); font-size: 11px; font-weight: 600;
}
.portfolio-return-line {
  fill: none; stroke-width: 2.6;
  stroke-linecap: round; stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}
.portfolio-chart-legend {
  display: flex; flex-wrap: wrap;
  gap: 8px 16px;
  padding: 4px 6px 0 44px;
}
.portfolio-chart-legend span {
  display: inline-flex; align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12px;
}
.portfolio-chart-legend i {
  width: 9px; height: 9px;
  flex: 0 0 auto;
  border-radius: 999px;
}
.portfolio-chart-legend b {
  overflow: hidden; text-overflow: ellipsis;
  max-width: 120px;
  white-space: nowrap;
}
.portfolio-chart-legend em {
  font-style: normal; font-weight: 800;
}
.chart-empty {
  margin: 0;
  padding: 28px;
  border: 1px dashed var(--line); border-radius: 7px;
  text-align: center;
}

.holding-main-grid {
  display: grid;
  grid-template-columns: minmax(0, 1.2fr) minmax(0, 0.8fr);
  gap: 0;
  margin: 0;
  border-bottom: 1px solid var(--line);
}

.holding-panel {
  border: 0;
  border-bottom: 1px solid var(--line);
  background: var(--panel);
}

.holding-panel {
  margin: 0;
  padding: 20px;
}

.panel-heading {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: flex-start;
  margin-bottom: 14px;
}

.panel-heading h2 {
  margin: 0 0 4px;
  font-size: 17px;
  font-weight: 700;
}

.panel-heading p {
  margin-bottom: 0;
  color: var(--muted);
  font-size: 14px;
}

.panel-heading span {
  flex-shrink: 0;
  padding: 4px 10px;
  border: 1px solid var(--line);
  border-radius: 999px;
  color: var(--muted);
  font-size: 13px;
  font-weight: 600;
}

.concentration-list {
  display: grid;
  gap: 10px;
}

.concentration-row {
  display: grid;
  grid-template-columns: 100px minmax(0, 1fr) 60px 64px;
  gap: 12px;
  align-items: center;
}

.concentration-label {
  font-weight: 600;
}

.concentration-bar-track {
  height: 10px;
  overflow: hidden;
  border-radius: 999px;
  background: #eef2f7;
}

.concentration-bar-track i {
  display: block;
  height: 100%;
  border-radius: inherit;
}

.bar-heavy { background: var(--red); }
.bar-moderate { background: #e6a817; }
.bar-light { background: #8b9cb8; }

.concentration-pct {
  font-weight: 800;
  text-align: right;
}

.correlation-list {
  display: grid;
  gap: 10px;
}

.correlation-row {
  display: grid;
  grid-template-columns: minmax(140px, 0.9fr) minmax(100px, 1fr) 56px;
  gap: 12px;
  align-items: center;
  padding: 10px;
  border: 1px solid var(--line);
  border-radius: 6px;
  background: var(--surface-1);
}

.correlation-row strong {
  font-size: 15px;
}

.correlation-row em {
  font-style: normal;
  font-weight: 800;
  text-align: right;
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

.axis {
  stroke: var(--line);
  stroke-width: 0.7;
}

td small {
  display: block;
  margin-top: 2px;
  color: var(--muted);
}

.up { color: var(--red); }
.down { color: var(--green); }
.neutral { color: var(--ink); }

@media (max-width: 980px) {
  .holding-shell {
    padding: 12px;
  }

  .holding-header {
    display: block;
    gap: 12px; padding: 16px;
  }

  .holding-header h1 {
    margin: 3px 0 5px; font-size: clamp(25px, 8vw, 32px);
  }

  .holding-header > div:first-child > p:last-child {
    font-size: 13px; line-height: 1.55;
  }

  .portfolio-metrics,
  .risk-strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .portfolio-metrics > div,
  .risk-strip > div {
    padding: 10px;
  }

  .portfolio-metrics > div:nth-child(3),
  .risk-strip > div:nth-child(3) {
    border-left: 0;
    border-top: 1px solid var(--line);
  }

  .portfolio-metrics > div:nth-child(4),
  .risk-strip > div:nth-child(4) {
    border-top: 1px solid var(--line);
  }

  .portfolio-metrics dt,
  .risk-strip dt {
    margin-bottom: 3px; font-size: 12px;
  }

  .portfolio-metrics dd,
  .risk-strip dd {
    overflow: hidden; font-size: 18px; text-overflow: ellipsis;
  }

  .header-meta {
    justify-content: flex-start;
    gap: 6px 12px; font-size: 12px;
    margin-top: 10px;
    padding: 8px 0 0;
    border-left: 0;
    border-top: 1px solid var(--line-light);
  }

  .holding-main-grid {
    grid-template-columns: 1fr;
  }

  .holding-main-grid > * {
    min-width: 0;
  }

  .portfolio-chart-panel {
    margin-top: 12px; padding: 14px;
  }

  .portfolio-chart-panel .panel-heading {
    margin-bottom: 8px;
  }

  .portfolio-chart-panel .panel-heading p {
    font-size: 12px; line-height: 1.5;
  }

  .portfolio-chart-wrap {
    padding: 4px 4px 8px;
  }

  .portfolio-main-chart {
    height: 238px;
  }

  .portfolio-chart-legend {
    gap: 7px 10px; padding-left: 42px;
  }

  .portfolio-chart-legend span {
    font-size: 11px;
  }

  .concentration-row {
    grid-template-columns: 80px minmax(0, 1fr) 48px 52px;
    gap: 8px;
  }
}

${holdingWorkbenchCss()}
`;
}
