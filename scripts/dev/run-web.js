#!/usr/bin/env node

/**
 * Next.js development server launcher with automatic port management.
 * Expects scripts/dev/setup-env.js to have been executed beforehand.
 */

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const net = require('net');
const dotenv = require('dotenv');
const { ensureEnvironment } = require('./setup-env');
const { PrismaClient } = require('@prisma/client');
const { buildStableCss } = require('../build/build-stable-css');

const rootDir = path.join(__dirname, '..', '..');
const isWindows = os.platform() === 'win32';
const nextDevLockFile = path.join(rootDir, '.next', 'dev', 'lock');
const nextEnvFile = path.join(rootDir, 'next-env.d.ts');
const nextBuildRouteTypesFile = path.join(rootDir, '.next', 'types', 'routes.d.ts');
const nextDevRouteTypesFile = path.join(rootDir, '.next', 'dev', 'types', 'routes.d.ts');
const nextEnvStableContent = `/// <reference types="next" />
/// <reference types="next/image-types/global" />
/// <reference types="next/navigation-types/compat/navigation" />
import "./.next/types/routes.d.ts";

// NOTE: This file should not be edited
// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.
`;

dotenv.config({ path: path.join(rootDir, '.env') });
dotenv.config({ path: path.join(rootDir, '.env.local') });

function parseCliArgs(argv) {
  const passthrough = [];
  let preferredPort;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--port' || arg === '-p') {
      const value = argv[i + 1];
      if (value && !value.startsWith('-')) {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isNaN(parsed)) {
          preferredPort = parsed;
        }
        i += 1;
        continue;
      }
    } else if (arg.startsWith('--port=')) {
      const value = arg.slice('--port='.length);
      const parsed = Number.parseInt(value, 10);
      if (!Number.isNaN(parsed)) {
        preferredPort = parsed;
      }
      continue;
    } else if (arg.startsWith('-p=')) {
      const value = arg.slice('-p='.length);
      const parsed = Number.parseInt(value, 10);
      if (!Number.isNaN(parsed)) {
        preferredPort = parsed;
      }
      continue;
    }

    passthrough.push(arg);
  }

  return { preferredPort, passthrough };
}

function hasHostnameArg(args) {
  return args.some((arg) => (
    arg === '--hostname' ||
    arg === '-H' ||
    arg.startsWith('--hostname=') ||
    arg.startsWith('-H=')
  ));
}

function runPrismaMigrations() {
  return new Promise((resolve, reject) => {
    console.log('🗃️  Applying versioned Prisma migrations...');
    const child = spawn('npx', ['prisma', 'migrate', 'deploy'], {
      cwd: rootDir,
      stdio: 'inherit',
      shell: isWindows,
      detached: !isWindows,
      env: {
        ...process.env,
        PRISMA_HIDE_UPDATE_MESSAGE: '1',
      },
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(`prisma migrate deploy exited with code ${code ?? 'unknown'}`)
        );
      }
    });

    child.on('error', (error) => {
      reject(error);
    });
  });
}

function runAccessControlBootstrap() {
  return new Promise((resolve, reject) => {
    console.log('🛡️  Ensuring built-in permission and quota policies...');
    const child = spawn('npx', ['tsx', 'scripts/auth/ensure-access-control.ts'], {
      cwd: rootDir,
      stdio: 'inherit',
      shell: isWindows,
      detached: !isWindows,
      env: process.env,
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(`access-control bootstrap exited with code ${code ?? 'unknown'}`)
        );
      }
    });

    child.on('error', reject);
  });
}

async function ensureDatabaseSynced() {
  if (process.env.SKIP_DB_SYNC === '1') {
    console.log('↪️  Skipping Prisma schema sync because SKIP_DB_SYNC=1.');
    return;
  }
  if (process.env.QUANTPILOT_DEGRADATION_MODE?.trim().toLowerCase() === 'offline') {
    console.log('↪️  Skipping Prisma schema sync because QUANTPILOT_DEGRADATION_MODE=offline.');
    return;
  }
  if (!envFlag('QUANTPILOT_DATABASE_ENABLED', true)) {
    console.log('↪️  Skipping Prisma schema sync because QUANTPILOT_DATABASE_ENABLED=0.');
    return;
  }

  // Connectivity alone cannot detect newly added tables or semantic CHECK /
  // partial-index constraints. Use the same versioned migration path in local
  // startup and deployment so development cannot silently run a weaker schema.
  await runPrismaMigrations();
  await runAccessControlBootstrap();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probeUrl(url, timeoutMs = 1500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
    });
    return response.ok || response.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function envFlag(name, fallback) {
  const value = process.env[name]?.trim().toLowerCase();
  if (!value) return fallback;
  if (['0', 'false', 'no', 'off', 'disabled'].includes(value)) return false;
  if (['1', 'true', 'yes', 'on', 'enabled'].includes(value)) return true;
  return fallback;
}

