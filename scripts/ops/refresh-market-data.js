#!/usr/bin/env node

const { spawnSync } = require('node:child_process');
const dotenv = require('dotenv');

const SHANGHAI_TIME_ZONE = 'Asia/Shanghai';

function loadEnvironment() {
  dotenv.config({ path: '.env', quiet: true });
  dotenv.config({ path: '.env.local', override: true, quiet: true });
}

function positiveInteger(name, fallback, { min = 1, max = 100_000 } = {}) {
  const value = Number.parseInt(process.env[name] ?? '', 10) || fallback;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`);
  }
  return value;
}

function nonNegativeNumber(name, fallback, max = 60) {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < 0 || value > max) {
    throw new Error(`${name} must be a number between 0 and ${max}.`);
  }
  return value;
}

function shanghaiDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDate(isoDate, days) {
  const value = new Date(`${isoDate}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function compactDate(isoDate) {
  return isoDate.replaceAll('-', '');
}

function parseArgs(argv) {
  return {
    calendarOnly: argv.includes('--calendar-only'),
    dryRun: argv.includes('--dry-run'),
    skipFreshness: argv.includes('--skip-freshness'),
  };
}

function requestHeaders() {
  const token = process.env.QUANTPILOT_MARKET_ADMIN_TOKEN?.trim();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

async function postJson(baseUrl, pathname, body, timeoutMs) {
  const url = new URL(pathname, `${baseUrl.replace(/\/$/, '')}/`).toString();
  const response = await fetch(url, {
    method: 'POST',
    headers: requestHeaders(),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text.slice(0, 2_000) };
  }
  if (!response.ok) {
    throw new Error(`${pathname} returned HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

async function getJson(baseUrl, pathname, timeoutMs) {
  const url = new URL(pathname, `${baseUrl.replace(/\/$/, '')}/`).toString();
  const response = await fetch(url, {
    headers: requestHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { raw: text.slice(0, 2_000) };
  }
  if (!response.ok) {
    throw new Error(`${pathname} returned HTTP ${response.status}: ${JSON.stringify(payload)}`);
  }
  return payload;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const TERMINAL_INGESTION_STATUSES = new Set(['completed', 'partial', 'failed', 'stopped']);
const ACTIVE_INGESTION_STATUSES = new Set([
  'pending',
  'running',
  'paused',
  'pause_requested',
  'resume_requested',
]);

async function waitForIngestionJob({ baseUrl, universeId, jobId, timeoutMs, pollIntervalMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const payload = await getJson(
      baseUrl,
      `/api/v1/ingestion/jobs?universe_id=${encodeURIComponent(universeId)}&limit=100`,
      Math.min(30_000, timeoutMs),
    );
    const job = Array.isArray(payload.jobs)
      ? payload.jobs.find((candidate) => candidate.id === jobId)
      : null;
    if (job && TERMINAL_INGESTION_STATUSES.has(job.status)) return job;
    await delay(pollIntervalMs);
  }
  await postJson(
    baseUrl,
    `/api/v1/ingestion/jobs/${encodeURIComponent(jobId)}/control`,
    { action: 'stop', reason: 'QuantPilot market maintenance timed out.' },
    30_000,
  ).catch(() => undefined);
  throw new Error(`Market ingestion job ${jobId} timed out after ${timeoutMs}ms.`);
}

async function runMaintenance(options = {}) {
  const today = options.today ?? shanghaiDate();
  const baseUrl = process.env.QUANTPILOT_MARKET_API_URL?.trim() || 'http://127.0.0.1:8000';
  const universeId = process.env.QUANTPILOT_MARKET_MAINTENANCE_UNIVERSE_ID?.trim()
    || 'a-share-sample-research-pool';
  const calendarLookbackDays = positiveInteger('QUANTPILOT_MARKET_CALENDAR_LOOKBACK_DAYS', 30);
  const historyLookbackDays = positiveInteger('QUANTPILOT_MARKET_HISTORY_LOOKBACK_DAYS', 14);
  const requestDelaySeconds = nonNegativeNumber(
    'QUANTPILOT_MARKET_MAINTENANCE_REQUEST_DELAY_SECONDS',
    0.2,
  );
  const batchDelaySeconds = nonNegativeNumber(
    'QUANTPILOT_MARKET_MAINTENANCE_BATCH_DELAY_SECONDS',
    0.7,
  );
  const calendarBody = {
    start: shiftDate(today, -calendarLookbackDays),
    // The Baostock refresh contract only accepts observed calendar dates.
    // Refresh through today; the freshness gate derives the latest completed
    // session from this authoritative window.
    end: today,
  };
  const historyBody = {
    universe_id: universeId,
    period: 'daily',
    adjustment: 'qfq',
    start: shiftDate(today, -historyLookbackDays),
    end: compactDate(today),
    limit: Math.max(30, historyLookbackDays * 2),
    lookback_years: 1,
    allow_fallback: false,
    request_delay_seconds: requestDelaySeconds,
    batch_delay_seconds: batchDelaySeconds,
    batch_size: positiveInteger('QUANTPILOT_MARKET_MAINTENANCE_BATCH_SIZE', 25, { max: 200 }),
    max_retries: positiveInteger('QUANTPILOT_MARKET_MAINTENANCE_MAX_RETRIES', 3, { max: 10 }),
    include_valuation_factors: false,
  };

  if (options.dryRun) {
    return { dryRun: true, baseUrl, calendarBody, historyBody };
  }

  console.log(`[market-maintenance] refreshing calendar ${calendarBody.start}..${calendarBody.end}`);
  const calendar = await postJson(
    baseUrl,
    '/api/v1/foundation/trading-calendar/refresh',
    calendarBody,
    positiveInteger('QUANTPILOT_MARKET_CALENDAR_TIMEOUT_MS', 120_000, { max: 900_000 }),
  );
  console.log(
    `[market-maintenance] calendar ready: written=${calendar.written_days ?? '-'}, open=${calendar.open_days ?? '-'}`,
  );

  let ingestion = null;
  if (!options.calendarOnly) {
    const ingestionTimeoutMs = positiveInteger(
      'QUANTPILOT_MARKET_INGESTION_TIMEOUT_MS',
      1_800_000,
      { max: 7_200_000 },
    );
    const pollIntervalMs = positiveInteger(
      'QUANTPILOT_MARKET_MAINTENANCE_POLL_INTERVAL_MS',
      2_000,
      { max: 60_000 },
    );
    const existing = await getJson(
      baseUrl,
      `/api/v1/ingestion/jobs?universe_id=${encodeURIComponent(universeId)}&limit=100`,
      30_000,
    );
    const activeJob = Array.isArray(existing.jobs)
      ? existing.jobs.find(
          (job) => job.provider === 'baostock-autofill' && ACTIVE_INGESTION_STATUSES.has(job.status),
        )
      : null;
    let jobId;
    if (activeJob) {
      jobId = activeJob.id;
      console.log(`[market-maintenance] resuming observation of active Baostock job=${jobId}`);
    } else {
      console.log(`[market-maintenance] starting Baostock daily/qfq autofill universe=${universeId} from=${historyBody.start}`);
      const started = await postJson(
        baseUrl,
        '/api/v1/ingestion/baostock/history/autofill',
        historyBody,
        120_000,
      );
      jobId = started.job_id;
    }
    if (typeof jobId !== 'string' || !jobId) {
      throw new Error('Baostock autofill did not return a job_id.');
    }
    ingestion = await waitForIngestionJob({
      baseUrl,
      universeId,
      jobId,
      timeoutMs: ingestionTimeoutMs,
      pollIntervalMs,
    });
    if (ingestion.status === 'failed' || Number(ingestion.completed_symbols ?? 0) === 0) {
      throw new Error(
        `Daily ingestion produced no usable symbols: status=${ingestion.status}, failed=${ingestion.failed_symbols ?? '-'}`,
      );
    }
    console.log(
      `[market-maintenance] daily/qfq ${ingestion.status}: symbols=${ingestion.completed_symbols ?? '-'}, failed=${ingestion.failed_symbols ?? '-'}, rows=${ingestion.rows_upserted ?? '-'}`,
    );
  }

  if (!options.skipFreshness && !options.calendarOnly) {
    const minimumSymbols = positiveInteger('QUANTPILOT_MARKET_FRESHNESS_MIN_SYMBOLS', 250);
    const gate = spawnSync(
      process.execPath,
      ['scripts/checks/check-market-data-freshness.js', '--min-symbols', String(minimumSymbols)],
      { cwd: process.cwd(), env: process.env, stdio: 'inherit' },
    );
    if (gate.error) throw gate.error;
    if (gate.status !== 0) throw new Error(`Market freshness gate exited with ${gate.status}.`);
  }

  return { dryRun: false, baseUrl, calendar, ingestion };
}

async function main() {
  loadEnvironment();
  const options = parseArgs(process.argv.slice(2));
  const result = await runMaintenance(options);
  if (options.dryRun) console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[market-maintenance] failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}

module.exports = { compactDate, parseArgs, runMaintenance, shanghaiDate, shiftDate };
