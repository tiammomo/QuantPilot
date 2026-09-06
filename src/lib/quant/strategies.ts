import { getAllProjects } from '@/lib/services/project';
import { getQuantCapability, type QuantCapabilityId } from '@/lib/domains/finance/capabilities';
import { serializeProjects } from '@/lib/serializers/project';
import type { Project } from '@/types';
import { STRATEGY_FACTOR_CATALOG, STRATEGY_TEMPLATES } from './strategy-catalog';
import { readinessFor } from './strategy-readiness';
import { listScanJobs, listScanRuns, writeScanJob, writeScanRun } from './strategy-scan-repository';
import type {
  StrategyParameterScan,
  StrategyScanRunResult,
  StrategyScanRun,
  StrategyScanJob,
  StrategyTemplate,
  StrategyWorkspaceRef,
  StrategyCatalogItem,
  StrategyDashboardData,
} from './strategy-types';
import { MARKET_API_BASE_URL, fetchBacktest } from './strategy-market-api';
import { getStrategyResearchState, getStrategyFoundationState } from './strategy-research-state';

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function findTemplate(templateId: string) {
  return STRATEGY_TEMPLATES.find(template => template.id === templateId) ?? null;
}

function listCatalogTemplates() {
  return STRATEGY_TEMPLATES.filter(template => template.kind);
}

function findScan(template: StrategyTemplate, scanId: string) {
  return template.parameterScans.find(scan => scan.id === scanId) ?? null;
}

function expandGrid(scan: StrategyParameterScan): Array<Record<string, string | number>> {
  return scan.grid.reduce<Array<Record<string, string | number>>>((acc, item) => {
    const base = acc.length ? acc : [{}];
    return base.flatMap(existing =>
      item.values.map(value => ({
        ...existing,
        [item.key]: value,
      }))
    );
  }, []);
}

function isValidMaCrossoverParams(params: Record<string, string | number>) {
  const fast = asNumber(params.fast_window);
  const slow = asNumber(params.slow_window);
  return fast !== null && slow !== null && fast < slow;
}

function summarizeBacktest(backtest: Record<string, unknown>): StrategyScanRunResult['metrics'] {
  const summary = backtest.summary && typeof backtest.summary === 'object'
    ? backtest.summary as Record<string, unknown>
    : {};
  return {
    totalReturnPct: asNumber(summary.total_return_pct),
    maxDrawdownPct: asNumber(summary.max_drawdown_pct),
    winRatePct: asNumber(summary.win_rate_pct),
    tradeCount: asNumber(summary.trade_count),
    sharpe: asNumber(summary.sharpe),
  };
}

function chooseBestResult(results: StrategyScanRunResult[]) {
  const successful = results.filter(result => result.status === 'success');
  if (!successful.length) return null;
  return successful
    .slice()
    .sort((a, b) => {
      const aReturn = a.metrics.totalReturnPct ?? Number.NEGATIVE_INFINITY;
      const bReturn = b.metrics.totalReturnPct ?? Number.NEGATIVE_INFINITY;
      if (aReturn !== bReturn) return bReturn - aReturn;
      const aDrawdown = a.metrics.maxDrawdownPct ?? Number.POSITIVE_INFINITY;
      const bDrawdown = b.metrics.maxDrawdownPct ?? Number.POSITIVE_INFINITY;
      return aDrawdown - bDrawdown;
    })[0];
}

function isStrategyCapability(capabilityId?: string | null): capabilityId is QuantCapabilityId {
  return capabilityId === 'strategy_research' || capabilityId === 'backtest_review' || capabilityId === 'portfolio_risk';
}

function toWorkspaceRef(project: Project): StrategyWorkspaceRef {
  return {
    id: project.id,
    name: project.name,
    status: project.status ?? null,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt ?? null,
    capabilityId: isStrategyCapability(project.capabilityId)
      ? project.capabilityId
      : null,
    initialPrompt: project.initialPrompt ?? null,
  };
}

