import {
  extractExplicitSymbolCodes,
  inferKnownSymbols,
} from '@/lib/domains/finance/symbol-aliases';

export { stripConversationalSecurityReferenceSuffix } from '@/lib/domains/finance/query-rewrite';

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
  semanticFocusId?: string | null;
  broadUniverse?: boolean;
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

  const codes = extractExplicitSymbolCodes(instruction);
  const knownTargetSymbols = inferKnownSymbols(instruction);
  const hasBroadMarketTarget = BROAD_MARKET_TARGET_PATTERN.test(instruction);
  // Query Rewrite is the authority for executable unnamed universes. Do not
  // reconstruct this semantic decision from keywords in the clarification layer.
  const broadStockSelectionRequest = params.broadUniverse === true;
  const explicitTargetCount = new Set([...symbols, ...codes, ...knownTargetSymbols]).size;
  const targetCount = explicitTargetCount;
  const canInferTargetFromImage =
    params.hasImageAttachments === true &&
    (IMAGE_CONTEXT_TARGET_PATTERN.test(instruction) || params.capabilityId === 'portfolio_risk');
  const hasTarget = targetCount > 0 || hasBroadMarketTarget || broadStockSelectionRequest || canInferTargetFromImage;
  const isComparison = COMPARISON_PATTERN.test(instruction) || params.capabilityId === 'asset_comparison';
  const isRecommendation = RECOMMENDATION_PATTERN.test(instruction);
  const hasGoal =
    GOAL_KEYWORD_PATTERN.test(instruction) ||
    Boolean(params.semanticFocusId && params.semanticFocusId !== 'comprehensive');
  const hasInvestmentConstraints = INVESTMENT_CONSTRAINT_PATTERN.test(instruction);
  const missing: ClarificationMissingField[] = [];

  if (!hasTarget && !isComparison && (instruction.length <= 18 || isRecommendation || hasGoal)) {
    missing.push('target');
  }

  if (isComparison && targetCount < 2 && !broadStockSelectionRequest) {
    missing.push('comparison_universe');
  }

  if (isRecommendation && !hasInvestmentConstraints && !canInferTargetFromImage && !broadStockSelectionRequest) {
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
          ...(broadStockSelectionRequest
            ? [
                '未给具体标的时默认使用本地 A 股股票池做候选筛选。',
                '推荐/买入类问题默认按短线候选研究口径输出，不作为确定性交易指令。',
              ]
            : []),
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
  reset?: boolean;
}): QuantClarificationContinuation | null {
  if (params.reset) return null;
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

  const displayResponse = normalizeInstruction(params.displayInstruction || params.instruction);
  const missing = previousPlan.clarification.missing;
  const supplementLabel = buildContinuationSupplementLabel(missing);
  const resolvedInstruction = [
    originalQuestion,
    `${supplementLabel}：${userResponse}`,
  ].join('\n');
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
