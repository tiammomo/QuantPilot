import { describe, expect, it, vi } from 'vitest';
import {
  extractQuantQueryTargetCandidates,
  inferQuantQueryFocus,
  inferQuantQueryTimeRange,
  rewriteQuantQuery,
} from './query-rewrite';

describe('quant query rewrite', () => {
  it.each([
    '帮我分析一下北方稀土',
    '请帮我分析一下北方稀土',
    '能不能分析一下北方稀土',
    '我想了解一下北方稀土',
    '麻烦帮我看看北方稀土',
    '北方稀土这只股票怎么样',
  ])('extracts the same security target from conversational query: %s', (query) => {
    expect(extractQuantQueryTargetCandidates(query)).toEqual(['北方稀土']);
  });

  it('keeps multiple comparison targets in user order', () => {
    expect(
      extractQuantQueryTargetCandidates('比较贵州茅台和宁德时代近60个交易日走势'),
    ).toEqual(['贵州茅台', '宁德时代']);
  });

  it('keeps deterministic previews clean for complex comparison wording', () => {
    expect(extractQuantQueryTargetCandidates(
      '请分别比较北方稀土和宁德时代去年下半年的趋势，同时说明谁的回撤风险更大',
    )).toEqual(['北方稀土', '宁德时代']);
    expect(inferQuantQueryTimeRange('比较北方稀土去年下半年走势')).toEqual({
      label: '去年下半年',
      value: 6,
      unit: 'month',
      source: 'explicit',
    });
  });

  it('does not turn comparison metrics into security targets', () => {
    const query = '请比较北方稀土和宁德时代去年下半年的收益、波动率和最大回撤，说明差异原因';
    expect(extractQuantQueryTargetCandidates(query)).toEqual(['北方稀土', '宁德时代']);
    expect(inferQuantQueryFocus(query)).toEqual({ id: 'comparison', label: '标的对比' });
  });

  it('recognizes implicit one-unit time ranges', () => {
    expect(inferQuantQueryTimeRange('中证红利近一年和沪深300相比谁更稳')).toEqual({
      label: '最近 1 年',
      value: 1,
      unit: 'year',
      source: 'explicit',
    });
  });

  it('keeps a leading implicit time range out of the first comparison target', () => {
    expect(extractQuantQueryTargetCandidates(
      '近一年中证红利和沪深300谁表现更稳？',
    )).toEqual(['中证红利', '沪深300']);
    expect(inferQuantQueryFocus(
      '近一年中证红利和沪深300谁表现更稳？',
    )).toEqual({ id: 'comparison', label: '标的对比' });
  });

  it('keeps financial metric comparisons on the fundamental focus', () => {
    expect(inferQuantQueryFocus(
      '北方稀土2025年年报里，比较经营现金流增速和净利润增速',
    )).toEqual({ id: 'fundamental', label: '财务与估值' });
  });

  it('extracts an explicit annual reporting period without polluting the target', () => {
    const query = '北方稀土2025年年报里，每股经营现金流增速有没有跑赢净利润增速？请生成可验证看板。';
    expect(extractQuantQueryTargetCandidates(query)).toEqual(['北方稀土']);
    expect(inferQuantQueryTimeRange(query)).toEqual({
      label: '2025年年报',
      value: 1,
      unit: 'reporting_period',
      source: 'explicit',
    });
  });

  it('resolves targets and emits an executable query contract', async () => {
    const resolver = vi.fn(async (query: string) => ({
      results: [{
        query,
        symbol: '600111',
        name: '北方稀土',
        asset_type: 'stock',
        market: 'SH',
        secid: '1.600111',
        source: 'eastmoney',
      }],
    }));

    const result = await rewriteQuantQuery(
      '帮我分析一下北方稀土近60个交易日的趋势和风险',
      { resolver },
    );

    expect(resolver).toHaveBeenCalledWith('北方稀土', 5);
    expect(result).toMatchObject({
      schemaVersion: 3,
      status: 'ready',
      capabilityHint: 'technical_analysis',
      targetCandidates: ['北方稀土'],
      resolvedSymbols: [{
        symbol: '600111',
        name: '北方稀土',
        market: 'SH',
      }],
      timeRange: {
        label: '最近 60 个交易日',
        value: 60,
        unit: 'trading_day',
      },
      analysisFocus: { id: 'technical', label: '趋势与风险' },
      execution: {
        strategy: 'deterministic',
        llm: { attempted: false, applied: false, status: 'not_requested' },
      },
    });
    expect(result.rewrittenQuery).toContain('北方稀土（600111.SH）');
  });

  it('returns actionable clarification issues instead of throwing on misses', async () => {
    const result = await rewriteQuantQuery('分析一下不存在标的', {
      resolver: async () => ({ results: [] }),
    });

    expect(result.status).toBe('needs_clarification');
    expect(result.unresolvedTargets).toEqual(['不存在标的']);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: 'TARGET_NOT_FOUND', retryable: false }),
    ]);
  });

  it('recognizes time and focus without resolving symbols', () => {
    expect(inferQuantQueryTimeRange('过去2年财务表现')).toMatchObject({
      label: '最近 2 年',
      value: 2,
      unit: 'year',
    });
    expect(inferQuantQueryFocus('做均线策略回测')).toEqual({
      id: 'backtest',
      label: '策略回测',
    });
  });

  it('classifies known index aliases without calling the remote resolver', async () => {
    const result = await rewriteQuantQuery('分析沪深300最近走势', {
      resolveTargets: false,
    });

    expect(result.resolvedSymbols).toEqual([
      expect.objectContaining({
        symbol: '000300',
        market: 'SH',
        assetType: 'index',
        secid: '1.000300',
      }),
    ]);
  });

  it('uses the LLM semantic fallback only for complex queries and still resolves every target', async () => {
    const semanticRewriter = vi.fn(async () => ({
      ok: true as const,
      provider: 'test-llm',
      model: 'test-model',
      usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160 },
      data: {
        targetCandidates: ['北方稀土', '宁德时代'],
        timeRange: { label: '去年下半年', unit: 'date_range' as const },
        analysisFocusId: 'comparison' as const,
        outputIntent: 'dashboard' as const,
        broadUniverse: false,
        confidence: 0.91,
      },
    }));
    const symbols: Record<string, string> = {
      北方稀土: '600111',
      宁德时代: '300750',
    };
    const resolver = vi.fn(async (target: string) => ({
      results: [{
        symbol: symbols[target],
        name: target,
        asset_type: 'stock',
        market: target === '北方稀土' ? 'SH' : 'SZ',
        secid: `${target === '北方稀土' ? '1' : '0'}.${symbols[target]}`,
        source: 'test-resolver',
      }],
    }));

    const result = await rewriteQuantQuery(
      '请分别比较北方稀土和宁德时代去年下半年的趋势，同时说明谁的回撤风险更大',
      { allowLlm: true, semanticRewriter, resolver },
    );

    expect(semanticRewriter).toHaveBeenCalledOnce();
    expect(resolver).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      status: 'ready',
      targetCandidates: ['北方稀土', '宁德时代'],
      resolvedSymbols: [{ symbol: '600111' }, { symbol: '300750' }],
      timeRange: { label: '去年下半年', unit: 'date_range' },
      analysisFocus: { id: 'comparison', label: '标的对比' },
      capabilityHint: 'asset_comparison',
      execution: {
        strategy: 'hybrid_llm',
        llm: {
          attempted: true,
          applied: true,
          status: 'applied',
          provider: 'test-llm',
          model: 'test-model',
          semanticConfidence: 0.91,
          usage: { totalTokens: 160 },
        },
      },
    });
  });

  it('rejects LLM-invented targets before the symbol resolver', async () => {
    const resolver = vi.fn(async (target: string) => ({
      results: [{
        symbol: '600111',
        name: target,
        asset_type: 'stock',
        market: 'SH',
        secid: '1.600111',
      }],
    }));

    const result = await rewriteQuantQuery(
      '请分别分析北方稀土，同时解释它的主要风险',
      {
        allowLlm: true,
        resolver,
        semanticRewriter: async () => ({
          ok: true,
          provider: 'test-llm',
          model: 'test-model',
          data: {
            targetCandidates: ['北方稀土', '虚构证券'],
            timeRange: null,
            analysisFocusId: 'technical',
            outputIntent: 'dashboard',
            broadUniverse: false,
            confidence: 0.8,
          },
        }),
      },
    );

    expect(result.targetCandidates).toEqual(['北方稀土']);
    expect(resolver).toHaveBeenCalledOnce();
    expect(resolver).toHaveBeenCalledWith('北方稀土', 5);
  });

  it('falls back to the deterministic contract when LLM rewrite fails', async () => {
    const semanticRewriter = vi.fn(async () => ({
      ok: false as const,
      code: 'LLM_NETWORK_ERROR',
      provider: 'test-llm',
      model: 'test-model',
      retryable: true,
    }));
    const result = await rewriteQuantQuery(
      '请分别比较贵州茅台和宁德时代，同时说明趋势差异',
      {
        allowLlm: true,
        semanticRewriter,
        resolver: async (target) => ({
          results: [{
            symbol: target === '贵州茅台' ? '600519' : '300750',
            name: target,
            asset_type: 'stock',
            market: target === '贵州茅台' ? 'SH' : 'SZ',
            secid: `${target === '贵州茅台' ? '1.600519' : '0.300750'}`,
          }],
        }),
      },
    );

    expect(result.status).toBe('ready');
    expect(result.resolvedSymbols).toHaveLength(2);
    expect(result.execution).toMatchObject({
      strategy: 'deterministic_fallback',
      llm: {
        attempted: true,
        applied: false,
        status: 'failed',
        errorCode: 'LLM_NETWORK_ERROR',
      },
    });
  });

  it('never calls the LLM during a deterministic-only preview', async () => {
    const semanticRewriter = vi.fn();
    await rewriteQuantQuery(
      '请分别比较贵州茅台和宁德时代，同时说明趋势差异',
      {
        allowLlm: false,
        semanticRewriter,
        resolveTargets: false,
      },
    );

    expect(semanticRewriter).not.toHaveBeenCalled();
  });

  it('repairs a partial resolver miss through the LLM and resolves the cleaned target set again', async () => {
    const semanticRewriter = vi.fn(async () => ({
      ok: true as const,
      provider: 'test-llm',
      model: 'test-model',
      data: {
        targetCandidates: ['北方稀土', '宁德时代'],
        timeRange: null,
        analysisFocusId: 'comparison' as const,
        outputIntent: 'dashboard' as const,
        broadUniverse: false,
        confidence: 0.9,
      },
    }));
    let northAttempts = 0;
    const resolver = vi.fn(async (target: string) => {
      if (target === '北方稀土') {
        northAttempts += 1;
        if (northAttempts === 1) return { results: [] };
      }
      return {
        results: [{
          symbol: target === '北方稀土' ? '600111' : '300750',
          name: target,
          asset_type: 'stock',
          market: target === '北方稀土' ? 'SH' : 'SZ',
        }],
      };
    });

    const result = await rewriteQuantQuery('比较北方稀土和宁德时代的表现', {
      allowLlm: true,
      resolver,
      semanticRewriter,
    });

    expect(semanticRewriter).toHaveBeenCalledOnce();
    expect(northAttempts).toBe(2);
    expect(result).toMatchObject({
      status: 'ready',
      resolvedSymbols: [{ symbol: '600111' }, { symbol: '300750' }],
      execution: { strategy: 'hybrid_llm' },
    });
  });

  it('treats an explicit A-share screener as a broad universe without inventing a target', async () => {
    const resolver = vi.fn();
    const result = await rewriteQuantQuery('帮我筛选A股近20日涨幅前10且PE低于30的公司', {
      resolver,
    });

    expect(result).toMatchObject({
      status: 'ready',
      broadUniverse: true,
      targetCandidates: [],
      unresolvedTargets: [],
    });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('rejects financial screening criteria returned as LLM security targets', async () => {
    const resolver = vi.fn();
    const query = '筛选A股里2025年营收和净利润都增长、经营现金流质量较好的公司';
    const result = await rewriteQuantQuery(query, {
      allowLlm: true,
      resolver,
      semanticRewriter: async () => ({
        ok: true,
        provider: 'test-llm',
        model: 'test-model',
        data: {
          targetCandidates: [
            'A股里2025年营收和净利润都增长',
            '经营现金流质量较好的公司',
          ],
          timeRange: null,
          analysisFocusId: 'fundamental',
          outputIntent: 'dashboard',
          broadUniverse: true,
          confidence: 0.85,
        },
      }),
    });

    expect(result).toMatchObject({
      status: 'ready',
      broadUniverse: true,
      targetCandidates: [],
      unresolvedTargets: [],
    });
    expect(resolver).not.toHaveBeenCalled();
  });

  it('refuses guaranteed-return requests before resolver or LLM execution', async () => {
    const resolver = vi.fn();
    const semanticRewriter = vi.fn();
    const result = await rewriteQuantQuery('明天买哪只股票一定能涨停？', {
      allowLlm: true,
      resolver,
      semanticRewriter,
    });

    expect(result).toMatchObject({
      schemaVersion: 3,
      status: 'refused',
      safety: {
        decision: 'refuse',
        code: 'GUARANTEED_RETURN_REQUEST',
      },
      execution: {
        strategy: 'deterministic',
        llm: { attempted: false },
      },
    });
    expect(resolver).not.toHaveBeenCalled();
    expect(semanticRewriter).not.toHaveBeenCalled();
  });
});
