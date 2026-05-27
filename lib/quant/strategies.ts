import { getAllProjects } from '@/lib/services/project';
import { getQuantCapability, type QuantCapabilityId } from '@/lib/quant/capabilities';
import { serializeProjects } from '@/lib/serializers/project';
import type { Project } from '@/types';
import fs from 'fs/promises';
import path from 'path';

type StrategyStatus = 'ready' | 'planned' | 'research';
type StrategyRiskLevel = 'low' | 'medium' | 'high';

export interface StrategyParameter {
  key: string;
  label: string;
  value: string | number;
  unit?: string;
  description: string;
}

export interface StrategyParameterScan {
  id: string;
  name: string;
  status: 'available' | 'planned' | 'blocked';
  objective: string;
  grid: Array<{
    key: string;
    values: Array<string | number>;
    unit?: string;
  }>;
  metrics: string[];
  guardrails: string[];
  sampleSize: number;
}

export interface StrategyVersionRecord {
  version: string;
  status: 'active' | 'draft' | 'archived';
  updatedAt: string;
  changes: string[];
  parameterSnapshot: Record<string, string | number>;
}

export interface StrategyBacktestArchive {
  id: string;
  title: string;
  status: 'available' | 'pending' | 'missing';
  symbol: string;
  period: string;
  metrics: {
    totalReturnPct?: number;
    maxDrawdownPct?: number;
    winRatePct?: number;
    tradeCount?: number;
  };
  source: string;
  linkedWorkspaceId?: string;
  limitations: string[];
}

export interface StrategyScanRunResult {
  id: string;
  parameters: Record<string, string | number>;
  status: 'success' | 'failed' | 'skipped';
  metrics: {
    totalReturnPct?: number | null;
    maxDrawdownPct?: number | null;
    winRatePct?: number | null;
    tradeCount?: number | null;
    sharpe?: number | null;
  };
  error?: string;
}

export interface StrategyScanRun {
  id: string;
  templateId: string;
  scanId: string;
  symbol: string;
  status: 'completed' | 'failed' | 'partial';
  startedAt: string;
  completedAt: string;
  total: number;
  succeeded: number;
  failed: number;
  bestResultId?: string | null;
  objective: string;
  source: string;
  results: StrategyScanRunResult[];
}

export interface StrategyTemplate {
  id: string;
  name: string;
  family: string;
  status: StrategyStatus;
  capabilityId: QuantCapabilityId;
  description: string;
  defaultSymbols: string[];
  timeframe: string;
  dataDependencies: string[];
  parameterSchema: StrategyParameter[];
  parameterScans: StrategyParameterScan[];
  versions: StrategyVersionRecord[];
  backtestArchives: StrategyBacktestArchive[];
  riskControls: string[];
  evaluationMetrics: string[];
  limitations: string[];
  promptSeed: string;
}

export interface StrategyWorkspaceRef {
  id: string;
  name: string;
  status?: string | null;
  createdAt: string;
  updatedAt?: string | null;
  capabilityId?: QuantCapabilityId | null;
  initialPrompt?: string | null;
}

export interface StrategyCatalogItem extends StrategyTemplate {
  readiness: {
    label: string;
    score: number;
    riskLevel: StrategyRiskLevel;
    summary: string;
  };
  linkedWorkspaces: StrategyWorkspaceRef[];
  latestScanRun: StrategyScanRun | null;
}

export interface StrategyDashboardData {
  generatedAt: string;
  summary: {
    templates: number;
    readyTemplates: number;
    plannedTemplates: number;
    strategyWorkspaces: number;
    backtestWorkspaces: number;
    dataDependencies: number;
    parameterScans: number;
    archivedReports: number;
    activeVersions: number;
  };
  templates: StrategyCatalogItem[];
  workspaces: StrategyWorkspaceRef[];
  scanRuns: StrategyScanRun[];
}

const ROOT = process.cwd();
const DATA_DIR = process.env.STRATEGY_SCANS_DIR || path.join(ROOT, 'data', 'strategy-scans');
const MARKET_API_BASE_URL =
  process.env.QUANTPILOT_MARKET_API_URL ||
  process.env.QUANTPILOT_MARKET_API_BASE_URL ||
  'http://127.0.0.1:8000';

