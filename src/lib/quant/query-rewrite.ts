import {
  extractExplicitSymbolCodes,
  matchKnownSymbolAliases,
  keepLongestDistinctTextCandidates,
} from '@/lib/quant/symbol-aliases';
import { getProjectLlmConfig } from '@/lib/config/llm';

export const QUANT_QUERY_REWRITE_SCHEMA_VERSION = 3 as const;

export type QuantQueryRewriteStatus =
  | 'ready'
  | 'partial'
  | 'needs_clarification'
  | 'refused';

export interface QuantQueryRewriteSafety {
  decision: 'allow' | 'refuse';
  code: 'GUARANTEED_RETURN_REQUEST' | null;
  message: string | null;
}

export type QuantQueryFocusId =
  | 'comprehensive'
  | 'technical'
  | 'fundamental'
  | 'events'
  | 'comparison'
  | 'strategy'
  | 'backtest'
  | 'portfolio_risk';

export interface QuantQueryTimeRange {
  label: string;
  value?: number;
  unit:
    | 'trading_day'
    | 'day'
    | 'week'
    | 'month'
    | 'quarter'
    | 'reporting_period'
    | 'year'
    | 'date_range';
  source: 'explicit';
}

export type QuantQueryRewriteLlmTrigger =
  | 'forced'
  | 'complex_semantics'
  | 'referential_language'
  | 'nonstandard_time_range'
  | 'no_target'
  | 'resolver_miss';

export type QuantQueryRewriteLlmStatus =
  | 'not_requested'
  | 'not_needed'
  | 'applied'
  | 'skipped_unconfigured'
  | 'invalid_output'
  | 'timed_out'
  | 'failed';

export interface QuantQueryRewriteExecution {
  strategy: 'deterministic' | 'hybrid_llm' | 'deterministic_fallback';
  deterministic: {
    targetCandidates: string[];
    timeRange: QuantQueryTimeRange | null;
    analysisFocus: QuantQueryFocus;
  };
  llm: {
    attempted: boolean;
    applied: boolean;
    trigger: QuantQueryRewriteLlmTrigger | null;
    status: QuantQueryRewriteLlmStatus;
    provider: string | null;
    model: string | null;
    durationMs: number | null;
    semanticConfidence: number | null;
    errorCode: string | null;
    usage: {
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
    } | null;
  };
}

export interface QuantQueryFocus {
  id: QuantQueryFocusId;
  label: string;
}

export interface QuantResolvedSymbol {
  query: string;
  symbol: string;
  name: string;
  market: string | null;
  assetType: string | null;
  secid: string | null;
  source: string | null;
  confidence: number;
}

export interface QuantAmbiguousTarget {
  query: string;
  candidates: QuantResolvedSymbol[];
}

export type QuantQueryRewriteIssueCode =
  | 'TARGET_NOT_FOUND'
  | 'TARGET_AMBIGUOUS'
  | 'SYMBOL_RESOLVER_UNAVAILABLE'
  | 'GUARANTEED_RETURN_REQUEST';

export interface QuantQueryRewriteIssue {
  code: QuantQueryRewriteIssueCode;
  message: string;
  target?: string;
  retryable: boolean;
}

export interface QuantQueryRewriteResult {
  schemaVersion: typeof QUANT_QUERY_REWRITE_SCHEMA_VERSION;
  originalQuery: string;
  normalizedQuery: string;
  rewrittenQuery: string;
  status: QuantQueryRewriteStatus;
  confidence: number;
  capabilityHint: string;
  targetCandidates: string[];
  resolvedSymbols: QuantResolvedSymbol[];
  unresolvedTargets: string[];
  ambiguousTargets: QuantAmbiguousTarget[];
  timeRange: QuantQueryTimeRange | null;
  analysisFocus: QuantQueryFocus;
  outputIntent: 'dashboard' | 'answer';
  broadUniverse: boolean;
  safety: QuantQueryRewriteSafety;
  issues: QuantQueryRewriteIssue[];
  execution: QuantQueryRewriteExecution;
}

type JsonRecord = Record<string, unknown>;

export type QuantSymbolResolver = (
  query: string,
  count: number,
) => Promise<unknown>;

export interface QuantQuerySemanticDraft {
  targetCandidates: string[];
  timeRange: QuantQueryTimeRange | null;
  analysisFocus: QuantQueryFocus;
  outputIntent: 'dashboard' | 'answer';
  broadUniverse: boolean;
}

export interface QuantQueryLlmSemantics {
  targetCandidates: string[];
  timeRange: Omit<QuantQueryTimeRange, 'source'> | null;
  analysisFocusId: QuantQueryFocusId;
  outputIntent: 'dashboard' | 'answer';
  broadUniverse: boolean;
  confidence: number;
}

export interface QuantQuerySemanticRewriteInput {
  originalQuery: string;
  normalizedQuery: string;
  deterministic: QuantQuerySemanticDraft;
  trigger: QuantQueryRewriteLlmTrigger;
  requestedModel?: string | null;
  signal: AbortSignal;
}

export type QuantQuerySemanticRewriteOutcome =
  | {
      ok: true;
      data: QuantQueryLlmSemantics;
      provider: string;
      model: string;
      usage?: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
      };
    }
  | {
      ok: false;
      code: string;
      provider?: string;
      model?: string;
      retryable: boolean;
    };

export type QuantQuerySemanticRewriter = (
  input: QuantQuerySemanticRewriteInput,
) => Promise<QuantQuerySemanticRewriteOutcome>;

export interface RewriteQuantQueryOptions {
  requestedCapabilityId?: string | null;
  resolver?: QuantSymbolResolver;
  resolveTargets?: boolean;
  maxTargets?: number;
  allowLlm?: boolean;
  llmMode?: 'off' | 'auto' | 'always';
  llmTimeoutMs?: number;
  requestedModel?: string | null;
  semanticRewriter?: QuantQuerySemanticRewriter;
}

