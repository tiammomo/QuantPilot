import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  countWeekdaySessions,
  estimateLatestCompletedTradeDate,
  evaluateFreshness,
} = require('../../../scripts/checks/check-market-data-freshness.js');

describe('market data freshness check', () => {
  it('uses the previous weekday before the daily bar ready hour', () => {
    expect(estimateLatestCompletedTradeDate(new Date('2026-07-17T09:59:00.000Z'))).toBe(
      '2026-07-16'
    );
  });

  it('uses Friday as the latest completed session during a weekend', () => {
    expect(estimateLatestCompletedTradeDate(new Date('2026-07-18T04:00:00.000Z'))).toBe(
      '2026-07-17'
    );
  });

  it('counts weekday sessions between two dates', () => {
    expect(countWeekdaySessions('2026-07-13', '2026-07-17')).toBe(4);
    expect(countWeekdaySessions('2026-07-17', '2026-07-20')).toBe(1);
  });

  it('fails when a stale calendar would otherwise mask stale bars', () => {
    const result = evaluateFreshness(
      {
        calendarThrough: '2026-07-14',
        latestOpenDate: '2026-07-14',
        latestBarDate: '2026-07-13',
        symbolsAtLatest: 298,
      },
      { estimatedDate: '2026-07-17' }
    );

    expect(result).toMatchObject({
      ok: false,
      calendarCovered: false,
      expectedBarDate: '2026-07-17',
      barLagSessions: 4,
    });
  });

  it('uses a covered calendar so exchange holidays do not cause false failures', () => {
    const result = evaluateFreshness(
      {
        calendarThrough: '2026-10-08',
        latestOpenDate: '2026-09-30',
        latestBarDate: '2026-09-30',
        symbolsAtLatest: 300,
      },
      { estimatedDate: '2026-10-08' }
    );

    expect(result).toMatchObject({
      ok: true,
      calendarCovered: true,
      expectedBarDate: '2026-09-30',
      barLagSessions: 0,
    });
  });
});
