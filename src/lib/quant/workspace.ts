import fs from 'fs/promises';
import path from 'path';
import {
  assessQuantIntentForClarification,
  QuantIntentClarification,
} from '@/lib/quant/intent';
import { buildQuantProjectSettings, getExecutionQuantCapability, getQuantCapability } from '@/lib/quant/capabilities';
import { inferKnownSymbols, inferQuantSymbolsFromText } from '@/lib/quant/symbol-aliases';
import {
  extractQuantQueryTargetCandidates,
  rewriteQuantQuery,
  type QuantQueryRewriteResult,
} from '@/lib/quant/query-rewrite';
import { serializeQuantVisualizationTemplate } from '@/lib/quant/visualization-templates';
import {
  getProjectLlmConfig,
  type ProjectLlmConfig,
} from '@/lib/config/llm';

type QuantManifest = {
  schemaVersion?: number;
  projectId?: string;
  projectName?: string;
  llm?: ProjectLlmConfig;
  quant?: {
    capabilityId?: string;
    agentType?: string;
    subAgentKey?: string;
    requiredSkills?: string[];
    dataEndpoints?: string[];
    expectedArtifacts?: string[];
    validationRules?: string[];
    executionCapabilityId?: string;
    status?: string;
    capabilitySource?: string;
  };
};

type RunPlanStatus = 'pending' | 'planned' | 'needs_clarification' | 'refused';

export interface QuantRunPlan {
  schemaVersion: 1;
  runId: string;
  status: RunPlanStatus;
  capabilityId: string;
  llm: ProjectLlmConfig;
  requestedCapabilityId?: string;
  executionCapabilityId?: string;
  question: string;
  queryRewrite?: QuantQueryRewriteResult;
  symbols: string[];
  timeRange: string | null;
  dataRequirements: string[];
  analysisSteps: string[];
  visualization: {
    required: boolean;
    templateId?: string;
    name?: string;
    scenario?: string;
    variantId?: string;
    variantName?: string;
    variantScenario?: string;
    layout?: string;
    density?: string;
    firstViewport?: string[];
    variantGuidance?: string[];
    matchReasons?: string[];
    panels: string[];
    painPoints?: string[];
    optionalPanels?: string[];
    dataSignals?: string[];
    finalDataContract?: string[];
  };
  clarification?: QuantIntentClarification;
  refusal?: {
    code: 'GUARANTEED_RETURN_REQUEST';
    message: string;
  };
  expectedArtifacts: string[];
  validationRules: string[];
  createdAt: string;
  updatedAt: string;
}

export interface QuantWorkspaceEvent {
  event_type: string;
  stage: string;
  status: 'pending' | 'success' | 'warning' | 'error';
  summary: string;
  run_id?: string;
  artifact_path?: string;
  created_at?: string;
}

const OPERATIONAL_INSTRUCTION_MARKERS = [
  '图片附件处理要求',
  '可见过程叙述要求',
  '执行过程要求',
  '平台执行要求',
  '生成过程要求',
  '系统附加要求',
  '工作区文件要求',
  '重要执行规则',
  '重要约束',
  'Visible process instructions',
  'Process instructions',
];

function quantDir(projectPath: string) {
  return path.join(projectPath, '.quantpilot');
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === 'object' ? (parsed as T) : null;
  } catch {
    return null;
  }
}

async function readManifest(projectPath: string): Promise<QuantManifest | null> {
  return readJsonFile<QuantManifest>(path.join(quantDir(projectPath), 'manifest.json'));
}

