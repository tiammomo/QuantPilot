#!/usr/bin/env node

const { PrismaClient } = require('@prisma/client');
const dotenv = require('dotenv');

const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';
const DAILY_BAR_READY_HOUR = 18;
const CN_CALENDAR_MARKETS = ['CN-A', 'SSE', 'SZSE', 'BSE'];

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function parseDate(value) {
  if (!value) return null;
  const parsed = new Date(`${String(value).slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function previousWeekday(date) {
  const candidate = new Date(date);
  do {
    candidate.setUTCDate(candidate.getUTCDate() - 1);
  } while (candidate.getUTCDay() === 0 || candidate.getUTCDay() === 6);
  return candidate;
}

function shanghaiDateTimeParts(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function estimateLatestCompletedTradeDate(now = new Date()) {
  const parts = shanghaiDateTimeParts(now);
  let candidate = new Date(
    Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day))
  );
  if (Number(parts.hour) < DAILY_BAR_READY_HOUR) {
    candidate = previousWeekday(candidate);
  } else {
    while (candidate.getUTCDay() === 0 || candidate.getUTCDay() === 6) {
      candidate = previousWeekday(candidate);
    }
  }
  return formatDate(candidate);
}

function countWeekdaySessions(fromExclusive, toInclusive) {
  const from = parseDate(fromExclusive);
  const to = parseDate(toInclusive);
  if (!from || !to || from >= to) return 0;
  let count = 0;
  const cursor = new Date(from);
  while (cursor < to) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (cursor.getUTCDay() !== 0 && cursor.getUTCDay() !== 6) count += 1;
  }
  return count;
}

function evaluateFreshness(snapshot, options = {}) {
  const maxLagSessions = Math.max(0, Number(options.maxLagSessions ?? 0));
  const minSymbols = Math.max(0, Number(options.minSymbols ?? 1));
  const estimatedDate = options.estimatedDate ?? estimateLatestCompletedTradeDate(options.now);
  const calendarThrough = snapshot.calendarThrough ?? null;
  const latestOpenDate = snapshot.latestOpenDate ?? null;
  const latestBarDate = snapshot.latestBarDate ?? null;
  const calendarCovered = Boolean(calendarThrough && calendarThrough >= estimatedDate);
  const expectedBarDate =
    calendarCovered && latestOpenDate && latestOpenDate <= estimatedDate
      ? latestOpenDate
      : estimatedDate;
  const calendarLagSessions = calendarCovered
    ? 0
    : countWeekdaySessions(calendarThrough, estimatedDate);
  const barLagSessions = latestBarDate
    ? countWeekdaySessions(latestBarDate, expectedBarDate)
    : Number.POSITIVE_INFINITY;
  const barCovered = Boolean(
    latestBarDate &&
      latestBarDate >= expectedBarDate
  );
  const symbolCoverageMet = Number(snapshot.symbolsAtLatest ?? 0) >= minSymbols;
  const ok = calendarCovered && (barCovered || barLagSessions <= maxLagSessions) && symbolCoverageMet;

  return {
    ok,
    estimatedDate,
    expectedBarDate,
    calendarCovered,
    calendarLagSessions,
    barCovered,
    barLagSessions,
    maxLagSessions,
    minSymbols,
    symbolCoverageMet,
    ...snapshot,
  };
}

function parseArgs(argv) {
  const result = {
    json: false,
    maxLagSessions: 0,
    minSymbols: Number(process.env.QUANTPILOT_MARKET_FRESHNESS_MIN_SYMBOLS ?? 1),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      result.json = true;
      continue;
    }
    if (arg === '--max-lag-sessions') {
      result.maxLagSessions = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith('--max-lag-sessions=')) {
      result.maxLagSessions = Number(arg.split('=', 2)[1]);
      continue;
    }
    if (arg === '--min-symbols') {
      result.minSymbols = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg.startsWith('--min-symbols=')) {
      result.minSymbols = Number(arg.split('=', 2)[1]);
    }
  }
  if (!Number.isInteger(result.maxLagSessions) || result.maxLagSessions < 0) {
    throw new Error('--max-lag-sessions 必须是非负整数。');
  }
  if (!Number.isInteger(result.minSymbols) || result.minSymbols < 1) {
    throw new Error('--min-symbols 必须是正整数。');
  }
  return result;
}

function loadEnvironment() {
  dotenv.config({ path: '.env', quiet: true });
  dotenv.config({ path: '.env.local', override: true, quiet: true });
}

async function readFreshnessSnapshot(prisma) {
  const [calendarRows, barRows] = await Promise.all([
    prisma.$queryRawUnsafe(
      `
        SELECT
          max(trade_date)::text AS "calendarThrough",
          max(trade_date) FILTER (WHERE is_open IS TRUE)::text AS "latestOpenDate"
        FROM quant.trading_calendars
        WHERE market = ANY($1::text[])
          AND session = 'regular'
      `,
      CN_CALENDAR_MARKETS
    ),
    prisma.$queryRawUnsafe(
      `
        WITH latest AS (
          SELECT max(timezone('Asia/Shanghai', ts)::date) AS trade_date
          FROM quant.canonical_stock_bars
          WHERE timeframe = 'daily'
            AND adjustment = 'qfq'
        )
        SELECT
          latest.trade_date::text AS "latestBarDate",
          count(DISTINCT bars.symbol)::int AS "symbolsAtLatest"
        FROM latest
        LEFT JOIN quant.canonical_stock_bars bars
          ON timezone('Asia/Shanghai', bars.ts)::date = latest.trade_date
         AND bars.timeframe = 'daily'
         AND bars.adjustment = 'qfq'
        GROUP BY latest.trade_date
      `
    ),
  ]);
  return {
    calendarThrough: calendarRows[0]?.calendarThrough ?? null,
    latestOpenDate: calendarRows[0]?.latestOpenDate ?? null,
    latestBarDate: barRows[0]?.latestBarDate ?? null,
    symbolsAtLatest: Number(barRows[0]?.symbolsAtLatest ?? 0),
  };
}

function printResult(result, json) {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const lag = Number.isFinite(result.barLagSessions) ? result.barLagSessions : 'unknown';
  if (result.ok) {
    console.log(
      `[market-freshness] ok: expected=${result.expectedBarDate}, bars=${result.latestBarDate}, symbols=${result.symbolsAtLatest}/${result.minSymbols}, lag=${lag}`
    );
    return;
  }
  console.error(
    `[market-freshness] stale: expected=${result.expectedBarDate}, bars=${result.latestBarDate ?? '-'}, lag=${lag}, symbols=${result.symbolsAtLatest}/${result.minSymbols}`
  );
  if (!result.calendarCovered) {
    console.error(
      `交易日历仅覆盖到 ${result.calendarThrough ?? '-'}，工作日估算要求覆盖到 ${result.estimatedDate}。`
    );
    console.error('先刷新交易日历，再通过策略平台补数任务同步 daily/qfq 日线。');
  } else {
    console.error('通过策略平台补数任务同步 daily/qfq 日线。');
  }
  if (!result.symbolCoverageMet) {
    console.error(`最新交易日标的覆盖不足：要求至少 ${result.minSymbols}，实际 ${result.symbolsAtLatest}。`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  loadEnvironment();
  const prisma = new PrismaClient();
  try {
    const snapshot = await readFreshnessSnapshot(prisma);
    const result = evaluateFreshness(snapshot, {
      maxLagSessions: args.maxLagSessions,
      minSymbols: args.minSymbols,
    });
    printResult(result, args.json);
    if (!result.ok) process.exitCode = 1;
  } finally {
    await prisma.$disconnect().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[market-freshness] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

module.exports = {
  countWeekdaySessions,
  estimateLatestCompletedTradeDate,
  evaluateFreshness,
};
