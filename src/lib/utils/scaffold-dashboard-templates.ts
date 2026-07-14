import { DASHBOARD_DATA_READER, DASHBOARD_PAGE_RUNTIME_PRELUDE } from './scaffold-dashboard-runtime-template';

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

function VisualizationPlanPanel({ visualization }: { visualization: JsonRecord | null }) {
  const rows = getVisualizationRows(visualization);
  if (!visualization || rows.length === 0) {
    return null;
  }

  return (
    <section className="comparison-matrix">
      <div className="panel-heading">
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
    </section>
  );
}

export default async function Home() {
  const data = await readDashboardData();
  const rows = getComparisonRows(data);
  const assets = getAssets(data);
  const leaders = getLeaders(data);
  const correlationPairs = getCorrelationPairs(data);
  const liquidityRows = getLiquidityRows(data);
  const valuationRows = getValuationRows(data);
  const trendTemplateRows = getTrendTemplateRows(data);
  const visualization = getVisualization(data);
  const requestedSymbols = asArray(data?.requestedSymbols ?? data?.symbols).map(String);
  const bestReturn = asRecord(leaders?.best_return);
  const lowestDrawdown = asRecord(leaders?.lowest_drawdown);
  const lowestVolatility = asRecord(leaders?.lowest_volatility);

  return (
    <main className="comparison-shell" data-market-proxy="/api/market" data-source-file={DATA_FILE}>
      <section className="comparison-hero">
        <div>
          <p className="eyebrow">QuantPilot 多标的对比</p>
          <h1>多标的相对强弱看板</h1>
          <p>覆盖 {requestedSymbols.length || rows.length} 个标的：{requestedSymbols.join('、') || rows.map((row) => String(row.symbol)).join('、')}</p>
        </div>
        <div className="hero-meta">
          <span>样本：最近 60 个交易日</span>
          <span>信源：{sourceDisplayName(data?.source ?? 'eastmoney')}</span>
          <span>证据：{SOURCES_FILE}</span>
        </div>
      </section>

      <section className="leader-grid">
        <article className="leader-card up">
          <span>收益领先</span>
          <strong>{String(bestReturn?.name ?? '-')}</strong>
          <em>{formatPercent(bestReturn?.value)}</em>
        </article>
        <article className="leader-card neutral">
          <span>回撤较小</span>
          <strong>{String(lowestDrawdown?.name ?? '-')}</strong>
          <em>{formatPercent(lowestDrawdown?.value)}</em>
        </article>
        <article className="leader-card neutral">
          <span>波动较低</span>
          <strong>{String(lowestVolatility?.name ?? '-')}</strong>
          <em>{formatPercent(lowestVolatility?.value)}</em>
        </article>
      </section>

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

      <VisualizationPlanPanel visualization={visualization} />

      <section className="comparison-matrix">
        <div className="panel-heading">
          <div>
            <h2>数据信源渠道与质量</h2>
            <p>逐只标的展示行情、K 线、财务等渠道和样本覆盖；公开行情接口可能存在延迟。</p>
          </div>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>标的</th>
                <th>信源渠道</th>
                <th>行情时间</th>
                <th>K 线样本</th>
                <th>质量提示</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((asset, index) => {
                const quote = asRecord(asset.quote);
                const kline = asRecord(asset.kline);
                const quality = asRecord(quote?.data_quality) ?? asRecord(kline?.data_quality);
                return (
                  <tr key={String(asset.symbol ?? index)}>
                    <td><strong>{String(asset.name ?? quote?.name ?? asset.symbol)}</strong><small>{String(asset.symbol ?? quote?.symbol ?? '-')}</small></td>
                    <td>{sourceDisplayName(asset.source ?? quote?.source ?? 'eastmoney')}</td>
                    <td>{String(asset.as_of ?? quote?.quote_time ?? quote?.fetched_at ?? '-')}</td>
                    <td>{asArray(kline?.bars).length}</td>
                    <td>{String(quality?.status ?? 'ok')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
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
                <td className={tone(row.period_return ?? row.return_120d_pct)}>{formatPercent(row.period_return ?? row.return_120d_pct)}</td>
                <td className="down">{formatPercent(row.max_drawdown)}</td>
                <td>{formatPercent(row.volatility20d)}</td>
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
    <section className="selection-panel chart-card core-chart-card">
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

function Sparkline({ asset }: { asset: JsonRecord }) {
  const bars = asArray(asRecord(asset.kline)?.bars).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  const visible = bars.slice(-50);
  const closes = visible.map((bar) => numeric(bar.close)).filter((value): value is number => value !== null);
  const min = closes.length ? Math.min(...closes) : 0;
  const max = closes.length ? Math.max(...closes) : 1;
  const range = Math.max(max - min, 0.000001);
  const points = closes.map((value, index) => {
    const x = (index / Math.max(closes.length - 1, 1)) * 100;
    const y = 34 - ((value - min) / range) * 28;
    return x.toFixed(2) + ',' + y.toFixed(2);
  }).join(' ');
  return (
    <svg className="sparkline" viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label={String(asset.name ?? asset.symbol ?? 'K 线迷你趋势')}>
      <line x1="0" y1="34" x2="100" y2="34" className="axis" />
      {points ? <polyline points={points} fill="none" /> : null}
    </svg>
  );
}

function AssetCards({ assets }: { assets: JsonRecord[] }) {
  return (
    <section className="asset-grid">
      {assets.map((asset, index) => {
        const quote = asRecord(asset.quote);
        const technical = asRecord(asRecord(asset.technicalIndicators)?.summary);
        const quality = asRecord(asset.financialQuality);
        return (
          <article className="asset-card" key={String(asset.symbol ?? index)}>
            <div>
              <strong>{String(asset.name ?? quote?.name ?? asset.symbol)}</strong>
              <small>{String(asset.symbol ?? quote?.symbol ?? '-')} · {String(quality?.quality_label ?? '质量待确认')}</small>
            </div>
            <Sparkline asset={asset} />
            <dl>
              <div><dt>最新价</dt><dd>{formatNumber(quote?.price)}</dd></div>
              <div><dt>区间</dt><dd className={tone(technical?.period_return_pct ?? technical?.return_120d_pct)}>{formatPercent(technical?.period_return_pct ?? technical?.return_120d_pct)}</dd></div>
              <div><dt>MA20</dt><dd>{formatNumber(technical?.ma20)}</dd></div>
              <div><dt>质量分</dt><dd>{formatNumber(quality?.quality_score, 0)}</dd></div>
            </dl>
          </article>
        );
      })}
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

function DataQualityPanel({ data, assets }: { data: JsonRecord | null; assets: JsonRecord[] }) {
  const visualization = asRecord(data?.visualization);
  const components = asArray(visualization?.required_components).map(String);
  return (
    <section className="selection-panel">
      <div className="panel-heading">
        <div>
          <h2>数据信源渠道逐项追踪</h2>
          <p>逐只标的展示实际使用的行情、K 线、财务渠道和样本覆盖。</p>
        </div>
        <span>多标的对比</span>
      </div>
      <div className="table-wrap">
        <table>
          <thead><tr><th>标的</th><th>信源渠道</th><th>行情时间</th><th>K 线样本</th><th>报告期</th></tr></thead>
          <tbody>
            {assets.map((asset, index) => {
              const quote = asRecord(asset.quote);
              const kline = asRecord(asset.kline);
              const quality = asRecord(asset.financialQuality);
              return (
                <tr key={String(asset.symbol ?? index)}>
                  <td><strong>{String(asset.name ?? quote?.name ?? asset.symbol)}</strong><small>{String(asset.symbol ?? quote?.symbol ?? '-')}</small></td>
                  <td>{sourceDisplayName(asset.source ?? quote?.source ?? 'eastmoney')}</td>
                  <td>{String(asset.as_of ?? quote?.quote_time ?? quote?.fetched_at ?? '-')}</td>
                  <td>{asArray(kline?.bars).length}</td>
                  <td>{String(quality?.latest_report_date ?? '-').slice(0, 10)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="component-line">组件覆盖：{components.join(' / ') || '按多标的对比模板渲染'} · 技术证据：{DATA_FILE}</p>
    </section>
  );
}

export default async function Home() {
  const data = await readDashboardData();
  const assets = getAssets(data);
  const rows = getComparisonRows(data);
  const rankingRows = getRowsFrom(data, 'selectionRanking');
  const financialRows = getRowsFrom(data, 'financialQuality');
  const conclusion = getConclusion(data);
  const leaders = asRecord(asRecord(data?.comparison)?.leaders);
  const screener = asRecord(data?.screener);
  const warnings = asArray(data?.warnings).map(String).filter(Boolean);
  const noCandidates = data?.status === 'no_candidates' && assets.length === 0 && rows.length === 0;
  const requestedSymbols = asArray(data?.requestedSymbols ?? data?.symbols).map(String);
  const topRanking = rankingRows[0] ?? rows.slice().sort((left, right) => (numeric(right.composite_score) ?? -1) - (numeric(left.composite_score) ?? -1))[0];

  return (
    <main className="selection-shell" data-market-proxy="/api/market" data-source-file={DATA_FILE} data-template="stock-selection">
      <section className="selection-hero">
        <div>
          <p className="eyebrow">QuantPilot 多标的对比</p>
          <h1>{topRanking ? String(topRanking.name ?? topRanking.symbol) + ' 暂列研究优先级第一' : '多标的研究看板'}</h1>
          <p>覆盖 {requestedSymbols.length || rows.length} 个标的：{requestedSymbols.join('、') || rows.map((row) => String(row.symbol)).join('、')}。以下排序仅用于研究，不构成交易指令。</p>
        </div>
        <aside>
          <span>研究用途</span>
          <strong>多标的对比</strong>
          <em>统一口径读取真实数据与信源证据</em>
        </aside>
      </section>

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

      <section className="summary-grid">
        <article><span>收益领先</span><strong>{String(asRecord(leaders?.best_return)?.name ?? '-')}</strong><em>{formatPercent(asRecord(leaders?.best_return)?.value)}</em></article>
        <article><span>回撤较小</span><strong>{String(asRecord(leaders?.lowest_drawdown)?.name ?? '-')}</strong><em>{formatPercent(asRecord(leaders?.lowest_drawdown)?.value)}</em></article>
        <article><span>波动较低</span><strong>{String(asRecord(leaders?.lowest_volatility)?.name ?? '-')}</strong><em>{formatPercent(asRecord(leaders?.lowest_volatility)?.value)}</em></article>
        <article><span>标的数量</span><strong>{rows.length}</strong><em>{assets.length} 只已绑定数据</em></article>
      </section>

      <ComparisonTable rows={rows} />

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

      <AssetCards assets={assets} />

      <FinancialQualityPanel rows={financialRows} />
      <DataQualityPanel data={data} assets={assets} />
    </main>
  );
}
`;
}

export function comparisonCss() {
  return `

.comparison-shell {
  min-height: 100vh;
  background: var(--bg);
  color: var(--ink);
  padding: 28px;
}

.comparison-hero {
  display: flex;
  justify-content: space-between;
  gap: 24px;
  align-items: flex-end;
  padding: 24px 28px;
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: 8px;
  box-shadow: var(--shadow-sm);
}

.comparison-hero h1 {
  margin: 4px 0 6px;
  font-size: clamp(26px, 2.8vw, 40px);
  letter-spacing: 0;
}

.comparison-hero p,
.hero-meta {
  color: var(--muted);
}

.eyebrow {
  margin: 0;
  color: var(--red);
  font-weight: 700;
  font-size: 14px;
}

.hero-meta {
  display: grid;
  gap: 6px;
  text-align: right;
  font-size: 14px;
}

.leader-grid,
.chart-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
  margin-top: 14px;
}

.leader-card,
.comparison-panel,
.comparison-matrix {
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: 8px;
  box-shadow: var(--shadow-sm);
}

.leader-card {
  padding: 20px;
}

.leader-card span {
  display: block;
  color: var(--muted);
  margin-bottom: 8px;
  font-size: 14px;
}

.leader-card strong {
  display: block;
  font-size: 24px;
  white-space: nowrap;
}

.leader-card em {
  display: block;
  margin-top: 8px;
  font-size: 22px;
  font-style: normal;
  font-weight: 800;
  white-space: nowrap;
}

.comparison-matrix,
.comparison-panel {
  margin-top: 14px;
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

  .comparison-hero,
  .panel-heading {
    display: block;
  }

  .hero-meta {
    margin-top: 14px;
    text-align: left;
  }

  .leader-grid,
  .chart-grid,
  .comparison-two-column {
    grid-template-columns: 1fr;
  }

  .leader-grid > *,
  .chart-grid > *,
  .comparison-two-column > * {
    min-width: 0;
  }
}
`;
}

export function stockSelectionCss() {
  return `

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
  min-height: 100vh;
  background: var(--bg);
  color: var(--ink);
  padding: 28px;
}

.selection-hero {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 260px;
  gap: 24px;
  align-items: stretch;
  padding: 24px 28px;
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: 8px;
  box-shadow: var(--shadow-sm);
}

.selection-hero h1 {
  margin: 6px 0;
  font-size: clamp(26px, 2.8vw, 42px);
  line-height: 1.1;
  letter-spacing: 0;
}

.selection-hero p,
.selection-hero em {
  color: var(--muted);
}

.selection-hero aside,
.selection-panel,
.asset-card,
.summary-grid article {
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: 8px;
  box-shadow: var(--shadow-sm);
}

.selection-hero aside {
  display: grid;
  align-content: center;
  gap: 8px;
  padding: 22px;
}

.selection-hero aside span,
.summary-grid span {
  color: var(--muted);
}

.selection-hero aside strong {
  color: var(--red);
  font-size: 28px;
}

.summary-grid,
.asset-grid,
.chart-grid,
.main-grid {
  display: grid;
  gap: 14px;
  margin-top: 14px;
}

.summary-grid {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}

.asset-grid,
.chart-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.core-chart-grid {
  align-items: stretch;
}

.main-grid {
  grid-template-columns: minmax(0, 1.05fr) minmax(0, 0.95fr);
}

.summary-grid article,
.asset-card,
.selection-panel {
  padding: 20px;
}

.summary-grid strong,
.summary-grid em,
.asset-card strong,
.asset-card dd,
.ranking-row strong,
.ranking-row em {
  display: block;
}

.summary-grid strong {
  margin-top: 8px;
  font-size: 24px;
  white-space: nowrap;
}

.summary-grid em {
  margin-top: 6px;
  font-style: normal;
  font-weight: 800;
}

.asset-card {
  display: grid;
  gap: 14px;
}

.asset-card dl {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin: 0;
}

.asset-card dt {
  color: var(--muted);
  font-size: 13px;
  white-space: nowrap;
}

.asset-card dd {
  margin: 2px 0 0;
  font-weight: 800;
  white-space: nowrap;
}

.sparkline {
  width: 100%;
  height: 68px;
}

.sparkline polyline {
  stroke: var(--blue);
  stroke-width: 2.4;
}

.selection-panel {
  margin-top: 14px;
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

.core-chart-card {
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

  .selection-hero {
    display: block;
    padding: 14px;
  }

  .selection-hero h1 {
    margin: 4px 0;
    font-size: 22px;
    line-height: 1.15;
  }

  .selection-hero p {
    margin: 0;
    font-size: 13px;
    line-height: 1.55;
  }

  .selection-hero aside {
    display: none;
  }

  .summary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 8px;
    margin-top: 8px;
  }

  .summary-grid article {
    padding: 10px;
  }

  .summary-grid strong {
    margin-top: 4px;
    font-size: 17px;
  }

  .summary-grid em {
    margin-top: 3px;
    font-size: 12px;
  }

  .selection-panel {
    margin-top: 10px;
    padding: 12px;
  }

  .panel-heading {
    margin-bottom: 8px;
  }

  .panel-heading h2 {
    font-size: 15px;
  }

  .panel-heading p {
    font-size: 12px;
  }

  .panel-heading span {
    padding: 2px 7px;
    font-size: 11px;
  }

  .asset-grid,
  .chart-grid,
  .main-grid {
    grid-template-columns: 1fr;
  }

  .summary-grid > *,
  .asset-grid > *,
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

function Sparkline({ asset }: { asset: JsonRecord }) {
  const bars = getSparklineBars(asset).slice(-50);
  const closes = bars.map((bar) => numeric(bar.close)).filter((value): value is number => value !== null);
  const min = closes.length ? Math.min(...closes) : 0;
  const max = closes.length ? Math.max(...closes) : 1;
  const range = Math.max(max - min, 0.000001);
  const points = closes.map((value, index) => {
    const x = (index / Math.max(closes.length - 1, 1)) * 100;
    const y = 34 - ((value - min) / range) * 28;
    return x.toFixed(2) + ',' + y.toFixed(2);
  }).join(' ');
  return (
    <svg className="sparkline" viewBox="0 0 100 40" preserveAspectRatio="none" role="img" aria-label={String(asset.name ?? asset.symbol ?? 'K 线迷你趋势')}>
      <line x1="0" y1="34" x2="100" y2="34" className="axis" />
      {points ? <polyline points={points} fill="none" /> : null}
    </svg>
  );
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

function HoldingCards({ holdings, assets }: { holdings: JsonRecord[]; assets: JsonRecord[] }) {
  return (
    <section className="holding-grid">
      {holdings.map((holding, index) => {
        const asset = assets.find((a) => (a.symbol ?? asRecord(a.quote)?.symbol) === holding.symbol) ?? {};
        const weight = numeric(holding.weight);
        const pnl = numeric(holding.pnl);
        const pnlPct = numeric(holding.pnl_pct);
        return (
          <article className="holding-card" key={String(holding.symbol ?? index)}>
            <div className="holding-card-top">
              <div>
                <strong>{String(holding.name ?? holding.symbol)}</strong>
                <small>{String(holding.symbol ?? '-')} · 权重 {formatPercent(weight)}</small>
              </div>
              <Sparkline asset={asset} />
            </div>
            <dl>
              <div><dt>持有数量</dt><dd>{formatNumber(holding.quantity, 0)} 股</dd></div>
              <div><dt>成本价</dt><dd>{formatNumber(holding.cost)}</dd></div>
              <div><dt>现价</dt><dd>{formatNumber(holding.current_price)}</dd></div>
              <div><dt>市值</dt><dd>{formatMoney(holding.market_value)}</dd></div>
              <div><dt>浮动盈亏</dt><dd className={tone(pnl)}>{formatMoney(pnl)}</dd></div>
              <div><dt>盈亏幅度</dt><dd className={tone(pnlPct)}>{formatPercent(pnlPct)}</dd></div>
            </dl>
          </article>
        );
      })}
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
      <div className="risk-grid">
        <article><span>VaR 95%</span><strong>{formatPercent(var95)}</strong></article>
        <article><span>VaR 99%</span><strong>{formatPercent(var99)}</strong></article>
        <article><span>Expected Shortfall</span><strong>{formatPercent(expectedShortfall)}</strong></article>
        <article><span>计算区间</span><strong>{String(risk?.window ?? risk?.sample_window ?? '-')}</strong></article>
      </div>
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

function DataSourcePanel({ assets }: { assets: JsonRecord[] }) {
  return (
    <section className="holding-panel">
      <div className="panel-heading">
        <div>
          <h2>数据信源渠道</h2>
          <p>逐只标的展示实际数据来源、行情时间和 K 线覆盖。</p>
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>标的</th><th>信源渠道</th><th>行情时间</th><th>K 线样本</th></tr>
          </thead>
          <tbody>
            {assets.map((asset, index) => {
              const quote = asRecord(asset.quote);
              const kline = asRecord(asset.kline);
              return (
                <tr key={String(asset.symbol ?? index)}>
                  <td><strong>{String(asset.name ?? quote?.name ?? asset.symbol)}</strong><small>{String(asset.symbol ?? quote?.symbol ?? '-')}</small></td>
                  <td>{sourceDisplayName(asset.source ?? quote?.source ?? 'eastmoney')}</td>
                  <td>{String(asset.as_of ?? quote?.quote_time ?? quote?.fetched_at ?? '-')}</td>
                  <td>{asArray(kline?.bars).length}</td>
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
  const portfolio = getPortfolio(data);
  const holdings = getHoldings(data);
  const assets = getAssets(data);
  const comparisonRows = getComparisonRows(data);
  const risk = getRiskMetrics(data);
  const requestedSymbols = asArray(data?.requestedSymbols ?? data?.symbols).map(String);
  const totalPnl = numeric(portfolio?.total_pnl);
  const totalPnlPct = numeric(portfolio?.total_pnl_pct);

  return (
    <main className="holding-shell" data-market-proxy="/api/market" data-source-file={DATA_FILE} data-template="holding-analysis">
      <section className="holding-hero">
        <div>
          <p className="eyebrow">QuantPilot 持仓分析</p>
          <h1>组合持仓风险看板</h1>
          <p>覆盖 {holdings.length} 只持仓：{holdings.map((h) => String(h.name ?? h.symbol)).join('、')}。以下分析仅用于研究，不构成交易指令。</p>
        </div>
        <div className="hero-summary">
          <article><span>组合市值</span><strong>{formatMoney(portfolio?.total_value)}</strong></article>
          <article><span>持仓成本</span><strong>{formatMoney(portfolio?.cost_basis)}</strong></article>
          <article><span>浮动盈亏</span><strong className={tone(totalPnl)}>{formatMoney(totalPnl)}</strong></article>
          <article><span>盈亏幅度</span><strong className={tone(totalPnlPct)}>{formatPercent(totalPnlPct)}</strong></article>
        </div>
        <div className="hero-meta">
          <span>持仓 {String(portfolio?.holdings_count ?? holdings.length)} 只</span>
          <span>覆盖 {requestedSymbols.length || assets.length} 个标的</span>
          <span>数据时间 {String(portfolio?.as_of ?? holdings[0]?.as_of ?? '-')}</span>
        </div>
      </section>

      <PortfolioReturnChart assets={assets} />

      <HoldingCards holdings={holdings} assets={assets} />

      <section className="holding-main-grid">
        <HoldingsTable holdings={holdings} />
        <ConcentrationPanel holdings={holdings} />
      </section>

      <ComparisonMetricsPanel rows={comparisonRows} />

      <RiskPanel risk={risk} />

      <DataSourcePanel assets={assets} />
    </main>
  );
}
`;
}

export function holdingAnalysisCss() {
  return `

.holding-shell {
  min-height: 100vh;
  background: var(--bg);
  color: var(--ink);
  padding: 28px;
}

.holding-hero {
  display: grid;
  gap: 20px;
  padding: 24px 28px;
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: 8px;
  box-shadow: var(--shadow-sm);
}

.holding-hero h1 {
  margin: 4px 0 6px;
  font-size: clamp(26px, 2.8vw, 40px);
  letter-spacing: 0;
}

.holding-hero p {
  color: var(--muted);
}

.hero-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
}

.hero-summary article {
  padding: 16px;
  border: 1px solid var(--line);
  background: var(--surface-1);
  border-radius: 8px;
}

.hero-summary span {
  display: block;
  margin-bottom: 6px;
  color: var(--muted);
  font-size: 14px;
}

.hero-summary strong {
  display: block;
  font-size: 24px;
  white-space: nowrap;
}

.hero-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 18px;
  color: var(--muted);
  font-size: 14px;
}

.holding-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
  margin-top: 14px;
}

.holding-card {
  padding: 18px;
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: 8px;
  box-shadow: var(--shadow-sm);
}

.holding-card-top {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 114px;
  gap: 14px;
  align-items: center;
  margin-bottom: 14px;
}

.holding-card-top strong {
  display: block;
  font-size: 17px;
}

.holding-card-top small {
  display: block;
  margin-top: 4px;
  color: var(--muted);
  font-size: 13px;
}

.holding-card dl {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin: 0;
}

.holding-card dt {
  color: var(--muted);
  font-size: 13px;
}

.holding-card dd {
  margin: 2px 0 0;
  font-weight: 800;
}

.portfolio-chart-panel { margin-top: 14px; }
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
  gap: 14px;
  margin-top: 14px;
}

.holding-panel,
.risk-grid article {
  border: 1px solid var(--line);
  background: var(--panel);
  border-radius: 8px;
  box-shadow: var(--shadow-sm);
}

.holding-panel {
  margin-top: 14px;
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

.risk-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 14px;
}

.risk-grid article {
  padding: 16px;
}

.risk-grid span {
  display: block;
  margin-bottom: 6px;
  color: var(--muted);
  font-size: 14px;
}

.risk-grid strong {
  display: block;
  font-size: 22px;
  white-space: nowrap;
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

.sparkline {
  width: 100%;
  height: 56px;
}

.sparkline polyline {
  stroke: var(--blue);
  stroke-width: 2.4;
}

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

  .holding-hero {
    gap: 12px; padding: 16px;
  }

  .holding-hero h1 {
    margin: 3px 0 5px; font-size: clamp(25px, 8vw, 32px);
  }

  .holding-hero > div:first-child > p:last-child {
    font-size: 13px; line-height: 1.55;
  }

  .hero-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px;
  }

  .hero-summary article {
    padding: 10px;
  }

  .hero-summary span {
    margin-bottom: 3px; font-size: 12px;
  }

  .hero-summary strong {
    overflow: hidden; font-size: 18px; text-overflow: ellipsis;
  }

  .hero-meta {
    gap: 6px 12px; font-size: 12px;
  }

  .holding-grid,
  .holding-main-grid,
  .risk-grid {
    grid-template-columns: 1fr;
  }

  .holding-grid > *,
  .holding-main-grid > *,
  .risk-grid > * {
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
`;
}
