import path from 'path';
import { ensureBaselineEvidenceFiles } from '@/lib/quant/evidence';
import { appendQuantWorkspaceEvent, QuantRunPlan } from '@/lib/domains/finance/workspace';
import { serializeQuantVisualizationTemplate } from '@/lib/domains/finance/visualization-templates';
import {
  type JsonRecord,
  type PrefetchResult,
  asRecord,
  extractBarsFromAsset,
  numeric,
  round,
} from './values';
import { buildFinancialQuality, buildFinancialQualitySummary, rankRows } from './fundamentals';
import { firstDateFromBars, lastDateFromBars } from './technical';
import { writeJson } from './transport';
import { buildCorrelationSummary, buildLiquiditySummary } from './portfolio';

export function buildComparisonSummary(assets: JsonRecord[]): JsonRecord {
  const financialQualityRows = assets.map((asset) => asRecord(asset.financialQuality) ?? buildFinancialQuality(asset));
  const rows = assets.map((asset) => {
    const metrics = asRecord(asset.computedMetrics);
    const quote = asRecord(asset.quote);
    const symbol = String(asset.symbol ?? quote?.symbol ?? '');
    const bars = extractBarsFromAsset(asset);
    const technicalSummary = asRecord(asRecord(asset.technicalIndicators)?.summary) ?? {};
    const financialQuality = asRecord(asset.financialQuality) ?? financialQualityRows.find((row) => row?.symbol === symbol);
    const avgAmount20d = numeric(metrics?.avgAmount20d);
    const amount = numeric(quote?.amount);
    return {
      symbol,
      name: asset.name ?? quote?.name ?? symbol,
      price: quote?.price ?? null,
      change_percent: quote?.change_percent ?? null,
      period_return: metrics?.periodReturn ?? null,
      max_drawdown: metrics?.maxDrawdown ?? null,
      volatility20d: metrics?.volatility20d ?? null,
      avg_volume_20d: metrics?.avgVolume20d ?? null,
      avg_amount_20d: avgAmount20d,
      amount: quote?.amount ?? null,
      as_of: asset.as_of ?? quote?.quote_time ?? quote?.fetched_at ?? null,
      source: asset.source ?? quote?.source ?? null,
      sample_size: bars.length,
      period_start: firstDateFromBars(bars),
      period_end: lastDateFromBars(bars),
      return_20d_pct: technicalSummary.return_20d_pct ?? metrics?.return20d ?? null,
      return_60d_pct: technicalSummary.return_60d_pct ?? metrics?.return60d ?? null,
      return_120d_pct: technicalSummary.return_120d_pct ?? metrics?.return120d ?? metrics?.periodReturn ?? null,
      financial_quality_score: financialQuality?.quality_score ?? null,
      financial_quality_label: financialQuality?.quality_label ?? null,
      liquidity_note: avgAmount20d !== null
        ? `20 日均成交额 ${round(avgAmount20d / 100_000_000, 2)} 亿元`
        : amount !== null
          ? `最新成交额 ${round(amount / 100_000_000, 2)} 亿元`
          : '成交额缺失，使用成交量代理。',
    };
  });

  const numericRows = rows.map((row) => ({
    ...row,
    periodReturnNumber: numeric(row.period_return),
    return120dNumber: numeric(row.period_return ?? row.return_120d_pct),
    drawdownNumber: numeric(row.max_drawdown),
    volatilityNumber: numeric(row.volatility20d),
    liquidityNumber: numeric(row.avg_amount_20d ?? row.amount),
    qualityNumber: numeric(row.financial_quality_score),
  }));
  const bestReturn = numericRows
    .filter((row) => row.return120dNumber !== null)
    .sort((a, b) => (b.return120dNumber ?? 0) - (a.return120dNumber ?? 0))[0];
  const lowestDrawdown = numericRows
    .filter((row) => row.drawdownNumber !== null)
    .sort((a, b) => Math.abs(a.drawdownNumber ?? 0) - Math.abs(b.drawdownNumber ?? 0))[0];
  const lowestVolatility = numericRows
    .filter((row) => row.volatilityNumber !== null)
    .sort((a, b) => (a.volatilityNumber ?? 0) - (b.volatilityNumber ?? 0))[0];
  const rankedReturns = rankRows(numericRows, 'return120dNumber', 'desc');
  const rankedDrawdown = rankRows(numericRows.map((row) => ({ ...row, drawdownAbs: Math.abs(row.drawdownNumber ?? Number.POSITIVE_INFINITY) })), 'drawdownAbs', 'asc');
  const rankedVolatility = rankRows(numericRows, 'volatilityNumber', 'asc');
  const rankedLiquidity = rankRows(numericRows, 'liquidityNumber', 'desc');
  const rankedQuality = rankRows(numericRows, 'qualityNumber', 'desc');
  const enrichedRows = numericRows.map((row) => {
    const returnRank = rankedReturns.get(row.symbol);
    const drawdownRank = rankedDrawdown.get(row.symbol);
    const volatilityRank = rankedVolatility.get(row.symbol);
    const liquidityRank = rankedLiquidity.get(row.symbol);
    const qualityRank = rankedQuality.get(row.symbol);
    const validRanks = [returnRank, drawdownRank, volatilityRank, liquidityRank, qualityRank]
      .filter((rank): rank is number => typeof rank === 'number');
    const compositeScore = validRanks.length
      ? round(validRanks.reduce((score, rank) => score + (assets.length - rank + 1), 0) / (validRanks.length * assets.length) * 100, 0)
      : null;
    return {
      ...row,
      rank_return: returnRank ?? null,
      rank_drawdown: drawdownRank ?? null,
      rank_volatility: volatilityRank ?? null,
      rank_liquidity: liquidityRank ?? null,
      rank_quality: qualityRank ?? null,
      composite_score: compositeScore,
      relative_strength: row.return120dNumber === null
        ? '待确认'
        : row === bestReturn
          ? '收益领先'
          : row.return120dNumber > 0
            ? '阶段为正'
            : '阶段偏弱',
      selection_view: compositeScore === null
        ? '数据待补齐'
        : compositeScore >= 72
          ? '优先研究'
        : compositeScore >= 55
            ? '观察研究'
            : '谨慎观察',
      ranking_reason: [
        returnRank ? `收益排名 ${returnRank}` : null,
        drawdownRank ? `回撤排名 ${drawdownRank}` : null,
        qualityRank ? `质量排名 ${qualityRank}` : null,
      ].filter(Boolean).join('，') || '关键指标仍需补齐。',
      exclusion_reason: compositeScore !== null && compositeScore < 55
        ? '综合排名靠后，需等待趋势、质量或流动性改善。'
        : null,
    };
  });

  return {
    rows: enrichedRows,
    leaders: {
      best_return: bestReturn
        ? { symbol: bestReturn.symbol, name: bestReturn.name, value: bestReturn.period_return ?? bestReturn.return_120d_pct }
        : null,
      lowest_drawdown: lowestDrawdown
        ? { symbol: lowestDrawdown.symbol, name: lowestDrawdown.name, value: lowestDrawdown.max_drawdown }
        : null,
      lowest_volatility: lowestVolatility
        ? { symbol: lowestVolatility.symbol, name: lowestVolatility.name, value: lowestVolatility.volatility20d }
        : null,
    },
  };
}

