import {
  extractExplicitSymbolCodes,
} from '@/lib/quant/symbol-aliases';
import { getProjectLlmConfig } from '@/lib/config/llm';

export const QUANT_QUERY_REWRITE_SCHEMA_VERSION = 4 as const;

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

export type QuantQueryRewriteLlmTrigger = 'primary';

export type QuantQueryRewriteLlmStatus =
  | 'not_applicable'
  | 'applied'
  | 'skipped_unconfigured'
  | 'invalid_output'
  | 'timed_out'
  | 'failed';

export interface QuantQueryRewriteExecution {
  strategy: 'llm_primary' | 'llm_unavailable' | 'safety_refusal';
  llm: {
    attempted: boolean;
    applied: boolean;
    trigger: QuantQueryRewriteLlmTrigger | null;
    status: QuantQueryRewriteLlmStatus;
    provider: string | null;
    model: string | null;
    durationMs: number | null;
    semanticConfidence: number | null;
    guardedFields: string[];
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
  | 'QUERY_REWRITE_LLM_UNAVAILABLE'
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
  timeRange: (Omit<QuantQueryTimeRange, 'source'> & { evidence: string }) | null;
  analysisFocusId: QuantQueryFocusId;
  outputIntent: 'dashboard' | 'answer';
  /** Literal query excerpt that explicitly requests answer-only output. */
  answerOnlyEvidence: string | null;
  broadUniverse: boolean;
  /** Literal query excerpt that explicitly names a market or screening universe. */
  broadUniverseEvidence: string | null;
  confidence: number;
}

export interface QuantQuerySemanticRewriteInput {
  originalQuery: string;
  normalizedQuery: string;
  trigger: QuantQueryRewriteLlmTrigger;
  requestedModel?: string | null;
  projectId?: string;
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
      /** Bounded, payload-free feedback used only to repair a subsequent LLM tool call. */
      repairInstruction?: string;
    };

export type QuantQuerySemanticRewriter = (
  input: QuantQuerySemanticRewriteInput,
) => Promise<QuantQuerySemanticRewriteOutcome>;

export interface RewriteQuantQueryOptions {
  requestedCapabilityId?: string | null;
  resolver?: QuantSymbolResolver;
  maxTargets?: number;
  llmTimeoutMs?: number;
  requestedModel?: string | null;
  semanticRewriter?: QuantQuerySemanticRewriter;
  projectId?: string;
}

const SYMBOL_CODE_PATTERN = /^(?:6|0|3|5)\d{5}$/;
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

function capabilityHintForFocus(focus: QuantQueryFocusId): string {
  if (focus === 'portfolio_risk') return 'portfolio_risk';
  if (focus === 'backtest') return 'backtest_review';
  if (focus === 'strategy') return 'strategy_research';
  if (focus === 'comparison') return 'asset_comparison';
  if (focus === 'fundamental') return 'fundamental_analysis';
  if (focus === 'technical') return 'technical_analysis';
  return 'stock_diagnosis';
}

function configuredLlmTimeoutMs(value?: number, requestedModel?: string | null): number {
  const configured = value ?? getProjectLlmConfig(requestedModel).queryRewrite.timeoutMs;
  return Number.isSafeInteger(configured) && configured >= 500 && configured <= 15_000
    ? configured
    : 4_000;
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
    guardedFields: [],
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
    .filter((candidate) => candidate.length > 0 && candidate.length <= 24)
    .filter((candidate) => /[\p{Script=Han}A-Za-z\d]/u.test(candidate))
    .filter((candidate) => {
      if (SYMBOL_CODE_PATTERN.test(candidate)) {
        return extractExplicitSymbolCodes(query).includes(candidate);
      }
      return normalizedQuery.includes(normalizeSecurityText(candidate));
    })))
    .sort((left, right) => query.indexOf(left) - query.indexOf(right))
    .slice(0, maxTargets);
}

function literalEvidence(query: string, value: unknown, maxLength: number): string | null {
  const evidence = typeof value === 'string' ? value.normalize('NFKC').trim() : '';
  return evidence && evidence.length <= maxLength && query.includes(evidence) ? evidence : null;
}

