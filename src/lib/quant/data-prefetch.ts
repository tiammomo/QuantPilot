import path from 'path';
import { ensureBaselineEvidenceFiles } from '@/lib/quant/evidence';
import { appendQuantWorkspaceEvent, ensureQuantWorkspace, QuantRunPlan } from '@/lib/domains/finance/workspace';
import { type JsonRecord, type PrefetchResult, asRecord, extractBarsFromAsset } from './data-prefetch/values';
import {
  hasExplicitTradingPlanIntent,
  inferPlannedSymbols,
  isBroadStockScreenerPlan,
  isQuantAnalysisPlan,
  syncRunPlanSymbols,
} from './data-prefetch/planning';
import { fetchScreenerSeedSymbols } from './data-prefetch/market';
import { collectSymbolDatasets, type PrefetchProgress } from './data-prefetch/collection';
import {
  buildComparisonSummary,
  buildConclusion,
  buildSelectionRanking,
  buildTradingPlan,
  buildVisualizationContract,
  writeEmptyScreenerResult,
} from './data-prefetch/dashboard';
import {
  augmentEvidenceWithImageExtraction,
  buildImageExtractionEvidence,
} from './data-prefetch/image-evidence';
import { fetchJson, writeJson } from './data-prefetch/transport';
import { ensureTechnicalSummary } from './data-prefetch/technical';
import { buildFinancialQuality, buildFinancialQualitySummary } from './data-prefetch/fundamentals';
import {
  buildCorrelationSummary,
  buildHoldingRows,
  buildLiquiditySummary,
  buildPortfolioSummary,
} from './data-prefetch/portfolio';

