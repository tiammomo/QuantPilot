import { describe, expect, it } from 'vitest';
import {
  assessQuantIntentForClarification,
  buildClarificationContinuation,
  extractQuantTargetCandidates,
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
  ])('keeps a resolvable security name in %s', (instruction, expectedTarget) => {
    expect(extractQuantTargetCandidates(instruction)).toContain(expectedTarget);
    expect(
      assessQuantIntentForClarification({ instruction, capabilityId: 'stock_diagnosis' })
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
    expect(extractQuantTargetCandidates(instruction)).toEqual([]);
    expect(
      assessQuantIntentForClarification({ instruction, capabilityId: 'asset_comparison' })
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
    expect(
      assessQuantIntentForClarification({
        instruction: continuation?.resolvedInstruction ?? '',
        capabilityId: 'asset_comparison',
      })
    ).toMatchObject({ required: false, missing: [] });
  });
});
