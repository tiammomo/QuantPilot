import { describe, expect, it, vi } from 'vitest';
import {
  rankQuantSymbolCandidates,
  rewriteQuantQuery,
  type QuantQueryLlmSemantics,
  type QuantQuerySemanticRewriter,
} from './query-rewrite';

function semanticData(
  overrides: Partial<QuantQueryLlmSemantics> = {},
): QuantQueryLlmSemantics {
  return {
    targetCandidates: ['大位科技'],
    timeRange: null,
    analysisFocusId: 'comprehensive',
    outputIntent: 'dashboard',
    answerOnlyEvidence: null,
    broadUniverse: false,
    broadUniverseEvidence: null,
    confidence: 0.95,
    ...overrides,
  };
}

function successfulRewrite(
  data: QuantQueryLlmSemantics,
  provider = 'openai',
): QuantQuerySemanticRewriter {
  return vi.fn(async () => ({
    ok: true as const,
    provider,
    model: 'local_qwen:qwen3.5-9b-q5km',
    usage: { inputTokens: 80, outputTokens: 30, totalTokens: 110 },
    data,
  }));
}

function resolvedSecurity(target: string, symbol = '600589', market = 'SH') {
  return {
    results: [{
      query: target,
      symbol,
      name: target,
      asset_type: 'stock',
      market,
      secid: `${market === 'SH' ? '1' : '0'}.${symbol}`,
      source: 'test-resolver',
    }],
  };
}