export function buildSelectionRanking(comparison: JsonRecord, assets: JsonRecord[]): JsonRecord {
  const rows = Array.isArray(comparison.rows)
    ? comparison.rows.map(asRecord).filter((row): row is JsonRecord => Boolean(row))
    : [];
  const ranked = rows
    .slice()
    .sort((left, right) => (numeric(right.composite_score) ?? -1) - (numeric(left.composite_score) ?? -1));
  return {
    method: 'multi_factor_research_priority',
    description: '综合收益、回撤、波动、流动性代理和财务质量后的研究优先级；不是交易指令。',
    rows: ranked.map((row, index) => ({
      rank: index + 1,
      symbol: row.symbol,
      name: row.name,
      score: row.composite_score,
      view: row.selection_view,
      reason: row.ranking_reason,
      exclusion_reason: row.exclusion_reason,
    })),
    coverage: {
      requested: assets.length,
      ranked: ranked.length,
    },
  };
}

export function buildTradingPlan(assets: JsonRecord[], selectionRanking: JsonRecord): JsonRecord {
  const rankingRows = Array.isArray(selectionRanking.rows)
    ? selectionRanking.rows.map(asRecord).filter((row): row is JsonRecord => Boolean(row))
    : [];
  const rankBySymbol = new Map(
    rankingRows
      .map((row) => [String(row.symbol ?? ''), numeric(row.rank)] as const)
      .filter(([, rank]) => rank !== null)
  );
  const rows = assets
    .map((asset): JsonRecord | null => {
      const quote = asRecord(asset.quote);
      const technical = asRecord(asRecord(asset.technicalIndicators)?.summary) ?? {};
      const metrics = asRecord(asset.computedMetrics);
      const bars = extractBarsFromAsset(asset);
      const latestBar = bars.at(-1);
      const symbol = String(asset.symbol ?? quote?.symbol ?? '');
      const name = String(asset.name ?? quote?.name ?? symbol);
      const currentPrice =
        numeric(quote?.price) ??
        numeric(technical.latest_close) ??
        numeric(latestBar?.close);
      if (currentPrice === null || currentPrice <= 0) {
        return null;
      }
      const ma5 = numeric(technical.ma5);
      const ma10 = numeric(technical.ma10);
      const ma20 = numeric(technical.ma20);
      const latestLow = numeric(quote?.low) ?? numeric(latestBar?.low);
      const periodHigh = numeric(metrics?.periodHigh) ?? numeric(quote?.high) ?? numeric(latestBar?.high) ?? currentPrice;
      const supportCandidates = [ma5, ma10, ma20]
        .filter((value): value is number => value !== null && value > 0)
        .sort((left, right) => {
          const leftDistance = Math.abs(currentPrice - left);
          const rightDistance = Math.abs(currentPrice - right);
          return leftDistance - rightDistance;
        });
      const support = supportCandidates[0] ?? currentPrice * 0.97;
      const buyZoneLow = round(Math.max(currentPrice * 0.94, support * 0.98));
      const rawBuyZoneHigh = Math.min(currentPrice * 1.01, Math.max((buyZoneLow ?? currentPrice) * 1.04, currentPrice * 0.995));
      const buyZoneHigh = round(Math.max(rawBuyZoneHigh, (buyZoneLow ?? currentPrice) * 1.01));
      const stopBase = Math.min(
        (buyZoneLow ?? currentPrice) * 0.965,
        latestLow !== null ? latestLow * 0.98 : currentPrice * 0.94,
        ma10 !== null ? ma10 * 0.985 : currentPrice * 0.94
      );
      const stopLoss = round(Math.max(stopBase, currentPrice * 0.86));
      const risk = Math.max((buyZoneHigh ?? currentPrice) - (stopLoss ?? currentPrice * 0.94), currentPrice * 0.025);
      const target1 = round(Math.max((buyZoneHigh ?? currentPrice) + risk * 1.5, currentPrice * 1.05, periodHigh * 1.01));
      const target2 = round(Math.max((target1 ?? currentPrice) + risk, currentPrice * 1.1));
      const chaseLimitPct = 4;
      const rank = rankBySymbol.get(symbol) ?? null;
      const maText = [
        ma5 !== null ? `MA5 ${round(ma5)}` : null,
        ma10 !== null ? `MA10 ${round(ma10)}` : null,
        ma20 !== null ? `MA20 ${round(ma20)}` : null,
      ].filter(Boolean).join(' / ');
      return {
        rank,
        symbol,
        name,
        current_price: round(currentPrice),
        buy_zone_low: buyZoneLow,
        buy_zone_high: buyZoneHigh,
        stop_loss: stopLoss,
        target_price_1: target1,
        target_price_2: target2,
        position_limit_pct: 30,
        timeframe: '1-3 个交易日',
        entry_style: '回踩承接，避免高开急拉追价',
        abandon_condition: [
          `高开超过 ${chaseLimitPct}% 且未回落到买入区间，不追。`,
          stopLoss !== null ? `盘中或收盘跌破 ${stopLoss}，短线计划失效。` : '跌破买入区间下沿且不能收回，短线计划失效。',
          ma5 !== null ? `收盘重新跌回 MA5 ${round(ma5)} 下方，降低优先级。` : null,
        ].filter(Boolean).join(' '),
        rationale: [
          `当前价 ${round(currentPrice)}，买入区间按最近均线支撑和当日波动回撤估算。`,
          maText ? `均线参考：${maText}。` : '均线样本不足，优先控制仓位。',
          '目标价以最近区间高点、风险收益比和短线波动共同约束。',
        ].join(' '),
        risk_note: '这是基于本地行情和技术指标的短线交易计划，不构成收益承诺或即时交易指令。',
      };
    })
    .filter((row): row is JsonRecord => Boolean(row))
    .sort((left, right) => (numeric(left.rank) ?? 999) - (numeric(right.rank) ?? 999));

  return {
    method: 'ma_support_pullback_risk_plan',
    description: '基于最新价、MA5/MA10/MA20、当日高低点和近期波动生成的短线买入/卖出风险计划。',
    rows,
    limitations: [
      '仅使用本地行情、K 线和已计算指标，不读取用户真实账户、委托深度或盘中逐笔资金。',
      '若次日集合竞价、成交额、涨跌停状态或板块环境显著变化，需要重新刷新计划。',
      '单票仓位默认不超过 30%，实际执行还需结合总资金、持仓集中度和交易纪律。',
    ],
  };
}