function normalizeLlmTimeRange(
  query: string,
  value: QuantQueryLlmSemantics['timeRange'],
): QuantQueryTimeRange | null {
  if (!value || !literalEvidence(query, value.evidence, 160)) return null;
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
  llm: QuantQueryLlmSemantics;
  maxTargets: number;
}): { draft: QuantQuerySemanticDraft; guardedFields: string[] } | null {
  const safeTargets = safeLlmTargetCandidates(
    params.query,
    params.llm.targetCandidates,
    params.maxTargets,
  );
  if (params.llm.targetCandidates.length > 0 && safeTargets.length === 0) return null;
  const focusId = params.llm.analysisFocusId;
  if (!(focusId in FOCUS_LABELS)) return null;
  if (
    params.llm.outputIntent !== 'dashboard' &&
    params.llm.outputIntent !== 'answer'
  ) {
    return null;
  }
  const answerOnlyEvidence = typeof params.llm.answerOnlyEvidence === 'string'
    ? literalEvidence(params.query, params.llm.answerOnlyEvidence, 160)
    : null;
  const validAnswerOnlyEvidence = Boolean(answerOnlyEvidence);
  const outputIntent = params.llm.outputIntent === 'answer' && validAnswerOnlyEvidence
    ? 'answer'
    : 'dashboard';
  const guardedFields = outputIntent !== params.llm.outputIntent ||
      (params.llm.outputIntent === 'dashboard' && Boolean(answerOnlyEvidence))
    ? ['outputIntent']
    : [];
  if (
    typeof params.llm.confidence !== 'number' ||
    !Number.isFinite(params.llm.confidence) ||
    params.llm.confidence < 0 ||
    params.llm.confidence > 1
  ) {
    return null;
  }
  const timeRange = normalizeLlmTimeRange(params.query, params.llm.timeRange);
  if (params.llm.timeRange && !timeRange) return null;
  const broadUniverseEvidence = literalEvidence(
    params.query,
    params.llm.broadUniverseEvidence,
    160,
  );
  if (params.llm.broadUniverse && !broadUniverseEvidence) return null;

  return {
    draft: {
      targetCandidates: safeTargets,
      timeRange,
      analysisFocus: { id: focusId, label: FOCUS_LABELS[focusId] },
      outputIntent,
      broadUniverse: params.llm.broadUniverse,
    },
    guardedFields,
  };
}

async function defaultSemanticRewriter(
  input: QuantQuerySemanticRewriteInput,
): Promise<QuantQuerySemanticRewriteOutcome> {
  const llmAdapter = await import('@/lib/quant/query-rewrite-llm');
  return llmAdapter.rewriteQuantQuerySemanticsWithConfiguredProvider(input);
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
  const neutralFocus: QuantQueryFocus = { id: 'comprehensive', label: FOCUS_LABELS.comprehensive };
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
      timeRange: null,
      analysisFocus: neutralFocus,
      outputIntent: 'answer',
      broadUniverse: false,
      safety,
      issues: [{
        code: 'GUARANTEED_RETURN_REQUEST',
        message: safety.message ?? '不支持确定性收益承诺。',
        retryable: false,
      }],
      execution: {
        strategy: 'safety_refusal',
        llm: defaultLlmExecution('not_applicable'),
      },
    };
  }

  const semanticRewriter = options.semanticRewriter ?? defaultSemanticRewriter;
  const llmResult = await runLlmSemanticRewrite({
    input: {
      originalQuery,
      normalizedQuery,
      trigger: 'primary',
      requestedModel: options.requestedModel,
      projectId: options.projectId,
    },
    rewriter: semanticRewriter,
    timeoutMs: configuredLlmTimeoutMs(options.llmTimeoutMs, options.requestedModel),
  });
  const llmExecution: QuantQueryRewriteExecution['llm'] = {
    ...defaultLlmExecution('failed'),
    attempted: true,
    trigger: 'primary' as const,
    durationMs: llmResult.durationMs,
  };

  let semanticDraft: QuantQuerySemanticDraft | null = null;
  let llmRetryable = true;
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
    llmRetryable = llmResult.outcome.retryable;
  } else {
    const merged = mergeLlmSemantics({
      query: normalizedQuery,
      llm: llmResult.outcome.data,
      maxTargets,
    });
    llmExecution.provider = llmResult.outcome.provider;
    llmExecution.model = llmResult.outcome.model;
    llmExecution.semanticConfidence = llmResult.outcome.data.confidence;
    llmExecution.usage = llmResult.outcome.usage ?? null;
    if (merged) {
      semanticDraft = merged.draft;
      llmExecution.guardedFields = merged.guardedFields;
      llmExecution.applied = true;
      llmExecution.status = 'applied';
      llmExecution.errorCode = null;
    } else {
      llmExecution.status = 'invalid_output';
      llmExecution.errorCode = 'LLM_INVALID_OUTPUT';
      llmRetryable = true;
    }
  }

  if (!semanticDraft) {
    const unavailableMessage = llmExecution.status === 'skipped_unconfigured'
      ? 'Query Rewrite 大模型未配置，任务已暂停；请配置可用模型后重试。'
      : 'Query Rewrite 大模型暂时不可用或返回了无效结果，任务已暂停；请稍后重试。';
    return {
      schemaVersion: QUANT_QUERY_REWRITE_SCHEMA_VERSION,
      originalQuery,
      normalizedQuery,
      rewrittenQuery: unavailableMessage,
      status: 'needs_clarification',
      confidence: 0,
      capabilityHint: options.requestedCapabilityId ?? 'stock_diagnosis',
      targetCandidates: [],
      resolvedSymbols: [],
      unresolvedTargets: [],
      ambiguousTargets: [],
      timeRange: null,
      analysisFocus: neutralFocus,
      outputIntent: 'dashboard',
      broadUniverse: false,
      safety,
      issues: [{
        code: 'QUERY_REWRITE_LLM_UNAVAILABLE',
        message: unavailableMessage,
        retryable: llmRetryable,
      }],
      execution: {
        strategy: 'llm_unavailable',
        llm: llmExecution,
      },
    };
  }

  const targetCandidates = semanticDraft.targetCandidates.slice(0, maxTargets);
  const resolvedTargetSet = await resolveTargetSet({
    targetCandidates,
    resolver: options.resolver ?? defaultSymbolResolver,
  });

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
    strategy: 'llm_primary',
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