function matchesTemplate(project: StrategyWorkspaceRef, template: StrategyTemplate) {
  if (project.capabilityId === template.capabilityId) return true;
  const prompt = `${project.name} ${project.initialPrompt ?? ''}`.toLowerCase();
  return template.defaultSymbols.some(symbol => prompt.includes(symbol.toLowerCase())) ||
    template.parameterSchema.some(param => prompt.includes(param.key.toLowerCase()));
}

export async function getStrategyDashboardData(): Promise<StrategyDashboardData> {
  const projects = serializeProjects(await getAllProjects().catch(() => []));
  const [scanRuns, scanJobs, research, foundation] = await Promise.all([
    listScanRuns(),
    listScanJobs(),
    getStrategyResearchState(),
    getStrategyFoundationState(),
  ]);
  const strategyWorkspaces = projects
    .filter(project => isStrategyCapability(project.capabilityId))
    .map(toWorkspaceRef);

  const templates = listCatalogTemplates().map((template): StrategyCatalogItem => ({
    ...template,
    readiness: readinessFor(template),
    linkedWorkspaces: strategyWorkspaces.filter(project => matchesTemplate(project, template)),
    latestScanRun: scanRuns.find(run => run.templateId === template.id) ?? null,
  }));

  const dependencySet = new Set(templates.flatMap(template => template.dataDependencies));
  const parameterScans = templates.reduce((sum, template) => sum + template.parameterScans.length, 0);
  const archivedReports = templates.reduce((sum, template) => sum + template.backtestArchives.length, 0);
  const activeVersions = templates.reduce(
    (sum, template) => sum + template.versions.filter(version => version.status === 'active').length,
    0
  );
  const trackedSymbols = research.universes.reduce(
    (sum, universe) => sum + universe.memberCount,
    0
  );
  const syncedSymbols = research.universes.reduce((sum, universe) => sum + universe.readyCount, 0);
  const syncedBars = research.universes.reduce((sum, universe) => sum + universe.barCount, 0);

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      templates: templates.length,
      readyTemplates: templates.filter(template => template.status === 'ready').length,
      plannedTemplates: templates.filter(template => template.status === 'planned').length,
      strategyWorkspaces: strategyWorkspaces.length,
      backtestWorkspaces: strategyWorkspaces.filter(project => project.capabilityId === 'backtest_review').length,
      dataDependencies: dependencySet.size,
      parameterScans,
      archivedReports,
      activeVersions,
      researchUniverses: research.universes.length,
      trackedSymbols,
      syncedSymbols,
      syncedBars,
    },
    templates,
    workspaces: strategyWorkspaces,
    scanRuns,
    scanJobs,
    research,
    foundation,
    factorCatalog: STRATEGY_FACTOR_CATALOG,
  };
}

export function buildStrategyPrompt(templateId: string, symbol?: string) {
  const template = STRATEGY_TEMPLATES.find(item => item.id === templateId) ?? STRATEGY_TEMPLATES[0];
  const target = symbol?.trim() || template.defaultSymbols[0];
  const capability = getQuantCapability(template.capabilityId);
  return {
    name: `${template.name} · ${target}`,
    prompt: `${template.promptSeed}\n\n策略模板：${template.name}\n目标标的：${target}\n能力模块：${capability.name}\n必须展示参数、数据来源、风险限制和验证结论边界。`,
    capabilityId: capability.id,
  };
}