export function buildConclusion(params: {
  comparison: JsonRecord;
  selectionRanking: JsonRecord;
  financialQuality: JsonRecord;
}): JsonRecord {
  const leaders = asRecord(params.comparison.leaders);
  const top = asRecord(Array.isArray(params.selectionRanking.rows) ? params.selectionRanking.rows[0] : null);
  const qualityRows = Array.isArray(params.financialQuality.rows)
    ? params.financialQuality.rows.map(asRecord).filter((row): row is JsonRecord => Boolean(row))
    : [];
  const qualityLeader = qualityRows
    .slice()
    .sort((left, right) => (numeric(right.quality_score) ?? -1) - (numeric(left.quality_score) ?? -1))[0];
  return {
    summary: [
      top ? `综合研究优先级第一：${String(top.name ?? top.symbol)}，原因：${String(top.reason ?? '多因子得分领先')}` : '综合研究优先级仍待补齐。',
      asRecord(leaders?.best_return)
        ? `阶段收益领先：${String(asRecord(leaders?.best_return)?.name ?? asRecord(leaders?.best_return)?.symbol)}。`
        : '阶段收益领先标的待确认。',
      asRecord(leaders?.lowest_drawdown)
        ? `回撤控制相对较好：${String(asRecord(leaders?.lowest_drawdown)?.name ?? asRecord(leaders?.lowest_drawdown)?.symbol)}。`
        : '回撤控制指标待确认。',
      qualityLeader ? `财务质量相对占优：${String(qualityLeader.name ?? qualityLeader.symbol)}。` : '财务质量数据仍需补齐。',
      '排序仅用于横向研究，不构成交易指令；仍需结合仓位、风险偏好、交易成本和后续基本面变化。',
    ],
    primary_view: top
      ? `${String(top.name ?? top.symbol)} 当前综合研究优先级最高；其余候选应结合趋势、质量和风险约束分层观察。`
      : '候选排序待确认。',
    risk_disclaimer: '公开行情和财务接口可能存在延迟或字段缺失，本结果不构成投资建议、收益承诺或即时交易指令。',
  };
}

