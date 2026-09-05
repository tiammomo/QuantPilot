import fs from 'fs/promises';
import path from 'path';
import { validateQuantArtifactContracts } from '@/lib/quant/artifact-contracts';
import { type QuantValidationCheck } from './contracts';
import {
  directoryExists,
  fileExists,
  isNonEmptyJsonValue,
  normalizeRelativePath,
  readTextFile,
} from './files';
import {
  asRecord,
  extractComparisonSymbols,
  extractFetchedSymbols,
  extractPlannedSymbols,
  hasExplicitTradingPlanIntent,
  inferExpectedTemplateFromTask,
  inspectDashboardDataPayload,
  isStructuredEmptyScreenerResult,
  normalizeTextForIntent,
  numeric,
  pickString,
  readRunPlan,
} from './inputs';

export async function checkFinalDataFile(
  projectPath: string
): Promise<Omit<QuantValidationCheck, 'id' | 'name' | 'durationMs'>> {
  const finalDir = path.join(projectPath, 'data_file', 'final');
  if (!(await directoryExists(finalDir))) {
    return {
      status: 'failed',
      summary: '未找到 data_file/final 目录。',
    };
  }

  const preferredPath = path.join(finalDir, 'dashboard-data.json');
  const entries = await fs.readdir(finalDir, { withFileTypes: true }).catch(() => []);
  const jsonFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(finalDir, entry.name));

  const candidates = [
    ...(await fileExists(preferredPath) ? [preferredPath] : []),
    ...jsonFiles.filter((filePath) => filePath !== preferredPath),
  ];

  if (candidates.length === 0) {
    return {
      status: 'failed',
      summary: 'data_file/final 下没有 JSON 数据文件，预期至少生成 dashboard-data.json。',
    };
  }

  const errors: string[] = [];
  for (const filePath of candidates) {
    const raw = await readTextFile(filePath);
    if (!raw || raw.trim().length <= 2) {
      errors.push(`${normalizeRelativePath(projectPath, filePath)} 为空。`);
      continue;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      const runPlan = await readRunPlan(projectPath);
      const plannedSymbols = extractPlannedSymbols(runPlan);
      const fetchedSymbols = extractFetchedSymbols(parsed);
      const comparisonSymbols = extractComparisonSymbols(parsed);
      const missingSymbols = plannedSymbols.filter((symbol) => !fetchedSymbols.includes(symbol));
      const serialized = JSON.stringify(parsed);
      const hasDataShape =
        /quote|quotes|price|symbol|symbols|assets|comparison|secid|history|kline|financial|reports|announcement|source|fetched_at|quote_time|close|open|volume|amount|backtest|equity_curve|trades|strategy|drawdown|win_rate|营收|净利润|毛利率|roe|回测|净值|回撤|胜率/i.test(
          serialized
        );
      const hasPlaceholderSmell = /mock|demo|example|placeholder|lorem|示例|样例|模拟|假数据/i.test(serialized);

      if (!isNonEmptyJsonValue(parsed)) {
        errors.push(`${normalizeRelativePath(projectPath, filePath)} 没有可用数据。`);
        continue;
      }

      if (!hasDataShape) {
        errors.push(`${normalizeRelativePath(projectPath, filePath)} 未检测到行情、K 线、财务或来源字段。`);
        continue;
      }

      if (hasPlaceholderSmell) {
        errors.push(`${normalizeRelativePath(projectPath, filePath)} 疑似包含示例或模拟数据标记。`);
        continue;
      }

      const payloadInspection = inspectDashboardDataPayload(parsed);
      const isEmptyScreenerResult = isStructuredEmptyScreenerResult(parsed);
      if (!payloadInspection.hasUsableMarketData && !isEmptyScreenerResult) {
        errors.push(`${normalizeRelativePath(projectPath, filePath)} 未提取到可用实时行情或 K 线样本。`);
        continue;
      }

      if (missingSymbols.length > 0) {
        errors.push(
          `${normalizeRelativePath(projectPath, filePath)} 未覆盖 run_plan 中的全部标的，缺少：${missingSymbols.join('、')}。`
        );
        continue;
      }

      if (plannedSymbols.length > 1) {
        const comparisonMissingSymbols = plannedSymbols.filter((symbol) => !comparisonSymbols.includes(symbol));
        if (comparisonMissingSymbols.length > 0) {
          errors.push(
            `${normalizeRelativePath(projectPath, filePath)} 的 comparison.rows 未覆盖全部对比标的，缺少：${comparisonMissingSymbols.join('、')}。`
          );
          continue;
        }
      }

      const runPlanVisualization = asRecord(runPlan?.visualization);
      const plannedTemplateId = pickString(runPlanVisualization?.templateId);
      const expectedTemplateId = inferExpectedTemplateFromTask(runPlan);
      const taskText = normalizeTextForIntent([
        runPlan?.question,
        runPlan?.task,
        runPlan?.instruction,
        runPlan?.clarification,
      ]);
      const visualization = asRecord(asRecord(parsed)?.visualization);
      const finalTemplateId = pickString(visualization?.template_id ?? visualization?.templateId);
      const requiredComponents = Array.isArray(visualization?.required_components)
        ? visualization.required_components
        : Array.isArray(runPlanVisualization?.panels)
          ? runPlanVisualization.panels
          : [];

      if (expectedTemplateId && plannedTemplateId !== expectedTemplateId) {
        errors.push(
          `${normalizeRelativePath(projectPath, filePath)} 的任务语义需要 ${expectedTemplateId} 模板，但 run_plan.visualization.templateId=${plannedTemplateId ?? '未设置'}。`
        );
        continue;
      }

      if (expectedTemplateId && finalTemplateId && finalTemplateId !== expectedTemplateId) {
        errors.push(
          `${normalizeRelativePath(projectPath, filePath)} 的任务语义需要 ${expectedTemplateId} 模板，但 visualization.template_id=${finalTemplateId}。`
        );
        continue;
      }

      if (plannedTemplateId && !finalTemplateId) {
        errors.push(
          `${normalizeRelativePath(projectPath, filePath)} 缺少 visualization.template_id，无法验证场景化看板模板。`
        );
        continue;
      }

      if (plannedTemplateId && finalTemplateId && plannedTemplateId !== finalTemplateId) {
        errors.push(
          `${normalizeRelativePath(projectPath, filePath)} 的 visualization.template_id=${finalTemplateId} 与 run_plan=${plannedTemplateId} 不一致。`
        );
        continue;
      }

      if (plannedTemplateId && requiredComponents.length === 0) {
        errors.push(
          `${normalizeRelativePath(projectPath, filePath)} 缺少 visualization.required_components，无法确认页面是否覆盖场景痛点。`
        );
        continue;
      }

      const record = asRecord(parsed);
      const tradingPlanRows = Array.isArray(asRecord(record?.tradingPlan)?.rows)
        ? asRecord(record?.tradingPlan)?.rows as unknown[]
        : [];
      if (!hasExplicitTradingPlanIntent(taskText) && tradingPlanRows.length > 0) {
        errors.push(
          `${normalizeRelativePath(projectPath, filePath)} 包含 tradingPlan.rows，但原始需求没有明确要求交易计划、买入区间、止损或目标价。`
        );
        continue;
      }

      if (plannedTemplateId === 'stock-selection' && !isEmptyScreenerResult) {
        const selectionRanking = asRecord(record?.selectionRanking);
        const financialQuality = asRecord(record?.financialQuality);
        const rankingRows = Array.isArray(selectionRanking?.rows) ? selectionRanking.rows : [];
        const qualityRows = Array.isArray(financialQuality?.rows) ? financialQuality.rows : [];
        const comparisonRows = Array.isArray(asRecord(record?.comparison)?.rows)
          ? asRecord(record?.comparison)?.rows as unknown[]
          : [];
        const missingSelectionData = [
          rankingRows.length === 0 ? 'selectionRanking.rows' : null,
          qualityRows.length === 0 ? 'financialQuality.rows' : null,
          comparisonRows.some((row) => {
            const item = asRecord(row);
            return !item || numeric(item.composite_score) === null || !pickString(item.selection_view);
          }) ? 'comparison.rows[].composite_score/selection_view' : null,
        ].filter((item): item is string => Boolean(item));

        if (missingSelectionData.length > 0) {
          errors.push(
            `${normalizeRelativePath(projectPath, filePath)} 缺少选股模板数据字段：${missingSelectionData.join('、')}。`
          );
          continue;
        }
      }

      if (plannedTemplateId === 'holding-analysis') {
        const record = asRecord(parsed);
        const holdings = Array.isArray(record?.holdings) ? record.holdings : [];
        const assets = Array.isArray(record?.assets) ? record.assets : [];
        const comparisonRows = Array.isArray(asRecord(record?.comparison)?.rows)
          ? asRecord(record?.comparison)?.rows as unknown[]
          : [];
        const missingHoldingData = [
          !asRecord(record?.portfolio) ? 'portfolio' : null,
          holdings.length === 0 ? 'holdings[]' : null,
          assets.length === 0 ? 'assets[]' : null,
          comparisonRows.length === 0 ? 'comparison.rows' : null,
        ].filter((item): item is string => Boolean(item));

        if (missingHoldingData.length > 0) {
          errors.push(
            `${normalizeRelativePath(projectPath, filePath)} 缺少持仓分析模板数据字段：${missingHoldingData.join('、')}。`
          );
          continue;
        }
      }

      return {
        status: 'passed',
        summary: `已找到可用最终数据文件：${normalizeRelativePath(projectPath, filePath)}。`,
        metadata: {
          file: normalizeRelativePath(projectPath, filePath),
          bytes: Buffer.byteLength(raw),
          plannedSymbols,
          fetchedSymbols,
          comparisonSymbols,
          barCount: payloadInspection.barCount,
          hasQuote: payloadInspection.hasQuote,
          visualizationTemplateId: finalTemplateId,
        },
      };
    } catch (error) {
      errors.push(`${normalizeRelativePath(projectPath, filePath)} JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    status: 'failed',
    summary: '最终数据文件存在，但没有通过真实数据形态检查。',
    details: errors.join('\n'),
  };
}

export async function checkArtifactContracts(
  projectPath: string,
  projectId: string,
  requestId?: string | null
): Promise<Omit<QuantValidationCheck, 'id' | 'name' | 'durationMs'>> {
  const report = await validateQuantArtifactContracts({
    projectPath,
    projectId,
    requestId,
  });
  const failed = report.checks.filter((check) => check.status === 'failed');
  const warnings = report.checks.filter((check) => check.status === 'warning');
  if (failed.length > 0) {
    return {
      status: 'failed',
      summary: `产物契约未通过：${failed.length} 个结构性问题。`,
      details: failed.map((check) => `${check.label}：${check.summary}${check.details ? `\n${check.details}` : ''}`).join('\n\n'),
      metadata: {
        reportPath: report.reportPath,
        failed: failed.map((check) => check.id),
      },
    };
  }
  return {
    status: warnings.length > 0 ? 'warning' : 'passed',
    summary: warnings.length > 0 ? `产物契约通过但有 ${warnings.length} 个警告。` : '关键 JSON 产物契约通过。',
    metadata: {
      reportPath: report.reportPath,
      warningCount: warnings.length,
    },
  };
}
