#!/usr/bin/env node

/**
 * 安全的 Next.js 生产构建入口。
 *
 * dev server 和 next build 都会写入 .next。两者同时运行时容易互相影响，
 * 所以构建前先停止根项目的 3000 开发服务。
 */

const { execFile, spawn } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const { promisify } = require('util');
const { buildStableCss } = require('./build-stable-css');
const { withNextArtifactLock } = require('../shared/next-artifact-lock');

const execFileAsync = promisify(execFile);
const rootDir = path.join(__dirname, '..', '..');
const isWindows = os.platform() === 'win32';
const rootPort = Number.parseInt(process.env.WEB_PORT || process.env.PORT || '3000', 10) || 3000;

function extractPidsFromSs(output) {
  const pids = new Set();
  for (const match of output.matchAll(/pid=(\d+)/g)) {
    const pid = Number.parseInt(match[1], 10);
    if (Number.isInteger(pid) && pid > 0) {
      pids.add(pid);
    }
  }
  return Array.from(pids);
}

async function findListeningPids(port) {
  if (isWindows) {
    return [];
  }
  try {
    const { stdout } = await execFileAsync('ss', ['-ltnpH', `sport = :${port}`]);
    return extractPidsFromSs(stdout);
  } catch {
    return [];
  }
}

async function isPidWithinRoot(pid) {
  if (isWindows) {
    return false;
  }
  try {
    const cwd = await require('fs/promises').readlink(`/proc/${pid}/cwd`);
    const normalizedCwd = path.resolve(cwd);
    return normalizedCwd === rootDir || normalizedCwd.startsWith(`${rootDir}${path.sep}`);
  } catch {
    return false;
  }
}

async function stopRootDevServer() {
  const pids = await findListeningPids(rootPort);
  if (pids.length === 0) {
    return;
  }

  const rootPids = (
    await Promise.all(pids.map(async (pid) => ((await isPidWithinRoot(pid)) ? pid : null)))
  ).filter((pid) => pid !== null);

  if (rootPids.length === 0) {
    return;
  }

  console.log(`[build] Stopping root dev server on port ${rootPort}: ${rootPids.join(', ')}`);
  for (const pid of rootPids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // 进程可能已经退出。
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 2_000));

  for (const pid of rootPids) {
    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
    } catch {
      // 已经退出。
    }
  }
}

function parseBuildArgs(argv) {
  const args = [];
  let standalone = process.env.QUANTPILOT_STANDALONE_BUILD === '1';

  for (const arg of argv) {
    if (arg === '--standalone') {
      standalone = true;
      continue;
    }
    args.push(arg);
  }

  return { args, standalone };
}

async function runNextBuild(args, { standalone } = {}) {
  const hasBundlerFlag = args.some((arg) => arg === '--webpack' || arg === '--turbo' || arg === '--turbopack');
  const buildArgs = ['build', ...(hasBundlerFlag ? args : ['--webpack', ...args])];
  await new Promise((resolve, reject) => {
    const child = spawn(
      path.join(rootDir, 'node_modules', '.bin', isWindows ? 'next.cmd' : 'next'),
      buildArgs,
      {
        cwd: rootDir,
        stdio: 'inherit',
        shell: isWindows,
        env: {
          ...process.env,
          QUANTPILOT_STANDALONE_BUILD: standalone ? '1' : '0',
          QUANTPILOT_SKIP_ROUTE_TRACING:
            process.env.QUANTPILOT_SKIP_ROUTE_TRACING || (standalone ? '0' : '1'),
          NEXT_TELEMETRY_DISABLED: '1',
          NEXT_PUBLIC_PROJECT_ROOT: process.env.NEXT_PUBLIC_PROJECT_ROOT || rootDir,
        },
      }
    );

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`next build exited with code ${code ?? 'null'}, signal ${signal ?? 'null'}`));
    });
  });
}

async function prepareStandaloneRuntime() {
  const standaloneDir = path.join(rootDir, '.next', 'standalone');
  const staticSource = path.join(rootDir, '.next', 'static');
  const staticTarget = path.join(standaloneDir, '.next', 'static');
  const serverSource = path.join(rootDir, '.next', 'server');
  const serverTarget = path.join(standaloneDir, '.next', 'server');
  const publicSource = path.join(rootDir, 'public');
  const publicTarget = path.join(standaloneDir, 'public');
  const excludedPublicDirectories = new Set([
    path.join(publicSource, 'generated'),
    path.join(publicSource, 'uploads'),
  ]);

  await fs.access(path.join(standaloneDir, 'server.js'));
  const standaloneRootEntries = await fs.readdir(standaloneDir);
  await Promise.all(
    standaloneRootEntries
      .filter((entry) => entry === '.env' || entry.startsWith('.env.'))
      .map((entry) => fs.rm(path.join(standaloneDir, entry), { force: true })),
  );
  await fs.rm(staticTarget, { recursive: true, force: true });
  await fs.mkdir(path.dirname(staticTarget), { recursive: true });
  await fs.cp(staticSource, staticTarget, { recursive: true, force: true });

  // Turbopack's standalone trace can omit shared server chunks even though the
  // generated route entrypoints reference them. Copying the compiled server
  // tree keeps the artifact self-contained; it contains build output only.
  await fs.rm(serverTarget, { recursive: true, force: true });
  await fs.cp(serverSource, serverTarget, { recursive: true, force: true });

  await fs.rm(publicTarget, { recursive: true, force: true });
  await fs.cp(publicSource, publicTarget, {
    recursive: true,
    force: true,
    filter: (source) => !excludedPublicDirectories.has(source),
  });
  const stableCssSource = path.join(publicSource, 'generated', 'quantpilot-tailwind.css');
  const stableCssTarget = path.join(publicTarget, 'generated', 'quantpilot-tailwind.css');
  await fs.mkdir(path.dirname(stableCssTarget), { recursive: true });
  await fs.copyFile(stableCssSource, stableCssTarget);

  console.log('[build] Standalone runtime staged with immutable public and Next static assets.');
}

async function main() {
  const { args, standalone } = parseBuildArgs(process.argv.slice(2));
  await stopRootDevServer();
  await buildStableCss();
  await withNextArtifactLock(rootDir, 'production build', async () => {
    await runNextBuild(args, { standalone });
    if (standalone) {
      await prepareStandaloneRuntime();
    }
  });
}

main().catch((error) => {
  console.error('[build] Failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
