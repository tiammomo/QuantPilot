import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { validateQuantVisualPresentation } from '@/lib/quant/visual-validation';
import {
  buildGeneratedProjectEnv,
  wrapGeneratedProjectCommand,
} from '@/lib/security/generated-project-sandbox';
import { type CommandResult, type QuantValidationCheck } from './contracts';
import { normalizeGeneratedProjectForValidation } from './preparation';
import { fileExists, formatDuration, normalizeRelativePath, readTextFile } from './files';

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

const BUILD_TIMEOUT_MS = Number.parseInt(process.env.QUANTPILOT_VALIDATION_BUILD_TIMEOUT_MS ?? '', 10) || 180_000;

const PREVIEW_HTTP_TIMEOUT_MS = Number.parseInt(process.env.QUANTPILOT_VALIDATION_HTTP_TIMEOUT_MS ?? '', 10) || 45_000;

const FETCH_TIMEOUT_MS = 5_000;

const OUTPUT_TAIL_LIMIT = 12_000;

async function startPreviewForValidation(projectId: string) {
  const { previewManager } = await import('@/lib/services/preview');
  return previewManager.start(projectId);
}

export async function stopPreviewForValidation(projectId: string) {
  const { previewManager } = await import('@/lib/services/preview');
  return previewManager.stop(projectId);
}

function trimOutput(output: string): string {
  if (output.length <= OUTPUT_TAIL_LIMIT) {
    return output.trim();
  }
  return `...输出已截断，仅保留最后 ${OUTPUT_TAIL_LIMIT} 字符...\n${output.slice(-OUTPUT_TAIL_LIMIT)}`.trim();
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs: number
): Promise<CommandResult> {
  const sandboxed = await wrapGeneratedProjectCommand(cwd, command, args);
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | null = null;

    const child = spawn(sandboxed.command, sandboxed.args, {
      cwd,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildGeneratedProjectEnv(cwd, {
        NODE_ENV: 'production',
        NEXT_PRIVATE_BUILD_WORKER: '1',
      }),
    });

    const append = (chunk: Buffer | string) => {
      output += chunk.toString();
      if (output.length > OUTPUT_TAIL_LIMIT * 2) {
        output = output.slice(-OUTPUT_TAIL_LIMIT);
      }
    };

    const settle = (result: Omit<CommandResult, 'output'>) => {
      if (settled) return;
      settled = true;
      if (killTimer) clearTimeout(killTimer);
      resolve({ ...result, output: trimOutput(output) });
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      append(`\n[QuantPilot validation] 命令超过 ${timeoutMs}ms，正在终止。\n`);
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    }, timeoutMs);

    child.stdout?.on('data', append);
    child.stderr?.on('data', append);

    child.on('error', (error) => {
      clearTimeout(timeout);
      append(`\n${error instanceof Error ? error.message : String(error)}\n`);
      settle({ exitCode: -1, signal: null, timedOut });
    });

    child.on('close', (exitCode, signal) => {
      clearTimeout(timeout);
      settle({ exitCode, signal, timedOut });
    });
  });
}

async function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
      cache: 'no-store',
    });
  } finally {
    clearTimeout(timer);
  }
}

async function waitForHttpOk(url: string, timeoutMs: number): Promise<{ status: number; text: string }> {
  const startedAt = Date.now();
  let lastStatus = 0;
  let lastText = '';

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetchWithTimeout(url, { method: 'GET' });
      lastStatus = response.status;
      lastText = await response.text().catch(() => '');
      if (response.ok) {
        return { status: response.status, text: lastText };
      }
    } catch (error) {
      lastText = error instanceof Error ? error.message : String(error);
    }

    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  throw new Error(
    lastStatus
      ? `预览地址未返回 2xx，最后状态码：${lastStatus}，响应：${lastText.slice(0, 500)}`
      : `预览地址未在 ${timeoutMs}ms 内返回 HTTP 200：${lastText}`
  );
}

export async function checkBuild(projectPath: string): Promise<Omit<QuantValidationCheck, 'id' | 'name' | 'durationMs'>> {
  await normalizeGeneratedProjectForValidation(projectPath);

  const packageJsonPath = path.join(projectPath, 'package.json');
  const packageJsonRaw = await readTextFile(packageJsonPath);
  if (!packageJsonRaw) {
    return {
      status: 'failed',
      summary: '未找到 package.json，无法执行 Next.js build。',
    };
  }

  let packageJson: { scripts?: Record<string, string> };
  try {
    packageJson = JSON.parse(packageJsonRaw) as { scripts?: Record<string, string> };
  } catch (error) {
    return {
      status: 'failed',
      summary: 'package.json 不是有效 JSON。',
      details: error instanceof Error ? error.message : String(error),
    };
  }

  if (!packageJson.scripts?.build) {
    return {
      status: 'failed',
      summary: 'package.json 缺少 build 脚本。',
    };
  }

  // Webpack avoids Turbopack's native helper escaping the PID/capability model
  // used by the generated-project namespace sandbox.
  const result = await runCommand(
    npmCommand,
    ['run', 'build', '--', '--webpack'],
    projectPath,
    BUILD_TIMEOUT_MS,
  );
  if (result.exitCode === 0 && !result.timedOut) {
    return {
      status: 'passed',
      summary: 'Next.js build 通过。',
      details: result.output,
    };
  }

  return {
    status: 'failed',
    summary: result.timedOut
      ? `Next.js build 超过 ${formatDuration(BUILD_TIMEOUT_MS)} 未完成。`
      : `Next.js build 失败，退出码：${result.exitCode ?? 'null'}，信号：${result.signal ?? 'none'}。`,
    details: result.output,
  };
}