const STRATEGY_TEMPLATES: StrategyTemplate[] = [
  {
    id: 'ma-crossover-single-asset',
    name: '均线突破策略',
    family: '趋势跟随',
    status: 'ready',
    capabilityId: 'backtest_review',
    description: '以 20/60 日均线交叉为核心信号，验证单标的趋势跟随效果。',
    defaultSymbols: ['510300', '000300'],
    timeframe: '日线 · 近 250 个交易日',
    dataDependencies: [
      'GET /api/v1/symbols/resolve',
      'GET /api/v1/quotes/history/{symbol}',
      'GET /api/v1/indicators/technical/{symbol}',
      'GET /api/v1/backtests/ma-crossover/{symbol}',
    ],
    parameterSchema: [
      { key: 'fast_window', label: '快线窗口', value: 20, unit: '日', description: '用于触发入场和离场的短期均线。' },
      { key: 'slow_window', label: '慢线窗口', value: 60, unit: '日', description: '用于判断中期趋势方向。' },
      { key: 'fee_bps', label: '单边费用', value: 5, unit: 'bps', description: '回测中默认扣减的交易费用。' },
    ],
    parameterScans: [
      {
        id: 'ma-window-grid',
        name: '均线窗口扫描',
        status: 'available',
        objective: '验证快慢均线窗口对收益、回撤和交易次数的敏感性。',
        grid: [
          { key: 'fast_window', values: [10, 20, 30], unit: '日' },
          { key: 'slow_window', values: [50, 60, 90], unit: '日' },
          { key: 'fee_bps', values: [3, 5, 10], unit: 'bps' },
        ],
        metrics: ['总收益', '最大回撤', '交易次数', '胜率'],
        guardrails: ['fast_window 必须小于 slow_window', '最大回撤必须展示', '费用变化必须纳入对比'],
        sampleSize: 27,
      },
    ],
    versions: [
      {
        version: 'v1.0',
        status: 'active',
        updatedAt: '2026-05-27T00:00:00.000Z',
        changes: ['接入本地均线突破回测端点', '固化 20/60 日均线和 5bps 费用口径'],
        parameterSnapshot: { fast_window: 20, slow_window: 60, fee_bps: 5 },
      },
      {
        version: 'v0.9',
        status: 'archived',
        updatedAt: '2026-05-14T00:00:00.000Z',
        changes: ['仅保留策略研究说明，尚未绑定回测端点'],
        parameterSnapshot: { fast_window: 20, slow_window: 60 },
      },
    ],
    backtestArchives: [
      {
        id: 'ma-crossover-510300-baseline',
        title: '510300 基准回测口径',
        status: 'available',
        symbol: '510300',
        period: '近 250 个交易日',
        metrics: {
          totalReturnPct: 0,
          maxDrawdownPct: 0,
          winRatePct: 0,
          tradeCount: 0,
        },
        source: 'GET /api/v1/backtests/ma-crossover/{symbol}',
        limitations: ['具体收益指标以生成工作空间内最新回测结果为准。', '归档口径用于记录参数和报告入口，不替代实时回测。'],
      },
    ],
    riskControls: ['单标的全仓/空仓', '不加杠杆', '必须展示最大回撤', '必须说明滑点和停牌未建模'],
    evaluationMetrics: ['总收益', '最大回撤', '胜率', '交易次数', '样本区间'],
    limitations: ['当前只覆盖单标的日线级回测。', '暂未建模滑点、停牌、分红再投资和冲击成本。'],
    promptSeed: '用最近两年的 20/60 日均线突破规则回测 510300，展示净值、回撤、胜率、交易明细和限制说明。',
  },
  {
    id: 'trend-volume-confirmation',
    name: '趋势放量确认策略',
    family: '趋势跟随',
    status: 'research',
    capabilityId: 'strategy_research',
    description: '在均线趋势基础上加入成交量过滤，用于研究突破信号的质量。',
    defaultSymbols: ['宁德时代', '创业板指'],
    timeframe: '日线 · 近 120 至 250 个交易日',
    dataDependencies: [
      'GET /api/v1/symbols/resolve',
      'GET /api/v1/quotes/history/{symbol}',
      'GET /api/v1/indicators/technical/{symbol}',
    ],
    parameterSchema: [
      { key: 'trend_window', label: '趋势窗口', value: 20, unit: '日', description: '判断趋势突破的均线周期。' },
      { key: 'volume_ratio', label: '放量倍数', value: 1.3, description: '相对过去成交量均值的过滤阈值。' },
      { key: 'stop_loss', label: '失效阈值', value: 8, unit: '%', description: '研究阶段建议纳入的最大单笔容忍亏损。' },
    ],
    parameterScans: [
      {
        id: 'trend-volume-grid',
        name: '趋势与放量阈值扫描',
        status: 'planned',
        objective: '比较趋势窗口和放量倍数对信号密度、突破后收益和回撤的影响。',
        grid: [
          { key: 'trend_window', values: [10, 20, 30], unit: '日' },
          { key: 'volume_ratio', values: [1.2, 1.3, 1.5] },
          { key: 'stop_loss', values: [6, 8, 10], unit: '%' },
        ],
        metrics: ['信号密度', '突破后区间收益', '最大回撤'],
        guardrails: ['未正式回测前不得展示收益承诺', '必须列出信号不足样本'],
        sampleSize: 27,
      },
    ],
    versions: [
      {
        version: 'v0.2',
        status: 'draft',
        updatedAt: '2026-05-27T00:00:00.000Z',
        changes: ['加入成交量过滤参数', '补充失效阈值和待验证指标'],
        parameterSnapshot: { trend_window: 20, volume_ratio: 1.3, stop_loss: 8 },
      },
    ],
    backtestArchives: [
      {
        id: 'trend-volume-research-plan',
        title: '趋势放量研究计划',
        status: 'pending',
        symbol: '创业板指',
        period: '近 120 至 250 个交易日',
        metrics: {},
        source: '待接入参数扫描执行器',
        limitations: ['当前为研究计划归档，尚无正式回测结果。'],
      },
    ],
    riskControls: ['先定义信号再讨论收益', '未回测前只展示研究假设', '必须列出失效条件'],
    evaluationMetrics: ['突破后区间收益', '回撤', '信号密度', '成交量确认比例'],
    limitations: ['当前尚未接入参数扫描。', '需要后续补充交易执行和风控模拟。'],
    promptSeed: '研究一个基于 20 日均线突破和成交量放大确认的趋势策略，先输出信号规则、样本口径、待验证清单和风险假设。',
  },
  {
    id: 'portfolio-risk-rebalance',
    name: '组合风险再平衡策略',
    family: '组合风控',
    status: 'planned',
    capabilityId: 'portfolio_risk',
    description: '围绕持仓集中度、波动、回撤和流动性生成调仓约束与再平衡计划。',
    defaultSymbols: ['贵州茅台', '招商银行', '510300'],
    timeframe: '日线 · 近 120 个交易日',
    dataDependencies: [
      'GET /api/v1/symbols/resolve',
      'GET /api/v1/quotes/realtime/{symbol}',
      'GET /api/v1/quotes/history/{symbol}',
      'GET /api/v1/indicators/technical/{symbol}',
    ],
    parameterSchema: [
      { key: 'max_weight', label: '单标的权重上限', value: 35, unit: '%', description: '避免组合过度集中。' },
      { key: 'rebalance_band', label: '再平衡偏离带', value: 5, unit: '%', description: '偏离目标权重后的触发阈值。' },
      { key: 'cash_buffer', label: '现金缓冲', value: 10, unit: '%', description: '保留流动性和回撤缓冲。' },
    ],
    parameterScans: [
      {
        id: 'rebalance-risk-grid',
        name: '再平衡风险阈值扫描',
        status: 'blocked',
        objective: '比较仓位上限、再平衡偏离带和现金缓冲对组合回撤和换手的影响。',
        grid: [
          { key: 'max_weight', values: [25, 35, 45], unit: '%' },
          { key: 'rebalance_band', values: [3, 5, 8], unit: '%' },
          { key: 'cash_buffer', values: [5, 10, 15], unit: '%' },
        ],
        metrics: ['集中度', '组合回撤', '换手率', '现金占用'],
        guardrails: ['需要组合收益序列和相关性计算能力', '不得输出即时调仓指令'],
        sampleSize: 27,
      },
    ],
    versions: [
      {
        version: 'v0.1',
        status: 'draft',
        updatedAt: '2026-05-27T00:00:00.000Z',
        changes: ['定义组合再平衡参数口径', '等待组合相关性和 VaR 能力接入'],
        parameterSnapshot: { max_weight: 35, rebalance_band: 5, cash_buffer: 10 },
      },
    ],
    backtestArchives: [
      {
        id: 'portfolio-risk-placeholder',
        title: '组合风险归档占位',
        status: 'missing',
        symbol: '组合',
        period: '近 120 个交易日',
        metrics: {},
        source: '待接入组合回测执行器',
        limitations: ['组合收益、换手和相关性计算尚未正式归档。'],
      },
    ],
    riskControls: ['不得直接给出交易指令', '必须标注用户输入和行情接口字段', '必须说明缺失成本和税费假设'],
    evaluationMetrics: ['集中度', '区间波动', '最大回撤', '流动性约束', '调仓优先级'],
    limitations: ['组合相关性和 VaR 仍在增强中。', '当前以风险约束和调仓计划为主。'],
    promptSeed: '分析一个贵州茅台、招商银行、510300 的组合风险，输出集中度、回撤、流动性和再平衡约束。',
  },
];

