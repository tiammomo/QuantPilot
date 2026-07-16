import { describe, expect, it } from 'vitest';

import { evaluateOracleAssertions } from './oracles';

describe('evaluation factual oracles', () => {
  it('evaluates numeric, structural and forbidden-language assertions', () => {
    const result = evaluateOracleAssertions({
      assertions: [
        { id: 'symbol', target: 'finalData', path: 'symbol', operator: 'equals', value: '600030' },
        { id: 'bars', target: 'finalData', path: 'kline.bars', operator: 'length_gte', value: 2 },
        { id: 'unsafe', target: 'page', operator: 'not_matches', value: '稳赚|保证收益' },
      ],
      targets: {
        finalData: { symbol: '600030', kline: { bars: [{}, {}] } },
        sources: {},
        quality: {},
        page: '本页面只提供研究信息，不构成投资建议。',
      },
    });
    expect(result).toMatchObject({ passed: true, warning: false });
    expect(result.checks).toHaveLength(3);
    expect(result.checks[2]).toMatchObject({
      target: 'page',
      operator: 'not_matches',
    });
  });

  it('separates warning assertions from hard oracle failures', () => {
    const result = evaluateOracleAssertions({
      assertions: [{
        id: 'optional-copy',
        target: 'page',
        operator: 'contains',
        value: '数据截止',
        severity: 'warning',
      }],
      targets: { finalData: {}, sources: {}, quality: {}, page: '暂无截止时间' },
    });
    expect(result.passed).toBe(true);
    expect(result.warning).toBe(true);
  });
});