export async function checkPreviewHttp(
  projectId: string
): Promise<Omit<QuantValidationCheck, 'id' | 'name' | 'durationMs'>> {
  const preview = await startPreviewForValidation(projectId);
  if (!preview.url) {
    return {
      status: 'failed',
      summary: '预览服务未返回可访问 URL。',
      metadata: { preview },
    };
  }

  const response = await waitForHttpOk(preview.url, PREVIEW_HTTP_TIMEOUT_MS);
  return {
    status: 'passed',
    summary: `预览首页 HTTP ${response.status}。`,
    metadata: {
      url: preview.url,
      port: preview.port,
      responsePreview: response.text.slice(0, 400),
    },
  };
}

export async function checkVisualPresentation(
  projectPath: string,
  projectId: string,
  requestId?: string | null
): Promise<Omit<QuantValidationCheck, 'id' | 'name' | 'durationMs'>> {
  const preview = await startPreviewForValidation(projectId);
  if (!preview.url) {
    return {
      status: 'failed',
      summary: '无法执行视觉验收，因为预览 URL 不存在。',
    };
  }
  const report = await validateQuantVisualPresentation({
    projectPath,
    projectId,
    previewUrl: preview.url,
    requestId,
  });
  if (!report.passed) {
    return {
      status: 'failed',
      summary: `视觉验收未通过：${report.failures.length} 个阻断项。`,
      details: [
        ...report.failures,
        report.viewports.length
          ? `截图：${report.viewports.map((viewport) => `${viewport.id}=${viewport.screenshotPath}`).join('；')}`
          : null,
      ].filter(Boolean).join('\n'),
      metadata: {
        reportPath: report.reportPath,
        screenshotDir: report.screenshotDir,
        viewports: report.viewports.map((viewport) => ({
          id: viewport.id,
          screenshotPath: viewport.screenshotPath,
          metrics: viewport.metrics,
        })),
      },
    };
  }
  return {
    status: report.status === 'warning' ? 'warning' : 'passed',
    summary: report.status === 'warning' ? `视觉验收通过但有 ${report.warnings.length} 个警告。` : '桌面和移动端视觉验收通过。',
    details: report.warnings.length ? report.warnings.join('\n') : undefined,
    metadata: {
      reportPath: report.reportPath,
      screenshotDir: report.screenshotDir,
      viewports: report.viewports.map((viewport) => ({
        id: viewport.id,
        screenshotPath: viewport.screenshotPath,
        metrics: viewport.metrics,
      })),
    },
  };
}

export async function checkMarketProxy(
  projectPath: string,
  projectId: string
): Promise<Omit<QuantValidationCheck, 'id' | 'name' | 'durationMs'>> {
  const marketDir = path.join(projectPath, 'app', 'api', 'market');
  const marketEntries = await fs.readdir(marketDir).catch(() => []);
  const escapedRouteEntry = marketEntries.find((entry) => entry.includes('\\[') || entry.includes('\\]'));
  if (escapedRouteEntry) {
    return {
      status: 'failed',
      summary: '/api/market 动态路由目录名称不正确。',
      details: `检测到目录 ${path.posix.join('app/api/market', escapedRouteEntry)}。请使用 app/api/market/[...path]/route.ts，不要在目录名中写入反斜杠。`,
    };
  }

  const routeCandidates = [
    path.join(projectPath, 'app', 'api', 'market', '[...path]', 'route.ts'),
    path.join(projectPath, 'app', 'api', 'market', '[[...path]]', 'route.ts'),
    path.join(projectPath, 'app', 'api', 'market', 'route.ts'),
  ];
  const routePath = await routeCandidates.reduce<Promise<string | null>>(async (previous, candidate) => {
    const found = await previous;
    if (found) return found;
    return (await fileExists(candidate)) ? candidate : null;
  }, Promise.resolve(null));

  if (!routePath) {
    return {
      status: 'failed',
      summary: '未找到 /api/market 同源代理 route。',
      details: '请在生成项目中创建 app/api/market/[...path]/route.ts，并转发到 http://127.0.0.1:8000/api/v1/**。',
    };
  }

  const preview = await startPreviewForValidation(projectId);
  if (!preview.url) {
    return {
      status: 'failed',
      summary: '无法检查 /api/market 代理，因为预览 URL 不存在。',
      metadata: { route: normalizeRelativePath(projectPath, routePath) },
    };
  }

  const probeUrl = new URL('/api/market/quotes/realtime/600519', preview.url).toString();
  const response = await fetchWithTimeout(probeUrl, { method: 'GET' }, 8_000);
  const responseText = await response.text().catch(() => '');
  if (!response.ok) {
    return {
      status: 'failed',
      summary: `/api/market 代理未返回 2xx，状态码：${response.status}。`,
      details: responseText.slice(0, 1_000),
      metadata: {
        route: normalizeRelativePath(projectPath, routePath),
        probeUrl,
      },
    };
  }

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    // 非 JSON 响应也会在下面的数据形态检查失败。
  }

  const serialized = parsed ? JSON.stringify(parsed) : responseText;
  if (!/600519|贵州茅台|price|symbol|quote|latest|fetched_at|source/i.test(serialized)) {
    return {
      status: 'failed',
      summary: '/api/market 代理返回了 2xx，但响应不像真实行情数据。',
      details: responseText.slice(0, 1_000),
      metadata: {
        route: normalizeRelativePath(projectPath, routePath),
        probeUrl,
      },
    };
  }

  return {
    status: 'passed',
    summary: '/api/market 同源代理可用，实时行情探测通过。',
    metadata: {
      route: normalizeRelativePath(projectPath, routePath),
      probeUrl,
    },
  };
}