export async function prefetchQuantDataForRunPlan(params: {
  projectPath: string;
  plan: QuantRunPlan;
  onProgress?: (progress: PrefetchProgress) => Promise<void>;
}): Promise<PrefetchResult> {
  if (
    params.plan.status === 'needs_clarification' ||
    params.plan.status === 'refused' ||
    params.plan.clarification?.required
  ) {
    return { skipped: true, summary: '任务仍需用户补充关键信息，跳过平台预取数据。' };
  }

  if (!isQuantAnalysisPlan(params.plan)) {
    return { skipped: true, summary: `能力 ${params.plan.capabilityId} 暂不需要平台预取数据。` };
  }

  await ensureQuantWorkspace(params.projectPath);
  const runId = params.plan.runId;
  const rawFiles: string[] = [];
  let symbols = inferPlannedSymbols(params.plan);
  const warnings: string[] = [];
  let screenerData: JsonRecord | null = null;

  if (symbols.length === 0 && isBroadStockScreenerPlan(params.plan)) {
    try {
      const screenerSeed = await fetchScreenerSeedSymbols({
        projectPath: params.projectPath,
        runId,
        plan: params.plan,
        rawFiles,
        warnings,
      });
      symbols = screenerSeed.symbols;
      screenerData = screenerSeed.screener;
    } catch (error) {
      warnings.push(`选股接口预取失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (symbols.length === 0 && screenerData) {
    await syncRunPlanSymbols({
      projectPath: params.projectPath,
      plan: params.plan,
      symbols,
      source: 'screener',
      warnings,
    });
    await appendQuantWorkspaceEvent(params.projectPath, {
      event_type: 'data_prefetch_started',
      stage: 'data_collection',
      status: 'pending',
      run_id: runId,
      summary: '平台已完成宽域 A 股筛选，正在固化零候选结果与证据。',
    });
    return writeEmptyScreenerResult({
      projectPath: params.projectPath,
      plan: params.plan,
      screener: screenerData,
      rawFiles,
      warnings,
    });
  }

  if (symbols.length === 0) {
    return {
      skipped: true,
      summary: `未识别到 A 股、指数或 ETF 标的，跳过平台预取。${warnings.length ? ` ${warnings.join('；')}` : ''}`,
    };
  }

  await syncRunPlanSymbols({
    projectPath: params.projectPath,
    plan: params.plan,
    symbols,
    source: screenerData ? 'screener' : 'run_plan',
    warnings,
  });

  const imageExtractionEvidence = await buildImageExtractionEvidence(params.projectPath, runId, warnings);
  const imageExtraction = asRecord(imageExtractionEvidence?.imageExtraction);

  await appendQuantWorkspaceEvent(params.projectPath, {
    event_type: 'data_prefetch_started',
    stage: 'data_collection',
    status: 'pending',
    run_id: runId,
    summary: `平台开始预取 ${symbols.join('、')} 的真实行情数据。`,
  });

  const quoteMap = new Map<string, JsonRecord>();
  if (symbols.length > 1) {
    try {
      const batchQuotes = await fetchJson('/api/v1/quotes/realtime', {
        method: 'POST',
        body: JSON.stringify({ symbols }),
      });
      const quoteRows = Array.isArray(batchQuotes.quotes) ? batchQuotes.quotes : [];
      for (const row of quoteRows) {
        const record = asRecord(row);
        const symbol = typeof record?.symbol === 'string' ? record.symbol : null;
        if (symbol && record) {
          quoteMap.set(symbol, record);
        }
      }
      const batchPath = path.join(params.projectPath, 'data_file', 'raw', runId, 'batch-quotes.json');
      await writeJson(batchPath, batchQuotes);
      rawFiles.push(path.relative(params.projectPath, batchPath).replaceAll(path.sep, '/'));
    } catch (error) {
      warnings.push(`批量实时行情预取失败，降级为逐只获取：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const collected = await collectSymbolDatasets({
    projectPath: params.projectPath,
    runId,
    plan: params.plan,
    symbols,
    quotes: quoteMap,
    onProgress: params.onProgress,
  });
  rawFiles.push(...collected.rawFiles);
  warnings.push(...collected.warnings);
  const assets = collected.assets;
  for (const asset of assets) {
    if (asRecord(asset.technicalIndicators) || extractBarsFromAsset(asset).length > 0) {
      ensureTechnicalSummary(asset);
    }
    buildFinancialQuality(asset);
  }

  if (assets.length === 0) {
    throw new Error(`所有标的预取失败：${warnings.join('；')}`);
  }

  const primaryAsset = assets[0];
  const visualization = buildVisualizationContract(params.plan, assets.length || symbols.length);
  const comparison = buildComparisonSummary(assets);
  const financialQuality = buildFinancialQualitySummary(assets);
  const selectionRanking = buildSelectionRanking(comparison, assets);
  const tradingPlan = hasExplicitTradingPlanIntent(params.plan.question)
    ? buildTradingPlan(assets, selectionRanking)
    : null;
  const conclusion = buildConclusion({ comparison, selectionRanking, financialQuality });
  const finalData = symbols.length === 1
    ? {
        ...primaryAsset,
        runId: params.plan.runId,
        ...(params.plan.requestedCapabilityId === 'portfolio_risk' || params.plan.capabilityId === 'portfolio_risk'
          ? {
              portfolio: buildPortfolioSummary(assets),
              holdings: buildHoldingRows(assets),
              assets,
              comparison: buildComparisonSummary(assets),
            }
          : {}),
        ...(imageExtraction ? { imageExtraction } : {}),
        ...(screenerData ? { screener: screenerData } : {}),
        visualization,
        liquidity: buildLiquiditySummary([primaryAsset]),
        financialQuality,
        selectionRanking,
        ...(tradingPlan ? { tradingPlan } : {}),
        conclusion,
      }
    : {
        ...primaryAsset,
        runId: params.plan.runId,
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        primarySymbol: primaryAsset.symbol,
        requestedSymbols: symbols,
        symbols: assets.map((asset) => asset.symbol),
        assetCount: assets.length,
        assets,
        ...(params.plan.requestedCapabilityId === 'portfolio_risk' || params.plan.capabilityId === 'portfolio_risk'
          ? {
              portfolio: buildPortfolioSummary(assets),
              holdings: buildHoldingRows(assets),
            }
          : {}),
        ...(imageExtraction ? { imageExtraction } : {}),
        comparison,
        correlation: buildCorrelationSummary(assets),
        liquidity: buildLiquiditySummary(assets),
        financialQuality,
        selectionRanking,
        ...(tradingPlan ? { tradingPlan } : {}),
        ...(screenerData ? { screener: screenerData } : {}),
        visualization,
        conclusion,
        warnings,
      };
  const finalPath = path.join(params.projectPath, 'data_file', 'final', 'dashboard-data.json');
  await writeJson(finalPath, finalData);

  await ensureBaselineEvidenceFiles(params.projectPath, { force: true });
  if (imageExtractionEvidence) {
    await augmentEvidenceWithImageExtraction(params.projectPath, imageExtractionEvidence);
  }

  const finalDataPath = path.relative(params.projectPath, finalPath).replaceAll(path.sep, '/');
  await appendQuantWorkspaceEvent(params.projectPath, {
    event_type: 'data_prefetched',
    stage: 'data_collection',
    status: warnings.length > 0 ? 'warning' : 'success',
    run_id: runId,
    artifact_path: finalDataPath,
    summary: `平台已预取 ${assets.map((asset) => asset.symbol).join('、')} 数据：raw ${rawFiles.length} 个文件，final 数据已写入。${warnings.length ? ` 警告：${warnings.join('；')}` : ''}`,
  });

  return {
    skipped: false,
    symbol: String(primaryAsset.symbol ?? symbols[0]),
    symbols: assets.map((asset) => String(asset.symbol ?? '')).filter(Boolean),
    finalDataPath,
    rawFiles,
    summary: `已预取 ${assets.map((asset) => asset.symbol).join('、')} 真实数据并生成 ${finalDataPath}。`,
  };
}
