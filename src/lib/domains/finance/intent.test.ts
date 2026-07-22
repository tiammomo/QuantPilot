import { describe, expect, it } from 'vitest';
import {
  assessQuantIntentForClarification,
  buildClarificationContinuation,
} from './intent';

describe('quant intent clarification', () => {
  it.each([
    ['中信证券最近怎么样', '中信证券'],
    ['招商证券近期走势如何', '招商证券'],
    ['杭钢股份最近基本面怎么样', '杭钢股份'],
    ['中国平安公司最近怎么样', '中国平安公司'],
    ['有研新材最近怎么样', '有研新材'],
    ['大位科技这个股票怎么样', '大位科技'],
    ['大位科技这只股票如何', '大位科技'],
    ['大位科技这家公司最近怎么样', '大位科技'],
  ])('accepts a target already resolved by Query Rewrite in %s', (instruction) => {
    expect(
      assessQuantIntentForClarification({
        instruction,
        capabilityId: 'stock_diagnosis',
        symbols: ['600589'],
        semanticFocusId: 'comprehensive',
      })
    ).toMatchObject({ required: false, missing: [] });
  });

  it.each([
    '这个证券最近怎么样',
    '某家公司最近怎么样',
    '这个股票怎么样',
    '证券最近怎么样',
  ])('still requests a target for a generic placeholder in %s', (instruction) => {
    expect(
      assessQuantIntentForClarification({ instruction, capabilityId: 'stock_diagnosis' })
    ).toMatchObject({ required: true, missing: ['target'] });
  });

  it('uses the default comprehensive diagnosis for a named security and a broad goal', () => {
    const result = assessQuantIntentForClarification({
      instruction: '中信证券最近怎么样',
      capabilityId: 'stock_diagnosis',
      symbols: ['600030'],
    });

    expect(result.defaults).toEqual(
      expect.arrayContaining([
        '未指定时间范围时默认使用最近 120 个交易日或最近报告期。',
        '未指定输出形式时默认生成可验证的量化看板。',
      ])
    );
  });

  it('does not count generic quantity phrases as comparison targets', () => {
    const instruction = '帮我对比几只股票，生成看板。';
    expect(
      assessQuantIntentForClarification({ instruction, capabilityId: 'asset_comparison' })
    ).toMatchObject({
      required: true,
      missing: ['comparison_universe'],
    });
  });

  it('uses only the LLM broad-universe decision for unnamed stock selection', () => {
    const instruction = '帮我推荐6月3日要买的股票，给我推荐10个。';

    expect(assessQuantIntentForClarification({
      instruction,
      capabilityId: 'asset_comparison',
      semanticFocusId: 'comparison',
      broadUniverse: false,
    }).missing).toContain('comparison_universe');

    expect(assessQuantIntentForClarification({
      instruction,
      capabilityId: 'asset_comparison',
      semanticFocusId: 'comparison',
      broadUniverse: true,
    })).toMatchObject({ required: false, missing: [] });
  });

  it('counts an ETF name and its overlapping index prefix as one comparison target', () => {
    expect(
      assessQuantIntentForClarification({
        instruction: '对比510300沪深300ETF的近期表现',
        capabilityId: 'asset_comparison',
      })
    ).toMatchObject({
      required: true,
      missing: ['comparison_universe'],
    });
  });

  it('builds a continuation after the user supplies comparison targets', () => {
    const originalQuestion = '帮我对比几只股票，生成看板。';
    const clarification = assessQuantIntentForClarification({
      instruction: originalQuestion,
      capabilityId: 'asset_comparison',
    });
    const continuation = buildClarificationContinuation({
      previousPlan: {
        runId: 'first-run',
        status: 'needs_clarification',
        capabilityId: 'asset_comparison',
        question: originalQuestion,
        clarification,
      },
      instruction: '贵州茅台、平安银行、宁德时代，最近120个交易日，综合比较趋势、回撤和财务质量。',
      capabilityId: 'asset_comparison',
    });

    expect(continuation).toMatchObject({
      previousRunId: 'first-run',
      originalQuestion,
    });
    expect(continuation?.resolvedInstruction).toContain('贵州茅台');
  });

  it('does not inherit stale clarification state during project reinitialization', () => {
    const originalQuestion = '帮我对比几只股票，生成看板。';
    const clarification = assessQuantIntentForClarification({
      instruction: originalQuestion,
      capabilityId: 'asset_comparison',
    });

    expect(buildClarificationContinuation({
      previousPlan: {
        runId: 'stale-clarification-run',
        status: 'needs_clarification',
        capabilityId: 'asset_comparison',
        question: originalQuestion,
        clarification,
      },
      instruction: '分析贵州茅台近 60 个交易日的趋势、量能、估值与主要风险。',
      capabilityId: 'stock_diagnosis',
      reset: true,
    })).toBeNull();
  });

  it('passes a possible new question to the next LLM rewrite with the prior context', () => {
    const originalQuestion = '帮我对比几只股票，生成看板。';
    const clarification = assessQuantIntentForClarification({
      instruction: originalQuestion,
      capabilityId: 'asset_comparison',
    });

    expect(buildClarificationContinuation({
      previousPlan: {
        runId: 'first-run',
        status: 'needs_clarification',
        capabilityId: 'asset_comparison',
        question: originalQuestion,
        clarification,
      },
      instruction: '看看平安',
      capabilityId: 'stock_diagnosis',
    })?.resolvedInstruction).toContain('看看平安');
  });

  it('passes a new recommendation response through the safety and LLM rewrite pipeline', () => {
    const clarification = assessQuantIntentForClarification({
      instruction: '看看平安',
      capabilityId: 'stock_diagnosis',
    });

    expect(buildClarificationContinuation({
      previousPlan: {
        runId: 'ambiguous-stock-run',
        status: 'needs_clarification',
        capabilityId: 'stock_diagnosis',
        question: '看看平安',
        clarification,
      },
      instruction: '给我推荐一只明天保证涨停、稳赚不赔的股票',
      capabilityId: 'stock_diagnosis',
    })?.resolvedInstruction).toContain('保证涨停');
  });

  it('accepts a compact response that directly supplies missing comparison symbols', () => {
    const originalQuestion = '帮我对比几只股票，生成看板。';
    const clarification = assessQuantIntentForClarification({
      instruction: originalQuestion,
      capabilityId: 'asset_comparison',
    });

    expect(buildClarificationContinuation({
      previousPlan: {
        runId: 'first-run',
        status: 'needs_clarification',
        capabilityId: 'asset_comparison',
        question: originalQuestion,
        clarification,
      },
      instruction: '600111 和 300750',
      capabilityId: 'asset_comparison',
    })?.resolvedInstruction).toContain('600111 和 300750');
  });

  it('uses authoritative rewrite focus to avoid a redundant financial-goal clarification', () => {
    expect(assessQuantIntentForClarification({
      instruction: '北方稀土2025年年报里，经营现金流增速是否跑赢净利润？',
      capabilityId: 'fundamental_analysis',
      symbols: ['600111'],
      semanticFocusId: 'fundamental',
    })).toMatchObject({ required: false, missing: [] });
  });
});
