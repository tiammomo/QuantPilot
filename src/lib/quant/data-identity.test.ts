import { describe, expect, it } from 'vitest';

import { assessQuantDatasetIdentity } from './data-identity';

function singleFinal(symbol = '600589') {
  return {
    runId: 'run-1',
    symbol,
    quote: { symbol },
    kline: { symbol },
    financials: { symbol },
  };
}

describe('quant dataset identity', () => {
  it('accepts a run-bound single-symbol dataset', () => {
    expect(assessQuantDatasetIdentity(
      { runId: 'run-1', symbols: ['600589'] },
      singleFinal(),
    )).toMatchObject({ ready: true, reasons: [], symbols: ['600589'] });
  });

  it('ignores empty optional dataset placeholders', () => {
    expect(assessQuantDatasetIdentity(
      { runId: 'run-1', symbols: ['600589'] },
      {
        ...singleFinal(),
        technicalIndicators: {},
        announcements: {},
      },
    )).toMatchObject({ ready: true, reasons: [] });
  });

  it('rejects a root label that hides quote or K-line data from another symbol', () => {
    const finalData = singleFinal();
    finalData.quote.symbol = '600519';
    finalData.kline.symbol = '600519';
    expect(assessQuantDatasetIdentity(
      { runId: 'run-1', symbols: ['600589'] },
      finalData,
    ).reasons).toEqual(expect.arrayContaining([
      'quote_symbol_mismatch',
      'kline_symbol_mismatch',
    ]));
  });

  it('requires exact ordered multi-symbol coverage and nested identities', () => {
    const plan = { runId: 'run-2', symbols: ['600519', '600589'] };
    const finalData = {
      runId: 'run-2',
      symbol: '600519',
      quote: { symbol: '600519' },
      kline: { symbol: '600519' },
      requestedSymbols: ['600519', '600589'],
      symbols: ['600519', '600589'],
      assets: [
        { symbol: '600519', quote: { symbol: '600519' }, kline: { symbol: '600519' } },
        { symbol: '600589', quote: { symbol: '600589' }, kline: { symbol: '600589' } },
      ],
      comparison: { rows: [{ symbol: '600519' }, { symbol: '600589' }] },
      selectionRanking: { rows: [{ symbol: '600519' }, { symbol: '600589' }] },
    };
    expect(assessQuantDatasetIdentity(plan, finalData).ready).toBe(true);

    finalData.assets[1].quote.symbol = '600519';
    finalData.selectionRanking.rows[1].symbol = '000001';
    const assessment = assessQuantDatasetIdentity(plan, finalData);
    expect(assessment.ready).toBe(false);
    expect(assessment.reasons).toEqual(expect.arrayContaining([
      'assets[1].quote_symbol_mismatch',
      'selectionRanking_symbols_mismatch',
    ]));
  });

  it('rejects stale final data from another planning run', () => {
    expect(assessQuantDatasetIdentity(
      { runId: 'run-current', symbols: ['600589'] },
      singleFinal(),
    ).reasons).toContain('final_run_id_mismatch');
  });
});