function stripOperationalInstructions(instruction: string): string {
  let cleaned = instruction.trim();
  for (const marker of OPERATIONAL_INSTRUCTION_MARKERS) {
    const markerIndex = cleaned.indexOf(marker);
    if (markerIndex > 0) {
      cleaned = cleaned.slice(0, markerIndex).trim();
    }
  }

  return cleaned
    .replace(/\n*Image #\d+ path: [^\n]+/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeForIntent(instruction: string): string {
  return stripOperationalInstructions(instruction).replace(/\s+/g, '');
}

function inferSymbols(instruction: string): string[] {
  return inferQuantSymbolsFromText(instruction);
}

function inferTimeRange(instruction: string): string | null {
  const normalized = instruction.replace(/\s+/g, '');
  const dayMatch = normalized.match(/最近(\d+)(?:个)?(?:交易日|日|天)/);
  if (dayMatch?.[1]) return `最近 ${dayMatch[1]} 个交易日`;
  const yearMatch = normalized.match(/最近(\d+)?年/);
  if (yearMatch) return yearMatch[1] ? `最近 ${yearMatch[1]} 年` : '最近 1 年';
  const quarterMatch = normalized.match(/最近(\d+)?(?:个)?(?:报告期|季度)/);
  if (quarterMatch) return quarterMatch[1] ? `最近 ${quarterMatch[1]} 个报告期` : '最近多个报告期';
  return null;
}

function inferDefaultTimeRange(capabilityId: string): string | null {
  if (capabilityId === 'fundamental_analysis') {
    return '最近报告期';
  }

  if (
    [
      'stock_diagnosis',
      'technical_analysis',
      'asset_comparison',
      'sector_rotation',
      'strategy_research',
      'backtest_review',
    ].includes(capabilityId)
  ) {
    return '最近 120 个交易日';
  }

  return null;
}

function mergeQueryRewriteClarification(params: {
  base: QuantIntentClarification;
  queryRewrite: QuantQueryRewriteResult;
  capabilityId: string;
  hasImageAttachments?: boolean;
}): QuantIntentClarification {
  if (params.hasImageAttachments || params.queryRewrite.broadUniverse) return params.base;

  const actionableIssues = params.queryRewrite.issues.filter(
    (issue) => issue.code === 'TARGET_NOT_FOUND' || issue.code === 'TARGET_AMBIGUOUS',
  );
  if (actionableIssues.length === 0) return params.base;

  const comparisonAffected =
    params.capabilityId === 'asset_comparison' ||
    params.capabilityId === 'portfolio_risk' ||
    params.queryRewrite.analysisFocus.id === 'comparison' ||
    params.queryRewrite.resolvedSymbols.length > 0;
  const missing = Array.from(new Set([
    ...params.base.missing,
    comparisonAffected ? 'comparison_universe' as const : 'target' as const,
  ]));
  const rewriteQuestions = actionableIssues.map((issue) => {
    if (issue.code === 'TARGET_AMBIGUOUS') {
      const ambiguity = params.queryRewrite.ambiguousTargets.find(
        (item) => item.query === issue.target,
      );
      const candidates = ambiguity?.candidates
        .map((item) => `${item.name}（${item.symbol}${item.market ? `.${item.market}` : ''}）`)
        .join('、');
      return candidates
        ? `“${issue.target}”对应多个证券：${candidates}。你想分析哪一个？`
        : `“${issue.target}”对应多个证券，请补充市场或代码。`;
    }
    return `没有找到“${issue.target}”对应的证券，请确认名称或提供六位代码。`;
  });

  return {
    required: true,
    reason: actionableIssues.map((issue) => issue.message).join('；'),
    missing,
    questions: Array.from(new Set([...rewriteQuestions, ...params.base.questions])).slice(0, 3),
    confidence: Math.min(params.base.confidence, params.queryRewrite.confidence),
    defaults: params.base.defaults,
  };
}

function shouldUseAssetComparison(instruction: string) {
  const normalized = normalizeForIntent(instruction);
  const inferredSymbols = inferSymbols(instruction);
  const symbolCount = inferredSymbols.length;
  const broadStockScreenerIntent = isBroadStockScreenerInstruction(instruction);
  const comparisonIntent =
    /对比|比较|多只|多支|多股票|多标的|横向|矩阵|排名|排序|推荐顺序|观察池|哪(?:个|些|几只)|谁更|更强|更稳健|候选|选股|资产池|股票池/.test(
      normalized
    );
  const multiNamedStocks =
    /、|，|,|和|与|及/.test(normalized) &&
    inferKnownSymbols(instruction).length >= 2;

  return symbolCount >= 2 || comparisonIntent || multiNamedStocks || broadStockScreenerIntent;
}

function isBroadStockScreenerInstruction(instruction: string): boolean {
  const normalized = instruction.replace(/\s+/g, '');
  if (!/(?:股票|个股|A股|全A|股票池)/.test(normalized)) {
    return false;
  }
  return /全A|A股股票池|股票池|选股|筛选|候选|短线候选|次日|明日|明天|今日|今天|要买|买股|买入策略|短线|推荐\d*(?:只|个)?(?:股票|个股)|(?:股票|个股).{0,12}推荐|推荐.{0,18}(?:股票|个股)/.test(normalized);
}

function hasExplicitPortfolioIntent(instruction: string, hasImageAttachments?: boolean): boolean {
  const normalized = normalizeForIntent(instruction);
  const textSignals =
    /持仓|仓位|组合持仓|我的组合|账户组合|持仓组合|调仓|盈亏|成本价|持仓成本|买入成本|成本线|成本偏离|账户|证券账户|总资产|可用资金|可用现金|浮动盈亏|持仓截图|截图持仓|账户截图|交易截图|交割单/.test(
      normalized
    );
  const imageSignals =
    hasImageAttachments === true && /持仓|仓位|账户|证券|交易|盈亏|成本价|持仓成本|买入成本|现金|总资产|调仓/.test(normalized);

  return textSignals || imageSignals;
}

function uniqueSymbolList(symbols: unknown): string[] {
  if (!Array.isArray(symbols)) {
    return [];
  }
  return Array.from(
    new Set(
      symbols
        .map((symbol) => (typeof symbol === 'string' ? symbol.trim() : ''))
        .filter((symbol) => /^(?:6|0|3|5)\d{5}$/.test(symbol))
    )
  );
}

function isDashboardRevisionInstruction(instruction: string): boolean {
  const normalized = normalizeForIntent(instruction);
  if (!normalized) {
    return false;
  }

  const revisionSignals =
    /这个|当前|现在|刚才|上一轮|上一版|原页面|结果|看板|页面|图表|方向对|不够贴题|重构|优化|调整|修改|改成|删除|新增|补充|保留|替换|不要|必须|移动端|横向溢出|折线图|热力图|矩阵/.test(
      normalized
    );
  const commandSignals =
    /重构|优化|调整|修改|改成|删除|新增|补充|保留|替换|不要|必须|方向对|不够贴题|移动端|横向溢出|折线图|热力图|矩阵/.test(
      normalized
    );

  return revisionSignals && commandSignals;
}

function hasExplicitVariantReselection(instruction: string): boolean {
  return /相关性|热力图|分散|流动性|成交额|换手|强弱|累计收益|收益曲线|净值曲线|折线图|排名|排序|候选|选股/.test(
    normalizeForIntent(instruction)
  );
}

function shouldInheritPreviousPlanContext(params: {
  instruction: string;
  explicitSymbols: string[];
  previousPlan?: QuantRunPlan | null;
  hasImageAttachments?: boolean;
}): boolean {
  const previousSymbols = uniqueSymbolList(params.previousPlan?.symbols);
  if (!params.previousPlan || params.previousPlan.status === 'needs_clarification') {
    return false;
  }
  if (params.explicitSymbols.length > 0 || previousSymbols.length === 0) {
    return false;
  }
  if (!isDashboardRevisionInstruction(params.instruction)) {
    return false;
  }
  if (hasExplicitPortfolioIntent(params.instruction, params.hasImageAttachments) && params.previousPlan.capabilityId !== 'portfolio_risk') {
    return false;
  }
  return true;
}

function inferCapabilityId(params: {
  requestedCapabilityId?: string | null;
  requestedCapabilitySource?: string | null;
  manifestCapabilityId?: string | null;
  manifestCapabilitySource?: string | null;
  instruction: string;
  hasImageAttachments?: boolean;
  queryRewrite: QuantQueryRewriteResult;
  resolvedSymbolCount: number;
}) {
  if (params.requestedCapabilityId && params.requestedCapabilitySource === 'manual') {
    return params.requestedCapabilityId;
  }

  if (!params.requestedCapabilityId && params.manifestCapabilityId && params.manifestCapabilitySource === 'manual') {
    return params.manifestCapabilityId;
  }

  if (hasExplicitPortfolioIntent(params.instruction, params.hasImageAttachments)) {
    return 'portfolio_risk';
  }

  if (params.queryRewrite.broadUniverse) {
    return 'asset_comparison';
  }

  if (
    params.queryRewrite.analysisFocus.id === 'comparison' &&
    params.resolvedSymbolCount >= 2
  ) {
    return 'asset_comparison';
  }

  if (params.requestedCapabilityId) {
    return params.requestedCapabilityId;
  }

  if (params.queryRewrite.capabilityHint) {
    return params.queryRewrite.capabilityHint;
  }

  if (
    params.resolvedSymbolCount >= 2 &&
    shouldUseAssetComparison(params.instruction)
  ) {
    return 'asset_comparison';
  }

  return params.manifestCapabilityId;
}

function buildAnalysisSteps(capabilityId: string, hasSymbols: boolean, instruction: string): string[] {
  const common = [
    hasSymbols ? '确认输入标的并标准化证券代码。' : '使用 quant-symbol-resolver 解析用户问题中的证券名称或代码。',
    '查询 quant-data-registry，确认本地数据能力可用。',
  ];

  if (capabilityId === 'asset_comparison') {
    if (!hasSymbols && isBroadStockScreenerInstruction(instruction)) {
      return [
        '调用本地 /api/v1/research/screeners/a-share/short-term-candidates 获取全 A 短线候选。',
        '把候选结果中的前排股票作为本次分析 symbols，并记录候选评分、信号和数据缺口。',
        '逐只获取实时行情、历史 K 线和可用的财务/指标数据。',
        '标准化收益、波动、回撤、成交额、换手率和相对强弱口径。',
        '检查每个标的数据质量并写入 evidence/sources.json 与 evidence/data_quality.json。',
        '生成包含 screener、assets[]、comparison 和 selectionRanking 的最终数据文件。',
        '生成选股排名看板并验证候选覆盖率、排名依据、图表和数据信源渠道。',
      ];
    }
    return [
      ...common,
      '逐只获取实时行情、历史 K 线和可用的财务/指标数据。',
      '标准化收益、波动、回撤、成交量和相对强弱口径。',
      '检查每个标的数据质量并写入 evidence/sources.json 与 evidence/data_quality.json。',
      '生成包含 assets[] 和 comparison 的最终数据文件。',
      '生成多标的对比看板并验证标的覆盖率、图表和数据信源渠道。',
    ];
  }

  if (capabilityId === 'technical_analysis') {
    return [
      ...common,
      '获取实时行情和历史 K 线。',
      '计算区间涨跌、均线、波动率、最大回撤等技术指标。',
      '检查数据质量并写入 evidence/sources.json 与 evidence/data_quality.json。',
      '生成技术分析数据文件和可视化页面。',
      '验证页面、图表和数据信源渠道。',
    ];
  }

  if (capabilityId === 'fundamental_analysis') {
    return [
      ...common,
      '获取实时行情、财务摘要和公告事件。',
      '分析营收、利润、ROE、毛利率、现金流质量和增长变化。',
      '检查数据质量并写入 evidence/sources.json 与 evidence/data_quality.json。',
      '生成基本面分析数据文件和可视化页面。',
      '验证页面、报告期、数据信源渠道和缺失字段说明。',
    ];
  }

  if (capabilityId === 'backtest_review') {
    return [
      ...common,
      '获取实时行情、历史 K 线和技术指标。',
      '调用后端均线突破回测，生成净值曲线、回撤和交易明细。',
      '检查回测样本、参数、费用和限制，并写入 evidence/sources.json 与 evidence/data_quality.json。',
      '生成回测复盘数据文件和可视化页面。',
      '验证页面、净值曲线、交易明细和数据信源渠道。',
    ];
  }

  if (capabilityId === 'portfolio_risk') {
    return [
      ...common,
      '把用户持仓、截图或口述信息整理为持仓结构，标注数量、成本、现价、现金和缺失字段。',
      '逐只获取实时行情和历史 K 线，计算收益、波动、回撤、流动性和相关性。',
      '检查每个持仓的数据质量并写入 evidence/sources.json 与 evidence/data_quality.json。',
      '生成包含 portfolio、holdings、assets[]、comparison、correlation 和 liquidity 的最终数据文件。',
      '生成持仓分析看板并验证持仓矩阵、仓位集中度、风险提示和调仓优先级。',
    ];
  }

  return [
    ...common,
    '获取实时行情、历史 K 线、财务摘要和公告事件。',
    '综合分析价格趋势、量价、财务质量和事件风险。',
    '检查数据质量并写入 evidence/sources.json 与 evidence/data_quality.json。',
    '生成个股诊断数据文件和可视化页面。',
    '验证页面、图表、数据信源渠道和更新时间。',
  ];
}

function plannedCapabilityNotice(requestedCapabilityId: string, executionCapabilityId: string): string[] {
  if (requestedCapabilityId === executionCapabilityId || requestedCapabilityId === 'asset_comparison') {
    return [];
  }
  return [
    `用户选择的能力为 ${requestedCapabilityId}，当前先映射到已验证执行链路 ${executionCapabilityId}。`,
    '页面必须显式说明尚未完全接入的分析维度，避免把计划能力包装成已完成结果。',
  ];
}

export async function ensureQuantWorkspace(projectPath: string) {
  await Promise.all([
    fs.mkdir(quantDir(projectPath), { recursive: true }),
    fs.mkdir(path.join(projectPath, 'data_file', 'raw'), { recursive: true }),
    fs.mkdir(path.join(projectPath, 'data_file', 'intermediate'), { recursive: true }),
    fs.mkdir(path.join(projectPath, 'data_file', 'final'), { recursive: true }),
    fs.mkdir(path.join(projectPath, 'evidence'), { recursive: true }),
    fs.mkdir(path.join(projectPath, 'scripts'), { recursive: true }),
    fs.mkdir(path.join(projectPath, 'dashboard'), { recursive: true }),
  ]);
}

export async function appendQuantWorkspaceEvent(projectPath: string, event: QuantWorkspaceEvent) {
  await ensureQuantWorkspace(projectPath);
  const line = {
    ...event,
    created_at: event.created_at ?? new Date().toISOString(),
  };
  await fs.appendFile(path.join(quantDir(projectPath), 'events.jsonl'), `${JSON.stringify(line)}\n`, 'utf8');
}

export async function readQuantRunPlan(projectPath: string): Promise<QuantRunPlan | null> {
  return readJsonFile<QuantRunPlan>(path.join(quantDir(projectPath), 'run_plan.json'));
}

export async function writeInitialRunPlan(params: {
  projectPath: string;
  instruction: string;
  requestId: string;
  capabilityId?: string | null;
  capabilitySource?: string | null;
  hasImageAttachments?: boolean;
  previousPlan?: QuantRunPlan | null;
  queryRewrite?: QuantQueryRewriteResult;
  enableLlmRewrite?: boolean;
  llmModel?: string | null;
}) {
  await ensureQuantWorkspace(params.projectPath);
  const manifest = await readManifest(params.projectPath);
  const manifestQuant = manifest?.quant;
  const planningInstruction = stripOperationalInstructions(params.instruction) || params.instruction.trim();
  const staticallyInferredSymbols = inferSymbols(planningInstruction);
  const extractedTargetCandidates = extractQuantQueryTargetCandidates(planningInstruction);
  const requiresDynamicSymbolResolution =
    extractedTargetCandidates.length > staticallyInferredSymbols.length;
  const queryRewrite = params.queryRewrite ?? await rewriteQuantQuery(planningInstruction, {
    requestedCapabilityId:
      params.capabilitySource === 'manual' ? params.capabilityId : null,
    resolveTargets: requiresDynamicSymbolResolution,
    allowLlm: params.enableLlmRewrite === true,
    requestedModel: params.llmModel,
  });
  const explicitSymbols = Array.from(new Set([
    ...queryRewrite.resolvedSymbols.map((item) => item.symbol),
    ...staticallyInferredSymbols,
  ]));
  const inheritPreviousPlan = shouldInheritPreviousPlanContext({
    instruction: planningInstruction,
    explicitSymbols,
    previousPlan: params.previousPlan,
    hasImageAttachments: params.hasImageAttachments,
  });
  const inheritedSymbols = inheritPreviousPlan ? uniqueSymbolList(params.previousPlan?.symbols) : [];
  const inheritedCapabilityId = inheritPreviousPlan ? params.previousPlan?.capabilityId : null;
  const inferredCapabilityId = inferCapabilityId({
    requestedCapabilityId: params.capabilityId ?? inheritedCapabilityId,
    requestedCapabilitySource: params.capabilityId ? params.capabilitySource : inheritedCapabilityId ? 'manual' : params.capabilitySource,
    manifestCapabilityId: manifestQuant?.capabilityId,
    manifestCapabilitySource: manifestQuant?.capabilitySource,
    instruction: planningInstruction,
    hasImageAttachments: params.hasImageAttachments,
    queryRewrite,
    resolvedSymbolCount: explicitSymbols.length,
  });
  const capability = getQuantCapability(inferredCapabilityId);
  const executionCapability = capability.id === 'asset_comparison'
    ? capability
    : getExecutionQuantCapability(capability.id);
  const quantSettings = buildQuantProjectSettings(capability.id);
  const now = new Date().toISOString();
  const llm = getProjectLlmConfig();
  const symbols = explicitSymbols.length > 0 ? explicitSymbols : inheritedSymbols;
  const requestedTimeRange =
    queryRewrite.timeRange?.label ??
    inferTimeRange(planningInstruction) ??
    (inheritPreviousPlan ? params.previousPlan?.timeRange ?? null : null);
  const baseClarification = assessQuantIntentForClarification({
    instruction: planningInstruction,
    capabilityId: capability.id,
    symbols,
    timeRange: requestedTimeRange,
    hasImageAttachments: params.hasImageAttachments,
    semanticFocusId: queryRewrite.analysisFocus.id,
    broadUniverse: queryRewrite.broadUniverse,
  });
  const clarification = mergeQueryRewriteClarification({
    base: baseClarification,
    queryRewrite,
    capabilityId: capability.id,
    hasImageAttachments: params.hasImageAttachments,
  });
  const refused = queryRewrite.safety.decision === 'refuse';
  const timeRange = clarification.required || refused
    ? requestedTimeRange
    : requestedTimeRange ?? inferDefaultTimeRange(capability.id);
  const shouldInheritManifest = !params.capabilityId || manifestQuant?.capabilityId === capability.id;
  const dataRequirements = Array.from(
    new Set([
      ...executionCapability.dataEndpoints,
      ...(shouldInheritManifest ? manifestQuant?.dataEndpoints ?? [] : []),
      ...(quantSettings.dataEndpoints ?? []),
    ])
  );
  const expectedArtifacts = Array.from(
    new Set([
      ...capability.expectedArtifacts,
      ...(shouldInheritManifest ? manifestQuant?.expectedArtifacts ?? [] : []),
      ...(quantSettings.expectedArtifacts ?? []),
    ])
  );
  const validationRules = Array.from(
    new Set([
      ...capability.validationRules,
      ...plannedCapabilityNotice(capability.id, executionCapability.id),
      ...(shouldInheritManifest ? manifestQuant?.validationRules ?? [] : []),
      ...(quantSettings.validationRules ?? []),
    ])
  );
  const visualizationTemplate = serializeQuantVisualizationTemplate(capability.id, {
    instruction: planningInstruction,
    // Only ticker strings are resolved at planning time. Name candidates are
    // hints for clarification, not resolved instruments, and must not be
    // reported as such in matchReasons.
    symbolCount: symbols.length > 0 ? symbols.length : undefined,
    requestedVariantId:
      inheritPreviousPlan && !hasExplicitVariantReselection(planningInstruction)
        ? params.previousPlan?.visualization?.variantId
        : null,
  });

  const plan: QuantRunPlan = {
    schemaVersion: 1,
    runId: params.requestId,
    status: refused
      ? 'refused'
      : clarification.required
        ? 'needs_clarification'
        : 'planned',
    capabilityId: capability.id,
    llm,
    requestedCapabilityId: capability.id,
    executionCapabilityId: executionCapability.id,
    question: planningInstruction,
    queryRewrite,
    symbols,
    timeRange,
    dataRequirements,
    analysisSteps: refused
      ? ['停止执行取数和生成任务，返回确定性安全说明。']
      : clarification.required
      ? [
          ...plannedCapabilityNotice(capability.id, executionCapability.id),
          '补充用户缺失的关键输入。',
          '确认标的、对比范围或投资约束后，再重新生成 planned 状态的执行计划。',
        ]
      : [
          ...plannedCapabilityNotice(capability.id, executionCapability.id),
          ...buildAnalysisSteps(capability.id, symbols.length > 0, planningInstruction),
        ],
    visualization: {
      required:
        !refused &&
        !clarification.required &&
        queryRewrite.outputIntent === 'dashboard',
      templateId: visualizationTemplate.templateId,
      name: visualizationTemplate.name,
      scenario: visualizationTemplate.scenario,
      variantId: visualizationTemplate.variantId,
      variantName: visualizationTemplate.variantName,
      variantScenario: visualizationTemplate.variantScenario,
      layout: visualizationTemplate.layout,
      density: visualizationTemplate.density,
      firstViewport: visualizationTemplate.firstViewport,
      variantGuidance: visualizationTemplate.variantGuidance,
      matchReasons: visualizationTemplate.matchReasons,
      panels: visualizationTemplate.requiredComponents,
      painPoints: visualizationTemplate.painPoints,
      optionalPanels: visualizationTemplate.optionalComponents,
      dataSignals: visualizationTemplate.dataSignals,
      finalDataContract: visualizationTemplate.finalDataContract,
    },
    clarification: !refused && clarification.required ? clarification : undefined,
    refusal: refused && queryRewrite.safety.code && queryRewrite.safety.message
      ? {
          code: queryRewrite.safety.code,
          message: queryRewrite.safety.message,
        }
      : undefined,
    expectedArtifacts: clarification.required || refused
      ? ['.quantpilot/run_plan.json', '.quantpilot/events.jsonl']
      : expectedArtifacts,
    validationRules,
    createdAt: now,
    updatedAt: now,
  };

  await fs.writeFile(
    path.join(quantDir(params.projectPath), 'run_plan.json'),
    `${JSON.stringify(plan, null, 2)}\n`,
    'utf8'
  );
  await fs.writeFile(
    path.join(quantDir(params.projectPath), 'query_rewrite.json'),
    `${JSON.stringify(queryRewrite, null, 2)}\n`,
    'utf8',
  );

  await appendQuantWorkspaceEvent(params.projectPath, {
    event_type: 'query_rewritten',
    stage: 'planning',
    status: queryRewrite.status === 'ready' || queryRewrite.status === 'refused'
      ? 'success'
      : 'warning',
    run_id: params.requestId,
    artifact_path: '.quantpilot/query_rewrite.json',
    summary: queryRewrite.status === 'refused'
      ? `问题改写完成，安全策略拒绝执行：${queryRewrite.safety.message}`
      : queryRewrite.status === 'ready'
        ? `已将用户问题改写为结构化查询，并解析 ${queryRewrite.resolvedSymbols.length} 个标的。`
        : `问题改写完成，仍有 ${queryRewrite.unresolvedTargets.length + queryRewrite.ambiguousTargets.length} 个标的需要确认。`,
    created_at: now,
  });

  await appendQuantWorkspaceEvent(params.projectPath, {
    event_type: refused
      ? 'intent_refused'
      : clarification.required
        ? 'intent_clarification_required'
        : 'run_planned',
    stage: 'planning',
    status: clarification.required || refused ? 'warning' : 'success',
    run_id: params.requestId,
    artifact_path: '.quantpilot/run_plan.json',
    summary: refused
      ? queryRewrite.safety.message ?? '任务已被安全策略拒绝。'
      : clarification.required
        ? `任务缺少关键输入，需要先向用户澄清：${clarification.questions.join('；')}`
        : `已生成${capability.name}计划，下一步将按计划解析标的、获取真实数据并生成可视化产物。`,
    created_at: now,
  });

  return plan;
}