export function buildVisualizationContract(plan: QuantRunPlan, symbolCount: number): JsonRecord {
  const template = serializeQuantVisualizationTemplate(
    plan.requestedCapabilityId ?? plan.capabilityId,
    {
      instruction: plan.question,
      symbolCount,
      requestedVariantId: plan.visualization?.variantId,
      dataSignals: plan.visualization?.dataSignals,
    }
  );

  return {
    template_id: template.templateId,
    name: template.name,
    scenario: template.scenario,
    variant_id: template.variantId,
    variant_name: template.variantName,
    variant_scenario: template.variantScenario,
    layout: template.layout,
    density: template.density,
    first_viewport: template.firstViewport,
    variant_guidance: template.variantGuidance,
    match_reasons: template.matchReasons,
    alternatives: template.alternatives,
    pain_points: template.painPoints,
    required_components: template.requiredComponents,
    optional_components: template.optionalComponents,
    data_signals: template.dataSignals,
    final_data_contract: template.finalDataContract,
    rendered_components: template.requiredComponents,
    missing_components: [],
  };
}

export async function writeEmptyScreenerResult(params: {
  projectPath: string;
  plan: QuantRunPlan;
  screener: JsonRecord;
  rawFiles: string[];
  warnings: string[];
}): Promise<PrefetchResult> {
  const now = new Date().toISOString();
  const runId = params.plan.runId;
  const requestedCount = numeric(params.screener.limit) ?? 0;
  const scannedCount = numeric(params.screener.scanned_symbols) ?? 0;
  const noCandidateWarning =
    `筛选器扫描 ${scannedCount} 个标的后未返回满足安全条件的候选；平台不会为凑足 ${requestedCount || '指定'} 只而放宽过滤或编造推荐。`;
  const warnings = Array.from(new Set([...params.warnings, noCandidateWarning]));

  // Even with no candidates, preserve the batch-quote stage as an explicit
  // non-executed artifact so downstream contracts can distinguish it from an
  // interrupted or partially generated workspace.
  const batchPath = path.join(params.projectPath, 'data_file', 'raw', runId, 'batch-quotes.json');
  await writeJson(batchPath, {
    schemaVersion: 1,
    status: 'not_requested',
    reason: 'screener_returned_no_candidates',
    requested_symbols: [],
    quotes: [],
    fetched_at: now,
    source: 'quantpilot-market-api',
  });
  params.rawFiles.push(path.relative(params.projectPath, batchPath).replaceAll(path.sep, '/'));

  const assets: JsonRecord[] = [];
  const comparison = buildComparisonSummary(assets);
  const financialQuality = buildFinancialQualitySummary(assets);
  const selectionRanking = buildSelectionRanking(comparison, assets);
  const tradingPlan = {
    ...buildTradingPlan(assets, selectionRanking),
    status: 'unavailable',
    reason: 'no_safe_candidates',
  };
  const visualization = buildVisualizationContract(params.plan, 0);
  const finalData = {
    schemaVersion: 1,
    runId,
    generatedAt: now,
    status: 'no_candidates',
    result: 'completed_without_candidates',
    symbol: 'A_SHARE_UNIVERSE',
    name: 'A 股短线候选池',
    asset_type: 'stock_selection',
    source: String(params.screener.source ?? 'quantpilot-market-api'),
    as_of: params.screener.trade_date ?? params.screener.fetched_at ?? now,
    requestedSymbols: [],
    symbols: [],
    assetCount: 0,
    assets,
    comparison,
    selectionRanking,
    financialQuality,
    correlation: buildCorrelationSummary(assets),
    liquidity: buildLiquiditySummary(assets),
    tradingPlan,
    screener: params.screener,
    visualization,
    conclusion: {
      summary: [
        `本次共扫描 ${scannedCount} 个标的，未发现满足当前安全筛选条件的候选。`,
        '平台没有为满足推荐数量而放宽涨跌停、停牌、流动性或数据完整性约束，也没有生成虚构股票。',
        '可在补齐目标交易日覆盖、放宽明确且可审计的研究条件后重新运行筛选。',
      ],
      primary_view: '当前没有可安全列入研究优先级的候选，结果应视为“空候选”而不是生成失败。',
      risk_disclaimer: '筛选结果仅用于研究，不构成投资建议、收益承诺或即时交易指令。',
    },
    warnings,
  };
  const finalPath = path.join(params.projectPath, 'data_file', 'final', 'dashboard-data.json');
  await writeJson(finalPath, finalData);
  await ensureBaselineEvidenceFiles(params.projectPath, { force: true });

  const finalDataPath = path.relative(params.projectPath, finalPath).replaceAll(path.sep, '/');
  await appendQuantWorkspaceEvent(params.projectPath, {
    event_type: 'data_prefetched',
    stage: 'data_collection',
    status: 'warning',
    run_id: runId,
    artifact_path: finalDataPath,
    summary: `选股接口返回 0 个安全候选；已写入结构化空结果、证据文件和 ${finalDataPath}。`,
  });

  return {
    skipped: false,
    symbols: [],
    finalDataPath,
    rawFiles: params.rawFiles,
    summary: '选股已完成但没有满足安全条件的候选；已生成可验证的空结果看板。',
  };
}
