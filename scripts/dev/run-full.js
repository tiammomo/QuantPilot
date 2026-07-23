#!/usr/bin/env node

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const dotenv = require('dotenv');
const { parseCliArgs, startWebDevServer } = require('./run-web');

const rootDir = path.join(__dirname, '..', '..');
const marketDataDir = path.join(rootDir, 'services', 'market-data');
const isWindows = os.platform() === 'win32';

dotenv.config({
  path: [path.join(rootDir, '.env.local'), path.join(rootDir, '.env')],
});

function envFlag(name, fallback) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(value)) return false;
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(value)) return true;
  return fallback;
}

function shouldRunMarketApi() {
  return (
    process.env.QUANTPILOT_DEGRADATION_MODE?.trim().toLowerCase() !== 'offline' &&
    envFlag('QUANTPILOT_MARKET_API_ENABLED', true)
  );
}

function shouldRunGenerationWorker() {
  return (
    process.env.MOAGENT_DISPATCH_MODE?.trim().toLowerCase() === 'worker' &&
    envFlag('QUANTPILOT_DEV_MANAGE_GENERATION_WORKER', true)
  );
}

function marketApiUrl() {
  return (
    process.env.QUANTPILOT_MARKET_API_URL ||
    process.env.QUANTPILOT_MARKET_API_BASE_URL ||
    `http://127.0.0.1:${process.env.QUANTPILOT_MARKET_PORT || '8000'}`
  ).replace(/\/$/, '');
}

async function probeHealth(url, timeoutMs = 1200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${url}/health`, {
      cache: 'no-store',
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stopChild(child) {
  if (!child?.pid) return;
  try {
    if (isWindows) {
      child.kill('SIGTERM');
    } else {
      process.kill(-child.pid, 'SIGTERM');
    }
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // 子进程已经退出。
    }
  }
}

async function startMarketApiIfNeeded() {
  if (!shouldRunMarketApi()) {
    console.log('↪️  Market API disabled by degradation configuration.');
    return { child: null, managed: false };
  }

  const url = marketApiUrl();
  if (await probeHealth(url)) {
    process.env.QUANTPILOT_MARKET_API_ENABLED = '1';
    console.log(`✅ Market API already healthy at ${url}`);
    return { child: null, managed: false };
  }

  const parsedUrl = new URL(url);
  const host = parsedUrl.hostname || '127.0.0.1';
  const port = parsedUrl.port || '8000';
  const noProxy = [process.env.NO_PROXY, process.env.no_proxy, '127.0.0.1', 'localhost']
    .filter(Boolean)
    .join(',');

  console.log(`🚀 Starting market-data service on ${url}`);
  const child = spawn(
    'uv',
    ['run', '--extra', 'baostock', '--extra', 'akshare', 'quantpilot-market-api'],
    {
      cwd: marketDataDir,
      stdio: 'inherit',
      shell: isWindows,
      detached: !isWindows,
      env: {
        ...process.env,
        NO_PROXY: noProxy,
        no_proxy: noProxy,
        QUANTPILOT_MARKET_HOST: host,
        QUANTPILOT_MARKET_PORT: port,
      },
    }
  );

  child.once('error', (error) => {
    console.error(`❌ Failed to start market-data: ${error.message}`);
  });

  for (let attempt = 1; attempt <= 40; attempt += 1) {
    if (await probeHealth(url)) {
      process.env.QUANTPILOT_MARKET_API_ENABLED = '1';
      console.log(`✅ Market API ready at ${url}`);
      return { child, managed: true };
    }
    if (child.exitCode !== null) {
      throw new Error(`market-data exited before becoming ready (code ${child.exitCode})`);
    }
    await delay(500);
  }

  stopChild(child);
  throw new Error(`market-data did not become healthy within 20 seconds: ${url}/health`);
}

function startGenerationWorkerIfNeeded() {
  if (!shouldRunGenerationWorker()) {
    console.log('↪️  Generation dispatch uses inline mode or an externally managed Worker.');
    return { child: null, managed: false };
  }
  console.log('🚀 Starting durable Data Agent generation Worker');
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'scripts/workers/generation-worker.ts'],
    {
      cwd: rootDir,
      stdio: 'inherit',
      shell: false,
      detached: !isWindows,
      env: process.env,
    }
  );
  child.once('error', (error) => {
    console.error(`❌ Failed to start generation Worker: ${error.message}`);
  });
  return { child, managed: true };
}

async function main() {
  const { preferredPort, passthrough } = parseCliArgs(process.argv.slice(2));
  const market = await startMarketApiIfNeeded();
  let web;
  let worker = { child: null, managed: false };

  try {
    web = await startWebDevServer({ preferredPort, passthrough, stdio: 'inherit' });
    worker = startGenerationWorkerIfNeeded();
  } catch (error) {
    if (market.managed) stopChild(market.child);
    if (worker.managed) stopChild(worker.child);
    throw error;
  }

  let shuttingDown = false;
  const shutdown = (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    stopChild(web.child);
    if (market.managed) stopChild(market.child);
    if (worker.managed) stopChild(worker.child);
    setTimeout(() => process.exit(exitCode), 250).unref();
  };

  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  web.child.on('exit', (code) => {
    if (!shuttingDown) shutdown(typeof code === 'number' ? code : 1);
  });
  if (market.managed) {
    market.child.on('exit', (code) => {
      if (!shuttingDown) {
        console.error(`❌ market-data exited unexpectedly (code ${code ?? 'unknown'})`);
        shutdown(typeof code === 'number' && code !== 0 ? code : 1);
      }
    });
  }
  if (worker.managed) {
    worker.child.on('exit', (code) => {
      if (!shuttingDown) {
        console.error(`❌ generation Worker exited unexpectedly (code ${code ?? 'unknown'})`);
        shutdown(typeof code === 'number' && code !== 0 ? code : 1);
      }
    });
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('\n❌ Failed to launch QuantPilot development stack');
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

module.exports = {
  envFlag,
  marketApiUrl,
  probeHealth,
  shouldRunMarketApi,
  shouldRunGenerationWorker,
  startGenerationWorkerIfNeeded,
  startMarketApiIfNeeded,
};