const SYMBOL_CODE_PATTERN = /^(?:6|0|3|5)\d{5}$/;
const SHANGHAI_INDEX_SYMBOLS = new Set(['000300', '000905', '000688']);
const INDEX_SYMBOLS = new Set([...SHANGHAI_INDEX_SYMBOLS, '399006']);
const BROAD_UNIVERSE_PATTERN =
  /(?:全\s*A|全A|A股股票池|股票池|全市场|大盘|行业|板块|市场|候选池|选股|筛选)/i;
const COMPARISON_PATTERN = /(?:对比|比较|相比|相对|哪个|哪只|谁[^，。！？?；;]{0,8}更|VS|vs|versus)/i;
const COMPLEX_SEMANTICS_PATTERN =
  /(?:如果|假设|同时|分别|先.+再|除了|不仅|并且|而且|但是|前提|条件|筛选.+(?:且|并)|基于.+(?:同时|并|再)|相对.+(?:同时|并))/u;
const REFERENTIAL_LANGUAGE_PATTERN =
  /(?:它们?|这几只|那几只|前者|后者|上述|刚才|之前(?:那|这)?只|前面(?:那|这)?只)/u;
const NONSTANDARD_TIME_RANGE_PATTERN =
  /(?:去年|前年|上半年|下半年|年初至今|季初至今|月初至今|上市以来|成立以来|从.+(?:至今|到现在)|最近几个季度)/u;
const EXPLICIT_TIME_SIGNAL_PATTERN =
  /(?:今天|今日|今年|本年度|最近|近期|过去|近\s*\d|20\d{2}|去年|前年|上半年|下半年|年初至今|季初至今|月初至今|以来|报告期|季度|交易日|日|天|周|月|年)/u;
const BROAD_UNIVERSE_LLM_PATTERN =
  /(?:全\s*A|全A|A股股票池|股票池|全市场|候选池|选股|筛选|行业|板块|市场)/iu;
const GUARANTEED_RETURN_PATTERN =
  /(?:(?:一定|保证|确保|必然|百分之百|100%)\s*(?:能|会|可以)?\s*(?:涨|赚钱|盈利|涨停|翻倍)|(?:稳赚|包赚|必涨|必赚|涨停股|明天涨停))/iu;
const GUARANTEED_RETURN_REQUEST_PATTERN =
  /(?:买|推荐|选|哪只|哪个|股票|个股|标的|明天|次日|预测|告诉我)/iu;

const FOCUS_LABELS: Record<QuantQueryFocusId, string> = {
  comprehensive: '综合诊断',
  technical: '趋势与风险',
  fundamental: '财务与估值',
  events: '公告与事件',
  comparison: '标的对比',
  strategy: '策略研究',
  backtest: '策略回测',
  portfolio_risk: '持仓与组合风险',
};

const VALID_TIME_RANGE_UNITS = new Set<QuantQueryTimeRange['unit']>([
  'trading_day',
  'day',
  'week',
  'month',
  'quarter',
  'reporting_period',
  'year',
  'date_range',
]);

const LEADING_POLITE_PATTERN =
  /^(?:我的持仓包括|持仓包括|我持有|持有|请问|请|麻烦|劳驾|能不能|可不可以|是否可以|可以|我想要|我想|想要|想|帮我|帮忙|给我|替我)+/u;
const LEADING_ACTION_PATTERN =
  /^(?:分析一下|分析下|分析|研究一下|研究下|研究|了解一下|了解下|了解|看一下|看下|看看|查看一下|查看|查询一下|查询|查一下|查|评估一下|评估|诊断一下|诊断|梳理一下|梳理|说说|介绍一下|介绍|比较一下|比较|对比一下|对比|筛选一下|筛选|选股|生成一个|生成|结合)+/u;
const LEADING_PARTICLE_PATTERN = /^(?:一下子|一下|下|这个|这只|该只)+/u;
const TRAILING_ANALYSIS_PATTERN =
  /(?:(?:这个|这只|该只|这家)?(?:股票|个股))?(?:最近|近期|近\s*[零一二两三四五六七八九十百半\d]|过去|今天|今日|昨日|本周|本月|今年|这段时间|行情|走势|K\s*线|成交量|技术指标|技术面|财务|基本面|估值|公告|事件|风险|回测|策略|怎么样|如何|怎么|是否值得|可视化|看板|页面).*$/iu;
const POSSESSIVE_ANALYSIS_PATTERN =
  /的(?:股票|个股|行情|走势|K\s*线|成交量|技术指标|技术面|财务|基本面|估值|公告|事件|风险|回测|策略|表现|情况).*$/iu;
const LEADING_TIME_RANGE_PATTERN =
  /^(?:(?:最近|近|过去)\s*(?:\d+|[一二两三四五六七八九十百半]+)?\s*(?:个)?\s*(?:交易日|日|天|周|个月|月|季度|报告期|年)|去年(?:上半年|下半年)?|前年(?:上半年|下半年)?|20\d{2}年)/u;
const REPORTING_PERIOD_SUFFIX_PATTERN =
  /20\d{2}年(?:度)?(?:年报|一季报|半年报|中报|三季报)(?:里|中|内)?$/u;
const ANALYTICAL_TARGET_FRAGMENT_PATTERN =
  /(?:营收|净利润|利润|经营现金流|现金流|ROE|PE|PB|估值|涨幅|回撤|波动).*(?:增长|增速|质量|较好|低于|高于|前\s*\d+|公司|企业|指标)/iu;

const GENERIC_TARGETS = new Set([
  '一下',
  '一个',
  '这个',
  '那个',
  '这只',
  '该只',
  '股票',
  '个股',
  '证券',
  '公司',
  '标的',
  '项目',
  '市场',
  '行业',
  '板块',
  '生成',
  '可验证',
  '验证',
  '集中',
  '它',
  '分析',
  '查询',
  '看看',
  '研究',
  '分别',
  '同时',
]);

function asRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function normalizeSecurityText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\s+/g, '')
    .replace(/(?:股份有限公司|有限责任公司)$/u, '')
    .toLocaleLowerCase();
}

export function normalizeQuantQuery(query: string): string {
  return query
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function stripConversationalSecurityReferenceSuffix(value: string): string {
  let candidate = value.trim();
  let previous = '';
  while (candidate !== previous) {
    previous = candidate;
    candidate = candidate
      .replace(/(?:(?:这|那)(?:个|只|支|家)?|该(?:只|支|家)?)(?:股票|个股|证券|公司|企业|股)?$/u, '')
      .replace(/(?:股票|个股)$/u, '')
      .trim();
  }
  return candidate;
}

function stripLeadingRequestLanguage(value: string): string {
  let candidate = value.trim();
  let previous = '';
  while (candidate !== previous) {
    previous = candidate;
    candidate = candidate
      .replace(LEADING_POLITE_PATTERN, '')
      .replace(LEADING_ACTION_PATTERN, '')
      .replace(LEADING_PARTICLE_PATTERN, '')
      .trim();
  }
  return candidate;
}

function cleanTargetCandidate(value: string): string | null {
  let candidate = stripLeadingRequestLanguage(value.replace(/\s+/g, ''))
    .replace(POSSESSIVE_ANALYSIS_PATTERN, '')
    .replace(/^(?:A股|港股|美股)(?:里|中|内|范围内)?/iu, '')
    .replace(LEADING_TIME_RANGE_PATTERN, '')
    .replace(REPORTING_PERIOD_SUFFIX_PATTERN, '')
    .replace(TRAILING_ANALYSIS_PATTERN, '')
    .trim();

  candidate = stripConversationalSecurityReferenceSuffix(candidate);
  candidate = candidate
    .replace(/^(?:分别|同时)?(?:说明|解释|重点解释|重点说明)(?:一下)?/u, '')
    .replace(/(?:谁的)?(?:收益|回撤|波动|风险|差异|原因)$/u, '')
    .trim();
  if (candidate.endsWith('板块')) candidate = candidate.slice(0, -2);

  const analyticalRemainder = candidate.replace(
    /(?:最大|区间|累计|年化|收益率?|回撤|波动率?|风险|差异|原因|趋势|行情|走势|基本面|财务|估值|经营现金流|现金流|净利润|利润|营收|增速|指标|表现|说明|解释|谁|更大|更稳|和|与|及|的)/gu,
    '',
  );

  if (
    candidate.length < 2 ||
    candidate.length > 24 ||
    GENERIC_TARGETS.has(candidate) ||
    ANALYTICAL_TARGET_FRAGMENT_PATTERN.test(candidate) ||
    analyticalRemainder.length === 0 ||
    /^(?:某|某个|某家|某家公司|某某公司|这家|那家)(?:股票|个股|证券|公司|企业)?$/u.test(candidate) ||
    /^(?:几|多|若干|一些|数|多个)(?:只|支|个)?(?:股票|个股|标的|证券)?$/u.test(candidate) ||
    !/[\p{Script=Han}A-Za-z\d]/u.test(candidate)
  ) {
    return null;
  }

  return candidate;
}

export function extractQuantQueryTargetCandidates(query: string): string[] {
  const normalized = normalizeQuantQuery(query)
    .replace(/\b(?:6|0|3|5)\d{5}\b/g, ' ');
  const parts = normalized.split(/[，。！？?；;、,：:\n\r]+/u);
  const expandedParts = parts.flatMap((part) => {
    const cleaned = stripLeadingRequestLanguage(part.trim());
    if (!COMPARISON_PATTERN.test(part)) return [part];
    return cleaned.split(/(?:以及|和|与|及|VS|vs|versus|对比|比较)/u);
  });
  const lookaheadMatches = normalized.match(
    /[\u4e00-\u9fffA-Za-z0-9]{2,24}(?=(?:最近|近期|近|过去|今天|股票|个股|股份|行情|走势|K\s*线|成交量|技术指标|财务|基本面|估值|公告|怎么样|如何|怎么))/giu,
  ) ?? [];
  const knownAliases = matchKnownSymbolAliases(normalized).map((match) => match.keyword);
  const comparisonLike = COMPARISON_PATTERN.test(normalized);
  const cleanedAliases = knownAliases
    .map(cleanTargetCandidate)
    .filter((candidate): candidate is string => Boolean(candidate));
  const cleanedCandidates = keepLongestDistinctTextCandidates(
    [
      ...expandedParts,
      ...lookaheadMatches.filter((candidate) =>
        !candidate.endsWith('的') &&
        (!comparisonLike || !/(?:以及|和|与|及)/u.test(candidate)),
      ),
    ]
      .map(cleanTargetCandidate)
      .filter((candidate): candidate is string => Boolean(candidate))
      .filter((candidate) => !cleanedAliases.some((alias) =>
        normalizeSecurityText(candidate).includes(normalizeSecurityText(alias)) ||
        normalizeSecurityText(alias).includes(normalizeSecurityText(candidate)),
      )),
  );

  return Array.from(new Set([...cleanedAliases, ...cleanedCandidates]))
    .sort((left, right) => normalized.indexOf(left) - normalized.indexOf(right))
    .slice(0, 8);
}

export function inferQuantQueryTimeRange(query: string): QuantQueryTimeRange | null {
  const normalized = normalizeQuantQuery(query);
  const reportingPeriod = normalized.match(
    /(20\d{2})年(?:度)?(年报|一季报|半年报|中报|三季报)/u,
  );
  if (reportingPeriod?.[1] && reportingPeriod[2]) {
    const reportType = reportingPeriod[2] === '中报' ? '半年报' : reportingPeriod[2];
    return {
      label: `${reportingPeriod[1]}年${reportType}`,
      value: 1,
      unit: 'reporting_period',
      source: 'explicit',
    };
  }
  const relative = normalized.match(
    /(?:最近|近|过去)\s*(\d+)\s*(?:个)?\s*(交易日|日|天|周|个月|月|季度|报告期|年)/u,
  );
  if (relative?.[1] && relative[2]) {
    const value = Number.parseInt(relative[1], 10);
    const unitMap: Record<string, QuantQueryTimeRange['unit']> = {
      交易日: 'trading_day',
      日: 'day',
      天: 'day',
      周: 'week',
      个月: 'month',
      月: 'month',
      季度: 'quarter',
      报告期: 'reporting_period',
      年: 'year',
    };
    const amountLabelMap: Record<string, string> = {
      交易日: `${value} 个交易日`,
      日: `${value} 天`,
      天: `${value} 天`,
      周: `${value} 周`,
      个月: `${value} 个月`,
      月: `${value} 个月`,
      季度: `${value} 个季度`,
      报告期: `${value} 个报告期`,
      年: `${value} 年`,
    };
    return {
      label: `最近 ${amountLabelMap[relative[2]]}`,
      value,
      unit: unitMap[relative[2]],
      source: 'explicit',
    };
  }

  const implicitOne = normalized.match(
    /(?:最近|近|过去)\s*(?:一|1)?\s*(年|个月|月|季度|报告期|周)/u,
  );
  if (implicitOne?.[1]) {
    const unitMap: Record<string, QuantQueryTimeRange['unit']> = {
      年: 'year',
      个月: 'month',
      月: 'month',
      季度: 'quarter',
      报告期: 'reporting_period',
      周: 'week',
    };
    const labelMap: Record<string, string> = {
      年: '最近 1 年',
      个月: '最近 1 个月',
      月: '最近 1 个月',
      季度: '最近 1 个季度',
      报告期: '最近 1 个报告期',
      周: '最近 1 周',
    };
    return {
      label: labelMap[implicitOne[1]],
      value: 1,
      unit: unitMap[implicitOne[1]],
      source: 'explicit',
    };
  }

  const dateRange = normalized.match(
    /(20\d{2}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?)\s*(?:至|到|~|—|–)\s*(20\d{2}[-/.年]\d{1,2}(?:[-/.月]\d{1,2}日?)?)/u,
  );
  if (dateRange) {
    return {
      label: `${dateRange[1]} 至 ${dateRange[2]}`,
      unit: 'date_range',
      source: 'explicit',
    };
  }

  if (/去年下半年/u.test(normalized)) {
    return { label: '去年下半年', value: 6, unit: 'month', source: 'explicit' };
  }
  if (/去年上半年/u.test(normalized)) {
    return { label: '去年上半年', value: 6, unit: 'month', source: 'explicit' };
  }
  if (/(?:今年|本年)年初至今|年初至今/u.test(normalized)) {
    return { label: '年初至今', unit: 'date_range', source: 'explicit' };
  }

  if (/(?:今天|今日|当日)/u.test(normalized)) {
    return { label: '今日', value: 1, unit: 'day', source: 'explicit' };
  }
  if (/(?:今年|本年度)/u.test(normalized)) {
    return { label: '今年', value: 1, unit: 'year', source: 'explicit' };
  }
  return null;
}

export function inferQuantQueryFocus(query: string): QuantQueryFocus {
  const normalized = normalizeQuantQuery(query);
  if (/(?:持仓|组合|仓位|成本|调仓|集中度|相关性|VaR)/iu.test(normalized)) {
    return { id: 'portfolio_risk', label: '持仓与组合风险' };
  }
  if (
    COMPARISON_PATTERN.test(normalized) &&
    extractQuantQueryTargetCandidates(normalized).length >= 2
  ) {
    return { id: 'comparison', label: '标的对比' };
  }
  if (/(?:回测|净值|胜率|交易明细|最大回撤)/u.test(normalized)) {
    return { id: 'backtest', label: '策略回测' };
  }
  if (/(?:策略|因子|信号|入场|出场|止损|止盈)/u.test(normalized)) {
    return { id: 'strategy', label: '策略研究' };
  }
  if (/(?:财务|基本面|估值|营收|利润|现金流|ROE|PE|PB)/iu.test(normalized)) {
    return { id: 'fundamental', label: '财务与估值' };
  }
  if (/(?:公告|事件|分红|减持|增持|业绩预告)/u.test(normalized)) {
    return { id: 'events', label: '公告与事件' };
  }
  if (/(?:技术|趋势|K\s*线|均线|量能|成交量|波动|支撑|压力)/iu.test(normalized)) {
    return { id: 'technical', label: '趋势与风险' };
  }
  return { id: 'comprehensive', label: '综合诊断' };
}

export function inferQuantCapabilityHint(
  query: string,
  requestedCapabilityId?: string | null,
): string {
  if (requestedCapabilityId) return requestedCapabilityId;
  return capabilityHintForFocus(inferQuantQueryFocus(query).id);
}

function capabilityHintForFocus(focus: QuantQueryFocusId): string {
  if (focus === 'portfolio_risk') return 'portfolio_risk';
  if (focus === 'backtest') return 'backtest_review';
  if (focus === 'strategy') return 'strategy_research';
  if (focus === 'comparison') return 'asset_comparison';
  if (focus === 'fundamental') return 'fundamental_analysis';
  if (focus === 'technical') return 'technical_analysis';
  return 'stock_diagnosis';
}

function configuredLlmMode(value?: RewriteQuantQueryOptions['llmMode']): 'off' | 'auto' | 'always' {
  if (value) return value;
  const config = getProjectLlmConfig().queryRewrite;
  return config.enabled ? config.mode : 'off';
}

function configuredLlmTimeoutMs(value?: number): number {
  const configured = value ?? getProjectLlmConfig().queryRewrite.timeoutMs;
  return Number.isSafeInteger(configured) && configured >= 500 && configured <= 15_000
    ? configured
    : 4_000;
}

function preResolutionLlmTrigger(params: {
  query: string;
  draft: QuantQuerySemanticDraft;
  mode: 'off' | 'auto' | 'always';
}): QuantQueryRewriteLlmTrigger | null {
  if (params.mode === 'off') return null;
  if (params.mode === 'always') return 'forced';
  if (REFERENTIAL_LANGUAGE_PATTERN.test(params.query)) return 'referential_language';
  if (NONSTANDARD_TIME_RANGE_PATTERN.test(params.query) && !params.draft.timeRange) {
    return 'nonstandard_time_range';
  }
  if (COMPLEX_SEMANTICS_PATTERN.test(params.query) || params.query.length >= 120) {
    return 'complex_semantics';
  }
  return null;
}

function postResolutionLlmTrigger(params: {
  targetCandidates: string[];
  resolvedSymbols: QuantResolvedSymbol[];
  ambiguousTargets: QuantAmbiguousTarget[];
  issues: QuantQueryRewriteIssue[];
}): QuantQueryRewriteLlmTrigger | null {
  if (params.ambiguousTargets.length > 0) return null;
  if (params.targetCandidates.length === 0) return 'no_target';
  if (params.issues.some((issue) => issue.code === 'TARGET_NOT_FOUND')) {
    return 'resolver_miss';
  }
  return null;
}

function querySafety(query: string): QuantQueryRewriteSafety {
  if (
    GUARANTEED_RETURN_PATTERN.test(query) &&
    GUARANTEED_RETURN_REQUEST_PATTERN.test(query)
  ) {
    return {
      decision: 'refuse',
      code: 'GUARANTEED_RETURN_REQUEST',
      message: '无法承诺或预测某只证券一定上涨、涨停或盈利。可以改为基于真实数据筛选候选，并明确依据、风险和不确定性。',
    };
  }
  return { decision: 'allow', code: null, message: null };
}

function scoreResolverRow(query: string, row: JsonRecord): number {
  const symbol = stringValue(row.symbol) ?? stringValue(row.code) ?? '';
  const name = stringValue(row.name) ?? '';
  const assetType = (stringValue(row.asset_type) ?? stringValue(row.assetType) ?? '').toLocaleLowerCase();
  const market = (stringValue(row.market) ?? '').toLocaleUpperCase();
  const normalizedQuery = normalizeSecurityText(query);
  const normalizedName = normalizeSecurityText(name);
  let score = 0;
  if (SYMBOL_CODE_PATTERN.test(query) && symbol === query) score += 120;
  if (normalizedName === normalizedQuery) score += 100;
  else if (normalizedName.includes(normalizedQuery) || normalizedQuery.includes(normalizedName)) score += 55;
  if (assetType === 'stock') score += 20;
  else if (assetType === 'index' || assetType === 'fund' || assetType === 'etf') score += 12;
  if (market === 'SH' || market === 'SZ' || market === 'BJ') score += 5;
  return score;
}

function toResolvedSymbol(query: string, row: JsonRecord, score: number): QuantResolvedSymbol | null {
  const symbol = stringValue(row.symbol) ?? stringValue(row.code);
  if (!symbol || !SYMBOL_CODE_PATTERN.test(symbol)) return null;
  return {
    query,
    symbol,
    name: stringValue(row.name) ?? symbol,
    market: stringValue(row.market),
    assetType: stringValue(row.asset_type) ?? stringValue(row.assetType),
    secid: stringValue(row.secid),
    source: stringValue(row.source),
    confidence: Math.min(0.99, Math.max(0.55, score / 145)),
  };
}

export function rankQuantSymbolCandidates(
  query: string,
  payload: unknown,
): { selected: QuantResolvedSymbol | null; ambiguous: QuantResolvedSymbol[] } {
  const record = asRecord(payload);
  const rows = Array.isArray(record?.results)
    ? record.results.map(asRecord).filter((row): row is JsonRecord => Boolean(row))
    : [];
  const ranked = rows
    .map((row) => ({ row, score: scoreResolverRow(query, row) }))
    .map(({ row, score }) => ({ resolved: toResolvedSymbol(query, row, score), score }))
    .filter((item): item is { resolved: QuantResolvedSymbol; score: number } => Boolean(item.resolved))
    .sort((left, right) => right.score - left.score || left.resolved.symbol.localeCompare(right.resolved.symbol));

  if (ranked.length === 0) return { selected: null, ambiguous: [] };
  const topScore = ranked[0].score;
  const top = ranked.filter((item) => item.score === topScore).map((item) => item.resolved);
  if (top.length > 1 && topScore < 100) return { selected: null, ambiguous: top.slice(0, 5) };
  return { selected: ranked[0].resolved, ambiguous: [] };
}

async function defaultSymbolResolver(query: string, count: number): Promise<unknown> {
  const baseUrl = (process.env.QUANTPILOT_MARKET_API_URL ?? 'http://127.0.0.1:8000').replace(/\/$/, '');
  const url = new URL('/api/v1/symbols/resolve', baseUrl);
  url.searchParams.set('query', query);
  url.searchParams.set('count', String(count));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, { cache: 'no-store', signal: controller.signal });
    if (!response.ok) throw new Error(`symbol resolver returned HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function inferStaticSymbolMarket(symbol: string): 'SH' | 'SZ' {
  return symbol.startsWith('6') || symbol.startsWith('5') || SHANGHAI_INDEX_SYMBOLS.has(symbol)
    ? 'SH'
    : 'SZ';
}

function inferStaticAssetType(symbol: string): 'stock' | 'fund' | 'index' {
  if (INDEX_SYMBOLS.has(symbol)) return 'index';
  return symbol.startsWith('5') ? 'fund' : 'stock';
}

async function staticSymbolResolver(query: string): Promise<unknown> {
  if (SYMBOL_CODE_PATTERN.test(query)) {
    const market = inferStaticSymbolMarket(query);
    return {
      results: [{
        query,
        symbol: query,
        name: query,
        asset_type: inferStaticAssetType(query),
        market,
        secid: `${market === 'SH' ? '1' : '0'}.${query}`,
        source: 'explicit-code',
      }],
    };
  }
  const alias = matchKnownSymbolAliases(query).find(
    (candidate) => normalizeSecurityText(candidate.keyword) === normalizeSecurityText(query),
  );
  if (!alias) return { results: [] };
  const market = inferStaticSymbolMarket(alias.symbol);
  return {
    results: [{
      query,
      symbol: alias.symbol,
      name: alias.name,
      asset_type: inferStaticAssetType(alias.symbol),
      market,
      secid: `${market === 'SH' ? '1' : '0'}.${alias.symbol}`,
      source: 'known-alias',
    }],
  };
}

interface ResolvedTargetSet {
  resolvedSymbols: QuantResolvedSymbol[];
  unresolvedTargets: string[];
  ambiguousTargets: QuantAmbiguousTarget[];
  issues: QuantQueryRewriteIssue[];
}

async function resolveTargetSet(params: {
  targetCandidates: string[];
  resolver: QuantSymbolResolver;
}): Promise<ResolvedTargetSet> {
  const resolvedSymbols: QuantResolvedSymbol[] = [];
  const unresolvedTargets: string[] = [];
  const ambiguousTargets: QuantAmbiguousTarget[] = [];
  const issues: QuantQueryRewriteIssue[] = [];

  await Promise.all(params.targetCandidates.map(async (target) => {
    try {
      const payload = await params.resolver(target, 5);
      const ranked = rankQuantSymbolCandidates(target, payload);
      if (ranked.selected) {
        resolvedSymbols.push(ranked.selected);
      } else if (ranked.ambiguous.length > 0) {
        ambiguousTargets.push({ query: target, candidates: ranked.ambiguous });
        issues.push({
          code: 'TARGET_AMBIGUOUS',
          message: `“${target}”存在多个同优先级证券候选，需要确认。`,
          target,
          retryable: false,
        });
      } else {
        unresolvedTargets.push(target);
        issues.push({
          code: 'TARGET_NOT_FOUND',
          message: `未找到与“${target}”匹配的证券。`,
          target,
          retryable: false,
        });
      }
    } catch (error) {
      unresolvedTargets.push(target);
      issues.push({
        code: 'SYMBOL_RESOLVER_UNAVAILABLE',
        message: `证券解析服务暂不可用：${error instanceof Error ? error.message : String(error)}`,
        target,
        retryable: true,
      });
    }
  }));

  resolvedSymbols.sort(
    (left, right) =>
      params.targetCandidates.indexOf(left.query) - params.targetCandidates.indexOf(right.query),
  );
  const uniqueResolved = resolvedSymbols.filter(
    (item, index, items) =>
      items.findIndex((candidate) => candidate.symbol === item.symbol) === index,
  );
  unresolvedTargets.sort(
    (left, right) => params.targetCandidates.indexOf(left) - params.targetCandidates.indexOf(right),
  );
  ambiguousTargets.sort(
    (left, right) =>
      params.targetCandidates.indexOf(left.query) - params.targetCandidates.indexOf(right.query),
  );
  issues.sort((left, right) =>
    params.targetCandidates.indexOf(left.target ?? '') -
    params.targetCandidates.indexOf(right.target ?? ''),
  );

  return {
    resolvedSymbols: uniqueResolved,
    unresolvedTargets,
    ambiguousTargets,
    issues,
  };
}

function defaultLlmExecution(status: QuantQueryRewriteLlmStatus): QuantQueryRewriteExecution['llm'] {
  return {
    attempted: false,
    applied: false,
    trigger: null,
    status,
    provider: null,
    model: null,
    durationMs: null,
    semanticConfidence: null,
    errorCode: null,
    usage: null,
  };
}

function safeLlmTargetCandidates(query: string, candidates: unknown, maxTargets: number): string[] {
  if (!Array.isArray(candidates)) return [];
  const normalizedQuery = normalizeSecurityText(query);
  return Array.from(new Set(candidates
    .filter((candidate): candidate is string => typeof candidate === 'string')
    .map((candidate) => candidate.normalize('NFKC').trim().replace(/\s+/g, ''))
    .map((candidate) => cleanTargetCandidate(candidate))
    .filter((candidate): candidate is string => Boolean(candidate))
    .filter((candidate) => {
      if (SYMBOL_CODE_PATTERN.test(candidate)) {
        return extractExplicitSymbolCodes(query).includes(candidate);
      }
      return normalizedQuery.includes(normalizeSecurityText(candidate));
    })))
    .sort((left, right) => query.indexOf(left) - query.indexOf(right))
    .slice(0, maxTargets);
}

function normalizeLlmTimeRange(
  query: string,
  value: QuantQueryLlmSemantics['timeRange'],
): QuantQueryTimeRange | null {
  if (!value || !EXPLICIT_TIME_SIGNAL_PATTERN.test(query)) return null;
  const label = typeof value.label === 'string' ? value.label.normalize('NFKC').trim() : '';
  const unit = value.unit;
  const rawValue = value.value;
  if (!label || label.length > 64 || !VALID_TIME_RANGE_UNITS.has(unit)) return null;
  if (
    rawValue !== undefined &&
    (!Number.isSafeInteger(rawValue) || rawValue <= 0 || rawValue > 5_000)
  ) {
    return null;
  }
  return {
    label,
    ...(rawValue === undefined ? {} : { value: rawValue }),
    unit,
    source: 'explicit',
  };
}

function mergeLlmSemantics(params: {
  query: string;
  deterministic: QuantQuerySemanticDraft;
  llm: QuantQueryLlmSemantics;
  maxTargets: number;
}): QuantQuerySemanticDraft | null {
  const safeTargets = safeLlmTargetCandidates(
    params.query,
    params.llm.targetCandidates,
    params.maxTargets,
  );
  const focusId = params.llm.analysisFocusId;
  if (!(focusId in FOCUS_LABELS)) return null;
  if (
    params.llm.outputIntent !== 'dashboard' &&
    params.llm.outputIntent !== 'answer'
  ) {
    return null;
  }
  if (
    typeof params.llm.confidence !== 'number' ||
    !Number.isFinite(params.llm.confidence) ||
    params.llm.confidence < 0 ||
    params.llm.confidence > 1
  ) {
    return null;
  }

  return {
    targetCandidates: safeTargets.length > 0
      ? safeTargets
      : params.deterministic.targetCandidates,
    timeRange:
      normalizeLlmTimeRange(params.query, params.llm.timeRange) ??
      params.deterministic.timeRange,
    analysisFocus: { id: focusId, label: FOCUS_LABELS[focusId] },
    outputIntent: params.llm.outputIntent,
    broadUniverse:
      params.deterministic.broadUniverse ||
      (params.llm.broadUniverse && BROAD_UNIVERSE_LLM_PATTERN.test(params.query)),
  };
}

async function defaultSemanticRewriter(
  input: QuantQuerySemanticRewriteInput,
): Promise<QuantQuerySemanticRewriteOutcome> {
  const llmAdapter = await import('@/lib/quant/query-rewrite-llm');
  return llmAdapter.rewriteQuantQuerySemanticsWithDeepSeek(input);
}

async function runLlmSemanticRewrite(params: {
  input: Omit<QuantQuerySemanticRewriteInput, 'signal'>;
  rewriter: QuantQuerySemanticRewriter;
  timeoutMs: number;
}): Promise<{
  outcome: QuantQuerySemanticRewriteOutcome;
  durationMs: number;
  timedOut: boolean;
}> {
  const startedAt = performance.now();
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<QuantQuerySemanticRewriteOutcome>((resolve) => {
      timeoutId = setTimeout(() => {
        controller.abort(new DOMException('Query Rewrite LLM timed out.', 'TimeoutError'));
        resolve({ ok: false, code: 'LLM_TIMEOUT', retryable: true });
      }, params.timeoutMs);
      timeoutId.unref?.();
    });
    const outcome = await Promise.race([
      params.rewriter({ ...params.input, signal: controller.signal }),
      timeout,
    ]);
    return {
      outcome,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      timedOut: !outcome.ok && outcome.code === 'LLM_TIMEOUT',
    };
  } catch {
    return {
      outcome: { ok: false, code: 'LLM_REWRITE_FAILED', retryable: true },
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      timedOut: false,
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

function outputIntentForQuery(query: string): 'dashboard' | 'answer' {
  return /(?:只回答|只做问答|不要修改|不要生成|无需看板|不需要看板)/u.test(query)
    ? 'answer'
    : 'dashboard';
}

function rewrittenQueryText(params: {
  targets: string[];
  timeRange: QuantQueryTimeRange | null;
  focus: QuantQueryFocus;
  outputIntent: 'dashboard' | 'answer';
  broadUniverse: boolean;
}): string {
  const targetText = params.targets.length > 0
    ? params.targets.join('、')
    : params.broadUniverse
      ? '用户指定的市场范围'
      : '待确认标的';
  return [
    `分析对象：${targetText}`,
    `分析重点：${params.focus.label}`,
    `时间范围：${params.timeRange?.label ?? '使用能力默认周期'}`,
    `输出方式：${params.outputIntent === 'dashboard' ? '生成可验证看板' : '只做分析问答'}`,
  ].join('；');
}

export async function rewriteQuantQuery(
  query: string,
  options: RewriteQuantQueryOptions = {},
): Promise<QuantQueryRewriteResult> {
  const originalQuery = query;
  const normalizedQuery = normalizeQuantQuery(query);
  const maxTargets = Math.min(8, Math.max(1, options.maxTargets ?? 8));
  const codes = extractExplicitSymbolCodes(normalizedQuery);
  const names = extractQuantQueryTargetCandidates(normalizedQuery);
  const deterministicTargetCandidates = Array.from(new Set([...codes, ...names]))
    .slice(0, maxTargets);
  const deterministicDraft: QuantQuerySemanticDraft = {
    targetCandidates: deterministicTargetCandidates,
    timeRange: inferQuantQueryTimeRange(normalizedQuery),
    analysisFocus: inferQuantQueryFocus(normalizedQuery),
    outputIntent: outputIntentForQuery(normalizedQuery),
    broadUniverse: BROAD_UNIVERSE_PATTERN.test(normalizedQuery),
  };
  const safety = querySafety(normalizedQuery);
  if (safety.decision === 'refuse') {
    return {
      schemaVersion: QUANT_QUERY_REWRITE_SCHEMA_VERSION,
      originalQuery,
      normalizedQuery,
      rewrittenQuery: safety.message ?? '请求不在可执行范围内。',
      status: 'refused',
      confidence: 0.99,
      capabilityHint: options.requestedCapabilityId ?? 'stock_diagnosis',
      targetCandidates: [],
      resolvedSymbols: [],
      unresolvedTargets: [],
      ambiguousTargets: [],
      timeRange: deterministicDraft.timeRange,
      analysisFocus: deterministicDraft.analysisFocus,
      outputIntent: 'answer',
      broadUniverse: deterministicDraft.broadUniverse,
      safety,
      issues: [{
        code: 'GUARANTEED_RETURN_REQUEST',
        message: safety.message ?? '不支持确定性收益承诺。',
        retryable: false,
      }],
      execution: {
        strategy: 'deterministic',
        deterministic: {
          targetCandidates: deterministicDraft.targetCandidates,
          timeRange: deterministicDraft.timeRange,
          analysisFocus: deterministicDraft.analysisFocus,
        },
        llm: defaultLlmExecution('not_needed'),
      },
    };
  }
  let semanticDraft = deterministicDraft;
  const resolver = options.resolver ?? (
    options.resolveTargets === false ? staticSymbolResolver : defaultSymbolResolver
  );
  const allowLlm = options.allowLlm === true;
  const llmMode = configuredLlmMode(options.llmMode);
  const semanticRewriter = options.semanticRewriter ?? defaultSemanticRewriter;
  let llmExecution = defaultLlmExecution(allowLlm && llmMode !== 'off'
    ? 'not_needed'
    : 'not_requested');

  const applyLlmRewrite = async (trigger: QuantQueryRewriteLlmTrigger): Promise<boolean> => {
    llmExecution = {
      ...llmExecution,
      attempted: true,
      trigger,
    };
    const llmResult = await runLlmSemanticRewrite({
      input: {
        originalQuery,
        normalizedQuery,
        deterministic: deterministicDraft,
        trigger,
        requestedModel: options.requestedModel,
      },
      rewriter: semanticRewriter,
      timeoutMs: configuredLlmTimeoutMs(options.llmTimeoutMs),
    });
    llmExecution.durationMs = llmResult.durationMs;
    if (!llmResult.outcome.ok) {
      llmExecution.provider = llmResult.outcome.provider ?? null;
      llmExecution.model = llmResult.outcome.model ?? null;
      llmExecution.errorCode = llmResult.outcome.code;
      llmExecution.status = llmResult.timedOut
        ? 'timed_out'
        : llmResult.outcome.code === 'LLM_NOT_CONFIGURED'
          ? 'skipped_unconfigured'
          : llmResult.outcome.code === 'LLM_INVALID_OUTPUT'
            ? 'invalid_output'
            : 'failed';
      return false;
    }

    const merged = mergeLlmSemantics({
      query: normalizedQuery,
      deterministic: deterministicDraft,
      llm: llmResult.outcome.data,
      maxTargets,
    });
    llmExecution.provider = llmResult.outcome.provider;
    llmExecution.model = llmResult.outcome.model;
    llmExecution.semanticConfidence = llmResult.outcome.data.confidence;
    llmExecution.usage = llmResult.outcome.usage ?? null;
    if (!merged) {
      llmExecution.status = 'invalid_output';
      llmExecution.errorCode = 'LLM_INVALID_OUTPUT';
      return false;
    }
    semanticDraft = merged;
    llmExecution.applied = true;
    llmExecution.status = 'applied';
    llmExecution.errorCode = null;
    return true;
  };

  const preTrigger = allowLlm
    ? preResolutionLlmTrigger({ query: normalizedQuery, draft: deterministicDraft, mode: llmMode })
    : null;
  if (preTrigger) await applyLlmRewrite(preTrigger);

  let targetCandidates = semanticDraft.targetCandidates.slice(0, maxTargets);
  let resolvedTargetSet = await resolveTargetSet({ targetCandidates, resolver });

  if (allowLlm && !preTrigger && llmMode !== 'off') {
    const postTrigger = postResolutionLlmTrigger({
      targetCandidates,
      resolvedSymbols: resolvedTargetSet.resolvedSymbols,
      ambiguousTargets: resolvedTargetSet.ambiguousTargets,
      issues: resolvedTargetSet.issues,
    });
    if (postTrigger) {
      const applied = await applyLlmRewrite(postTrigger);
      targetCandidates = semanticDraft.targetCandidates.slice(0, maxTargets);
      if (applied) {
        resolvedTargetSet = await resolveTargetSet({ targetCandidates, resolver });
      }
    }
  }

  const {
    resolvedSymbols,
    unresolvedTargets,
    ambiguousTargets,
    issues,
  } = resolvedTargetSet;
  const canonicalTargets = resolvedSymbols.map((item) =>
    `${item.name}（${item.symbol}${item.market ? `.${item.market}` : ''}）`,
  );
  const status: QuantQueryRewriteStatus =
    ambiguousTargets.length > 0 ||
    (targetCandidates.length === 0 && !semanticDraft.broadUniverse)
      ? 'needs_clarification'
      : unresolvedTargets.length > 0
        ? resolvedSymbols.length > 0 ? 'partial' : 'needs_clarification'
        : 'ready';
  const confidence = status === 'ready'
    ? resolvedSymbols.length > 0
      ? Math.min(
          ...resolvedSymbols.map((item) => item.confidence),
          llmExecution.semanticConfidence ?? 1,
        )
      : llmExecution.semanticConfidence ?? 0.86
    : status === 'partial' ? 0.68 : 0.45;
  const execution: QuantQueryRewriteExecution = {
    strategy: llmExecution.applied
      ? 'hybrid_llm'
      : llmExecution.attempted
        ? 'deterministic_fallback'
        : 'deterministic',
    deterministic: {
      targetCandidates: deterministicDraft.targetCandidates,
      timeRange: deterministicDraft.timeRange,
      analysisFocus: deterministicDraft.analysisFocus,
    },
    llm: llmExecution,
  };

  return {
    schemaVersion: QUANT_QUERY_REWRITE_SCHEMA_VERSION,
    originalQuery,
    normalizedQuery,
    rewrittenQuery: rewrittenQueryText({
      targets: canonicalTargets.length > 0 ? canonicalTargets : targetCandidates,
      timeRange: semanticDraft.timeRange,
      focus: semanticDraft.analysisFocus,
      outputIntent: semanticDraft.outputIntent,
      broadUniverse: semanticDraft.broadUniverse,
    }),
    status,
    confidence,
    capabilityHint:
      options.requestedCapabilityId ?? capabilityHintForFocus(semanticDraft.analysisFocus.id),
    targetCandidates,
    resolvedSymbols,
    unresolvedTargets,
    ambiguousTargets,
    timeRange: semanticDraft.timeRange,
    analysisFocus: semanticDraft.analysisFocus,
    outputIntent: semanticDraft.outputIntent,
    broadUniverse: semanticDraft.broadUniverse,
    safety,
    issues,
    execution,
  };
}
