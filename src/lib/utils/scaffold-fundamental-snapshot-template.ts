export function financialSnapshotPageFragment(): string {
  return `function getFundamentalSummary(data: JsonRecord | null): JsonRecord | null {
  const assets = asArray(data?.assets).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  if (assets.length > 0) {
    return getFundamentalSummary(assets[0]);
  }
  const fundamental = asRecord(data?.fundamentalIndicators) ?? asRecord(data?.fundamentals) ?? asRecord(data?.financials);
  return asRecord(fundamental?.summary);
}

function getFundamentalMetricComparison(data: JsonRecord | null): JsonRecord | null {
  const assets = asArray(data?.assets).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  if (assets.length > 0) {
    return getFundamentalMetricComparison(assets[0]);
  }
  return asRecord(data?.fundamentalMetricComparison);
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

function getFinancialQuality(data: JsonRecord | null): JsonRecord | null {
  const assets = asArray(data?.assets).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  if (assets.length > 0) {
    return getFinancialQuality(assets[0]);
  }
  return asRecord(data?.financialQuality);
}

function FinancialQualityPanel({ quality }: { quality: JsonRecord | null }) {
  const rows = asArray(quality?.rows).map(asRecord).filter((item): item is JsonRecord => Boolean(item));
  const primary = rows[0] ?? null;
  const score = numeric(primary?.quality_score);
  const strengths = asArray(primary?.strengths).map(String).filter(Boolean);
  const watchItems = asArray(primary?.watch_items).map(String).filter(Boolean);
  const limitations = asArray(quality?.limitations).map(String).filter(Boolean);

  return (
    <article className="data-panel financial-quality-panel">
      <div className="panel-heading compact">
        <div>
          <h2>财务质量评分</h2>
          <p>最近报告期的盈利能力、成长与现金流研究摘要</p>
        </div>
        <span>{formatDate(primary?.latest_report_date)}</span>
      </div>
      <div className="quality-score-row">
        <strong>{score === null ? '-' : formatNumber(score, 0)}</strong>
        <div>
          <span>{String(primary?.quality_label ?? '财务质量待确认')}</span>
          <div className="quality-score-track" aria-label={'财务质量评分 ' + formatNumber(score, 0)}>
            <i style={{ width: Math.max(0, Math.min(100, score ?? 0)) + '%' }} />
          </div>
        </div>
      </div>
      <div className="quality-facts">
        <div>
          <h3>优势依据</h3>
          {strengths.length > 0 ? <ul>{strengths.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>暂无可核验优势项。</p>}
        </div>
        <div>
          <h3>关注项</h3>
          {watchItems.length > 0 ? <ul>{watchItems.map((item, index) => <li key={index}>{item}</li>)}</ul> : <p>暂无额外关注项。</p>}
        </div>
      </div>
      <div className="quality-limitations">
        <strong>缺失字段与口径说明</strong>
        {limitations.length > 0
          ? limitations.map((item, index) => <p key={index}>{item}</p>)
          : <p>未提供额外口径说明，需结合原始财报复核。</p>}
      </div>
    </article>
  );
}`;
}

export function financialSnapshotCss(): string {
  return `/* ==================== FUNDAMENTAL SNAPSHOT ==================== */

.financial-snapshot-grid {
  display: grid;
  grid-template-columns: minmax(280px, 0.75fr) minmax(0, 1.65fr);
  gap: 16px;
  margin-bottom: 16px;
}

.financial-snapshot-grid > * {
  min-width: 0;
}

.financial-quality-panel {
  border-color: color-mix(in srgb, var(--blue) 25%, var(--line));
  background: linear-gradient(145deg, var(--panel), var(--blue-bg));
}

.quality-score-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 16px;
  margin: 16px 0;
}

.quality-score-row > strong {
  color: var(--blue);
  font-size: clamp(38px, 5vw, 58px);
  line-height: 1;
}

.quality-score-row > div > span {
  font-weight: 700;
}

.quality-score-track {
  height: 8px;
  margin-top: 8px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--line-light);
}

.quality-score-track i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--teal), var(--blue));
}

.quality-facts {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.quality-facts > div,
.quality-limitations {
  padding: 10px 12px;
  border: 1px solid var(--line-light);
  border-radius: 6px;
  background: color-mix(in srgb, var(--panel) 90%, transparent);
}

.quality-facts h3,
.quality-limitations strong {
  margin: 0 0 6px;
  font-size: 13px;
}

.quality-facts ul {
  margin: 0;
  padding-left: 18px;
}

.quality-facts li,
.quality-facts p,
.quality-limitations p {
  margin: 4px 0 0;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.55;
}

.quality-limitations {
  margin-top: 10px;
}`;
}
