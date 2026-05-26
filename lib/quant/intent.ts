export type ClarificationMissingField =
  | 'target'
  | 'analysis_goal'
  | 'comparison_universe'
  | 'investment_constraints';

export interface QuantIntentClarification {
  required: boolean;
  reason: string;
  missing: ClarificationMissingField[];
  questions: string[];
  confidence: number;
  defaults?: string[];
}

interface AssessQuantIntentParams {
  instruction: string;
  capabilityId?: string | null;
  symbols?: string[];
  timeRange?: string | null;
  hasImageAttachments?: boolean;
}

interface PreviousClarificationPlan {
  runId: string;
  status?: string;
  capabilityId?: string | null;
  executionCapabilityId?: string | null;
  question?: string | null;
  clarification?: QuantIntentClarification;
}

export interface QuantClarificationContinuation {
  previousRunId: string;
  originalQuestion: string;
  userResponse: string;
  resolvedInstruction: string;
  displayInstruction: string;
  missing: ClarificationMissingField[];
}

const SYMBOL_CODE_PATTERN = /\b(?:6|0|3|5)\d{5}\b/g;

const KNOWN_SYMBOL_KEYWORDS: Array<{ keyword: string; symbol: string }> = [
  { keyword: '贵州茅台', symbol: '600519' },
  { keyword: '茅台', symbol: '600519' },
  { keyword: '宁德时代', symbol: '300750' },
  { keyword: '平安银行', symbol: '000001' },
  { keyword: '招商银行', symbol: '600036' },
  { keyword: '通富微电', symbol: '002156' },
  { keyword: '杭钢股份', symbol: '600126' },
  { keyword: '京沪高铁', symbol: '601816' },
  { keyword: '三七互娱', symbol: '002555' },
  { keyword: '中国黄金', symbol: '600916' },
  { keyword: '完美世界', symbol: '002624' },
  { keyword: '沪深300', symbol: '000300' },
  { keyword: '沪深 300', symbol: '000300' },
  { keyword: '创业板指', symbol: '399006' },
  { keyword: '创业板指数', symbol: '399006' },
  { keyword: '中证500', symbol: '000905' },
  { keyword: '中证 500', symbol: '000905' },
  { keyword: '科创50', symbol: '000688' },
  { keyword: '科创 50', symbol: '000688' },
  { keyword: '沪深300ETF', symbol: '510300' },
  { keyword: '沪深300 ETF', symbol: '510300' },
  { keyword: '300ETF', symbol: '510300' },
];

const GENERIC_TARGET_WORDS = [
  '一个',
  '一下',
  '这个',
  '那个',
  '某个',
  '股票',
  '个股',
  '标的',
  '证券',
  '公司',
  '资产',
  '行业',
  '板块',
  '市场',
  '项目',
  '它',
  '他们',
  '有',
  '没有',
  '推荐',
  '买入',
  '卖出',
  '补充',
  '哪个',
  '哪只',
  '谁更',
  '更好',
  '更强',
  '更弱',
  '对比',
  '比较',
  '分析',
  '查询',
  '查看',
  '看看',
  '看一下',
  '帮我',
  '帮忙',
  '可视化',
  '看板',
  '页面',
  '生成',
];

const FINANCIAL_KEYWORD_PATTERN =
  /股票|个股|A股|港股|美股|证券|标的|行情|走势|K\s*线|技术指标|财务|基本面|公告|指数|ETF|基金|量化|回测|策略|风控|风险|仓位|涨跌|价格|大盘|板块|行业|买入|卖出|持有|推荐|估值/i;

const GOAL_KEYWORD_PATTERN =
  /行情|走势|K\s*线|技术|财务|基本面|公告|回测|策略|风险|估值|对比|比较|诊断|看板|可视化|价格|成交量|指标|收益|回撤|波动|分析|怎么样|如何|怎么/i;

const BROAD_MARKET_TARGET_PATTERN =
  /大盘|全市场|A股|港股|美股|沪深|创业板|科创|中证|指数|ETF|基金|行业|板块|市场/i;

const COMPARISON_PATTERN = /对比|比较|相比|相对|哪个|哪只|谁更|强弱|VS|vs|versus/i;
const RECOMMENDATION_PATTERN = /推荐|买什么|买入|卖出|持有|能不能买|能买吗|值得买吗|可以买|要不要/i;
const INVESTMENT_CONSTRAINT_PATTERN =
  /短线|中线|长线|日内|波段|价值|成长|稳健|激进|保守|风险|回撤|仓位|周期|一周|一个月|三个月|半年|一年|预算|资金|偏好|低风险|高风险|A股|港股|美股|ETF|指数/i;
const IMAGE_CONTEXT_TARGET_PATTERN =
  /图片|截图|持仓|账户|仓位|组合|调仓|证券|交易|盈亏|成本|可用|现金|总资产|市值/i;

