import { type JsonRecord, asRecord, numeric, round, sum } from './values';

export function buildFinancialQuality(asset: JsonRecord): JsonRecord {
  const quote = asRecord(asset.quote);
  const symbol = String(asset.symbol ?? quote?.symbol ?? '');
  const name = String(asset.name ?? quote?.name ?? symbol);
  const fundamental = asRecord(asset.fundamentalIndicators);
  const financials = asRecord(asset.financials);
  const summary = asRecord(fundamental?.summary);
  const firstReport = Array.isArray(financials?.reports)
    ? asRecord(financials.reports[0])
    : null;
  const source = summary ?? firstReport ?? {};
  const roe = numeric(source.latest_weighted_roe ?? source.weighted_roe);
  const grossMargin = numeric(source.latest_gross_margin ?? source.gross_margin);
  const netMargin = numeric(source.latest_net_margin ?? source.net_margin);
  const revenueYoy = numeric(source.latest_revenue_yoy ?? source.revenue_yoy);
  const profitYoy = numeric(source.latest_net_profit_yoy ?? source.net_profit_yoy);
  const scoreParts = [
    roe === null ? null : Math.min(Math.max(roe * 3, 0), 30),
    grossMargin === null ? null : Math.min(Math.max(grossMargin / 2, 0), 25),
    netMargin === null ? null : Math.min(Math.max(netMargin / 2, 0), 25),
    revenueYoy === null ? null : Math.min(Math.max(revenueYoy / 2, -10), 15),
    profitYoy === null ? null : Math.min(Math.max(profitYoy / 4, -10), 15),
  ].filter((value): value is number => value !== null);
  const qualityScore = scoreParts.length ? Math.max(0, Math.min(100, round(sum(scoreParts), 0) ?? 0)) : null;
  let qualityLabel = '财务质量待确认';
  if (qualityScore !== null) {
    if (qualityScore >= 75) {
      qualityLabel = '盈利质量较强';
    } else if (qualityScore >= 60) {
      qualityLabel = '质量与成长较均衡';
    } else if (qualityScore >= 40) {
      qualityLabel = '质量约束较明显';
    } else {
      qualityLabel = '财务质量偏弱或缺失较多';
    }
  }

  const strengths: string[] = [];
  const watchItems: string[] = [];
  if ((grossMargin ?? 0) >= 40) strengths.push('毛利率处于较高水平。');
  if ((netMargin ?? 0) >= 15) strengths.push('净利率表现较好。');
  if ((revenueYoy ?? 0) > 20 || (profitYoy ?? 0) > 20) strengths.push('最近报告期仍有增长弹性。');
  if ((roe ?? 0) < 5) watchItems.push('ROE 偏低，需要关注资产回报效率。');
  if ((netMargin ?? 0) < 8) watchItems.push('净利率偏低，盈利质量约束更强。');
  if ((revenueYoy ?? 0) < 0 || (profitYoy ?? 0) < 0) watchItems.push('收入或利润同比为负，需要关注基本面压力。');
  if (strengths.length === 0) strengths.push('可作为候选池横向比较样本。');
  if (watchItems.length === 0) watchItems.push('仍需结合现金流、负债结构和行业景气度复核。');

  const quality = {
    symbol,
    name,
    latest_report_date: source.latest_report_date ?? source.report_date ?? null,
    roe_pct: round(roe, 4),
    gross_margin_pct: round(grossMargin, 4),
    net_margin_pct: round(netMargin, 4),
    revenue_yoy_pct: round(revenueYoy, 4),
    net_profit_yoy_pct: round(profitYoy, 4),
    quality_score: qualityScore,
    quality_label: qualityLabel,
    strengths,
    watch_items: watchItems,
  };

  asset.financialQuality = quality;
  return quality;
}