describe('quant query rewrite schema v4', () => {
  it('uses the selected LLM as the only semantic parser before resolving 大位科技', async () => {
    const semanticRewriter = successfulRewrite(semanticData({
      timeRange: {
        label: '最近20个交易日',
        value: 20,
        unit: 'trading_day',
        evidence: '最近20个交易日',
      },
      analysisFocusId: 'technical',
    }));
    const resolver = vi.fn(async (target: string) => resolvedSecurity(target));

    const result = await rewriteQuantQuery(
      '分析大位科技最近20个交易日，生成技术面看板',
      {
        requestedModel: 'local_qwen:qwen3.5-9b-q5km',
        semanticRewriter,
        resolver,
      },
    );

    expect(semanticRewriter).toHaveBeenCalledOnce();
    expect(semanticRewriter).toHaveBeenCalledWith(expect.objectContaining({
      trigger: 'primary',
      requestedModel: 'local_qwen:qwen3.5-9b-q5km',
    }));
    expect(resolver).toHaveBeenCalledWith('大位科技', 5);
    expect(result).toMatchObject({
      schemaVersion: 4,
      status: 'ready',
      capabilityHint: 'technical_analysis',
      targetCandidates: ['大位科技'],
      resolvedSymbols: [{ symbol: '600589', name: '大位科技' }],
      timeRange: { label: '最近20个交易日', value: 20, unit: 'trading_day' },
      analysisFocus: { id: 'technical' },
      execution: {
        strategy: 'llm_primary',
        llm: { attempted: true, applied: true, status: 'applied' },
      },
    });
  });

  it('resolves each literal target returned by the LLM in user order', async () => {
    const query = '比较北方稀土和宁德时代去年下半年的趋势';
    const semanticRewriter = successfulRewrite(semanticData({
      targetCandidates: ['北方稀土', '宁德时代'],
      timeRange: {
        label: '去年下半年',
        unit: 'date_range',
        evidence: '去年下半年',
      },
      analysisFocusId: 'comparison',
      confidence: 0.91,
    }));
    const resolver = vi.fn(async (target: string) => resolvedSecurity(
      target,
      target === '北方稀土' ? '600111' : '300750',
      target === '北方稀土' ? 'SH' : 'SZ',
    ));

    const result = await rewriteQuantQuery(query, { semanticRewriter, resolver });

    expect(resolver).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      status: 'ready',
      capabilityHint: 'asset_comparison',
      resolvedSymbols: [{ symbol: '600111' }, { symbol: '300750' }],
      analysisFocus: { id: 'comparison' },
    });
  });

  it('reconciles an unresolved display alias when an explicit code resolved the same security', async () => {
    const semanticRewriter = successfulRewrite(semanticData({
      targetCandidates: ['510300', '沪深300ETF'],
      analysisFocusId: 'technical',
    }));
    const resolver = vi.fn(async (target: string) => target === '510300'
      ? {
          results: [{
            query: target,
            symbol: '510300',
            name: '沪深300ETF华泰柏瑞',
            asset_type: 'etf',
            market: 'SH',
            secid: '1.510300',
            source: 'test-resolver',
          }],
        }
      : { results: [] });

    const result = await rewriteQuantQuery(
      '510300 沪深300ETF 最近120天走势如何？',
      { semanticRewriter, resolver },
    );

    expect(result).toMatchObject({
      status: 'ready',
      resolvedSymbols: [{ symbol: '510300' }],
      unresolvedTargets: [],
      ambiguousTargets: [],
      issues: [],
    });
  });

  it('does not reconcile a short generic label with an explicitly resolved security', async () => {
    const semanticRewriter = successfulRewrite(semanticData({
      targetCandidates: ['510300', 'ETF'],
      analysisFocusId: 'technical',
    }));
    const resolver = vi.fn(async (target: string) => target === '510300'
      ? {
          results: [{
            query: target,
            symbol: '510300',
            name: '沪深300ETF华泰柏瑞',
            asset_type: 'etf',
            market: 'SH',
            secid: '1.510300',
            source: 'test-resolver',
          }],
        }
      : { results: [] });

    const result = await rewriteQuantQuery('510300 ETF 最近走势如何？', {
      semanticRewriter,
      resolver,
    });

    expect(result).toMatchObject({
      status: 'partial',
      resolvedSymbols: [{ symbol: '510300' }],
      unresolvedTargets: ['ETF'],
      issues: [{ code: 'TARGET_NOT_FOUND', target: 'ETF' }],
    });
  });

  it('fails closed when the LLM is unavailable and never invokes the resolver', async () => {
    const resolver = vi.fn();
    const semanticRewriter: QuantQuerySemanticRewriter = vi.fn(async () => ({
      ok: false as const,
      code: 'LLM_NETWORK_ERROR',
      provider: 'openai',
      model: 'local_qwen:qwen3.5-9b-q5km',
      retryable: true,
    }));

    const result = await rewriteQuantQuery('比较贵州茅台和宁德时代', {
      semanticRewriter,
      resolver,
    });

    expect(resolver).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'needs_clarification',
      targetCandidates: [],
      resolvedSymbols: [],
      issues: [{ code: 'QUERY_REWRITE_LLM_UNAVAILABLE', retryable: true }],
      execution: {
        strategy: 'llm_unavailable',
        llm: { attempted: true, applied: false, status: 'failed' },
      },
    });
  });

  it('does not supplement an empty LLM target set with keyword-derived targets', async () => {
    const resolver = vi.fn();
    const result = await rewriteQuantQuery('分析大位科技最近20个交易日', {
      semanticRewriter: successfulRewrite(semanticData({
        targetCandidates: [],
        timeRange: {
          label: '最近20个交易日',
          value: 20,
          unit: 'trading_day',
          evidence: '最近20个交易日',
        },
      })),
      resolver,
    });

    expect(result).toMatchObject({
      status: 'needs_clarification',
      targetCandidates: [],
      execution: { strategy: 'llm_primary' },
    });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('drops an invented target before the resolver while keeping literal targets', async () => {
    const resolver = vi.fn(async (target: string) => resolvedSecurity(target, '600111'));
    const result = await rewriteQuantQuery('分析北方稀土的主要风险', {
      semanticRewriter: successfulRewrite(semanticData({
        targetCandidates: ['北方稀土', '虚构证券'],
        analysisFocusId: 'technical',
      })),
      resolver,
    });

    expect(result.targetCandidates).toEqual(['北方稀土']);
    expect(resolver).toHaveBeenCalledOnce();
    expect(resolver).toHaveBeenCalledWith('北方稀土', 5);
  });

  it('requires literal evidence for broad-universe and time-range semantics', async () => {
    const resolver = vi.fn();
    const result = await rewriteQuantQuery('筛选A股近20日涨幅前10的公司', {
      semanticRewriter: successfulRewrite(semanticData({
        targetCandidates: [],
        timeRange: {
          label: '近20日',
          value: 20,
          unit: 'day',
          evidence: '近20日',
        },
        broadUniverse: true,
        broadUniverseEvidence: 'A股',
      })),
      resolver,
    });

    expect(result).toMatchObject({
      status: 'ready',
      broadUniverse: true,
      timeRange: { label: '近20日' },
      execution: { strategy: 'llm_primary' },
    });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('fails closed when the LLM emits ungrounded broad-universe semantics', async () => {
    const result = await rewriteQuantQuery('分析大位科技', {
      semanticRewriter: successfulRewrite(semanticData({
        broadUniverse: true,
        broadUniverseEvidence: '全市场',
      })),
      resolver: vi.fn(),
    });

    expect(result).toMatchObject({
      status: 'needs_clarification',
      issues: [{ code: 'QUERY_REWRITE_LLM_UNAVAILABLE' }],
      execution: {
        strategy: 'llm_unavailable',
        llm: { status: 'invalid_output', errorCode: 'LLM_INVALID_OUTPUT' },
      },
    });
  });

  it('allows answer-only output only with literal negative-dashboard evidence', async () => {
    const result = await rewriteQuantQuery('只回答北方稀土怎么样，不需要看板', {
      semanticRewriter: successfulRewrite(semanticData({
        targetCandidates: ['北方稀土'],
        outputIntent: 'answer',
        answerOnlyEvidence: '不需要看板',
      })),
      resolver: async (target) => resolvedSecurity(target, '600111'),
    });

    expect(result.outputIntent).toBe('answer');
  });

  it('returns an actionable issue when the authoritative resolver misses', async () => {
    const result = await rewriteQuantQuery('分析大位科技', {
      semanticRewriter: successfulRewrite(semanticData()),
      resolver: async () => ({ results: [] }),
    });

    expect(result).toMatchObject({
      status: 'needs_clarification',
      unresolvedTargets: ['大位科技'],
      issues: [{ code: 'TARGET_NOT_FOUND', retryable: false }],
    });
  });

  it('refuses guaranteed-return requests before LLM or resolver execution', async () => {
    const resolver = vi.fn();
    const semanticRewriter = vi.fn();
    const result = await rewriteQuantQuery('明天买哪只股票一定能涨停？', {
      semanticRewriter,
      resolver,
    });

    expect(result).toMatchObject({
      schemaVersion: 4,
      status: 'refused',
      execution: {
        strategy: 'safety_refusal',
        llm: { attempted: false, status: 'not_applicable' },
      },
    });
    expect(semanticRewriter).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
  });

  it('marks equal resolver matches as ambiguous', () => {
    const result = rankQuantSymbolCandidates('测试证券', {
      results: [
        { symbol: '600001', name: '测试证券甲', asset_type: 'stock' },
        { symbol: '000001', name: '测试证券乙', asset_type: 'stock' },
      ],
    });

    expect(result.selected).toBeNull();
    expect(result.ambiguous).toHaveLength(2);
  });
});
