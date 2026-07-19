import { describe, expect, it } from 'vitest';

import { inferExpectedTemplateFromTask } from './validation';

describe('validation template intent', () => {
  it('keeps strategy research on its capability template even when the query mentions candidates', () => {
    expect(inferExpectedTemplateFromTask({
      capabilityId: 'strategy_research',
      question: '研究 A 股低波动与红利因子的候选筛选思路。',
      symbols: [],
    })).toBe('strategy-research');
  });

  it('keeps a multi-symbol portfolio on holding analysis', () => {
    expect(inferExpectedTemplateFromTask({
      capabilityId: 'portfolio_risk',
      question: '分析三只股票构成的等权组合风险。',
      symbols: ['600519', '300750', '600036'],
    })).toBe('holding-analysis');
  });

  it('uses stock selection for an explicit comparison capability', () => {
    expect(inferExpectedTemplateFromTask({
      capabilityId: 'asset_comparison',
      question: '对比贵州茅台和五粮液。',
      symbols: ['600519', '000858'],
    })).toBe('stock-selection');
  });

  it('uses keyword inference only for a legacy plan without a capability', () => {
    expect(inferExpectedTemplateFromTask({
      question: '比较贵州茅台和五粮液。',
      symbols: ['600519', '000858'],
    })).toBe('stock-selection');
  });
});