function readinessFor(template: StrategyTemplate): StrategyCatalogItem['readiness'] {
  if (template.status === 'ready') {
    return {
      label: '可回测',
      score: 92,
      riskLevel: 'medium',
      summary: '已接入本地回测端点，可生成可复现参数、净值、回撤和交易明细。',
    };
  }
  if (template.status === 'research') {
    return {
      label: '研究中',
      score: 68,
      riskLevel: 'medium',
      summary: '可生成策略研究工作空间，但收益验证前必须展示假设和待验证项。',
    };
  }
  return {
    label: '规划中',
    score: 45,
    riskLevel: 'high',
    summary: '适合沉淀策略口径和风控约束，完整自动化执行仍需补齐。',
  };
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function writeJsonFile(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function listScanRuns(): Promise<StrategyScanRun[]> {
  try {
    const entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
    const runs = await Promise.all(
      entries
        .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
        .map(entry => readJsonFile<StrategyScanRun>(path.join(DATA_DIR, entry.name)))
    );
    return runs
      .filter((run): run is StrategyScanRun => Boolean(run?.id && run?.templateId && run?.scanId))
      .sort((a, b) => b.completedAt.localeCompare(a.completedAt));
  } catch {
    return [];
  }
}

function scanRunPath(runId: string) {
  return path.join(DATA_DIR, `${runId}.json`);
}

function findTemplate(templateId: string) {
  return STRATEGY_TEMPLATES.find(template => template.id === templateId) ?? null;
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

async function fetchBacktest(params: {
  symbol: string;
  parameters: Record<string, string | number>;
}): Promise<Record<string, unknown>> {
  const query = new URLSearchParams({
    fast_window: String(params.parameters.fast_window ?? 20),
    slow_window: String(params.parameters.slow_window ?? 60),
    fee_bps: String(params.parameters.fee_bps ?? 5),
    period: 'daily',
    adjustment: 'qfq',
    limit: '250',
  });
  const response = await fetch(
    `${MARKET_API_BASE_URL}/api/v1/backtests/ma-crossover/${encodeURIComponent(params.symbol)}?${query.toString()}`,
    { cache: 'no-store' }
  );
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`market API ${response.status}: ${body.slice(0, 180)}`);
  }
  return response.json() as Promise<Record<string, unknown>>;
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
    capabilityId: project.quantCapabilityId ?? null,
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
  const projects = serializeProjects(await getAllProjects());
  const scanRuns = await listScanRuns();
  const strategyWorkspaces = projects
    .filter(project => isStrategyCapability(project.quantCapabilityId))
    .map(toWorkspaceRef);

  const templates = STRATEGY_TEMPLATES.map((template): StrategyCatalogItem => ({
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
    },
    templates,
    workspaces: strategyWorkspaces,
    scanRuns,
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
    await writeJsonFile(scanRunPath(run.id), run);
    return run;
  }

  for (const [index, parameters] of combinations.entries()) {
    const id = `${scan.id}-${index + 1}`;
    if (template.id === 'ma-crossover-single-asset' && !isValidMaCrossoverParams(parameters)) {
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
      const backtest = await fetchBacktest({ symbol, parameters });
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
    source: `${MARKET_API_BASE_URL}/api/v1/backtests/ma-crossover/{symbol}`,
    results,
  };
  await writeJsonFile(scanRunPath(run.id), run);
  return run;
}
