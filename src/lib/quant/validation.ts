import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { serializeMessage } from '@/lib/serializers/chat';
import { createMessage } from '@/lib/services/message';
import { streamManager } from '@/lib/services/stream';
import { ensureBaselineEvidenceFiles } from '@/lib/quant/evidence';
import { prefetchQuantDataForRunPlan } from '@/lib/quant/data-prefetch';
import {
  appendQuantWorkspaceEvent,
  ensureQuantWorkspace,
  writeInitialRunPlan,
} from '@/lib/quant/workspace';
import type { QuantRunPlan } from '@/lib/quant/workspace';
import { validateQuantArtifactContracts } from '@/lib/quant/artifact-contracts';
import { validateQuantVisualPresentation } from '@/lib/quant/visual-validation';
import {
  generatedBuildScriptContents,
  restoreQuantDashboardTemplate,
  scaffoldBasicNextApp,
} from '@/lib/utils/scaffold';
import {
  buildGeneratedProjectEnv,
  wrapGeneratedProjectCommand,
} from '@/lib/security/generated-project-sandbox';

export type QuantValidationCheckStatus = 'passed' | 'failed' | 'warning';
export type QuantValidationStatus = 'passed' | 'failed';

export interface QuantValidationCheck {
  id: string;
  name: string;
  status: QuantValidationCheckStatus;
  summary: string;
  details?: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

export interface QuantValidationReport {
  schemaVersion: 1;
  runId?: string;
  status: QuantValidationStatus;
  passed: boolean;
  projectId: string;
  reportPath: string;
  checks: QuantValidationCheck[];
  createdAt: string;
  updatedAt: string;
}

export type QuantValidationStaleReason =
  | 'artifact_modified_after_report'
  | 'run_id_mismatch';

export interface QuantValidationArtifactMtime {
  path: string;
  mtimeMs: number;
}

export interface QuantValidationFreshness {
  stale: boolean;
  reasons: QuantValidationStaleReason[];
  staleArtifactPaths: string[];
  newestArtifactMtimeMs: number | null;
  reportRunId: string | null;
  currentRunId: string | null;
}

/**
 * Pure validation-report freshness contract. A report belongs only to the
 * generation run that produced it and only covers artifacts that are no newer
 * than the report itself.
 */
export function assessQuantValidationReportFreshness(params: {
  reportRunId?: string | null;
  currentRunId?: string | null;
  reportMtimeMs: number;
  artifacts: QuantValidationArtifactMtime[];
}): QuantValidationFreshness {
  const reportRunId = params.reportRunId?.trim() || null;
  const currentRunId = params.currentRunId?.trim() || null;
  const staleArtifacts = params.artifacts.filter(
    (artifact) =>
      Number.isFinite(artifact.mtimeMs) &&
      artifact.mtimeMs > params.reportMtimeMs,
  );
  const reasons: QuantValidationStaleReason[] = [];

  if (staleArtifacts.length > 0) {
    reasons.push('artifact_modified_after_report');
  }
  if (currentRunId && reportRunId !== currentRunId) {
    reasons.push('run_id_mismatch');
  }

  return {
    stale: reasons.length > 0,
    reasons,
    staleArtifactPaths: staleArtifacts.map((artifact) => artifact.path),
    newestArtifactMtimeMs:
      staleArtifacts.length > 0
        ? Math.max(...staleArtifacts.map((artifact) => artifact.mtimeMs))
        : null,
    reportRunId,
    currentRunId,
  };
}

export interface QuantValidationRepairStep {
  checkId: string;
  checkName: string;
  summary: string;
  actions: string[];
  details?: string;
}

export interface QuantValidationRepairPlan {
  schemaVersion: 1;
  status: 'needed';
  projectId: string;
  reportPath: string;
  repairPlanPath: string;
  steps: QuantValidationRepairStep[];
  createdAt: string;
}

export interface QuantDashboardTemplateRestoreResult {
  restored: boolean;
  reason: string;
  failedCheckIds: string[];
}

interface ValidateQuantProjectParams {
  projectId: string;
  projectPath: string;
  requestId?: string | null;
  conversationId?: string | null;
  cliSource?: string | null;
}

export interface PrepareQuantProjectForValidationParams {
  projectId: string;
  projectPath: string;
}

interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  output: string;
}

