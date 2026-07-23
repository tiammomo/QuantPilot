import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  compactDate,
  parseArgs,
  runMaintenance,
  shanghaiDate,
  shiftDate,
} = require('../../../scripts/ops/refresh-market-data.js');

describe('market maintenance scheduler', () => {
  it('uses Shanghai calendar dates', () => {
    expect(shanghaiDate(new Date('2026-07-21T16:30:00.000Z'))).toBe('2026-07-22');
  });

  it('builds stable ISO and provider dates', () => {
    expect(shiftDate('2026-07-22', -14)).toBe('2026-07-08');
    expect(compactDate('2026-07-22')).toBe('20260722');
  });

  it('never asks the calendar provider for future dates', async () => {
    const result = await runMaintenance({ today: '2026-07-22', dryRun: true });
    expect(result.calendarBody.end).toBe('2026-07-22');
  });

  it('parses safe operational modes', () => {
    expect(parseArgs(['--dry-run', '--calendar-only'])).toEqual({
      calendarOnly: true,
      dryRun: true,
      skipFreshness: false,
    });
  });
});
