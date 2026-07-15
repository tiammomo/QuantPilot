import { describe, expect, it } from 'vitest';
import {
  inferKnownSymbols,
  inferQuantSymbolsFromText,
  keepLongestDistinctTextCandidates,
  matchKnownSymbolAliases,
} from './symbol-aliases';

describe('known symbol alias matching', () => {
  it('keeps the longest ETF alias and rejects its overlapping index prefix', () => {
    const question = '510300 沪深300ETF 最近120天走势如何？';

    expect(matchKnownSymbolAliases(question)).toEqual([
      expect.objectContaining({ keyword: '沪深300ETF', symbol: '510300' }),
    ]);
    expect(inferKnownSymbols(question)).toEqual(['510300']);
    expect(inferQuantSymbolsFromText(question)).toEqual(['510300']);
  });

  it('applies the same longest-match rule to a spaced ETF name', () => {
    expect(inferKnownSymbols('分析沪深300 ETF最近走势')).toEqual(['510300']);
  });

  it('keeps distinct non-overlapping index and ETF mentions in text order', () => {
    expect(inferKnownSymbols('对比沪深300和沪深300ETF')).toEqual(['000300', '510300']);
  });

  it('matches latin alias suffixes without case sensitivity', () => {
    expect(inferKnownSymbols('分析300etf最近走势')).toEqual(['510300']);
  });

  it('drops shorter name fragments emitted alongside a containing candidate', () => {
    expect(keepLongestDistinctTextCandidates(['沪深300ETF', 'ETF', '宁德时代'])).toEqual([
      '沪深300ETF',
      '宁德时代',
    ]);
  });
});
