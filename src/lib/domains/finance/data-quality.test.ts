import { describe, expect, it } from 'vitest';
import { assessQuantDashboardData, assessQuantDataResponse } from './data-quality';

function payload() {
  return {
    symbol: '600519', period: 'daily', adjustment: 'qfq', as_of: '2026-01-03',
    data_quality: { status: 'ok' },
    bars: [1, 2, 3].map(day => ({ date: `2026-01-0${day}`, open: '10', high: '12', low: '9', close: '11', volume: '100' })),
  };
}
const assess = (data: unknown) => assessQuantDataResponse({
  path: '/api/v1/quotes/history/600519', query: { period: 'daily', adjustment: 'qfq' }, payload: data,
});

describe('observed market data consistency', () => {
  it('accepts decimal strings and records sample coverage', () => {
    expect(assess(payload())).toMatchObject({ status: 'passed', usable: true, rowCount: 3 });
  });
  it('does not confuse the same code on different exchanges', () => {
    const result = assessQuantDataResponse({
      path: '/api/v1/quotes/history/000001.SH',
      payload: { ...payload(), symbol: '000001', market: 'SZ' },
    });
    expect(result.issues.map(issue => issue.code)).toContain('market_mismatch');
  });
  it('rejects impossible calendar dates and makes unavailable quotes explicit', () => {
    const data = payload();
    data.bars[0].date = '2026-02-30';
    expect(assess(data).issues.map(issue => issue.code)).toContain('bar_time_invalid');
    expect(assessQuantDataResponse({ path: '/api/v1/quotes/realtime/600519', payload: { symbol: '600519', price: null } }))
      .toMatchObject({ status: 'warning', usable: false });
  });
  it.each([
    ['symbol_mismatch', (data: ReturnType<typeof payload>) => { data.symbol = '000001'; }],
    ['adjustment_mismatch', (data: ReturnType<typeof payload>) => { data.adjustment = 'none'; }],
    ['period_mismatch', (data: ReturnType<typeof payload>) => { data.period = 'weekly'; }],
    ['duplicate_bar_time', (data: ReturnType<typeof payload>) => { data.bars[1].date = data.bars[0].date; }],
    ['bar_time_out_of_order', (data: ReturnType<typeof payload>) => { data.bars.reverse(); }],
    ['bar_after_as_of', (data: ReturnType<typeof payload>) => { data.as_of = '2026-01-02'; }],
    ['bar_time_invalid', (data: ReturnType<typeof payload>) => { data.bars[0].date = 'yesterday'; }],
    ['invalid_market_number', (data: ReturnType<typeof payload>) => { data.bars[0].close = 'NaN'; }],
    ['invalid_market_number', (data: ReturnType<typeof payload>) => { data.bars[0].volume = '-1'; }],
    ['invalid_ohlc_range', (data: ReturnType<typeof payload>) => { data.bars[0].low = '13'; }],
    ['price_outside_ohlc_range', (data: ReturnType<typeof payload>) => { data.bars[0].close = '99'; }],
    ['source_quality_error', (data: ReturnType<typeof payload>) => { data.data_quality.status = 'error'; }],
  ])('rejects %s rather than trusting source status', (code, mutate) => {
    const data = payload();
    mutate(data);
    const result = assess(data);
    expect(result.status).toBe('failed');
    expect(result.issues.map(issue => issue.code)).toContain(code);
  });
  it('preserves an explicit empty result as unusable data with warnings', () => {
    expect(assess({ ...payload(), bars: [] })).toMatchObject({ status: 'warning', usable: false, rowCount: 0 });
    expect(assess({ ...payload(), data_quality: { status: 'warning', stale: true } }).issues.map(issue => issue.code))
      .toContain('source_stale');
  });
  it('checks intraday timestamps instead of collapsing them to trade dates', () => {
    const data = { ...payload(), bars: [1, 2].map(hour => ({
      ts: `2026-01-03T0${hour}:00:00Z`, trade_date: '2026-01-03', close: '10',
    })) };
    expect(assess(data).status).toBe('passed');
  });
  it('checks every asset and limits diagnostic size', () => {
    const data = payload();
    data.bars = Array.from({ length: 100 }, () => ({ ...data.bars[0], close: 'bad' }));
    const result = assessQuantDashboardData({ symbol: '600519', assets: [{ symbol: '600519', kline: data }] })[0];
    expect(result.status).toBe('failed');
    expect(result.issueCount).toBeGreaterThan(24);
    expect(result.issues).toHaveLength(24);
  });
});