const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const VALIDATION_REPORT_RELATIVE_PATH = '.quantpilot/validation.json';
const VALIDATION_REPAIR_PLAN_RELATIVE_PATH = '.quantpilot/validation-repair-plan.json';
const VALIDATION_STALE_ARTIFACT_PATHS = [
  '.quantpilot/run_plan.json',
  'app/page.tsx',
  'app/globals.css',
  'app/layout.tsx',
  'app/api/market/[...path]/route.ts',
  'data_file/final/dashboard-data.json',
  'evidence/sources.json',
  'evidence/data_quality.json',
  'evidence/image_extraction.json',
  'package.json',
];
const DASHBOARD_TEMPLATE_RESTORE_CHECK_IDS = new Set([
  'next_build',
  'preview_http_200',
  'visual_presentation',
  'dashboard_data_binding',
  'chart_presence',
]);
const DASHBOARD_TEMPLATE_PROTECTED_ARTIFACT_PATHS = [
  '.quantpilot/run_plan.json',
  'data_file/final/dashboard-data.json',
  'evidence/sources.json',
  'evidence/data_quality.json',
] as const;
const BUILD_TIMEOUT_MS = Number.parseInt(process.env.QUANTPILOT_VALIDATION_BUILD_TIMEOUT_MS ?? '', 10) || 180_000;
const PREVIEW_HTTP_TIMEOUT_MS = Number.parseInt(process.env.QUANTPILOT_VALIDATION_HTTP_TIMEOUT_MS ?? '', 10) || 45_000;
const FETCH_TIMEOUT_MS = 5_000;
const OUTPUT_TAIL_LIMIT = 12_000;
const SENSITIVE_EVIDENCE_PATTERN =
  /(?:sk-(?:proj|ant|cp|live|test)-[a-z0-9_-]{12,}|bearer\s+[a-z0-9._-]{12,}|(?:authorization|api[_-]?key|auth[_-]?token|cookie|set-cookie)\s*[:=]\s*["']?[a-z0-9._~+/=-]{12,})/i;
const ARTIFACT_POLICY_MAX_FILE_BYTES = 300_000;
const ARTIFACT_POLICY_ROOT_DIRS = ['app', 'components', 'hooks', 'lib', 'src', 'styles'];
const ARTIFACT_POLICY_ROOT_FILES = [
  'package.json',
  'next.config.js',
  'next.config.mjs',
  'postcss.config.js',
  'tailwind.config.js',
  'tailwind.config.ts',
];
const ARTIFACT_POLICY_SKIP_DIRS = new Set([
  '.git',
  '.next',
  '.turbo',
  '.vercel',
  'build',
  'coverage',
  'dist',
  'node_modules',
]);
const ARTIFACT_POLICY_SOURCE_EXTENSIONS = new Set([
  '.css',
  '.html',
  '.js',
  '.jsx',
  '.json',
  '.mjs',
  '.ts',
  '.tsx',
]);
const REMOTE_URL_PATTERN = /\bhttps?:\/\/[a-z0-9.-]+(?::\d+)?[^\s'"`<>){}]*/gi;
const REMOTE_USAGE_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: '远程脚本', pattern: /<script[^>]+src=["']https?:\/\/[^"']+["']/gi },
  { label: '远程样式', pattern: /<link[^>]+href=["']https?:\/\/[^"']+["']/gi },
  { label: 'CSS 远程资源', pattern: /(?:@import\s+(?:url\()?["']?https?:\/\/|url\(\s*["']?https?:\/\/)[^'")\s]+/gi },
  { label: '远程模块导入', pattern: /(?:\bfrom\s+["']https?:\/\/[^"']+["']|\bimport\s*\(\s*["']https?:\/\/[^"']+["']\s*\))/gi },
  { label: '浏览器直连外部接口', pattern: /\b(?:fetch|new\s+EventSource|new\s+WebSocket)\s*\(\s*["']https?:\/\/[^"']+["']/gi },
  { label: '远程媒体资源', pattern: /<(?:img|source|iframe)[^>]+(?:src|srcSet)=["']https?:\/\/[^"']+["']/gi },
];
const SENSITIVE_ARTIFACT_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  { label: '明文 API key', pattern: /\b(?:sk|sk-proj|sk-ant|sk-cp)-[a-z0-9_-]{16,}\b/i },
  { label: 'Bearer token', pattern: /\bbearer\s+[a-z0-9._-]{16,}\b/i },
  {
    label: '环境变量密钥字面量',
    pattern: /\b(?:DEEPSEEK_API_KEY|OPENAI_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|MINIMAX_API_KEY|CODEX_OPENAI_API_KEY)\s*[:=]\s*["'][^"'\n]{8,}["']/i,
  },
  { label: 'AWS access key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
];
const EXECUTION_ESCAPE_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  {
    label: 'Node 宿主能力导入',
    pattern: /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'](?:node:)?(?:child_process|cluster|dgram|dns|http2?|https|inspector|module|net|os|process|tls|vm|worker_threads)["']/i,
  },
  { label: 'CommonJS 动态加载', pattern: /\brequire\s*\(/i },
  { label: '动态模块加载', pattern: /\bimport\s*\(/i },
  {
    label: '宿主 process 特权访问',
    pattern: /\bprocess\s*(?:\.\s*(?:env|binding|chdir|dlopen|getBuiltinModule|mainModule)|\[\s*["'](?:env|binding|chdir|dlopen|getBuiltinModule|mainModule)["'])/i,
  },
  { label: '动态代码执行', pattern: /\b(?:eval|Function)\s*\(|\bWebAssembly\b/i },
  { label: '子进程执行 API', pattern: /\b(?:execFileSync|execFile|execSync|spawnSync|spawn|fork)\s*\(/i },
  { label: '非受控网络客户端', pattern: /\bnew\s+(?:EventSource|WebSocket|XMLHttpRequest)\b|\bsendBeacon\s*\(/i },
  { label: '宿主绝对路径', pattern: /["'](?:\/(?:etc|home|proc|root|run|sys|var\/run)\/|[a-z]:\\(?:users|windows)\\)/i },
];

async function startPreviewForValidation(projectId: string) {
  const { previewManager } = await import('@/lib/services/preview');
  return previewManager.start(projectId);
}

async function stopPreviewForValidation(projectId: string) {
  const { previewManager } = await import('@/lib/services/preview');
  return previewManager.stop(projectId);
}
const MOCK_ARTIFACT_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
  {
    label: 'mock/sample 静态数据变量',
    pattern:
      /\b(?:MOCK|SAMPLE|DEMO|PLACEHOLDER|STATIC)_(?:DATA|QUOTE|QUOTES|KLINE|KLINES|HISTORY|FINANCIALS|REPORTS|ANNOUNCEMENTS|DASHBOARD_DATA)\b/i,
  },
  {
    label: 'mock/sample 静态数据命名',
    pattern:
      /\b(?:mockData|sampleData|demoData|placeholderData|staticQuotes|staticKlines|staticFinancials|staticDashboardData)\b/,
  },
  { label: '示例或模拟数据标记', pattern: /lorem ipsum|假数据|模拟数据|示例数据|样例数据|占位数据/i },
];
const DISCOURAGED_VISUALIZATION_DEPENDENCIES = new Set([
  '@visx/visx',
  'chart.js',
  'd3',
  'echarts',
  'plotly.js',
  'recharts',
]);
const validationQueues = new Map<string, Promise<void>>();

function validationReportPath(projectPath: string) {
  return path.join(projectPath, VALIDATION_REPORT_RELATIVE_PATH);
}

function validationRepairPlanPath(projectPath: string) {
  return path.join(projectPath, VALIDATION_REPAIR_PLAN_RELATIVE_PATH);
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function directoryExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function readTextFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

function trimOutput(output: string): string {
  if (output.length <= OUTPUT_TAIL_LIMIT) {
    return output.trim();
  }
  return `...输出已截断，仅保留最后 ${OUTPUT_TAIL_LIMIT} 字符...\n${output.slice(-OUTPUT_TAIL_LIMIT)}`.trim();
}

function formatDuration(ms?: number): string {
  if (!ms) return '';
  if (ms < 1_000) return `${ms}ms`;
  return `${(ms / 1_000).toFixed(1)}s`;
}

function isNonEmptyJsonValue(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).length > 0;
  }
  return value !== null && value !== undefined && value !== '';
}

function normalizeRelativePath(projectPath: string, filePath: string): string {
  return path.relative(projectPath, filePath).replaceAll(path.sep, '/');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function validationArtifactSignature(projectPath: string): Promise<string> {
  const signatures = await Promise.all(
    VALIDATION_STALE_ARTIFACT_PATHS.map(async (relativePath) => {
      const absolutePath = path.join(projectPath, relativePath);
      const stat = await fs.stat(absolutePath).catch(() => null);
      if (!stat?.isFile()) {
        return `${relativePath}:missing`;
      }
      return `${relativePath}:${stat.size}:${Math.floor(stat.mtimeMs)}`;
    })
  );
  return signatures.join('|');
}

async function waitForValidationArtifactsToSettle(projectPath: string) {
  const timeoutMs = Number.parseInt(process.env.QUANTPILOT_VALIDATION_SETTLE_TIMEOUT_MS ?? '', 10) || 4_000;
  const intervalMs = 500;
  const startedAt = Date.now();
  let lastSignature = '';
  let stableCount = 0;

  while (Date.now() - startedAt < timeoutMs) {
    const signature = await validationArtifactSignature(projectPath);
    if (signature === lastSignature) {
      stableCount += 1;
      if (stableCount >= 2) {
        return;
      }
    } else {
      lastSignature = signature;
      stableCount = 0;
    }
    await sleep(intervalMs);
  }
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

async function safeRunCheck(
  id: string,
  name: string,
  checker: () => Promise<Omit<QuantValidationCheck, 'id' | 'name' | 'durationMs'>>
): Promise<QuantValidationCheck> {
  const startedAt = Date.now();
  const elapsed = () => Math.max(0, Date.now() - startedAt);
  try {
    const result = await checker();
    return {
      id,
      name,
      durationMs: elapsed(),
      ...result,
    };
  } catch (error) {
    return {
      id,
      name,
      status: 'failed',
      summary: `${name}检查异常。`,
      details: error instanceof Error ? error.message : String(error),
      durationMs: elapsed(),
    };
  }
}

async function checkBuild(projectPath: string): Promise<Omit<QuantValidationCheck, 'id' | 'name' | 'durationMs'>> {
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

async function normalizeGeneratedProjectForValidation(projectPath: string) {
  await normalizePostCssConfig(projectPath);
  await normalizeBuildScript(projectPath);
  await normalizeNextConfig(projectPath);
}

async function normalizePostCssConfig(projectPath: string) {
  const postCssPath = path.join(projectPath, 'postcss.config.js');
  const content = await readTextFile(postCssPath);
  if (content === null) {
    return;
  }

  const compact = content.replace(/\s+/g, '');
  const hasPluginsKey = /\bplugins\s*:/.test(content) || compact.includes('"plugins":') || compact.includes("'plugins':");
  const isEmptyExport = /module\.exports\s*=\s*\{\s*\}\s*;?/.test(content) || /export\s+default\s+\{\s*\}\s*;?/.test(content);

  if (hasPluginsKey && !isEmptyExport) {
    return;
  }

  await fs.writeFile(
    postCssPath,
    `module.exports = {
  plugins: [],
};
`,
    'utf8'
  );
}

async function normalizeBuildScript(projectPath: string) {
  const packageJsonPath = path.join(projectPath, 'package.json');
  const raw = await readTextFile(packageJsonPath);
  if (!raw) {
    return;
  }

  let packageJson: Record<string, unknown>;
  try {
    packageJson = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return;
  }

  let changed = false;
  const scripts = packageJson.scripts;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) {
    packageJson.scripts = {};
    changed = true;
  }

  const scriptMap = packageJson.scripts as Record<string, unknown>;
  if (
    scriptMap.build !== 'node scripts/run-build.js' &&
    (typeof scriptMap.build !== 'string' || /^next\s+build(?:\s|$)/.test(scriptMap.build))
  ) {
    scriptMap.build = 'node scripts/run-build.js';
    changed = true;
  }
  if (!scriptMap.build) {
    scriptMap.build = 'node scripts/run-build.js';
    changed = true;
  }

  const buildScriptPath = path.join(projectPath, 'scripts', 'run-build.js');
  const buildScript = generatedBuildScriptContents();
  if ((await readTextFile(buildScriptPath)) !== buildScript) {
    await fs.mkdir(path.dirname(buildScriptPath), { recursive: true });
    await fs.writeFile(buildScriptPath, buildScript, 'utf8');
  }

  if (
    !packageJson.dependencies ||
    typeof packageJson.dependencies !== 'object' ||
    Array.isArray(packageJson.dependencies)
  ) {
    packageJson.dependencies = {};
    changed = true;
  }

  const dependencies = packageJson.dependencies as Record<string, unknown>;
  if (dependencies['next-rspack']) {
    delete dependencies['next-rspack'];
    changed = true;
  }

  const devDependencies = packageJson.devDependencies;
  if (
    devDependencies &&
    typeof devDependencies === 'object' &&
    !Array.isArray(devDependencies) &&
    (devDependencies as Record<string, unknown>)['next-rspack']
  ) {
    delete (devDependencies as Record<string, unknown>)['next-rspack'];
    changed = true;
  }

  if (changed) {
    await fs.writeFile(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
  }
}

async function normalizeNextConfig(projectPath: string) {
  const configPath = path.join(projectPath, 'next.config.js');
  const content = await readTextFile(configPath);
  const defaultConfig = `/** @type {import('next').NextConfig} */
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = process.env.QUANTPILOT_WORKSPACE_ROOT
  ? path.resolve(process.env.QUANTPILOT_WORKSPACE_ROOT)
  : path.resolve(projectRoot, '../../..');

const nextConfig = {
  turbopack: {
    root: workspaceRoot,
  },
  allowedDevOrigins: ['localhost', '127.0.0.1'],
  typedRoutes: true,
  outputFileTracingRoot: workspaceRoot,
};

module.exports = nextConfig;
`;

  if (content === null || content.trim().length === 0) {
    await fs.writeFile(configPath, defaultConfig, 'utf8');
    return;
  }

  let nextContent = content;
  nextContent = nextContent.replace(
    /(?:const|var|let)\s+withRspack\s*=\s*require\(['"]next-rspack['"]\);\n?/g,
    ''
  );
  nextContent = nextContent.replace(
    /const\s+shouldUseRspack\s*=.*?;\n?/g,
    ''
  );
  nextContent = nextContent.replace(
    /module\.exports\s*=\s*shouldUseRspack\s*\?\s*withRspack\(nextConfig\)\s*:\s*nextConfig\s*;?/g,
    'module.exports = nextConfig;'
  );
  nextContent = nextContent.replace(
    /module\.exports\s*=\s*withRspack\(nextConfig\)\s*;?/g,
    'module.exports = nextConfig;'
  );
  if (!nextContent.includes('const projectRoot = __dirname;')) {
    nextContent = nextContent.replace(
      /\/\*\* @type \{import\(['"]next['"]\)\.NextConfig\} \*\/\n/,
      "/** @type {import('next').NextConfig} */\nconst projectRoot = __dirname;\n"
    );
  }
  if (!nextContent.includes("const path = require('path');")) {
    nextContent = nextContent.replace(
      /\/\*\* @type \{import\(['"]next['"]\)\.NextConfig\} \*\/\n/,
      "/** @type {import('next').NextConfig} */\nconst path = require('path');\n\n"
    );
  }
  if (!nextContent.includes('const workspaceRoot =')) {
    nextContent = nextContent.replace(
      /const projectRoot = __dirname;\n/,
      `const projectRoot = __dirname;
const workspaceRoot = process.env.QUANTPILOT_WORKSPACE_ROOT
  ? path.resolve(process.env.QUANTPILOT_WORKSPACE_ROOT)
  : path.resolve(projectRoot, '../../..');
`
    );
  }
  nextContent = nextContent.replace(/outputFileTracingRoot:\s*projectRoot/g, 'outputFileTracingRoot: workspaceRoot');
  nextContent = nextContent.replace(/root:\s*projectRoot/g, 'root: workspaceRoot');
  if (!nextContent.includes('turbopack:')) {
    nextContent = nextContent.replace(
      /const nextConfig = \{\n/,
      `const nextConfig = {
  turbopack: {
    root: workspaceRoot,
  },
`
    );
  }
  if (!nextContent.includes('allowedDevOrigins')) {
    nextContent = nextContent.replace(
      /const nextConfig = \{\n/,
      `const nextConfig = {
  allowedDevOrigins: ['localhost', '127.0.0.1'],
`
    );
  }

  if (nextContent !== content) {
    await fs.writeFile(configPath, nextContent, 'utf8');
  }
}

async function checkPreviewHttp(
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

async function checkVisualPresentation(
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

async function checkFinalDataFile(
  projectPath: string
): Promise<Omit<QuantValidationCheck, 'id' | 'name' | 'durationMs'>> {
  const finalDir = path.join(projectPath, 'data_file', 'final');
  if (!(await directoryExists(finalDir))) {
    return {
      status: 'failed',
      summary: '未找到 data_file/final 目录。',
    };
  }

  const preferredPath = path.join(finalDir, 'dashboard-data.json');
  const entries = await fs.readdir(finalDir, { withFileTypes: true }).catch(() => []);
  const jsonFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => path.join(finalDir, entry.name));

  const candidates = [
    ...(await fileExists(preferredPath) ? [preferredPath] : []),
    ...jsonFiles.filter((filePath) => filePath !== preferredPath),
  ];

  if (candidates.length === 0) {
    return {
      status: 'failed',
      summary: 'data_file/final 下没有 JSON 数据文件，预期至少生成 dashboard-data.json。',
    };
  }

  const errors: string[] = [];
  for (const filePath of candidates) {
    const raw = await readTextFile(filePath);
    if (!raw || raw.trim().length <= 2) {
      errors.push(`${normalizeRelativePath(projectPath, filePath)} 为空。`);
      continue;
    }

    try {
      const parsed = JSON.parse(raw) as unknown;
      const runPlan = await readRunPlan(projectPath);
      const plannedSymbols = extractPlannedSymbols(runPlan);
      const fetchedSymbols = extractFetchedSymbols(parsed);
      const comparisonSymbols = extractComparisonSymbols(parsed);
      const missingSymbols = plannedSymbols.filter((symbol) => !fetchedSymbols.includes(symbol));
      const serialized = JSON.stringify(parsed);
      const hasDataShape =
        /quote|quotes|price|symbol|symbols|assets|comparison|secid|history|kline|financial|reports|announcement|source|fetched_at|quote_time|close|open|volume|amount|backtest|equity_curve|trades|strategy|drawdown|win_rate|营收|净利润|毛利率|roe|回测|净值|回撤|胜率/i.test(
          serialized
        );
      const hasPlaceholderSmell = /mock|demo|example|placeholder|lorem|示例|样例|模拟|假数据/i.test(serialized);

      if (!isNonEmptyJsonValue(parsed)) {
        errors.push(`${normalizeRelativePath(projectPath, filePath)} 没有可用数据。`);
        continue;
      }

      if (!hasDataShape) {
        errors.push(`${normalizeRelativePath(projectPath, filePath)} 未检测到行情、K 线、财务或来源字段。`);
        continue;
      }

      if (hasPlaceholderSmell) {
        errors.push(`${normalizeRelativePath(projectPath, filePath)} 疑似包含示例或模拟数据标记。`);
        continue;
      }

      const payloadInspection = inspectDashboardDataPayload(parsed);
      const isEmptyScreenerResult = isStructuredEmptyScreenerResult(parsed);
      if (!payloadInspection.hasUsableMarketData && !isEmptyScreenerResult) {
        errors.push(`${normalizeRelativePath(projectPath, filePath)} 未提取到可用实时行情或 K 线样本。`);
        continue;
      }

      if (missingSymbols.length > 0) {
        errors.push(
          `${normalizeRelativePath(projectPath, filePath)} 未覆盖 run_plan 中的全部标的，缺少：${missingSymbols.join('、')}。`
        );
        continue;
      }

      if (plannedSymbols.length > 1) {
        const comparisonMissingSymbols = plannedSymbols.filter((symbol) => !comparisonSymbols.includes(symbol));
        if (comparisonMissingSymbols.length > 0) {
          errors.push(
            `${normalizeRelativePath(projectPath, filePath)} 的 comparison.rows 未覆盖全部对比标的，缺少：${comparisonMissingSymbols.join('、')}。`
          );
          continue;
        }
      }

      const runPlanVisualization = asRecord(runPlan?.visualization);
      const plannedTemplateId = pickString(runPlanVisualization?.templateId);
      const expectedTemplateId = inferExpectedTemplateFromTask(runPlan);
      const taskText = normalizeTextForIntent([
        runPlan?.question,
        runPlan?.task,
        runPlan?.instruction,
        runPlan?.clarification,
      ]);
      const visualization = asRecord(asRecord(parsed)?.visualization);
      const finalTemplateId = pickString(visualization?.template_id ?? visualization?.templateId);
      const requiredComponents = Array.isArray(visualization?.required_components)
        ? visualization.required_components
        : Array.isArray(runPlanVisualization?.panels)
          ? runPlanVisualization.panels
          : [];

      if (expectedTemplateId && plannedTemplateId !== expectedTemplateId) {
        errors.push(
          `${normalizeRelativePath(projectPath, filePath)} 的任务语义需要 ${expectedTemplateId} 模板，但 run_plan.visualization.templateId=${plannedTemplateId ?? '未设置'}。`
        );
        continue;
      }

      if (expectedTemplateId && finalTemplateId && finalTemplateId !== expectedTemplateId) {
        errors.push(
          `${normalizeRelativePath(projectPath, filePath)} 的任务语义需要 ${expectedTemplateId} 模板，但 visualization.template_id=${finalTemplateId}。`
        );
        continue;
      }

      if (plannedTemplateId && !finalTemplateId) {
        errors.push(
          `${normalizeRelativePath(projectPath, filePath)} 缺少 visualization.template_id，无法验证场景化看板模板。`
        );
        continue;
      }

      if (plannedTemplateId && finalTemplateId && plannedTemplateId !== finalTemplateId) {
        errors.push(
          `${normalizeRelativePath(projectPath, filePath)} 的 visualization.template_id=${finalTemplateId} 与 run_plan=${plannedTemplateId} 不一致。`
        );
        continue;
      }

      if (plannedTemplateId && requiredComponents.length === 0) {
        errors.push(
          `${normalizeRelativePath(projectPath, filePath)} 缺少 visualization.required_components，无法确认页面是否覆盖场景痛点。`
        );
        continue;
      }

      const record = asRecord(parsed);
      const tradingPlanRows = Array.isArray(asRecord(record?.tradingPlan)?.rows)
        ? asRecord(record?.tradingPlan)?.rows as unknown[]
        : [];
      if (!hasExplicitTradingPlanIntent(taskText) && tradingPlanRows.length > 0) {
        errors.push(
          `${normalizeRelativePath(projectPath, filePath)} 包含 tradingPlan.rows，但原始需求没有明确要求交易计划、买入区间、止损或目标价。`
        );
        continue;
      }

      if (plannedTemplateId === 'stock-selection' && !isEmptyScreenerResult) {
        const selectionRanking = asRecord(record?.selectionRanking);
        const financialQuality = asRecord(record?.financialQuality);
        const rankingRows = Array.isArray(selectionRanking?.rows) ? selectionRanking.rows : [];
        const qualityRows = Array.isArray(financialQuality?.rows) ? financialQuality.rows : [];
        const comparisonRows = Array.isArray(asRecord(record?.comparison)?.rows)
          ? asRecord(record?.comparison)?.rows as unknown[]
          : [];
        const missingSelectionData = [
          rankingRows.length === 0 ? 'selectionRanking.rows' : null,
          qualityRows.length === 0 ? 'financialQuality.rows' : null,
          comparisonRows.some((row) => {
            const item = asRecord(row);
            return !item || numeric(item.composite_score) === null || !pickString(item.selection_view);
          }) ? 'comparison.rows[].composite_score/selection_view' : null,
        ].filter((item): item is string => Boolean(item));

        if (missingSelectionData.length > 0) {
          errors.push(
            `${normalizeRelativePath(projectPath, filePath)} 缺少选股模板数据字段：${missingSelectionData.join('、')}。`
          );
          continue;
        }
      }

      if (plannedTemplateId === 'holding-analysis') {
        const record = asRecord(parsed);
        const holdings = Array.isArray(record?.holdings) ? record.holdings : [];
        const assets = Array.isArray(record?.assets) ? record.assets : [];
        const comparisonRows = Array.isArray(asRecord(record?.comparison)?.rows)
          ? asRecord(record?.comparison)?.rows as unknown[]
          : [];
        const missingHoldingData = [
          !asRecord(record?.portfolio) ? 'portfolio' : null,
          holdings.length === 0 ? 'holdings[]' : null,
          assets.length === 0 ? 'assets[]' : null,
          comparisonRows.length === 0 ? 'comparison.rows' : null,
        ].filter((item): item is string => Boolean(item));

        if (missingHoldingData.length > 0) {
          errors.push(
            `${normalizeRelativePath(projectPath, filePath)} 缺少持仓分析模板数据字段：${missingHoldingData.join('、')}。`
          );
          continue;
        }
      }

      return {
        status: 'passed',
        summary: `已找到可用最终数据文件：${normalizeRelativePath(projectPath, filePath)}。`,
        metadata: {
          file: normalizeRelativePath(projectPath, filePath),
          bytes: Buffer.byteLength(raw),
          plannedSymbols,
          fetchedSymbols,
          comparisonSymbols,
          barCount: payloadInspection.barCount,
          hasQuote: payloadInspection.hasQuote,
          visualizationTemplateId: finalTemplateId,
        },
      };
    } catch (error) {
      errors.push(`${normalizeRelativePath(projectPath, filePath)} JSON 解析失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    status: 'failed',
    summary: '最终数据文件存在，但没有通过真实数据形态检查。',
    details: errors.join('\n'),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function hasAnyKeyDeep(value: unknown, keys: string[]): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => hasAnyKeyDeep(entry, keys));
  }
  const record = asRecord(value);
  if (!record) {
    return false;
  }
  return Object.entries(record).some(([key, nestedValue]) => keys.includes(key) || hasAnyKeyDeep(nestedValue, keys));
}

function pickString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function truncatePolicySnippet(value: string, limit = 180): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= limit) {
    return compact;
  }
  return `${compact.slice(0, limit)}...`;
}

function isAllowedBackendProxyUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    const port = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
    return (host === '127.0.0.1' || host === 'localhost') && port === '8000' && parsed.pathname.startsWith('/api/v1/');
  } catch {
    return false;
  }
}

async function collectArtifactPolicyFiles(projectPath: string): Promise<string[]> {
  const files: string[] = [];

  const visit = async (currentPath: string) => {
    const entries = await fs.readdir(currentPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isDirectory()) {
        if (!ARTIFACT_POLICY_SKIP_DIRS.has(entry.name)) {
          await visit(absolutePath);
        }
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const ext = path.extname(entry.name);
      if (!ARTIFACT_POLICY_SOURCE_EXTENSIONS.has(ext)) {
        continue;
      }

      const stat = await fs.stat(absolutePath).catch(() => null);
      if (!stat || stat.size > ARTIFACT_POLICY_MAX_FILE_BYTES) {
        continue;
      }

      files.push(absolutePath);
    }
  };

  for (const rootDir of ARTIFACT_POLICY_ROOT_DIRS) {
    const absoluteRoot = path.join(projectPath, rootDir);
    if (await directoryExists(absoluteRoot)) {
      await visit(absoluteRoot);
    }
  }

  for (const rootFile of ARTIFACT_POLICY_ROOT_FILES) {
    const absoluteFile = path.join(projectPath, rootFile);
    if (await fileExists(absoluteFile)) {
      files.push(absoluteFile);
    }
  }

  return Array.from(new Set(files));
}

function findRemotePolicyViolations(projectPath: string, filePath: string, content: string): string[] {
  const relativePath = normalizeRelativePath(projectPath, filePath);
  const isMarketProxyRoute =
    relativePath === 'app/api/market/route.ts' ||
    /^app\/api\/market\/.*\/route\.ts$/.test(relativePath);
  const violations: string[] = [];

  for (const usage of REMOTE_USAGE_PATTERNS) {
    usage.pattern.lastIndex = 0;
    const matches = Array.from(content.matchAll(usage.pattern)).slice(0, 3);
    for (const match of matches) {
      const snippet = match[0] ?? '';
      const urls = Array.from(snippet.matchAll(REMOTE_URL_PATTERN)).map((urlMatch) => urlMatch[0]);
      const disallowedUrls = urls.filter((url) => !(isMarketProxyRoute && isAllowedBackendProxyUrl(url)));
      if (disallowedUrls.length > 0) {
        violations.push(`${relativePath} 存在${usage.label}：${truncatePolicySnippet(snippet)}`);
      }
    }
  }

  REMOTE_URL_PATTERN.lastIndex = 0;
  const remoteUrls = Array.from(content.matchAll(REMOTE_URL_PATTERN)).map((match) => match[0]);
  for (const remoteUrl of remoteUrls.slice(0, 8)) {
    if (isMarketProxyRoute && isAllowedBackendProxyUrl(remoteUrl)) {
      continue;
    }

    if (/nextjs\.org|react\.dev|vercel\.com/i.test(remoteUrl) && /package\.json$|next\.config\./.test(relativePath)) {
      continue;
    }

    if (relativePath === 'package.json') {
      continue;
    }

    violations.push(`${relativePath} 存在外部 URL：${remoteUrl}`);
  }

  return Array.from(new Set(violations));
}

function findPatternPolicyViolations(
  projectPath: string,
  filePath: string,
  content: string,
  patterns: Array<{ label: string; pattern: RegExp }>
): string[] {
  const relativePath = normalizeRelativePath(projectPath, filePath);
  const violations: string[] = [];

  for (const { label, pattern } of patterns) {
    pattern.lastIndex = 0;
    const match = pattern.exec(content);
    if (match?.[0]) {
      violations.push(`${relativePath} 存在${label}：${truncatePolicySnippet(match[0])}`);
    }
  }

  return violations;
}

function collectVisualizationDependencyWarnings(projectPath: string, packageRaw: string | null): string[] {
  if (!packageRaw) {
    return [];
  }

  try {
    const parsed = JSON.parse(packageRaw) as Record<string, unknown>;
    const dependencyNames = [
      ...Object.keys(asRecord(parsed.dependencies) ?? {}),
      ...Object.keys(asRecord(parsed.devDependencies) ?? {}),
    ];
    return dependencyNames
      .filter((dependency) => DISCOURAGED_VISUALIZATION_DEPENDENCIES.has(dependency))
      .map(
        (dependency) =>
          `${normalizeRelativePath(projectPath, path.join(projectPath, 'package.json'))} 引入 ${dependency}，生成看板优先使用平台内置 SVG/CSS 图表，避免额外依赖拖慢 build。`
      );
  } catch {
    return [];
  }
}

async function checkArtifactPolicy(
  projectPath: string
): Promise<Omit<QuantValidationCheck, 'id' | 'name' | 'durationMs'>> {
  const requiredArtifacts = [
    '.quantpilot/run_plan.json',
    'app/page.tsx',
    'data_file/final/dashboard-data.json',
    'evidence/sources.json',
    'evidence/data_quality.json',
  ];
  const missingArtifacts: string[] = [];
  for (const relativePath of requiredArtifacts) {
    if (!(await fileExists(path.join(projectPath, relativePath)))) {
      missingArtifacts.push(relativePath);
    }
  }

  const files = await collectArtifactPolicyFiles(projectPath);
  const violations: string[] = [];
  const warnings: string[] = [];

  if (missingArtifacts.length > 0) {
    violations.push(`缺少标准产物：${missingArtifacts.join('、')}。`);
  }

  for (const filePath of files) {
    const relativePath = normalizeRelativePath(projectPath, filePath);
    const content = await readTextFile(filePath);
    if (!content) {
      continue;
    }

    violations.push(...findRemotePolicyViolations(projectPath, filePath, content));
    violations.push(...findPatternPolicyViolations(projectPath, filePath, content, SENSITIVE_ARTIFACT_PATTERNS));

    if (/^(?:app|components|hooks|lib|src)\//.test(relativePath)) {
      violations.push(...findPatternPolicyViolations(projectPath, filePath, content, EXECUTION_ESCAPE_PATTERNS));
      if (
        relativePath !== 'app/api/market/[...path]/route.ts' &&
        /\b(?:globalThis\s*\.\s*)?fetch\s*\(/i.test(content)
      ) {
        violations.push(`${relativePath} 存在非平台 market proxy 的网络请求 API。`);
      }
      violations.push(...findPatternPolicyViolations(projectPath, filePath, content, MOCK_ARTIFACT_PATTERNS));
    }
  }

  const pagePath = path.join(projectPath, 'app', 'page.tsx');
  const page = await readTextFile(pagePath);
  if (page && !/data_file\/final\/dashboard-data\.json|data_file\\final\\dashboard-data\.json|\/api\/market/.test(page)) {
    violations.push('app/page.tsx 没有使用标准 final 数据文件或 /api/market 同源接口。');
  }

  const packageRaw = await readTextFile(path.join(projectPath, 'package.json'));
  warnings.push(...collectVisualizationDependencyWarnings(projectPath, packageRaw));

  if (violations.length > 0) {
    return {
      status: 'failed',
      summary: '生成产物未满足 QuantPilot 硬约束。',
      details: violations.slice(0, 20).join('\n'),
      metadata: {
        checkedFiles: files.length,
        violationCount: violations.length,
        warningCount: warnings.length,
      },
    };
  }

  if (warnings.length > 0) {
    return {
      status: 'warning',
      summary: '生成产物满足硬约束，但存在可优化依赖。',
      details: warnings.slice(0, 10).join('\n'),
      metadata: {
        checkedFiles: files.length,
        warningCount: warnings.length,
      },
    };
  }

  return {
    status: 'passed',
    summary: '生成产物满足本地化、真实数据绑定和安全策略。',
    metadata: {
      checkedFiles: files.length,
    },
  };
}

export async function checkQuantArtifactPolicy(projectPath: string): Promise<QuantValidationCheck> {
  return safeRunCheck('artifact_policy', '生成产物策略', () =>
    checkArtifactPolicy(path.resolve(/*turbopackIgnore: true*/ projectPath))
  );
}

function normalizeTextForIntent(value: unknown): string {
  if (typeof value === 'string') {
    return value.replace(/\s+/g, '');
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeTextForIntent(item)).join('');
  }
  const record = asRecord(value);
  if (record) {
    return Object.values(record).map((item) => normalizeTextForIntent(item)).join('');
  }
  return '';
}

function hasHoldingAnalysisIntent(taskText: string): boolean {
  return /持仓|仓位|调仓|盈亏|成本价|持仓成本|买入成本|成本线|成本偏离|账户|证券账户|总资产|可用资金|可用现金|浮动盈亏|持仓截图|截图持仓|账户截图|交易截图|组合持仓|我的组合|账户组合|持仓组合|交割单/.test(
    taskText
  );
}

function hasExplicitTradingPlanIntent(taskText: string): boolean {
  return /交易计划|买入区间|买点|卖点|入场|出场|止损|止盈|目标价|仓位|建仓|加仓|减仓|卖出|买入|怎么操作|如何操作|操作建议|短线.*(?:买|卖|交易|计划)|(?:1|3|5|一|三|五)个交易日.*(?:计划|操作)|持仓.*(?:调仓|减仓|加仓)/.test(
    taskText
  );
}

function hasComparisonAnalysisIntent(taskText: string, plannedSymbols: string[]): boolean {
  return (
    plannedSymbols.length >= 2 ||
    /对比|比较|多只|多支|多股票|多标的|横向|矩阵|排名|排序|推荐顺序|观察池|哪(?:个|些|几只)|谁更|更强|更稳健|候选|选股|资产池|股票池|累计收益|收益曲线|相关性|分散|流动性|成交额/.test(taskText) ||
    (
      /(?:股票|个股|a股|全a|股票池)/i.test(taskText) &&
      /全a|a股股票池|股票池|选股|筛选|候选|短线候选|次日|明日|明天|今日|今天|要买|买股|买入策略|短线|推荐\d*(?:只|个)?(?:股票|个股)|(?:股票|个股).{0,12}推荐|推荐.{0,18}(?:股票|个股)/i.test(taskText)
    )
  );
}

function inferExpectedTemplateFromTask(runPlan: Record<string, unknown> | null): string | null {
  if (!runPlan) {
    return null;
  }

  const capabilityId = pickString(runPlan.capabilityId ?? runPlan.capability_id);
  const taskText = normalizeTextForIntent([
    runPlan.question,
    runPlan.task,
    runPlan.instruction,
    runPlan.clarification,
  ]);
  const plannedSymbols = extractPlannedSymbols(runPlan);
  const holdingIntent = hasHoldingAnalysisIntent(taskText);
  const comparisonIntent = hasComparisonAnalysisIntent(taskText, plannedSymbols);

  if (comparisonIntent && !holdingIntent) {
    return 'stock-selection';
  }
  if (holdingIntent) {
    return 'holding-analysis';
  }
  if (capabilityId === 'portfolio_risk') {
    return 'holding-analysis';
  }
  if (capabilityId === 'asset_comparison') {
    return 'stock-selection';
  }
  if (capabilityId === 'sector_rotation') {
    return 'sector-rotation';
  }
  if (capabilityId === 'backtest_review') {
    return 'backtest-review';
  }
  if (capabilityId === 'technical_analysis') {
    return 'technical-timing';
  }
  if (capabilityId === 'fundamental_analysis') {
    return 'fundamental-research';
  }

  return null;
}

function pickSymbolCode(value: unknown): string | null {
  if (typeof value === 'string' && /^(?:6|0|3|5)\d{5}$/.test(value.trim())) {
    return value.trim();
  }

  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const candidates = [
    record.symbol,
    record.code,
    record.security_code,
    record.securityCode,
    record.ticker,
    typeof record.secid === 'string' ? record.secid.split('.').at(-1) : null,
  ];

  for (const candidate of candidates) {
    const symbol = pickString(candidate);
    if (symbol && /^(?:6|0|3|5)\d{5}$/.test(symbol)) {
      return symbol;
    }
  }

  return null;
}

async function readRunPlan(projectPath: string): Promise<Record<string, unknown> | null> {
  const raw = await readTextFile(path.join(projectPath, '.quantpilot', 'run_plan.json'));
  if (!raw) {
    return null;
  }
  try {
    return asRecord(JSON.parse(raw));
  } catch {
    return null;
  }
}

async function readCurrentQuantRunId(projectPath: string): Promise<string | null> {
  const generationStateRaw = await readTextFile(
    path.join(projectPath, '.quantpilot', 'generation-state.json'),
  );
  if (generationStateRaw) {
    try {
      const generationState = asRecord(JSON.parse(generationStateRaw));
      const requestId = pickString(generationState?.requestId);
      if (requestId) {
        return requestId;
      }
    } catch {
      // Fall back to the run plan when generation state is unavailable.
    }
  }

  const runPlan = await readRunPlan(projectPath);
  return pickString(runPlan?.runId);
}

function extractPlannedSymbols(runPlan: Record<string, unknown> | null): string[] {
  const symbols = Array.isArray(runPlan?.symbols) ? runPlan.symbols : [];
  return Array.from(
    new Set(
      symbols
        .map((symbol) => pickSymbolCode(symbol))
        .filter((symbol): symbol is string => Boolean(symbol && /^(?:6|0|3|5)\d{5}$/.test(symbol)))
    )
  );
}

function extractFetchedSymbols(data: unknown): string[] {
  const record = asRecord(data);
  if (!record) {
    return [];
  }

  const assets = Array.isArray(record.assets)
    ? record.assets.map(asRecord).filter((asset): asset is Record<string, unknown> => Boolean(asset))
    : [];
  const candidates = assets.length > 0
    ? assets.map((asset) => pickSymbolCode(asset) ?? pickSymbolCode(asRecord(asset.quote)?.symbol))
    : [
        pickSymbolCode(record),
        pickSymbolCode(asRecord(record.quote)),
        ...(Array.isArray(record.symbols) ? record.symbols.map((symbol) => pickSymbolCode(symbol)) : []),
      ];

  return Array.from(
    new Set(candidates.filter((symbol): symbol is string => Boolean(symbol && /^(?:6|0|3|5)\d{5}$/.test(symbol))))
  );
}

function extractComparisonSymbols(data: unknown): string[] {
  const record = asRecord(data);
  if (!record) {
    return [];
  }

  const comparison = asRecord(record.comparison);
  const rows = Array.isArray(comparison?.rows)
    ? comparison.rows
    : Array.isArray(record.comparison)
      ? record.comparison
      : [];

  return Array.from(
    new Set(
      rows
        .map((row) => pickSymbolCode(row))
        .filter((symbol): symbol is string => Boolean(symbol && /^(?:6|0|3|5)\d{5}$/.test(symbol)))
    )
  );
}

function numeric(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item))
    : [];
}

function extractBarsFromDashboardData(data: unknown): Record<string, unknown>[] {
  const record = asRecord(data);
  if (!record) {
    return [];
  }

  const assets = arrayOfRecords(record.assets);
  if (assets.length > 0) {
    return assets.flatMap((asset) => extractBarsFromDashboardData(asset));
  }

  const kline = asRecord(record.kline) ?? asRecord(record.history) ?? asRecord(record.ohlc);
  const candidates = [
    kline?.bars,
    kline?.data,
    kline?.items,
    record.bars,
    record.klines,
    record.candles,
    record.history,
  ];

  for (const candidate of candidates) {
    const bars = arrayOfRecords(candidate);
    if (bars.length > 0) {
      return bars;
    }
  }

  return [];
}

function hasUsableQuote(data: unknown): boolean {
  const record = asRecord(data);
  if (!record) {
    return false;
  }

  const assets = arrayOfRecords(record.assets);
  if (assets.length > 0) {
    return assets.some(hasUsableQuote);
  }

  const quote = asRecord(record.quote);
  return [
    quote?.price,
    quote?.latest,
    quote?.latest_price,
    quote?.close,
    record.price,
    record.latest,
    record.latest_price,
  ].some((value) => numeric(value) !== null);
}

function inspectDashboardDataPayload(data: unknown) {
  const bars = extractBarsFromDashboardData(data);
  const hasQuote = hasUsableQuote(data);
  const fetchedSymbols = extractFetchedSymbols(data);

  return {
    hasQuote,
    barCount: bars.length,
    fetchedSymbols,
    hasUsableMarketData: hasQuote || bars.length > 0,
  };
}

function isStructuredEmptyScreenerResult(data: unknown): boolean {
  const record = asRecord(data);
  const screener = asRecord(record?.screener);
  const comparison = asRecord(record?.comparison);
  const ranking = asRecord(record?.selectionRanking);
  const financialQuality = asRecord(record?.financialQuality);
  const tradingPlan = asRecord(record?.tradingPlan);
  const assets = Array.isArray(record?.assets) ? record.assets : null;
  const candidates = Array.isArray(screener?.candidates) ? screener.candidates : null;
  const totalCandidates = numeric(screener?.total_candidates);

  return Boolean(
    record?.status === 'no_candidates' &&
      assets &&
      assets.length === 0 &&
      candidates &&
      candidates.length === 0 &&
      totalCandidates === 0 &&
      pickString(screener?.source) &&
      pickString(screener?.fetched_at ?? screener?.as_of ?? screener?.trade_date) &&
      Array.isArray(comparison?.rows) &&
      Array.isArray(ranking?.rows) &&
      Array.isArray(financialQuality?.rows) &&
      Array.isArray(tradingPlan?.rows) &&
      Array.isArray(record.warnings) &&
      record.warnings.length > 0
  );
}

async function ensurePrefetchedFinalData(projectPath: string) {
  const runPlan = await readRunPlan(projectPath);
  if (!runPlan) {
    return;
  }

  const raw = await readTextFile(path.join(projectPath, 'data_file', 'final', 'dashboard-data.json'));
  let parsed: unknown = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }

  const inspection = inspectDashboardDataPayload(parsed);
  const plannedSymbols = extractPlannedSymbols(runPlan);
  const missingSymbols = plannedSymbols.filter((symbol) => !inspection.fetchedSymbols.includes(symbol));
  if (raw && (inspection.hasUsableMarketData || isStructuredEmptyScreenerResult(parsed)) && missingSymbols.length === 0) {
    return;
  }

  try {
    await prefetchQuantDataForRunPlan({
      projectPath,
      plan: runPlan as unknown as QuantRunPlan,
    });
  } catch (error) {
    console.warn(
      '[QuantValidation] Failed to prefetch final dashboard data before validation:',
      error
    );
  }
}

type EvidenceJsonResult =
  | { ok: true; parsed: unknown; raw: string; absolutePath: string }
  | { ok: false; error: string; absolutePath: string };

async function readEvidenceJson(
  projectPath: string,
  relativePath: string
): Promise<EvidenceJsonResult> {
  const absolutePath = path.join(projectPath, relativePath);
  const raw = await readTextFile(absolutePath);
  if (!raw) {
    return { ok: false, error: `未找到或为空：${relativePath}`, absolutePath };
  }
  try {
    return { ok: true, parsed: JSON.parse(raw), raw, absolutePath };
  } catch (error) {
    return {
      ok: false,
      error: `${relativePath} JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
      absolutePath,
    };
  }
}

async function checkEvidenceFiles(
  projectPath: string
): Promise<Omit<QuantValidationCheck, 'id' | 'name' | 'durationMs'>> {
  const baseline = await ensureBaselineEvidenceFiles(projectPath);
  const sources = await readEvidenceJson(projectPath, path.join('evidence', 'sources.json'));
  const quality = await readEvidenceJson(projectPath, path.join('evidence', 'data_quality.json'));
  const errors: string[] = [];

  if (!sources.ok || !quality.ok) {
    const fileErrors = [
      sources.ok ? null : sources.error,
      quality.ok ? null : quality.error,
    ].filter((error): error is string => Boolean(error));
    return {
      status: 'failed',
      summary: '缺少数据信源渠道或数据质量证据文件。',
      details: fileErrors.join('\n'),
    };
  }

  const sourcesRaw = sources.raw;
  const qualityRaw = quality.raw;
  const combined = `${sourcesRaw}\n${qualityRaw}`;
  if (SENSITIVE_EVIDENCE_PATTERN.test(combined)) {
    return {
      status: 'failed',
      summary: 'evidence 文件疑似包含敏感信息。',
      details: '请移除任何鉴权凭据、会话凭据或密钥值，仅保留数据信源渠道、端点、时间戳和质量摘要。',
    };
  }

  const sourceEntries = asRecord(sources.parsed)?.sources;
  if (!Array.isArray(sourceEntries) || sourceEntries.length === 0) {
    errors.push('evidence/sources.json 必须包含非空 sources 数组。');
  }

  const serializedSources = JSON.stringify(sources.parsed);
  if (!/source|eastmoney|tencent|endpoint|fetched_at|as_of|quote_time|artifact_path/i.test(serializedSources)) {
    errors.push('evidence/sources.json 未检测到 source、endpoint、fetched_at/as_of 或 artifact_path 等来源字段。');
  }

  const qualityRecord = asRecord(quality.parsed);
  const qualityStatus = typeof qualityRecord?.status === 'string' ? qualityRecord.status : null;
  if (!qualityStatus || !['ok', 'warning', 'error'].includes(qualityStatus)) {
    errors.push('evidence/data_quality.json 必须包含 status，取值为 ok、warning 或 error。');
  }

  const hasQualitySignals =
    hasAnyKeyDeep(quality.parsed, ['datasets', 'checks', 'missing_fields', 'warnings', 'limitations', 'row_count', 'fetched_at']) ||
    /row_count|missing_fields|warnings|limitations|fetched_at|样本|缺失|限制/i.test(JSON.stringify(quality.parsed));
  if (!hasQualitySignals) {
    errors.push('evidence/data_quality.json 未检测到数据集、检查项、缺失字段、警告或限制说明。');
  }

  if (errors.length > 0) {
    return {
      status: 'failed',
      summary: '数据信源渠道或质量证据不完整。',
      details: errors.join('\n'),
    };
  }

  const warningSummary = qualityStatus === 'warning' ? '数据质量存在警告，页面应展示限制说明。' : undefined;
  return {
    status: qualityStatus === 'error' ? 'failed' : qualityStatus === 'warning' ? 'warning' : 'passed',
    summary: baseline.created
      ? `已根据最终数据自动生成数据信源渠道和质量证据文件，状态：${qualityStatus}。`
      : warningSummary ?? '已找到数据信源渠道和质量证据文件。',
    metadata: {
      sources: 'evidence/sources.json',
      dataQuality: 'evidence/data_quality.json',
      qualityStatus,
      sourceCount: Array.isArray(sourceEntries) ? sourceEntries.length : 0,
      baselineCreated: baseline.created,
      baselineReason: baseline.reason,
    },
  };
}

async function checkDashboardBinding(
  projectPath: string
): Promise<Omit<QuantValidationCheck, 'id' | 'name' | 'durationMs'>> {
  const pagePath = path.join(projectPath, 'app', 'page.tsx');
  const page = await readTextFile(pagePath);
  if (!page) {
    return {
      status: 'failed',
      summary: '未找到 app/page.tsx。',
    };
  }

  const defaultPageSignals = [
    'Get started by editing',
    'Learn →',
    'Examples →',
    'Next.js →',
  ];
  if (defaultPageSignals.some((signal) => page.includes(signal))) {
    return {
      status: 'failed',
      summary: 'app/page.tsx 仍包含 Next.js 默认页内容。',
    };
  }

  const bindingSignals = [
    '/api/market',
    'dashboard-data.json',
    'data_file/final',
    'data_file\\final',
    'fetch(',
  ];
  const hasBindingSignal = bindingSignals.some((signal) => page.includes(signal));
  const hardcodedDataSignals = [
    /const\s+DASHBOARD_DATA\s*[:=]\s*\{/,
    /const\s+(?:STATIC_|MOCK_|SAMPLE_)?(?:QUOTE|QUOTES|HISTORY|KLINE|KLINES|FINANCIALS|REPORTS|ANNOUNCEMENTS|DASHBOARD_DATA)\s*[:=]\s*(?:\[|\{)/,
    /(?:bars|reports|announcements)\s*:\s*\[\s*\{[\s\S]{0,80}(?:open|close|report_date|notice_date|title)\s*:/,
  ];
  const hasStaticSmell =
    hardcodedDataSignals.some((signal) => signal.test(page)) ||
    (page.match(/(?:trade_date|report_date|notice_date|change_percent)\s*:/g)?.length ?? 0) > 30;
  const runPlan = await readRunPlan(projectPath);
  const plannedSymbols = extractPlannedSymbols(runPlan);
  const finalDataRaw = await readTextFile(path.join(projectPath, 'data_file', 'final', 'dashboard-data.json'));
  let finalData: unknown = null;
  try {
    finalData = finalDataRaw ? JSON.parse(finalDataRaw) : null;
  } catch {
    finalData = null;
  }
  const finalDataRecord = asRecord(finalData);
  const assetRows = Array.isArray(finalDataRecord?.assets) ? finalDataRecord.assets : [];
  const fetchedSymbols = extractFetchedSymbols(finalData);
  const payloadInspection = inspectDashboardDataPayload(finalData);
  const isEmptyScreenerResult = isStructuredEmptyScreenerResult(finalData);
  const isMultiSymbolTask = plannedSymbols.length > 1 || assetRows.length > 1;
  const runPlanVisualization = asRecord(runPlan?.visualization);
  const plannedTemplateId = pickString(runPlanVisualization?.templateId);
  const expectedTemplateId = inferExpectedTemplateFromTask(runPlan);
  const taskText = normalizeTextForIntent([
    runPlan?.question,
    runPlan?.task,
    runPlan?.instruction,
    runPlan?.clarification,
  ]);
  const requiredPanels = Array.isArray(runPlanVisualization?.panels)
    ? runPlanVisualization.panels.map((panel) => pickString(panel)).filter((panel): panel is string => Boolean(panel))
    : [];

  if (!hasBindingSignal) {
    return {
      status: 'failed',
      summary: '页面未检测到数据文件或同源行情 API 绑定。',
      details: 'app/page.tsx 应读取 data_file/final/dashboard-data.json，或通过 /api/market/** 获取真实数据。',
    };
  }

  if (hasStaticSmell) {
    return {
      status: 'failed',
      summary: '页面疑似直接硬编码大段行情/财务数据，未形成可复用的数据绑定。',
      details: '请让 app/page.tsx 读取 data_file/final/dashboard-data.json，或通过 /api/market/** 获取数据；不要把完整数据对象内联到页面代码。',
    };
  }

  if (!payloadInspection.hasUsableMarketData && !isEmptyScreenerResult) {
    return {
      status: 'failed',
      summary: '页面数据入口存在，但最终数据无法映射出实时行情或 K 线样本。',
      details: '请先生成可用 data_file/final/dashboard-data.json；其中至少应包含 quote.price 或 kline.bars/history.bars 等字段。',
      metadata: payloadInspection,
    };
  }

  const hasStandardBinding =
    /function\s+getBars\(|extractBarsFromDashboardData|data-source-file=\{DATA_FILE\}|data_file\/final\/dashboard-data\.json/.test(page);
  if (!hasStandardBinding) {
    return {
      status: 'failed',
      summary: '页面未使用 QuantPilot 标准看板数据绑定结构。',
      details: '请使用平台标准模板读取 dashboard-data.json，并通过统一解析层渲染最新价、K 线样本、指标、财务和公告。',
    };
  }

  if (expectedTemplateId && plannedTemplateId !== expectedTemplateId) {
    return {
      status: 'failed',
      summary: `执行计划模板与任务语义不一致，应使用 ${expectedTemplateId}。`,
      details: `当前 run_plan.visualization.templateId=${plannedTemplateId ?? '未设置'}。持仓、调仓、截图账户类任务必须走持仓分析模板，不能复用个股诊断模板。`,
      metadata: {
        expectedTemplateId,
        plannedTemplateId,
      },
    };
  }

  const finalTemplateId = pickString(asRecord(finalDataRecord?.visualization)?.template_id ?? asRecord(finalDataRecord?.visualization)?.templateId);
  if (expectedTemplateId && finalTemplateId && finalTemplateId !== expectedTemplateId) {
    return {
      status: 'failed',
      summary: `最终数据模板与任务语义不一致，应使用 ${expectedTemplateId}。`,
      details: `当前 data_file/final/dashboard-data.json visualization.template_id=${finalTemplateId}。`,
      metadata: {
        expectedTemplateId,
        finalTemplateId,
      },
    };
  }

  const tradingPlanRows = Array.isArray(asRecord(finalDataRecord?.tradingPlan)?.rows)
    ? asRecord(finalDataRecord?.tradingPlan)?.rows as unknown[]
    : [];
  const hasPageTradingPlan = /短线交易计划|交易计划|买入区间|买点|卖点|止损|止盈|目标价|仓位上限|入场|出场/.test(page);
  if (!hasExplicitTradingPlanIntent(taskText) && (tradingPlanRows.length > 0 || hasPageTradingPlan)) {
    return {
      status: 'failed',
      summary: '页面包含未被用户明确要求的交易执行计划。',
      details: '原始需求没有要求买入区间、止损、目标价、仓位或操作建议。请移除 tradingPlan 和页面中的短线交易计划，只保留事实对比、研究结论、风险提示和数据限制。',
      metadata: {
        hasTradingPlanData: tradingPlanRows.length > 0,
        hasPageTradingPlan,
      },
    };
  }

  if (isMultiSymbolTask) {
    const dataDrivenCoverage =
      /requestedSymbols|assets|comparison/.test(page) &&
      plannedSymbols.every((symbol) => fetchedSymbols.includes(symbol));
    const missingPageSymbols = dataDrivenCoverage
      ? []
      : plannedSymbols.filter((symbol) => !page.includes(symbol));
    const hasComparisonBinding = /assets|comparison|requestedSymbols|assetCount|对比|相对强弱|多标的|收益对比|回撤对比|波动/.test(page);
    if (missingPageSymbols.length > 0 || !hasComparisonBinding) {
      return {
        status: 'failed',
        summary: '页面未完整绑定多标的对比数据。',
        details: [
          missingPageSymbols.length > 0 ? `页面未显式覆盖标的：${missingPageSymbols.join('、')}。` : null,
          !hasComparisonBinding ? '页面未检测到 assets[]、comparison 或多标的对比展示逻辑。' : null,
        ].filter(Boolean).join('\n'),
        metadata: {
          plannedSymbols,
          fetchedSymbols,
          assetCount: assetRows.length,
        },
      };
    }
  }

	  if (plannedTemplateId) {
	    const serializedPage = page.toLowerCase();
	    const serializedFinal = JSON.stringify(finalData ?? {}).toLowerCase();
	    const templateChecks: Record<string, { label: string; patterns: RegExp[] }> = {
      'holding-analysis': {
        label: '持仓分析模板',
        patterns: [/持仓|holding|portfolio|仓位|集中度/, /调仓|风险|相关性|流动性|回撤/],
      },
	      'stock-selection': {
	        label: '选股分析模板',
	        patterns: [
	          /stock-selection|选股|候选|多标的|comparison|assets/,
	          /selectionranking|financialquality|排名|相对强弱|研究优先级/,
	          /收益对比|波动对比|回撤对比|财务质量|(?:数据来源|数据信源|信源渠道)逐项追踪/,
	        ],
	      },
      'single-stock-diagnosis': {
        label: '个股诊断模板',
        patterns: [/个股|行情|最新价|quote|k\s*线|k线/, /财务|公告|(?:数据来源|数据信源|信源渠道)|质量/],
      },
      'technical-timing': {
        label: '技术择时模板',
        patterns: [/k\s*线|k线|均线|ma20|ma60|成交量/, /触发|失效|趋势|回撤|波动/],
      },
      'fundamental-research': {
        label: '基本面研究模板',
        patterns: [/财务|基本面|营收|净利润|roe|毛利率/, /报告期|现金流|公告|估值/],
      },
      'backtest-review': {
        label: '回测复盘模板',
        patterns: [/回测|净值|策略|胜率|交易/, /参数|回撤|样本|限制/],
      },
      'sector-rotation': {
        label: '板块轮动模板',
        patterns: [/板块|行业|指数|etf|轮动|相对强弱/, /收益|回撤|流动性|排名/],
      },
    };
    const templateCheck = templateChecks[plannedTemplateId];
    const missingSignals = templateCheck?.patterns
      .filter((pattern) => !pattern.test(page) && !pattern.test(serializedPage) && !pattern.test(serializedFinal))
      .map((pattern) => pattern.source) ?? [];

	    if (templateCheck && missingSignals.length > 0) {
	      return {
	        status: 'failed',
        summary: `页面未体现 ${templateCheck.label} 的关键组件。`,
        details: [
          `run_plan.visualization.templateId=${plannedTemplateId}`,
          requiredPanels.length ? `必备组件：${requiredPanels.join('、')}` : null,
          `缺少信号：${missingSignals.join('；')}`,
        ].filter(Boolean).join('\n'),
	      };
	    }

	    if (plannedTemplateId === 'holding-analysis') {
	      const oversizedHeroSignals = [
	        /hero-band/,
	        /risk-card/,
	        /holding-analysis\s*持仓分析模板/i,
	        /持仓问题快速诊断/,
	      ];
	      if (oversizedHeroSignals.some((signal) => signal.test(page))) {
	        return {
	          status: 'failed',
	          summary: '持仓分析页面仍使用过重的顶部 hero 结构。',
          details: '持仓、调仓和截图账户类看板应直接从账户摘要、持仓矩阵或核心风险指标开始；VaR、样本口径和声明应放入连续指标带、风险分区或底部说明，不要占据首屏顶部。',
	        };
	      }
	    }

	    if (plannedTemplateId === 'stock-selection') {
	      const holdingOnlySignals = [
	        /持仓矩阵/,
	        /仓位与集中度/,
	        /调仓优先级/,
	        /portfolio[_-]?risk/i,
	        /holding-analysis/i,
	      ];
	      if (holdingOnlySignals.some((signal) => signal.test(page))) {
	        return {
	          status: 'failed',
	          summary: '页面仍残留持仓分析模板，不符合选股/多股对比任务。',
	          details: 'stock-selection 页面应展示候选覆盖、排名依据、财务质量、收益/波动/回撤对比和数据信源渠道逐项追踪。',
	        };
	      }
	    }
	  }

  return {
    status: 'passed',
    summary: '页面已检测到真实数据绑定入口。',
    metadata: {
      signals: bindingSignals.filter((signal) => page.includes(signal)),
    },
  };
}

async function checkChartPresence(
  projectPath: string
): Promise<Omit<QuantValidationCheck, 'id' | 'name' | 'durationMs'>> {
  const pagePath = path.join(projectPath, 'app', 'page.tsx');
  const page = await readTextFile(pagePath);
  if (!page) {
    return {
      status: 'failed',
      summary: '未找到 app/page.tsx，无法检查图表。',
    };
  }

  const styleFiles = await Promise.all([
    readTextFile(path.join(projectPath, 'app', 'globals.css')),
    readTextFile(path.join(projectPath, 'styles', 'globals.css')),
    readTextFile(path.join(projectPath, 'src', 'app', 'globals.css')),
  ]);
  const visualSource = [page, ...styleFiles.filter(Boolean)].join('\n');
  const hasGraphicElement = /<svg|<canvas|<polyline|<rect|<path|Chart|chart|candlestick|ohlc|K线|K 线|折线|柱状|趋势图/i.test(page);
  const hasFinanceOrMarketLanguage = /成交量|成交额|均线|MA5|MA10|MA20|K线|K 线|营收|净利润|ROE|毛利率|回撤|波动率|quote|history|financial/i.test(page);
  const hasSemanticColoring = /red|green|up|down|gain|loss|risk-(?:high|mid|low)|dot\s+(?:red|green|amber)|candle-up|candle-down|volume-up|volume-down|bar-up|bar-down|quality-(?:ok|warning|error)|signal-(?:up|down)|#d9363e|#15945b|#dc2626|#16a34a/i.test(visualSource);
  const hasChartReadingAid = /<title>|<desc>|aria-label|chart-label|axis|grid|legend|tooltip|刻度|图例|坐标|日期/i.test(page);
  const hasMiniOnlySmell = /className="(?:sparkline|mini-kline)"|className='(?:sparkline|mini-kline)'|sparkline-empty|MiniKlineChart/i.test(page) &&
    !/chart-label|chart-price|chart-date|volume-chart|KLinePanel|MainKline|主图|成交量副图/i.test(page);
  const runPlan = await readRunPlan(projectPath);
  const plannedSymbols = extractPlannedSymbols(runPlan);
  const finalDataRaw = await readTextFile(path.join(projectPath, 'data_file', 'final', 'dashboard-data.json'));
  const hasMultiFinalData = Boolean(finalDataRaw && /"assets"\s*:|"comparison"\s*:/.test(finalDataRaw));
  const isMultiSymbolTask = plannedSymbols.length > 1 || hasMultiFinalData;
  const plannedTemplateId = pickString(asRecord(runPlan?.visualization)?.templateId);

  if (!hasGraphicElement || !hasFinanceOrMarketLanguage) {
    return {
      status: 'failed',
      summary: '未检测到有效金融图表实现。',
      details: '页面至少应包含 SVG/canvas/图表组件，并展示 K 线、成交量、均线、财务趋势或风险指标。',
    };
  }

  if (!hasSemanticColoring || !hasChartReadingAid) {
    return {
      status: 'failed',
      summary: '金融图表缺少语义染色或读图辅助。',
      details: '页面需要为涨跌、风险、质量状态提供明确颜色，并给 SVG/canvas 图表提供坐标/图例/tooltip/title 等读图辅助。',
      metadata: {
        hasSemanticColoring,
        hasChartReadingAid,
      },
    };
  }

  if (hasMiniOnlySmell) {
    return {
      status: 'failed',
      summary: '金融图表只有迷你趋势图，缺少可读主图。',
      details: '多标的页面可以保留 sparkline，但必须额外提供带坐标/日期/图例/成交量或对比尺度的主图、矩阵或表格。',
      metadata: {
        plannedSymbols,
        plannedTemplateId,
      },
    };
  }

  if (isMultiSymbolTask && !/对比|相对强弱|多标的|矩阵|收益|波动|回撤|comparison|assets/i.test(page)) {
    return {
      status: 'failed',
      summary: '多标的任务未检测到对比图表或对比指标展示。',
      details: '页面需要展示多标的指标矩阵、收益对比、波动/回撤对比或相对强弱摘要。',
      metadata: {
        plannedSymbols,
      },
    };
  }

  if (
    plannedTemplateId === 'stock-selection' &&
    !/selectionRanking|financialQuality|stock-selection|相对强弱与排名依据|财务质量|收益对比图|波动对比图|回撤对比图/.test(page)
  ) {
    return {
      status: 'failed',
      summary: '选股任务未检测到场景化选股图表组件。',
      details: '页面需要展示相对强弱/排名依据、财务质量、收益对比图、波动对比图或回撤对比图。',
      metadata: {
        plannedSymbols,
        plannedTemplateId,
      },
    };
  }

  if (plannedTemplateId === 'technical-timing') {
    const hasMa60Graphic =
      /legend-ma60|className=["'][^"']*ma60|(?:ma60|MA60)[\w]*\s*\.map\(|name\s*:\s*["']MA60/i.test(page);
    const hasExplicitRiskConclusion = /风险结论|风险等级/.test(page);
    const hasVolumeGraphic = /volume-chart|成交量副图|VolumeChart|volumeBars/.test(page);
    if (!hasMa60Graphic || !hasExplicitRiskConclusion || !hasVolumeGraphic) {
      return {
        status: 'failed',
        summary: '技术择时看板缺少完整的 MA60、成交量或风险结论。',
        details: [
          !hasMa60Graphic ? 'MA60 必须实际绘制到主图，不能只出现在文字或组件清单中。' : null,
          !hasVolumeGraphic ? '必须绘制成交量副图。' : null,
          !hasExplicitRiskConclusion ? '必须显式展示风险结论或风险等级。' : null,
        ].filter(Boolean).join('\n'),
        metadata: {
          hasMa60Graphic,
          hasVolumeGraphic,
          hasExplicitRiskConclusion,
          plannedTemplateId,
        },
      };
    }
  }

  return {
    status: 'passed',
    summary: '已检测到金融图表相关实现。',
  };
}

async function checkMarketProxy(
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

async function checkArtifactContracts(
  projectPath: string,
  projectId: string,
  requestId?: string | null
): Promise<Omit<QuantValidationCheck, 'id' | 'name' | 'durationMs'>> {
  const report = await validateQuantArtifactContracts({
    projectPath,
    projectId,
    requestId,
  });
  const failed = report.checks.filter((check) => check.status === 'failed');
  const warnings = report.checks.filter((check) => check.status === 'warning');
  if (failed.length > 0) {
    return {
      status: 'failed',
      summary: `产物契约未通过：${failed.length} 个结构性问题。`,
      details: failed.map((check) => `${check.label}：${check.summary}${check.details ? `\n${check.details}` : ''}`).join('\n\n'),
      metadata: {
        reportPath: report.reportPath,
        failed: failed.map((check) => check.id),
      },
    };
  }
  return {
    status: warnings.length > 0 ? 'warning' : 'passed',
    summary: warnings.length > 0 ? `产物契约通过但有 ${warnings.length} 个警告。` : '关键 JSON 产物契约通过。',
    metadata: {
      reportPath: report.reportPath,
      warningCount: warnings.length,
    },
  };
}

async function writeValidationReport(projectPath: string, report: QuantValidationReport) {
  await ensureQuantWorkspace(projectPath);
  await fs.writeFile(validationReportPath(projectPath), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function actionsForFailedCheck(check: QuantValidationCheck): string[] {
  switch (check.id) {
    case 'next_build':
      return [
        '根据失败详情定位并修复 TypeScript、Next.js 或 CSS 错误。',
        '动态 JSON 字段必须使用 JsonRecord、asRecord、asArray、numeric 等守卫函数处理。',
      ];
    case 'preview_http_200':
      return [
        '根据失败详情修复页面加载时抛出的运行时异常。',
        '保持 app/page.tsx、app/layout.tsx 和 app/globals.css 的导入与渲染链路有效。',
      ];
    case 'visual_presentation':
      return [
        '只查看 .quantpilot/visual-validation.json 指向的失败 viewport、截图与指标。',
        '修复桌面/移动端布局：首屏不能空白，不能横向溢出，文本不能互相遮挡。',
        '把独立白色圆角卡片网格合并为连续金融工作台：主画布共用背景，以细分区线、连续指标带、主图、矩阵和表格建立层级；移除重复圆角、阴影和 card 套 card。',
        '移动端 390x844 首屏必须露出一个可用的核心图表、矩阵或表格；如果摘要区过高，压缩或下移次要指标、信源、模板说明和免责声明。',
      ];
    case 'final_data_file':
      return [
        '生成或修复 data_file/final/dashboard-data.json。',
        '读取 .quantpilot/run_plan.json 和现有 raw/final/evidence 数据，按真实数据重组 final 文件，不要只创建空 JSON。',
        '确保 final 数据包含 symbol/name/source/as_of、quote.price/change_percent/quote_time，以及 kline.bars[] 或 history.bars[]；每根 K 线至少包含 date/open/high/low/close/volume 或 amount。',
        '多标的任务必须覆盖 run_plan.symbols 中的全部代码，并写入 requestedSymbols、assets[] 与 comparison.rows[]；comparison.rows[] 必须包含 symbol/name、价格或收益、回撤/波动/成交额等可排序字段。',
        'final 数据必须包含 visualization.template_id、variant_id、required_components 和 rendered_components，并与 run_plan.visualization.templateId 对齐。',
      ];
    case 'evidence_files':
      return [
        '生成 evidence/sources.json，记录 source、endpoint、fetched_at/as_of、样本量和 artifact_path。',
        '生成 evidence/data_quality.json，记录 status、datasets/checks、缺失字段、警告和限制。',
        '不要把鉴权凭据、会话凭据或密钥值写入 evidence。',
      ];
    case 'artifact_contracts':
      return [
        '只查看 .quantpilot/artifact-contracts.json 中失败的契约项。',
        '只修复 evidence/*.json 或 data_file/final/dashboard-data.json 的结构字段；run_plan、generation-state 和其他 .quantpilot 结构由平台重建。',
      ];
    case 'artifact_policy':
      return [
        '移除外部 CDN、远程脚本、远程样式、远程字体、远程媒体和浏览器直连外部 API。',
        '页面资源必须本地化；浏览器取数只能读取 data_file/final/dashboard-data.json 或同源 /api/market/**。',
        '移除 MOCK_DATA、SAMPLE_DATA、STATIC_QUOTES、示例数据、模拟数据、占位数据和明文密钥。',
      ];
    case 'dashboard_data_binding':
      {
        const tradingPlanFailure = /交易执行计划|交易计划|买入区间|止损|目标价|仓位|操作建议/.test(
          `${check.summary}\n${check.details ?? ''}`
        );
        return [
        '让 app/page.tsx 使用 QuantPilot 标准数据绑定结构读取 data_file/final/dashboard-data.json。',
        '保留 DATA_FILE、readDashboardData()、getBars() 或 data-source-file={DATA_FILE} 等标准入口。',
        ...(tradingPlanFailure
          ? [
              '必须实际编辑 app/page.tsx：删除 getTradingPlanRows、priceRange、TradingPlanPanel、tradingRows 变量和 <TradingPlanPanel ... /> 调用。',
              '必须实际编辑 app/globals.css：删除 .trading-plan-grid、.trade-card、.trade-title、.trade-rationale、.trade-abandon 等交易计划样式，或确保页面不再引用这些 class。',
              '除“不是买卖建议/不构成交易指令”这类免责声明外，页面不得残留短线交易计划、买入区间、止损、目标价或仓位上限。',
            ]
          : []),
        '不要把完整行情、K 线、财务或公告对象内联到页面代码。',
        ];
      }
    case 'chart_presence':
      return [
        '补齐真实金融图表：K 线/OHLC、成交量、均线、财务趋势、收益/回撤/波动或风险指标。',
        '图表必须有语义染色、坐标/图例/tooltip/title 等读图辅助。',
        '用户明确要求“累计收益曲线/收益曲线/净值曲线/折线图”时必须绘制带日期轴、统一尺度和图例的折线图，不能用柱状图、指标卡或 sparkline 替代。',
        '用户明确要求“相关性矩阵/热力图/分散风险图谱”时必须绘制真实矩阵或热力图，并展示标的标签、数值和颜色刻度。',
      ];
    case 'market_proxy':
      return [
        '创建 app/api/market/[...path]/route.ts。',
        '将 /api/market/** 转发到 http://127.0.0.1:8000/api/v1/** 并保留 query 参数。',
        '前端刷新行情时调用 /api/market/**，不要从浏览器直连 8000 或外部接口。',
      ];
    default:
      return [
        '根据失败摘要和细节定位关联文件，只修复该失败项。',
      ];
  }
}

const REPAIR_SCOPE_BY_CHECK_ID: Record<string, readonly string[]> = {
  next_build: ['app/**'],
  preview_http_200: ['app/**'],
  visual_presentation: ['app/**'],
  final_data_file: ['data_file/final/**'],
  evidence_files: ['evidence/**'],
  artifact_contracts: ['data_file/final/**', 'evidence/**'],
  artifact_policy: ['app/**'],
  dashboard_data_binding: ['app/**', 'data_file/final/**'],
  chart_presence: ['app/**'],
  market_proxy: ['app/**'],
};

function repairWritablePaths(failedChecks: QuantValidationCheck[]): string[] {
  const paths = new Set<string>();
  for (const check of failedChecks) {
    for (const writablePath of REPAIR_SCOPE_BY_CHECK_ID[check.id] ?? ['app/**']) {
      paths.add(writablePath);
    }
  }
  const preferredOrder = ['app/**', 'data_file/final/**', 'evidence/**'];
  return [...paths].sort((left, right) => {
    const leftIndex = preferredOrder.indexOf(left);
    const rightIndex = preferredOrder.indexOf(right);
    return (leftIndex < 0 ? preferredOrder.length : leftIndex)
      - (rightIndex < 0 ? preferredOrder.length : rightIndex);
  });
}

/**
 * Converts platform-owned validation failures into the only additional paths
 * a repair run may mutate. The typed-tool policy consumes this result; the
 * prompt is explanatory and is never the authority boundary.
 */
export function quantValidationRepairWritableGlobs(
  report: QuantValidationReport,
): string[] {
  return repairWritablePaths(report.checks.filter((check) => check.status === 'failed'));
}

function formatChineseList(values: string[]): string {
  if (values.length <= 1) {
    return values[0] ?? '无';
  }
  if (values.length === 2) {
    return `${values[0]} 和 ${values[1]}`;
  }
  return `${values.slice(0, -1).join('、')} 和 ${values.at(-1)}`;
}

function targetedReadsForFailedChecks(failedChecks: QuantValidationCheck[]): string[] {
  const paths = new Set<string>([
    '.quantpilot/validation.json（仅失败项）',
    '.quantpilot/validation-repair-plan.json（仅本轮步骤）',
  ]);
  for (const check of failedChecks) {
    switch (check.id) {
      case 'visual_presentation':
        paths.add('.quantpilot/visual-validation.json（仅失败 viewport 和其截图路径）');
        paths.add('app/page.tsx 与 app/globals.css（只读相关区段）');
        break;
      case 'next_build':
      case 'preview_http_200':
        paths.add('失败详情点名的 app/** 文件与相关导入');
        break;
      case 'final_data_file':
        paths.add('.quantpilot/run_plan.json（只读 symbols/visualization）');
        paths.add('data_file/final/dashboard-data.json');
        break;
      case 'evidence_files':
        paths.add('evidence/sources.json 与 evidence/data_quality.json');
        break;
      case 'artifact_contracts':
        paths.add('.quantpilot/artifact-contracts.json（仅失败契约）');
        paths.add('失败契约指向的 final/evidence 文件');
        break;
      case 'dashboard_data_binding':
        paths.add('app/page.tsx 的数据读取与绑定区段');
        paths.add('data_file/final/dashboard-data.json 的顶层结构');
        break;
      case 'chart_presence':
      case 'artifact_policy':
      case 'market_proxy':
        paths.add('失败详情点名的 app/** 文件与相关区段');
        break;
      default:
        paths.add('失败详情明确指向的文件或区段');
    }
  }
  return [...paths];
}

function completionConditionForFailedCheck(check: QuantValidationCheck): string {
  switch (check.id) {
    case 'next_build':
      return '报告点名的类型、导入或样式错误已在关联 app 文件中消除。';
    case 'preview_http_200':
      return '报告点名的页面加载异常已消除，渲染入口不再抛错。';
    case 'visual_presentation':
      return '失败 viewport 的首屏主体可见，且无空白、横向溢出或文本遮挡。';
    case 'final_data_file':
      return 'dashboard-data.json 覆盖计划标的、真实数据字段和 visualization 契约。';
    case 'evidence_files':
      return 'sources 与 data_quality evidence 完整记录来源、时效、质量和限制。';
    case 'artifact_contracts':
      return 'artifact-contracts 报告中的失败 JSON 字段已在 final/evidence 中补齐。';
    case 'artifact_policy':
      return '报告点名的远程资源、浏览器外连、mock 或敏感字面量已移除。';
    case 'dashboard_data_binding':
      return '页面通过标准入口读取 final 数据，且未内联完整行情对象。';
    case 'chart_presence':
      return '用户任务要求的核心金融图表及读图辅助已实际渲染。';
    case 'market_proxy':
      return '同源 /api/market/** 路由按报告要求存在并保留查询参数。';
    default:
      return `${check.name} 的失败摘要已被对应文件修改直接解决。`;
  }
}

export function buildQuantValidationRepairPlan(report: QuantValidationReport): QuantValidationRepairPlan {
  const failedChecks = report.checks.filter((check) => check.status === 'failed');
  return {
    schemaVersion: 1,
    status: 'needed',
    projectId: report.projectId,
    reportPath: report.reportPath,
    repairPlanPath: VALIDATION_REPAIR_PLAN_RELATIVE_PATH,
    steps: failedChecks.map((check) => ({
      checkId: check.id,
      checkName: check.name,
      summary: check.summary,
      actions: actionsForFailedCheck(check),
      ...(check.details ? { details: truncateForPrompt(check.details, 1_000) } : {}),
    })),
    createdAt: new Date().toISOString(),
  };
}

async function writeValidationRepairPlan(projectPath: string, report: QuantValidationReport) {
  const repairPlanPath = validationRepairPlanPath(projectPath);
  if (report.passed) {
    await fs.rm(repairPlanPath, { force: true }).catch(() => undefined);
    return;
  }

  await ensureQuantWorkspace(projectPath);
  const plan = buildQuantValidationRepairPlan(report);
  await fs.writeFile(repairPlanPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
}

function buildValidationSummary(report: QuantValidationReport): string {
  const passedCount = report.checks.filter((check) => check.status === 'passed').length;
  const failedChecks = report.checks.filter((check) => check.status === 'failed');
  const warningChecks = report.checks.filter((check) => check.status === 'warning');
  const headline = report.passed
    ? `自动验证通过：${passedCount}/${report.checks.length} 项检查通过。`
    : `自动验证未通过：${passedCount}/${report.checks.length} 项检查通过，${failedChecks.length} 项失败。`;

  const lines = [
    headline,
    '',
    ...report.checks.map((check) => {
      const mark = check.status === 'passed' ? '通过' : check.status === 'warning' ? '警告' : '失败';
      const duration = check.durationMs ? `（${formatDuration(check.durationMs)}）` : '';
      return `- ${mark}：${check.name}${duration} - ${check.summary}`;
    }),
    '',
    `验证报告：${report.reportPath}`,
  ];

  if (!report.passed) {
    lines.push(`修复计划：${VALIDATION_REPAIR_PLAN_RELATIVE_PATH}`);
  }

  if (warningChecks.length > 0) {
    lines.push(`警告项：${warningChecks.map((check) => check.name).join('、')}`);
  }

  return lines.join('\n');
}

function truncateForPrompt(value: string, limit = 1_500): string {
  const trimmed = value.trim();
  if (trimmed.length <= limit) {
    return trimmed;
  }
  return `${trimmed.slice(0, limit)}\n...内容已截断...`;
}

export async function repairQuantPlatformOwnedArtifacts(params: {
  projectPath: string;
  requestId: string;
  originalInstruction: string;
  report: QuantValidationReport;
}): Promise<{ runPlanRebuilt: boolean }> {
  const platformFailureText = params.report.checks
    .filter((check) => check.status === 'failed')
    .map((check) => `${check.id}\n${check.summary}\n${check.details ?? ''}`)
    .join('\n');
  const runPlanNeedsPlatformRepair =
    /(?:run_plan|运行计划).*(?:缺失|无效|契约|不一致|误写|template)|(?:template|模板).*(?:run_plan|运行计划)/i.test(
      platformFailureText,
    );

  if (!runPlanNeedsPlatformRepair) {
    return { runPlanRebuilt: false };
  }

  await writeInitialRunPlan({
    projectPath: params.projectPath,
    instruction: params.originalInstruction,
    requestId: params.requestId,
    capabilitySource: 'inferred',
  });

  await appendQuantWorkspaceEvent(params.projectPath, {
    event_type: 'platform_artifact_repaired',
    stage: 'validation_repair',
    status: 'success',
    run_id: params.requestId,
    artifact_path: '.quantpilot/run_plan.json',
    summary: '平台已根据原始请求重建只读 run_plan，Agent 无需且不得修改 .quantpilot。',
  });

  return { runPlanRebuilt: true };
}

/**
 * Last-resort recovery for an exhausted Agent repair loop. The platform template
 * may replace the generated page only when every blocking check is presentation
 * related; data, evidence, contract, policy, or proxy failures must be repaired
 * without overwriting the page.
 */
export async function restoreQuantDashboardTemplateAfterRepairExhaustion(params: {
  projectPath: string;
  report: QuantValidationReport;
}): Promise<QuantDashboardTemplateRestoreResult> {
  const failedCheckIds = Array.from(
    new Set(
      params.report.checks
        .filter((check) => check.status === 'failed')
        .map((check) => check.id),
    ),
  );

  if (params.report.passed || params.report.status !== 'failed') {
    return {
      restored: false,
      reason: '验证报告未处于失败状态，无需恢复平台看板模板。',
      failedCheckIds,
    };
  }

  if (failedCheckIds.length === 0) {
    return {
      restored: false,
      reason: '验证报告没有阻断性失败项，未恢复平台看板模板。',
      failedCheckIds,
    };
  }

  const nonPresentationCheckIds = failedCheckIds.filter(
    (checkId) => !DASHBOARD_TEMPLATE_RESTORE_CHECK_IDS.has(checkId),
  );
  if (nonPresentationCheckIds.length > 0) {
    return {
      restored: false,
      reason: `存在非页面类失败项（${nonPresentationCheckIds.join('、')}），为避免覆盖有效页面，未恢复平台看板模板。`,
      failedCheckIds,
    };
  }

  const projectPath = path.resolve(/*turbopackIgnore: true*/ params.projectPath);
  const protectedArtifacts = await Promise.all(
    DASHBOARD_TEMPLATE_PROTECTED_ARTIFACT_PATHS.map(async (relativePath) => ({
      relativePath,
      content: await readTextFile(path.join(projectPath, relativePath)),
    })),
  );
  const missingProtectedArtifacts = protectedArtifacts
    .filter((artifact) => artifact.content === null)
    .map((artifact) => artifact.relativePath);
  if (missingProtectedArtifacts.length > 0) {
    return {
      restored: false,
      reason: `缺少恢复所需的只读数据产物（${missingProtectedArtifacts.join('、')}），未恢复平台看板模板。`,
      failedCheckIds,
    };
  }

  let restoreFailure: string | null = null;
  try {
    await restoreQuantDashboardTemplate(projectPath);
  } catch (error) {
    restoreFailure = error instanceof Error ? error.message : String(error);
  }

  const changedProtectedArtifacts: Array<{ relativePath: string; content: string }> = [];
  for (const artifact of protectedArtifacts) {
    const content = artifact.content as string;
    const currentContent = await readTextFile(path.join(projectPath, artifact.relativePath));
    if (currentContent !== content) {
      changedProtectedArtifacts.push({ relativePath: artifact.relativePath, content });
    }
  }

  if (changedProtectedArtifacts.length > 0) {
    const rollbackFailures: string[] = [];
    for (const artifact of changedProtectedArtifacts) {
      try {
        const absolutePath = path.join(projectPath, artifact.relativePath);
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, artifact.content, 'utf8');
      } catch {
        rollbackFailures.push(artifact.relativePath);
      }
    }
    const changedPaths = changedProtectedArtifacts.map((artifact) => artifact.relativePath).join('、');
    return {
      restored: false,
      reason: rollbackFailures.length > 0
        ? `模板恢复意外改动了受保护产物（${changedPaths}），且回滚失败：${rollbackFailures.join('、')}。`
        : `模板恢复意外改动了受保护产物（${changedPaths}），已回滚数据产物并拒绝标记为恢复成功。`,
      failedCheckIds,
    };
  }

  if (restoreFailure) {
    return {
      restored: false,
      reason: `平台看板模板恢复失败：${restoreFailure}`,
      failedCheckIds,
    };
  }

  return {
    restored: true,
    reason: `仅检测到页面类失败项（${failedCheckIds.join('、')}），已恢复平台看板模板；final 与 evidence 保持不变，需重新运行验证。`,
    failedCheckIds,
  };
}

export function buildQuantValidationRepairInstruction(
  report: QuantValidationReport,
  options: { originalInstruction?: string } = {}
): string {
  const failedChecks = report.checks.filter((check) => check.status === 'failed');
  const repairPlan = buildQuantValidationRepairPlan(report);
  const failedSummary = failedChecks
    .map((check, index) => {
      const details = check.details ? `\n   细节：${truncateForPrompt(check.details)}` : '';
      return `${index + 1}. ${check.name}（${check.id}）：${check.summary}${details}`;
    })
    .join('\n');
  const repairSteps = repairPlan.steps
    .map((step, index) => {
      const actions = step.actions.map((action, actionIndex) => `   ${actionIndex + 1}. ${action}`).join('\n');
      return `${index + 1}. ${step.checkName}（${step.checkId}）\n${actions}`;
    })
    .join('\n');

  const original = options.originalInstruction
    ? `\n原始用户需求：\n${truncateForPrompt(options.originalInstruction, 1_000)}\n`
    : '';
  const failedCheckIds = failedChecks.map((check) => check.id);
  const writablePaths = repairWritablePaths(failedChecks);
  const targetedReads = targetedReadsForFailedChecks(failedChecks);
  const completionConditions = failedChecks
    .map((check) => `- ${check.id}：${completionConditionForFailedCheck(check)}`)
    .join('\n');

  return `QuantPilot failure-scoped repair packet

目标：只修复本轮失败项，保留已有真实数据、有效分析和无关页面内容。${original}

修复范围：
- 失败 ID：${failedCheckIds.join('、') || '报告状态异常但未提供失败 ID'}
- 唯一可写范围：${formatChineseList(writablePaths)}
- 整个 \`.quantpilot/**\` 是平台只读计划、报告与状态；你不得修改它。其结构修复和重新生成由平台负责。
- 定向读取：${targetedReads.join('；')}
- 不要扫描或通读未被失败项指向的目录和文件。

失败项：
${failedSummary || '无失败项，但验证报告状态为失败，请重新检查产物。'}

最小修复动作：
${repairSteps || '请重新检查验证报告并补齐缺失产物。'}

完成条件（平台复验前候选）：
${completionConditions || '- 报告未提供失败 ID；仅提交已能由失败详情证明的修复。'}

执行契约：
1. 使用本轮提供的 typed tools 定向读取和修改；只在需要新建失败产物时使用 write_file，否则优先 edit_file。
2. 必须实际修改失败项关联文件，但不得顺带重写未失败模块；不得写入 mock、占位数据、凭据或密钥。
3. 不要执行 shell、安装依赖、启动开发服务器、构建、预览或循环复验。构建、预览与自动验证由 QuantPilot 平台统一执行。
4. 完成上述失败项对应修改后，调用 submit_result，artifacts 只列出本轮实际修改的工作区相对路径；提交即结束本次物理运行，等待平台独立验证。`;
}

async function publishValidationSummary(
  params: ValidateQuantProjectParams,
  report: QuantValidationReport
) {
  const content = buildValidationSummary(report);

  try {
    const savedMessage = await createMessage({
      projectId: params.projectId,
      role: 'assistant',
      messageType: 'chat',
      content,
      conversationId: params.conversationId ?? null,
      cliSource: params.cliSource ?? 'validator',
      requestId: params.requestId ?? undefined,
      metadata: {
        toolName: 'QuantPilot 自动验证',
        isMissionIntermediate: true,
        validationStatus: report.status,
        reportPath: report.reportPath,
        checks: report.checks.map((check) => ({
          id: check.id,
          name: check.name,
          status: check.status,
          summary: check.summary,
        })),
      },
    });

    streamManager.publish(params.projectId, {
      type: 'message',
      data: serializeMessage(savedMessage, {
        requestId: params.requestId ?? undefined,
        isFinal: true,
      }),
    });
  } catch (error) {
    console.error('[QuantValidation] Failed to persist validation summary:', error);
  }
}

export async function validateQuantProject(params: ValidateQuantProjectParams): Promise<QuantValidationReport> {
  return withProjectValidationLock(params.projectId, () => validateQuantProjectUnlocked(params));
}

/**
 * Apply every trusted, validation-owned workspace mutation before evidence is
 * frozen. Checks may defensively repeat normalization, but those writes must be
 * content-idempotent after this boundary.
 */
export async function prepareQuantProjectForValidation(
  params: PrepareQuantProjectForValidationParams,
): Promise<string> {
  const projectPath = path.resolve(/*turbopackIgnore: true*/ params.projectPath);

  await ensureQuantWorkspace(projectPath);
  await waitForValidationArtifactsToSettle(projectPath);
  await ensurePrefetchedFinalData(projectPath);
  await scaffoldBasicNextApp(projectPath, params.projectId);
  await normalizeGeneratedProjectForValidation(projectPath);
  await waitForValidationArtifactsToSettle(projectPath);

  return projectPath;
}

async function withProjectValidationLock<T>(
  projectId: string,
  task: () => Promise<T>
): Promise<T> {
  const previous = validationQueues.get(projectId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current, () => current);
  validationQueues.set(projectId, queued);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (validationQueues.get(projectId) === queued) {
      validationQueues.delete(projectId);
    }
  }
}

async function validateQuantProjectUnlocked(params: ValidateQuantProjectParams): Promise<QuantValidationReport> {
  const projectPath = await prepareQuantProjectForValidation(params);
  const now = new Date().toISOString();

  await stopPreviewForValidation(params.projectId).catch((error) => {
    console.warn(
      '[QuantValidation] Failed to stop preview before validation build:',
      error
    );
  });
  await appendQuantWorkspaceEvent(projectPath, {
    event_type: 'validation_started',
    stage: 'validation',
    status: 'pending',
    run_id: params.requestId ?? undefined,
    summary: '开始自动验证：build、HTTP 200、最终数据文件、evidence、产物策略、图表和 /api/market 代理。',
    created_at: now,
  });

  streamManager.publish(params.projectId, {
    type: 'status',
    data: {
      status: 'validation_running',
      message: '正在执行自动验证：build、HTTP 200、数据文件、evidence、产物策略、图表和 /api/market 代理。',
      requestId: params.requestId ?? undefined,
    },
  });

  const checks: QuantValidationCheck[] = [];
  try {
    const artifactPolicy = await safeRunCheck(
      'artifact_policy',
      '生成产物策略',
      () => checkArtifactPolicy(projectPath),
    );
    checks.push(artifactPolicy);
    if (artifactPolicy.status !== 'failed') {
      checks.push(await safeRunCheck('next_build', 'Next.js build', () => checkBuild(projectPath)));
      checks.push(await safeRunCheck('preview_http_200', '预览 HTTP 200', () => checkPreviewHttp(params.projectId)));
      checks.push(await safeRunCheck('visual_presentation', '视觉验收', () => checkVisualPresentation(projectPath, params.projectId, params.requestId)));
    } else {
      for (const [id, name] of [
        ['next_build', 'Next.js build'],
        ['preview_http_200', '预览 HTTP 200'],
        ['visual_presentation', '视觉验收'],
      ] as const) {
        checks.push({
          id,
          name,
          status: 'warning',
          summary: '生成产物安全预检失败，已跳过可执行检查。',
          details: '修复 artifact_policy 后才会执行生成代码。',
          durationMs: 0,
        });
      }
    }
    checks.push(await safeRunCheck('final_data_file', '最终数据文件', () => checkFinalDataFile(projectPath)));
    checks.push(await safeRunCheck('evidence_files', '数据证据文件', () => checkEvidenceFiles(projectPath)));
    checks.push(await safeRunCheck('artifact_contracts', '产物 Schema 契约', () => checkArtifactContracts(projectPath, params.projectId, params.requestId)));
    checks.push(await safeRunCheck('dashboard_data_binding', '页面数据绑定', () => checkDashboardBinding(projectPath)));
    checks.push(await safeRunCheck('chart_presence', '金融图表存在性', () => checkChartPresence(projectPath)));
    checks.push(await safeRunCheck('market_proxy', '/api/market 代理', () => checkMarketProxy(projectPath, params.projectId)));
  } finally {
    await stopPreviewForValidation(params.projectId).catch((error) => {
      console.warn(
        '[QuantValidation] Failed to stop temporary preview after validation:',
        error
      );
    });
  }

  const passed = checks.every((check) => check.status !== 'failed');
  const updatedAt = new Date().toISOString();
  const reportRunId = params.requestId ?? await readCurrentQuantRunId(projectPath);
  const report: QuantValidationReport = {
    schemaVersion: 1,
    runId: reportRunId ?? undefined,
    status: passed ? 'passed' : 'failed',
    passed,
    projectId: params.projectId,
    reportPath: VALIDATION_REPORT_RELATIVE_PATH,
    checks,
    createdAt: now,
    updatedAt,
  };

  await writeValidationReport(projectPath, report);
  await writeValidationRepairPlan(projectPath, report);
  await appendQuantWorkspaceEvent(projectPath, {
    event_type: 'validation_completed',
    stage: 'validation',
    status: passed ? 'success' : 'error',
    run_id: params.requestId ?? undefined,
    artifact_path: VALIDATION_REPORT_RELATIVE_PATH,
    summary: passed ? '自动验证通过。' : `自动验证未通过：${checks.filter((check) => check.status === 'failed').length} 项失败。`,
    created_at: updatedAt,
  });

  streamManager.publish(params.projectId, {
    type: 'status',
    data: {
      status: passed ? 'validation_checks_passed' : 'validation_failed',
      message: passed
        ? '自动验证检查已通过，正在等待独立证据验收。'
        : '自动验证未通过，请查看验证摘要。',
      requestId: params.requestId ?? undefined,
      metadata: {
        reportPath: VALIDATION_REPORT_RELATIVE_PATH,
        checks: checks.map((check) => ({
          id: check.id,
          status: check.status,
          summary: check.summary,
        })),
      },
    },
  });

  await publishValidationSummary(params, report);

  return report;
}

export async function readQuantValidationReport(projectPath: string): Promise<QuantValidationReport | null> {
  const resolvedProjectPath = path.resolve(/*turbopackIgnore: true*/ projectPath);
  const reportPath = validationReportPath(resolvedProjectPath);
  const report = await readTextFile(reportPath);
  if (!report) {
    return null;
  }

  try {
    const parsed = JSON.parse(report) as QuantValidationReport;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const [reportStat, artifactStats, currentRunId] = await Promise.all([
      fs.stat(reportPath).catch(() => null),
      Promise.all(
        VALIDATION_STALE_ARTIFACT_PATHS.map(async (relativePath) => {
          const stat = await fs
            .stat(path.join(resolvedProjectPath, relativePath))
            .catch(() => null);
          return stat?.isFile()
            ? { path: relativePath, mtimeMs: stat.mtimeMs }
            : null;
        }),
      ),
      readCurrentQuantRunId(resolvedProjectPath),
    ]);
    if (reportStat) {
      const freshness = assessQuantValidationReportFreshness({
        reportRunId: parsed.runId,
        currentRunId,
        reportMtimeMs: reportStat.mtimeMs,
        artifacts: artifactStats.filter(
          (artifact): artifact is QuantValidationArtifactMtime => artifact !== null,
        ),
      });
      if (freshness.stale) {
        const staleBecauseRunChanged = freshness.reasons.includes('run_id_mismatch');
        const staleBecauseArtifactsChanged = freshness.reasons.includes(
          'artifact_modified_after_report',
        );
        return {
          ...parsed,
          checks: [
            ...(Array.isArray(parsed.checks) ? parsed.checks : []),
            {
              id: 'validation_report_stale',
              name: '验证报告已过期',
              status: 'warning',
              summary:
                staleBecauseRunChanged && staleBecauseArtifactsChanged
                  ? '当前生成轮次和关键产物均已变化，需要重新运行自动验证。'
                  : staleBecauseRunChanged
                    ? '验证报告不属于当前生成轮次，需要重新运行自动验证。'
                    : '生成产物在上次验证后发生变化，需要重新运行自动验证。',
              metadata: {
                reasons: freshness.reasons,
                reportUpdatedAt: reportStat.mtime.toISOString(),
                staleArtifactPaths: freshness.staleArtifactPaths,
                reportRunId: freshness.reportRunId,
                currentRunId: freshness.currentRunId,
                ...(freshness.newestArtifactMtimeMs !== null
                  ? {
                      newestArtifactUpdatedAt: new Date(
                        freshness.newestArtifactMtimeMs,
                      ).toISOString(),
                    }
                  : {}),
              },
            },
          ],
        };
      }
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function readQuantValidationRepairPlan(projectPath: string): Promise<QuantValidationRepairPlan | null> {
  const report = await readTextFile(
    validationRepairPlanPath(path.resolve(/*turbopackIgnore: true*/ projectPath))
  );
  if (!report) {
    return null;
  }

  try {
    const parsed = JSON.parse(report) as QuantValidationRepairPlan;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}