export function buildFundamentalMetricComparison(
  financials: JsonRecord,
  requestedTimeRange?: string | null,
): JsonRecord | null {
  const reports = Array.isArray(financials.reports)
    ? financials.reports.map(asRecord).filter((report): report is JsonRecord => Boolean(report))
    : [];
  if (reports.length === 0) return null;
  const requestedYear = requestedTimeRange?.match(/20\d{2}/)?.[0] ?? null;
  const requestedAnnual = /年报/.test(requestedTimeRange ?? '');
  const report = reports.find((candidate) => {
    const dataType = String(candidate.data_type ?? '');
    return (!requestedYear || dataType.includes(requestedYear)) &&
      (!requestedAnnual || dataType.includes('年报'));
  }) ?? reports[0];
  const reportDate = String(report.report_date ?? '');
  const reportYear = Number.parseInt(reportDate.slice(0, 4), 10);
  const previous = Number.isSafeInteger(reportYear)
    ? reports.find((candidate) => {
        const candidateDate = String(candidate.report_date ?? '');
        return candidateDate.slice(0, 4) === String(reportYear - 1) &&
          candidateDate.slice(4, 10) === reportDate.slice(4, 10);
      }) ?? null
    : null;
  const currentRaw = asRecord(report.raw);
  const previousRaw = asRecord(previous?.raw);
  const cashFlowPerShare = numeric(
    report.operating_cash_flow_per_share ?? currentRaw?.MGJYXJJE,
  );
  const previousCashFlowPerShare = numeric(
    previous?.operating_cash_flow_per_share ?? previousRaw?.MGJYXJJE,
  );
  const cashFlowYoy = numeric(report.operating_cash_flow_per_share_yoy) ?? (
    cashFlowPerShare !== null &&
    previousCashFlowPerShare !== null &&
    previousCashFlowPerShare !== 0
      ? ((cashFlowPerShare - previousCashFlowPerShare) / Math.abs(previousCashFlowPerShare)) * 100
      : null
  );
  const netProfitYoy = numeric(report.net_profit_yoy);
  const outpaced = cashFlowYoy !== null && netProfitYoy !== null
    ? cashFlowYoy > netProfitYoy
    : null;

  return {
    symbol: report.symbol ?? financials.symbol ?? null,
    reporting_period: report.data_type ?? report.report_date ?? requestedTimeRange ?? null,
    operating_cash_flow_per_share: round(cashFlowPerShare),
    previous_operating_cash_flow_per_share: round(previousCashFlowPerShare),
    operating_cash_flow_per_share_yoy: round(cashFlowYoy),
    net_profit_yoy: round(netProfitYoy),
    cash_flow_outpaced_net_profit: outpaced,
    conclusion: outpaced === null
      ? '现有财务摘要不足以完成经营现金流增速与净利润增速比较。'
      : outpaced
        ? '每股经营现金流增速高于净利润增速。'
        : '每股经营现金流增速未跑赢净利润增速。',
    basis: '经营现金流使用每股经营活动现金流净额同比作为可核验代理口径。',
  };
}

export function rankRows(
  rows: Array<JsonRecord & { symbol: string }>,
  field: string,
  direction: 'asc' | 'desc'
): Map<string, number> {
  const ranked = rows
    .map((row) => ({ symbol: row.symbol, value: numeric(row[field]) }))
    .filter((row): row is { symbol: string; value: number } => Boolean(row.symbol) && row.value !== null)
    .sort((left, right) => direction === 'asc' ? left.value - right.value : right.value - left.value);
  return new Map(ranked.map((row, index) => [row.symbol, index + 1]));
}

export function buildFinancialQualitySummary(assets: JsonRecord[]): JsonRecord {
  const rows = assets.map((asset) => asRecord(asset.financialQuality) ?? buildFinancialQuality(asset));
  const ranked = rankRows(
    rows.map((row) => ({ ...row, symbol: String(row.symbol ?? '') })),
    'quality_score',
    'desc'
  );
  return {
    method: 'latest_report_profitability_growth_score',
    latest_report_date: rows.find((row) => row.latest_report_date)?.latest_report_date ?? null,
    rows: rows.map((row) => ({
      ...row,
      rank_quality: ranked.get(String(row.symbol ?? '')) ?? null,
    })),
    limitations: [
      '财务质量评分用于横向研究，不构成估值目标价或买卖建议。',
      '当前仅使用接口可得的最近报告期、盈利率和同比指标，未纳入现金流、负债结构和行业景气度。',
    ],
  };
}
