import { describe, expect, it } from 'vitest';
import {
  mapLocalKlineResponse,
  mapResearchMember,
  mapScreenerResponse,
} from './strategy-mappers';

describe('strategy response mappers', () => {
  it('normalizes research members and derives sector tags safely', () => {
    const member = mapResearchMember({
      symbol: '600519.SH',
      code: '600519',
      name: '贵州茅台',
      weight: '0.25',
      row_count: '120',
      is_st: 0,
      data_status: 'ready',
    });

    expect(member.weight).toBe(0.25);
    expect(member.rowCount).toBe(120);
    expect(member.isSt).toBe(false);
    expect(member.sectorTags).toContain('白酒');
  });

  it('derives K-line summaries when the backend omits aggregate fields', () => {
    const response = mapLocalKlineResponse({
      symbol: '000001.SZ',
      bars: [
        { ts: '2026-07-10', open: 10, high: 11, low: 9, close: 10, volume: 100 },
        { ts: '2026-07-11', open: 10, high: 13, low: 10, close: 12, volume: 150 },
      ],
    });

    expect(response.summary).toMatchObject({
      rowCount: 2,
      firstTs: '2026-07-10',
      lastTs: '2026-07-11',
      latestClose: 12,
      previousClose: 10,
      high: 13,
      low: 9,
      totalVolume: 250,
    });
    expect(response.summary.returnPct).toBe(20);
  });

  it('applies bounded defaults to incomplete screener responses', () => {
    const response = mapScreenerResponse({
      mode: 'unexpected',
      candidates: [{ symbol: '300750.SZ', score: '91.5', is_st: 'false' }],
    });

    expect(response.mode).toBe('short_term');
    expect(response.totalCandidates).toBe(1);
    expect(response.candidates[0]).toMatchObject({
      symbol: '300750.SZ',
      score: 91.5,
      isSt: false,
    });
  });
});