export async function runStrategyParameterScan(params: {
  templateId: string;
  scanId: string;
  symbol?: string;
}): Promise<StrategyScanRun> {
  const template = findTemplate(params.templateId);
  if (!template) {
    throw new Error(`Unknown strategy template: ${params.templateId}`);
  }
  const scan = findScan(template, params.scanId);
  if (!scan) {
    throw new Error(`Unknown parameter scan: ${params.scanId}`);
  }
  const startedAt = new Date().toISOString();
  const symbol = params.symbol?.trim() || template.defaultSymbols[0] || '510300';
  const combinations = expandGrid(scan).slice(0, 64);
  const results: StrategyScanRunResult[] = [];

  if (scan.status !== 'available') {
    const run: StrategyScanRun = {
      id: `scan-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      templateId: template.id,
      scanId: scan.id,
      symbol,
      status: 'failed',
      startedAt,
      completedAt: new Date().toISOString(),
      total: combinations.length,
      succeeded: 0,
      failed: combinations.length,
      bestResultId: null,
      objective: scan.objective,
      source: scan.status === 'planned' ? 'parameter scan is planned' : 'parameter scan is blocked',
      results: combinations.map((parameters, index) => ({
        id: `${scan.id}-${index + 1}`,
        parameters,
        status: 'skipped',
        metrics: {},
        error: scan.status === 'planned' ? '扫描仍在规划中' : '扫描被依赖阻断',
      })),
    };
    await writeScanRun(run);
    return run;
  }

  for (const [index, parameters] of combinations.entries()) {
    const id = `${scan.id}-${index + 1}`;
    if (template.backtestStrategyId === 'ma_crossover' && !isValidMaCrossoverParams(parameters)) {
      results.push({
        id,
        parameters,
        status: 'skipped',
        metrics: {},
        error: 'fast_window 必须小于 slow_window',
      });
      continue;
    }

    try {
      const backtest = await fetchBacktest({
        symbol,
        parameters,
        strategyId: template.backtestStrategyId,
        limit: template.backtestLimit,
      });
      results.push({
        id,
        parameters,
        status: 'success',
        metrics: summarizeBacktest(backtest),
      });
    } catch (error) {
      results.push({
        id,
        parameters,
        status: 'failed',
        metrics: {},
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const best = chooseBestResult(results);
  const succeeded = results.filter(result => result.status === 'success').length;
  const failed = results.filter(result => result.status === 'failed').length;
  const run: StrategyScanRun = {
    id: `scan-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    templateId: template.id,
    scanId: scan.id,
    symbol,
    status: succeeded === 0 ? 'failed' : failed > 0 ? 'partial' : 'completed',
    startedAt,
    completedAt: new Date().toISOString(),
    total: results.length,
    succeeded,
    failed,
    bestResultId: best?.id ?? null,
    objective: scan.objective,
    source: `${MARKET_API_BASE_URL}/api/v1/backtests/strategies/${template.backtestStrategyId}/{symbol}`,
    results,
  };
  await writeScanRun(run);
  return run;
}

async function executeScanJob(job: StrategyScanJob) {
  const runningJob: StrategyScanJob = {
    ...job,
    status: 'running',
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    error: null,
  };
  await writeScanJob(runningJob);

  try {
    const run = await runStrategyParameterScan({
      templateId: job.templateId,
      scanId: job.scanId,
      symbol: job.symbol,
    });
    await writeScanJob({
      ...runningJob,
      status: run.status === 'failed' ? 'failed' : 'completed',
      runId: run.id,
      completedAt: run.completedAt,
      updatedAt: new Date().toISOString(),
      error: run.status === 'failed' ? '扫描未产生成功结果' : null,
    });
  } catch (error) {
    await writeScanJob({
      ...runningJob,
      status: 'failed',
      completedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function enqueueStrategyParameterScan(params: {
  templateId: string;
  scanId: string;
  symbol?: string;
}): Promise<StrategyScanJob> {
  const template = findTemplate(params.templateId);
  if (!template) {
    throw new Error(`Unknown strategy template: ${params.templateId}`);
  }
  const scan = findScan(template, params.scanId);
  if (!scan) {
    throw new Error(`Unknown parameter scan: ${params.scanId}`);
  }

  const now = new Date().toISOString();
  const job: StrategyScanJob = {
    id: `scan-job-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    templateId: template.id,
    scanId: scan.id,
    symbol: params.symbol?.trim() || template.defaultSymbols[0] || '510300',
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    runId: null,
    error: null,
  };
  await writeScanJob(job);

  setTimeout(() => {
    void executeScanJob(job);
  }, 0);

  return job;
}