function normalizeInstruction(instruction: string): string {
  return instruction.replace(/\s+/g, ' ').trim();
}

function cleanTargetCandidate(value: string): string | null {
  let candidate = value
    .replace(/\s+/g, '')
    .replace(/^(请|麻烦|帮我|帮忙|补充|信息|分析|查询|查看|看看|看一下|研究|诊断|评估|生成|做一个|做下|比较|对比|一下)+/, '')
    .replace(/(股票|个股|股份|公司)?(最近|近期|近|今天|这段时间|的|行情|走势|K线|K线图|成交量|技术指标|技术|指标|财务|基本面|公告|怎么样|如何|怎么|可视化|看板|页面).*$/, '')
    .replace(/^(?:A股|港股|美股)/, '')
    .trim();

  if (candidate.endsWith('板块')) {
    candidate = candidate.slice(0, -2);
  }

  if (candidate.length < 2 || candidate.length > 12) {
    return null;
  }

  if (GENERIC_TARGET_WORDS.some((word) => candidate === word || candidate.includes(word))) {
    return null;
  }

  return candidate;
}

export function extractQuantTargetCandidates(instruction: string): string[] {
  const normalized = normalizeInstruction(instruction).replace(SYMBOL_CODE_PATTERN, ' ');
  const parts = normalized.split(/[，。！？?；;、,：:\n\r]|(?:和)|(?:与)|(?:及)|(?:以及)|(?:VS)|(?:vs)|(?:对比)|(?:比较)/);
  const lookaheadMatches =
    normalized.match(/[\u4e00-\u9fffA-Za-z]{2,14}(?=(?:最近|近期|近|今天|股票|个股|股份|行情|走势|K\s*线|成交量|技术指标|财务|基本面|公告|怎么样|如何|怎么))/g) ?? [];

  return Array.from(
    new Set(
      [...parts, ...lookaheadMatches]
        .map(cleanTargetCandidate)
        .filter((candidate): candidate is string => Boolean(candidate))
    )
  ).slice(0, 8);
}

function hasFinancialIntent(instruction: string, capabilityId?: string | null): boolean {
  if (FINANCIAL_KEYWORD_PATTERN.test(instruction)) {
    return true;
  }

  return Boolean(
    capabilityId &&
      [
        'stock_diagnosis',
        'technical_analysis',
        'fundamental_analysis',
        'asset_comparison',
        'sector_rotation',
        'strategy_research',
        'backtest_review',
        'portfolio_risk',
      ].includes(capabilityId)
  );
}

function uniqueMissing(values: ClarificationMissingField[]): ClarificationMissingField[] {
  return Array.from(new Set(values));
}

function buildQuestions(missing: ClarificationMissingField[], params: {
  isRecommendation: boolean;
  isComparison: boolean;
}): string[] {
  const questions: string[] = [];

  if (missing.includes('target')) {
    questions.push('你想分析哪个股票、指数或 ETF？请给名称或代码。');
  }

  if (missing.includes('comparison_universe')) {
    questions.push('你要对比哪些标的？请给至少两个名称或代码。');
  }

  if (missing.includes('investment_constraints')) {
    questions.push(
      params.isRecommendation
        ? '这是投资建议类问题，请补充投资周期、风险偏好和市场范围；我会基于数据做分析，不直接给确定性买卖结论。'
        : '请补充投资周期、风险偏好或约束条件，方便后续做风险口径一致的分析。'
    );
  }

  if (missing.includes('analysis_goal')) {
    questions.push(
      params.isComparison
        ? '你更希望比较行情趋势、基本面、估值、风险，还是综合评分？'
        : '你更关注行情技术、基本面、公告事件、回测，还是综合诊断？'
    );
  }

  return questions.slice(0, 3);
}

function buildContinuationSupplementLabel(missing: ClarificationMissingField[]): string {
  if (missing.includes('comparison_universe')) {
    return '补充对比标的';
  }
  if (missing.includes('target')) {
    return '补充标的';
  }
  if (missing.includes('investment_constraints')) {
    return '补充投资约束';
  }
  if (missing.includes('analysis_goal')) {
    return '补充分析方向';
  }
  return '补充信息';
}