function isDegradedStartupEnv() {
  return (
    process.env.SKIP_DB_SYNC === '1' ||
    process.env.QUANTPILOT_DEGRADATION_MODE?.trim().toLowerCase() === 'offline' ||
    !envFlag('QUANTPILOT_DATABASE_ENABLED', true) ||
    !envFlag('QUANTPILOT_MARKET_API_ENABLED', true) ||
    !envFlag('QUANTPILOT_OBSERVABILITY_ENABLED', true) ||
    !envFlag('QUANTPILOT_REDIS_CACHE_ENABLED', true)
  );
}

async function probeDatabaseReady() {
  let prisma;
  try {
    prisma = new PrismaClient();
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  } finally {
    if (prisma) {
      await prisma.$disconnect().catch(() => {});
    }
  }
}

function probeTcp(urlText, timeoutMs = 800) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(urlText);
    } catch {
      resolve(false);
      return;
    }

    const port = Number.parseInt(parsed.port || (parsed.protocol === 'rediss:' ? '6380' : '6379'), 10);
    const socket = net.createConnection({
      host: parsed.hostname || '127.0.0.1',
      port,
    });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);

    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once('error', () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

async function restoreRecoveredDegradationComponents() {
  if (process.env.QUANTPILOT_AUTO_RESTORE_DEGRADATION === '0') {
    return;
  }
  if (!isDegradedStartupEnv()) {
    return;
  }

  const recovered = [];
  const databaseReady = await probeDatabaseReady();
  if (databaseReady) {
    delete process.env.SKIP_DB_SYNC;
    process.env.QUANTPILOT_DATABASE_ENABLED = '1';
    process.env.QUANTPILOT_DATABASE_REQUIRED = '1';
    recovered.push('database');
  }

  const marketHealthUrl = process.env.QUANTPILOT_MARKET_API_URL
    ? `${process.env.QUANTPILOT_MARKET_API_URL.replace(/\/$/, '')}/health`
    : 'http://127.0.0.1:8000/health';
  if (await probeUrl(marketHealthUrl)) {
    process.env.QUANTPILOT_MARKET_API_ENABLED = '1';
    recovered.push('market-api');
  }

  const lokiReadyUrl = process.env.LOKI_URL
    ? `${process.env.LOKI_URL.replace(/\/$/, '')}/ready`
    : 'http://127.0.0.1:3100/ready';
  if (await probeUrl(lokiReadyUrl)) {
    process.env.QUANTPILOT_OBSERVABILITY_ENABLED = '1';
    recovered.push('observability');
  }

  if (await probeTcp(process.env.REDIS_URL || 'redis://127.0.0.1:6379/0')) {
    process.env.QUANTPILOT_REDIS_CACHE_ENABLED = '1';
    recovered.push('redis');
  }

  if (recovered.length) {
    process.env.QUANTPILOT_DEGRADATION_MODE = 'auto';
    console.log(`✅ Recovered components detected; restoring non-offline mode for this run: ${recovered.join(', ')}`);
  }
}

function stopChild(child) {
  if (!child?.pid) {
    return;
  }

  try {
    if (!isWindows) {
      process.kill(-child.pid, 'SIGTERM');
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      // 进程可能已经退出。
    }
  }
}

async function clearStaleNextDevLock() {
  try {
    const raw = await fs.readFile(nextDevLockFile, 'utf8');
    const parsed = JSON.parse(raw);
    const pid = Number.parseInt(String(parsed?.pid ?? ''), 10);
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return;
      } catch {
        // PID 不存在，锁文件是过期的。
      }
    }
  } catch {
    // 没有锁文件或内容不可解析都可以直接清理。
  }

  await fs.rm(nextDevLockFile, { force: true });
}

