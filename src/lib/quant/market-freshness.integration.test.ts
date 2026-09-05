import { createRequire } from 'node:module';
import { PrismaClient } from '@prisma/client';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { readFreshnessSnapshot, evaluateFreshness } = require('../../../scripts/checks/check-market-data-freshness.js');
const databaseUrl = process.env.PI_AGENT_TEST_DATABASE_URL?.trim();

describe.skipIf(!databaseUrl)('market freshness SQL (PostgreSQL integration)', () => {
  it('uses past open sessions on holidays and excludes future-dated bars', async () => {
    const prisma = new PrismaClient({ datasourceUrl: databaseUrl! });
    const rollback = new Error('rollback isolated market fixture');
    try {
      // These query-contract tables live only in this transaction. The test
      // runner provisions application migrations in a disposable database;
      // it does not require the market service or the Timescale extension.
      await expect(prisma.$transaction(async (transaction) => {
        await transaction.$executeRawUnsafe('CREATE SCHEMA IF NOT EXISTS quant');
        await transaction.$executeRawUnsafe(`CREATE TABLE quant.trading_calendars (
          market text, session text, trade_date date, is_open boolean
        )`);
        await transaction.$executeRawUnsafe(`CREATE TABLE quant.canonical_stock_bars (
          symbol text, ts timestamptz, timeframe text, adjustment text
        )`);
        await transaction.$executeRawUnsafe(`INSERT INTO quant.trading_calendars VALUES
          ('CN-A', 'regular', '2019-12-31', true),
          ('CN-A', 'regular', '2020-01-01', false),
          ('CN-A', 'regular', '2020-01-02', true),
          ('CN-A', 'regular', '2020-12-31', true)
        `);
        await transaction.$executeRawUnsafe(`INSERT INTO quant.canonical_stock_bars VALUES
          ('fixture', '2019-12-31 15:00:00+08', 'daily', 'qfq'),
          ('future-fixture', '2020-01-02 15:00:00+08', 'daily', 'qfq')
        `);
        const snapshot = await readFreshnessSnapshot(transaction, '2020-01-01');
        expect(snapshot).toEqual({
          calendarThrough: '2020-12-31', latestOpenDate: '2019-12-31',
          latestBarDate: '2019-12-31', symbolsAtLatest: 1,
        });
        expect(evaluateFreshness(snapshot, { estimatedDate: '2020-01-01' })).toMatchObject({
          ok: true, expectedBarDate: '2019-12-31', barLagSessions: 0,
        });

        await transaction.$executeRawUnsafe("DELETE FROM quant.canonical_stock_bars WHERE symbol = 'fixture'");
        const futureOnly = await readFreshnessSnapshot(transaction, '2020-01-01');
        expect(futureOnly.latestBarDate).toBeNull();
        expect(evaluateFreshness(futureOnly, { estimatedDate: '2020-01-01' }).ok).toBe(false);
        throw rollback;
      })).rejects.toBe(rollback);
    } finally {
      await prisma.$disconnect();
    }
  });
});