export function assessQuantIntentForClarification(
  params: AssessQuantIntentParams
): QuantIntentClarification {
  const instruction = normalizeInstruction(params.instruction);
  const symbols = Array.isArray(params.symbols) ? params.symbols.filter(Boolean) : [];

  if (!instruction || !hasFinancialIntent(instruction, params.capabilityId)) {
    return {
      required: false,
      reason: '当前请求不是需要平台量化取数的金融分析任务。',
      missing: [],
      questions: [],
      confidence: 0.9,
    };
  }

  const codes = instruction.match(SYMBOL_CODE_PATTERN) ?? [];
  const knownTargetSymbols = Array.from(
    new Set(
      KNOWN_SYMBOL_KEYWORDS
        .filter((item) => instruction.includes(item.keyword))
        .map((item) => item.symbol)
    )
  );
  const targetCandidates = extractQuantTargetCandidates(instruction);
  const hasBroadMarketTarget = BROAD_MARKET_TARGET_PATTERN.test(instruction);
  const explicitTargetCount = new Set([...symbols, ...codes, ...knownTargetSymbols]).size;
  const targetCount = Math.max(explicitTargetCount, targetCandidates.length);
  const canInferTargetFromImage =
    params.hasImageAttachments === true &&
    (IMAGE_CONTEXT_TARGET_PATTERN.test(instruction) || params.capabilityId === 'portfolio_risk');
  const hasTarget = targetCount > 0 || hasBroadMarketTarget || canInferTargetFromImage;
  const isComparison = COMPARISON_PATTERN.test(instruction) || params.capabilityId === 'asset_comparison';
  const isRecommendation = RECOMMENDATION_PATTERN.test(instruction);
  const hasGoal = GOAL_KEYWORD_PATTERN.test(instruction);
  const hasInvestmentConstraints = INVESTMENT_CONSTRAINT_PATTERN.test(instruction);
  const missing: ClarificationMissingField[] = [];

  if (!hasTarget && (instruction.length <= 18 || isRecommendation || hasGoal)) {
    missing.push('target');
  }

  if (isComparison && targetCount < 2) {
    missing.push('comparison_universe');
  }

  if (isRecommendation && !hasInvestmentConstraints && !canInferTargetFromImage) {
    missing.push('investment_constraints');
  }

  if (hasTarget && !hasGoal && !isRecommendation) {
    missing.push('analysis_goal');
  }

  const unique = uniqueMissing(missing);
  const required = unique.length > 0;

  return {
    required,
    reason: required
      ? `任务缺少关键输入：${unique.join(', ')}。`
      : '任务意图足够明确，可进入取数、证据和看板生成流程。',
    missing: unique,
    questions: buildQuestions(unique, { isRecommendation, isComparison }),
    confidence: required ? 0.82 : 0.86,
    defaults: required
      ? undefined
      : [
          params.timeRange ? `使用时间范围：${params.timeRange}` : '未指定时间范围时默认使用最近 120 个交易日或最近报告期。',
          '未指定输出形式时默认生成可验证的量化看板。',
          ...(canInferTargetFromImage
            ? ['图片/截图任务会先识别附件中的标的、持仓、成本、现金和盈亏字段，再进入取数分析；识别不确定的字段必须在结果中标注。']
            : []),
        ],
  };
}

export function buildQuantClarificationMessage(clarification: QuantIntentClarification): string {
  const questions = clarification.questions.length
    ? clarification.questions
    : ['请补充你想分析的标的、时间范围和关注方向。'];

  return [
    '我需要先补充几个关键信息，再开始取数和生成看板：',
    '',
    ...questions.map((question, index) => `${index + 1}. ${question}`),
    '',
    '补充后我会先生成 run_plan，再获取真实数据、写入证据文件，最后生成可验证的可视化看板。',
  ].join('\n');
}

export function buildClarificationContinuation(params: {
  previousPlan: PreviousClarificationPlan | null | undefined;
  instruction: string;
  displayInstruction?: string | null;
  capabilityId?: string | null;
}): QuantClarificationContinuation | null {
  const previousPlan = params.previousPlan;
  const originalQuestion = normalizeInstruction(previousPlan?.question ?? '');
  const userResponse = normalizeInstruction(params.instruction);

  if (
    !previousPlan ||
    previousPlan.status !== 'needs_clarification' ||
    !previousPlan.clarification?.required ||
    !originalQuestion ||
    !userResponse
  ) {
    return null;
  }

  const capabilityId =
    params.capabilityId ?? previousPlan.executionCapabilityId ?? previousPlan.capabilityId ?? null;
  const displayResponse = normalizeInstruction(params.displayInstruction || params.instruction);
  const missing = previousPlan.clarification.missing;
  const supplementLabel = buildContinuationSupplementLabel(missing);
  const resolvedInstruction = [
    originalQuestion,
    `${supplementLabel}：${userResponse}`,
  ].join('\n');
  const combinedAssessment = assessQuantIntentForClarification({
    instruction: resolvedInstruction,
    capabilityId,
  });
  const stillMissing = new Set(combinedAssessment.missing);
  const allPreviousFieldsStillMissing =
    missing.length > 0 && missing.every((field) => stillMissing.has(field));

  if (combinedAssessment.required && allPreviousFieldsStillMissing && userResponse.length < 2) {
    return null;
  }

  return {
    previousRunId: previousPlan.runId,
    originalQuestion,
    userResponse,
    resolvedInstruction,
    displayInstruction: [
      '承接上一轮澄清',
      `原始问题：${originalQuestion}`,
      `补充信息：${displayResponse}`,
    ].join('\n'),
    missing,
  };
}