async function clearNextDevStartupCaches() {
  await Promise.all([
    fs.rm(path.join(rootDir, '.next', 'dev', 'cache', 'webpack'), { recursive: true, force: true }),
    clearStaleNextDevLock(),
  ]);
}

async function restoreStableNextEnv() {
  try {
    const devRoutes = await fs.readFile(nextDevRouteTypesFile, 'utf8').catch(() => '');
    if (devRoutes) {
      await fs.mkdir(path.dirname(nextBuildRouteTypesFile), { recursive: true });
      await fs.writeFile(nextBuildRouteTypesFile, devRoutes, 'utf8');
    }

    const current = await fs.readFile(nextEnvFile, 'utf8').catch(() => '');
    if (current !== nextEnvStableContent) {
      await fs.writeFile(nextEnvFile, nextEnvStableContent, 'utf8');
    }
  } catch {
    // next-env.d.ts 是 Next 自动生成文件，恢复失败不应阻断开发服务。
  }
}

function scheduleStableNextEnvRestore() {
  for (const delayMs of [1_000, 3_000, 8_000]) {
    setTimeout(() => {
      void restoreStableNextEnv();
    }, delayMs);
  }
}

async function startWebDevServer({
  preferredPort,
  passthrough = [],
  stdio = 'inherit',
  onOutput,
} = {}) {
  const { port, url } = await ensureEnvironment({
    preferredPort,
  });

  await buildStableCss();
  await restoreRecoveredDegradationComponents();
  await ensureDatabaseSynced();
  await clearNextDevStartupCaches();

  const resolvedPort = port;
  const resolvedUrl = url;

  process.env.PORT = resolvedPort.toString();
  process.env.WEB_PORT = resolvedPort.toString();
  process.env.NEXT_PUBLIC_APP_URL = resolvedUrl;

  console.log(`🚀 Starting Next.js dev server on ${resolvedUrl}`);

  const defaultHost = process.env.QUANTPILOT_WEB_HOST?.trim() || '127.0.0.1';
  const hostArgs = hasHostnameArg(passthrough) ? [] : ['--hostname', defaultHost];
  const devArgs = ['next', 'dev', ...hostArgs, '--port', resolvedPort.toString(), ...passthrough];

  const child = spawn(
    'npx',
    devArgs,
    {
      cwd: rootDir,
      stdio: onOutput ? ['inherit', 'pipe', 'pipe'] : stdio,
      shell: isWindows,
      env: {
        ...process.env,
        PORT: resolvedPort.toString(),
        WEB_PORT: resolvedPort.toString(),
        NEXT_PUBLIC_APP_URL: resolvedUrl,
        BROWSER: process.env.BROWSER || 'none',
        NEXT_TELEMETRY_DISABLED: '1',
      },
    }
  );

  child.once('spawn', scheduleStableNextEnvRestore);

  if (onOutput) {
    child.stdout?.on('data', (chunk) => onOutput(chunk));
    child.stderr?.on('data', (chunk) => onOutput(chunk));
  }

  await new Promise((resolve, reject) => {
    const handleError = (error) => {
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    child.once('error', handleError);
    child.once('spawn', () => {
      child.removeListener('error', handleError);
      resolve();
    });
  });

  return { child, port: resolvedPort, url: resolvedUrl };
}

async function runFromCli() {
  const argv = process.argv.slice(2);
  const { preferredPort, passthrough } = parseCliArgs(argv);
  const { child } = await startWebDevServer({
    preferredPort,
    passthrough,
    stdio: 'inherit',
  });

  child.on('error', (error) => {
    console.error('\n❌ Failed to start Next.js dev server');
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });

  child.on('exit', (code) => {
    if (typeof code !== 'number' || code === 0) {
      return;
    }

    console.error(`\n❌ Next.js dev server exited with code ${code}`);
    process.exit(code);
  });
}

if (require.main === module) {
  runFromCli().catch((error) => {
    console.error('\n❌ Failed to launch dev server');
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

module.exports = {
  hasHostnameArg,
  parseCliArgs,
  startWebDevServer,
};
