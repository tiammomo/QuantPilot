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

  it('maps stock diagnosis through the capability contract', () => {
    expect(inferExpectedTemplateFromTask({
      capabilityId: 'stock_diagnosis',
      question: '分析贵州茅台。',
      symbols: ['600519'],
    })).toBe('single-stock-diagnosis');
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

  it('fails closed instead of inferring a template from keywords', () => {
    expect(inferExpectedTemplateFromTask({
      question: '比较贵州茅台和五粮液。',
      symbols: ['600519', '000858'],
    })).toBeNull();
  });
});
