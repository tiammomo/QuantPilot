/**
 * Claude Agent SDK Service - Claude Agent SDK Integration
 *
 * Interacts with projects using the Claude Agent SDK.
 */

import { query, type PermissionResult, type SDKMessage, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ClaudeSession, ClaudeResponse } from '@/types/backend';
import { streamManager } from '../stream';
import { serializeMessage, createRealtimeMessage } from '@/lib/serializers/chat';
import { updateProject, getProjectById } from '../project';
import { createMessage } from '../message';
import {
  CLAUDE_DEFAULT_MODEL,
  DEEPSEEK_MODEL_ID,
  DEEPSEEK_OFFICIAL_ANTHROPIC_BASE_URL,
  getClaudeModelDefinition,
  getClaudeModelDisplayName,
} from '@/lib/constants/cliModels';
import path from 'path';
import fs from 'fs/promises';
import { randomUUID } from 'crypto';
import {
  buildQuantPilotSystemPrompt,
  buildQuantPilotTaskPrompt,
  ensureClaudeSkillsForProject,
  readQuantPilotManifest,
} from '@/lib/services/claude-skills';
import { buildQuantPilotMcpServers } from '@/lib/services/quant-image-mcp';
import {
  markUserRequestAsRunning,
  isUserRequestCancelled,
} from '@/lib/services/user-requests';
import {
  completeAgentRun,
  failAgentRun,
  isAgentRunCancelled,
  registerAgentRun,
} from '@/lib/services/agent-runtime';
import {
  compactToolOutputPreview,
  TOOL_OUTPUT_PREVIEW_LIMIT,
} from '@/lib/utils/tool-output';

type ToolAction = 'Edited' | 'Created' | 'Read' | 'Deleted' | 'Generated' | 'Searched' | 'Executed';

type ClaudeImageAttachment = {
  name: string;
  path: string;
  url?: string;
  publicUrl?: string;
  mimeType?: string;
  size?: number;
};

const TOOL_NAME_ACTION_MAP: Record<string, ToolAction> = {
  read: 'Read',
  read_file: 'Read',
  'read-file': 'Read',
  write: 'Created',
  write_file: 'Created',
  'write-file': 'Created',
  create_file: 'Created',
  edit: 'Edited',
  edit_file: 'Edited',
  'edit-file': 'Edited',
  update_file: 'Edited',
  apply_patch: 'Edited',
  patch_file: 'Edited',
  remove_file: 'Deleted',
  delete_file: 'Deleted',
  delete: 'Deleted',
  remove: 'Deleted',
  list_files: 'Searched',
  list: 'Searched',
  ls: 'Searched',
  glob: 'Searched',
  glob_files: 'Searched',
  search_files: 'Searched',
  grep: 'Searched',
  bash: 'Executed',
  run: 'Executed',
  run_bash: 'Executed',
  shell: 'Executed',
  todo_write: 'Generated',
  todo: 'Generated',
  plan_write: 'Generated',
};

/**
 * Tool results are already delivered to the Agent SDK in full. The platform only
 * needs a bounded preview for chat history and observability; persisting entire
 * source files in both message content and metadata can otherwise multiply a
 * single Read result into hundreds of kilobytes of database payload.
 */
export function compactToolOutputForPersistence(value: string): string {
  return compactToolOutputPreview(value, TOOL_OUTPUT_PREVIEW_LIMIT);
}

function readPositiveMsEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

type QuantDashboardArtifactSnapshot = {
  complete: boolean;
  signature: string;
  summary: string;
};

async function statFileOrNull(filePath: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) return null;
    return { size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

function hasMeaningfulJsonPayload(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }

  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>).length > 0;
  }

  return false;
}

async function parseJsonFileOrNull(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

async function inspectQuantDashboardArtifacts(projectPath: string): Promise<QuantDashboardArtifactSnapshot> {
  const requiredFiles = [
    '.quantpilot/run_plan.json',
    'data_file/final/dashboard-data.json',
    'evidence/sources.json',
    'evidence/data_quality.json',
    'app/page.tsx',
    'app/globals.css',
  ];

  const stats = await Promise.all(
    requiredFiles.map(async (relativePath) => ({
      relativePath,
      stat: await statFileOrNull(path.join(projectPath, relativePath)),
    }))
  );
  const missing = stats.filter((entry) => !entry.stat).map((entry) => entry.relativePath);

  if (missing.length > 0) {
    return {
      complete: false,
      signature: '',
      summary: `缺少关键产物：${missing.join(', ')}`,
    };
  }

  const [runPlan, dashboardData, sources, dataQuality, pageSource] = await Promise.all([
    parseJsonFileOrNull(path.join(projectPath, '.quantpilot/run_plan.json')),
    parseJsonFileOrNull(path.join(projectPath, 'data_file/final/dashboard-data.json')),
    parseJsonFileOrNull(path.join(projectPath, 'evidence/sources.json')),
    parseJsonFileOrNull(path.join(projectPath, 'evidence/data_quality.json')),
    fs.readFile(path.join(projectPath, 'app/page.tsx'), 'utf8').catch(() => ''),
  ]);

  if (!hasMeaningfulJsonPayload(runPlan)) {
    return { complete: false, signature: '', summary: '.quantpilot/run_plan.json 不是有效执行计划' };
  }

  if (!hasMeaningfulJsonPayload(dashboardData)) {
    return { complete: false, signature: '', summary: 'dashboard-data.json 没有有效数据' };
  }

  if (!hasMeaningfulJsonPayload(sources) || !hasMeaningfulJsonPayload(dataQuality)) {
    return { complete: false, signature: '', summary: '数据来源或质量证据不完整' };
  }

  const hasQuantDashboard =
    pageSource.length > 1500 &&
    !/Create Next App|Get started by editing|next\/image/i.test(pageSource) &&
    /(dashboard-data|data_file\/final|K\s*线|量价|均线|财务|公告|风险|quote_time|fetched_at|svg|canvas|recharts)/i.test(pageSource);

  if (!hasQuantDashboard) {
    return { complete: false, signature: '', summary: 'app/page.tsx 尚未形成有效量化看板' };
  }

  const runPlanRecord = runPlan && typeof runPlan === 'object' && !Array.isArray(runPlan)
    ? (runPlan as Record<string, unknown>)
    : null;
  const dashboardRecord = dashboardData && typeof dashboardData === 'object' && !Array.isArray(dashboardData)
    ? (dashboardData as Record<string, unknown>)
    : null;
  const plannedSymbols = Array.isArray(runPlanRecord?.symbols)
    ? runPlanRecord.symbols.filter((symbol): symbol is string => typeof symbol === 'string' && /^(?:6|0|3|5)\d{5}$/.test(symbol))
    : [];
  const assetRows = Array.isArray(dashboardRecord?.assets) ? dashboardRecord.assets : [];
  const isMultiSymbolTask = plannedSymbols.length > 1 || assetRows.length > 1;
  if (isMultiSymbolTask) {
    const dashboardSymbols = Array.isArray(dashboardRecord?.assets)
      ? dashboardRecord.assets
          .map((asset) => (asset && typeof asset === 'object' && !Array.isArray(asset) ? (asset as Record<string, unknown>).symbol : null))
          .filter((symbol): symbol is string => typeof symbol === 'string')
      : [];
    const pageMentionsAllSymbols =
      plannedSymbols.every((symbol) => pageSource.includes(symbol)) ||
      (/requestedSymbols|assets|comparison/.test(pageSource) && plannedSymbols.every((symbol) => dashboardSymbols.includes(symbol)));
    const hasComparisonSignals = /(requestedSymbols|assets|comparison|对比|相对强弱|横向|矩阵|多标的|收益对比|回撤对比|波动)/i.test(pageSource);
    if (!pageMentionsAllSymbols || !hasComparisonSignals) {
      return {
        complete: false,
        signature: '',
        summary: '多标的任务页面尚未展示全部标的或对比结构',
      };
    }
  }

  return {
    complete: true,
    signature: stats
      .map(({ relativePath, stat }) => `${relativePath}:${stat?.size ?? 0}:${Math.round(stat?.mtimeMs ?? 0)}`)
      .join('|'),
    summary: 'run_plan、final 数据、证据文件和看板页面已完成',
  };
}

async function appendQuantExecutionEvent(projectPath: string, payload: Record<string, unknown>): Promise<void> {
  const eventPath = path.join(projectPath, '.quantpilot/events.jsonl');
  const event = {
    created_at: new Date().toISOString(),
    ...payload,
  };

  try {
    await fs.mkdir(path.dirname(eventPath), { recursive: true });
    await fs.appendFile(eventPath, `${JSON.stringify(event)}\n`, 'utf8');
  } catch (error) {
    console.warn('[ClaudeService] Failed to append QuantPilot execution event:', error);
  }
}

function pickCommandFromToolInput(input: Record<string, unknown>): string | null {
  const keys = ['command', 'cmd', 'shellCommand', 'shell_command'];
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return value;
    }
  }
  return null;
}

function collectAbsolutePathsFromShellCommand(command: string): string[] {
  const paths = new Set<string>();
  const absolutePathPattern = /(?:^|[\s'"=:(])((?:\/(?!\/)[^\s'"`;&|()<>{}]+))/g;
  let match: RegExpExecArray | null;
  while ((match = absolutePathPattern.exec(command)) !== null) {
    const candidate = match[1]?.replace(/[,:\]]+$/, '');
    if (candidate) paths.add(candidate);
  }
  return Array.from(paths);
}

function collectShellPathCandidates(command: string): string[] {
  const candidates = new Set<string>();
  const tokenPattern = /"((?:\\.|[^"\\])*)"|'([^']*)'|([^\s;&|()<>{}]+)/g;
  let match: RegExpExecArray | null;

  while ((match = tokenPattern.exec(command)) !== null) {
    const raw = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!raw) continue;

    // Bash removes a backslash used to quote the following character. Decode
    // that small subset before resolving so `.\.\./secret` cannot hide `../`.
    const decoded = raw.replace(/\\([^\n])/g, '$1').replace(/[,\]]+$/, '');
    if (!decoded || decoded === '-' || decoded.startsWith('http://') || decoded.startsWith('https://')) {
      continue;
    }
    candidates.add(decoded);

    // Validate the value portion of environment assignments and option forms
    // such as `--output=path`, not only the full shell token.
    const equalsIndex = decoded.indexOf('=');
    if (equalsIndex >= 0 && equalsIndex < decoded.length - 1) {
      candidates.add(decoded.slice(equalsIndex + 1));
    }
  }

  return Array.from(candidates);
}

function mutatesPlatformArtifacts(command: string): boolean {
  if (!/(?:^|[\s'"=./])\.quantpilot(?:\/|\b)/i.test(command)) {
    return false;
  }

  const hasKnownMutation =
    /\b(?:rm|mv|cp|install|truncate|chmod|chown|touch|mkdir|rmdir|unlink|rename)\b/i.test(command) ||
    /\b(?:sed\s+-[^\s]*i|perl\s+-[^\s]*i|find\b[^;&|]*(?:-delete|-exec\b|-ok\b))/i.test(command) ||
    /(?:^|[^<])(?:>>?|\|\s*tee\b)/.test(command) ||
    /\b(?:python(?:3)?|node)\b[^;&|]*(?:write|unlink|remove|rename|mkdir|rmdir|open\s*\([^)]*['"]?[wa+])/i.test(command) ||
    /\b(?:git\s+(?:clean|reset|checkout|restore)|dd|rsync|patch|tar\s+[^;&|]*-[^\s]*x|unzip)\b/i.test(command);
  if (hasKnownMutation) return true;

  // When a command touches platform-owned state, allow only an explicit set of
  // read-only shell operations. This closes alternate writers without trying
  // to enumerate every possible interpreter or utility.
  const readOnlyCommands = new Set([
    'cat', 'cd', 'cut', 'false', 'find', 'grep', 'head', 'jq', 'ls', 'pwd',
    'readlink', 'rg', 'sort', 'stat', 'tail', 'test', 'true', 'uniq', 'wc',
  ]);
  const segments = command
    .split(/(?:&&|\|\||[;|])/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  return segments.some((segment) => {
    const commandName = segment.match(/^(?:\([^)]*\)\s*)?(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*([A-Za-z0-9_./-]+)/)?.[1];
    if (!commandName) return true;
    return !readOnlyCommands.has(path.basename(commandName).toLowerCase());
  });
}

function getBlockedBashReason(command: string): string | null {
  const compact = command.replace(/\s+/g, ' ').trim();
  if (mutatesPlatformArtifacts(compact)) {
    return '.quantpilot 是平台状态与验收目录，只能读取，不能由 Agent 命令改写。';
  }
  const blockedPatterns: Array<{ pattern: RegExp; reason: string }> = [
    {
      pattern: /(^|[;&|]\s*|\bxargs\s+)kill\b|\bpkill\b|\bkillall\b|\bfuser\b[^;&|]*\s-k\b/i,
      reason: '不能杀进程或清理 dev server，这会影响 QuantPilot 平台自身。',
    },
    {
      pattern: /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?dev\b|\bnpm\s+exec\s+next\s+dev\b|\bnext\s+dev\b/i,
      reason: '不能自行启动 Next.js dev server，预览由 QuantPilot 统一托管。',
    },
    {
      pattern: /\bscripts\/run-(?:web|dev)\.js\b|\bnode\s+scripts\/run-(?:web|dev)\.js\b/i,
      reason: '不能绕过平台启动脚本，预览端口由 QuantPilot 统一分配。',
    },
    {
      pattern: /\buvicorn\b|\bfastapi\s+dev\b|\bflask\s+run\b|\bpython(?:3)?\s+-m\s+http\.server\b|\bserve\b(?:\s|$)/i,
      reason: '不能在生成项目中启动长驻服务，HTTP 验证由平台自动执行。',
    },
    {
      pattern: /\b(?:cat|tee|echo|printf|python(?:3)?(?:\s+-c)?|node(?:\s+-e)?)\b[\s\S]*(?:>|>>|<<\s*['"]?\w+)|\btouch\s+.*\.(?:tsx?|jsx?|css|json|txt|md)\b/i,
      reason: '不能通过 Bash 重定向、heredoc、脚本或 touch 写入源码/数据文件，请使用 Write/Edit 工具修改文件。',
    },
    {
      pattern: /(?:^|[\s'"=:(;\/\\])\.\.(?=$|[\s'";&|)<>\],\/\\])|(?:^|[\s'"=:(;])~(?:[A-Za-z0-9._-]+)?(?=$|[\s'";&|)<>\],\/])|\/(?:etc|proc|sys|root|var\/run)\//i,
      reason: '不能访问生成项目目录之外的宿主机路径。',
    },
    {
      pattern: /(?:\$\(|`|[<>]\(|\$(?:\{[^}\n]*\}|[A-Za-z_][A-Za-z0-9_]*|[0-9@*#?$!-]))/,
      reason: '不能在 Bash 路径中使用环境变量、命令替换或进程替换；请使用当前工作空间内的静态相对路径。',
    },
    {
      pattern: /(?:^|[;&|]\s*|\s)(?:ln|link)\s|\b(?:symlink|symlinkSync|linkSync)\s*\(/i,
      reason: '不能通过 Bash 创建符号链接或硬链接；这可能绕过当前工作空间边界。',
    },
    {
      pattern: /(^|[;&|]\s*)(?:env|printenv|set)(?:\s|$)|\b(?:cat|sed|awk|grep|rg)\b[^;&|]*(?:\.env|credentials|secret|token)/i,
      reason: '不能枚举运行环境或读取凭据文件。',
    },
    {
      pattern: /\b(?:wget|scp|ssh|nc|ncat|socat)\b|\bgit\s+(?:push|fetch|pull|clone)\b/i,
      reason: '不能建立未授权的外部网络连接或修改远程仓库。',
    },
    {
      pattern: /\bcurl\b(?![^;&|]*(?:127\.0\.0\.1|localhost)(?::8000)?\/api\/v1\/)/i,
      reason: 'curl 只允许访问本机 market-data 的 /api/v1/ 接口。',
    },
  ];

  return blockedPatterns.find(({ pattern }) => pattern.test(compact))?.reason ?? null;
}

export async function guardClaudeToolUse(
  toolName: string,
  input: Record<string, unknown>,
  projectPath: string,
): Promise<PermissionResult> {
  const requestedPaths = collectToolPaths(input);
  for (const candidate of requestedPaths) {
    if (!(await isToolPathWithinProject(projectPath, candidate))) {
      return {
        behavior: 'deny',
        message: 'QuantPilot 已拦截跨工作空间文件访问。所有读写必须限定在当前生成项目目录内。',
      };
    }
  }
  const normalizedToolName = toolName.toLowerCase();
  const isShellTool = normalizedToolName.includes('bash') || normalizedToolName.includes('shell');
  const isMutatingFileTool = /(?:write|edit|patch|delete|remove|move|rename|create)/.test(
    normalizedToolName.replaceAll(' ', '_'),
  );

  if (isMutatingFileTool) {
    const root = path.resolve(projectPath);
    const attemptsPlatformArtifactWrite = requestedPaths.some((candidate) => {
      if (!candidate || /^(?:https?|data):/i.test(candidate)) return false;
      const relative = path.relative(root, path.resolve(projectPath, candidate));
      return relative === '.quantpilot' || relative.startsWith(`.quantpilot${path.sep}`);
    });
    if (attemptsPlatformArtifactWrite) {
      return {
        behavior: 'deny',
        message: 'QuantPilot 已拦截平台产物改写：.quantpilot 下的计划、状态、事件和验证报告由平台维护，Agent 只能读取。',
      };
    }
  }

  if (isShellTool) {
    const command = pickCommandFromToolInput(input);
    if (command) {
      for (const candidate of collectAbsolutePathsFromShellCommand(command)) {
        if (!(await isToolPathWithinProject(projectPath, candidate))) {
          return {
            behavior: 'deny',
            message: 'QuantPilot 已拦截跨工作空间命令访问。Bash 中的绝对路径必须限定在当前生成项目目录内。',
          };
        }
      }
      const blockedReason = getBlockedBashReason(command);
      if (blockedReason) {
        return {
          behavior: 'deny',
          message: `QuantPilot 已拦截该命令：${blockedReason} 请只修改生成项目文件并运行 npm run build；预览、HTTP 200 和端口管理由平台自动完成。`,
        };
      }
      for (const candidate of collectShellPathCandidates(command)) {
        if (!(await isToolPathWithinProject(projectPath, candidate))) {
          return {
            behavior: 'deny',
            message: 'QuantPilot 已拦截跨工作空间命令访问。Bash 参数解析到了当前生成项目目录之外，或经过符号链接指向宿主机路径。',
          };
        }
      }
    }
  }

  return { behavior: 'allow', updatedInput: input };
}

const normalizeAction = (value: unknown): ToolAction | undefined => {
  if (typeof value !== 'string') return undefined;
  const candidate = value.trim().toLowerCase();
  if (!candidate) return undefined;
  if (candidate.includes('edit') || candidate.includes('modify') || candidate.includes('update') || candidate.includes('patch')) {
    return 'Edited';
  }
  if (candidate.includes('write') || candidate.includes('create') || candidate.includes('add') || candidate.includes('append')) {
    return 'Created';
  }
  if (candidate.includes('read') || candidate.includes('open') || candidate.includes('view')) {
    return 'Read';
  }
  if (candidate.includes('delete') || candidate.includes('remove')) {
    return 'Deleted';
  }
  if (
    candidate.includes('search') ||
    candidate.includes('find') ||
    candidate.includes('list') ||
    candidate.includes('glob') ||
    candidate.includes('ls') ||
    candidate.includes('grep')
  ) {
    return 'Searched';
  }
  if (candidate.includes('generate') || candidate.includes('todo') || candidate.includes('plan')) {
    return 'Generated';
  }
  if (
    candidate.includes('execute') ||
    candidate.includes('exec') ||
    candidate.includes('run') ||
    candidate.includes('bash') ||
    candidate.includes('shell') ||
    candidate.includes('command')
  ) {
    return 'Executed';
  }
  return undefined;
};

const inferActionFromToolName = (toolName: unknown): ToolAction | undefined => {
  if (typeof toolName !== 'string') return undefined;
  const normalized = toolName.trim().toLowerCase();
  if (!normalized) return undefined;
  if (TOOL_NAME_ACTION_MAP[normalized]) {
    return TOOL_NAME_ACTION_MAP[normalized];
  }
  const suffix = normalized.split(':').pop() ?? normalized;
  if (suffix && TOOL_NAME_ACTION_MAP[suffix]) {
    return TOOL_NAME_ACTION_MAP[suffix];
  }
  return normalizeAction(normalized);
};

const pickFirstString = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const candidate = pickFirstString(entry);
      if (candidate) return candidate;
    }
    return undefined;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const nestedKeys = ['path', 'filepath', 'filePath', 'file_path', 'target', 'value'];
    for (const key of nestedKeys) {
      if (key in obj) {
        const candidate = pickFirstString(obj[key]);
        if (candidate) return candidate;
      }
    }
  }
  return undefined;
};

const extractPathFromInput = (input: unknown, action?: ToolAction): string | undefined => {
  if (!input || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  const candidateKeys = [
    'filePath',
    'file_path',
    'filepath',
    'path',
    'targetPath',
    'target_path',
    'target',
    'targets',
    'fullPath',
    'full_path',
    'destination',
    'destinationPath',
    'outputPath',
    'output_path',
    'glob',
    'pattern',
    'directory',
    'dir',
    'filename',
    'name',
  ];

  for (const key of candidateKeys) {
    if (key in record) {
      const result = pickFirstString(record[key]);
      if (result) {
        return result;
      }
    }
  }

  if (Array.isArray(record.targets)) {
    for (const target of record.targets as unknown[]) {
      const candidate = pickFirstString(target);
      if (candidate) {
        return candidate;
      }
    }
  }

  if (!action || action === 'Executed') {
    const commandKeys = ['command', 'cmd', 'shellCommand', 'shell_command'];
    for (const key of commandKeys) {
      if (key in record) {
        const candidate = pickFirstString(record[key]);
        if (candidate) {
          return candidate;
        }
      }
    }
  }

  return undefined;
};

const extractPathFromToolText = (value: unknown): string | undefined => {
  const text = stringifyToolResultContent(value);
  if (!text) return undefined;

  const patterns = [
    /File created successfully at:\s*([^\n(]+)/i,
    /The file\s+(.+?)\s+has been updated successfully/i,
    /File (?:updated|written|created) successfully at:\s*([^\n(]+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    const candidate = match?.[1]?.trim();
    if (candidate) {
      return candidate;
    }
  }

  return undefined;
};

const describeCurlCommand = (command: string): string | undefined => {
  const lower = command.toLowerCase();
  if (!lower.includes('curl')) return undefined;
  if (lower.includes('/api/v1/symbols/resolve')) return '解析股票名称或代码，确认后续取数标的。';
  if (lower.includes('/api/v1/quotes/realtime')) return '获取实时行情数据，确认最新价、涨跌幅和成交信息。';
  if (lower.includes('/api/v1/quotes/history')) return '获取历史 K 线和成交量数据，用于趋势、均线和量价分析。';
  if (lower.includes('/api/v1/indicators')) return '计算技术指标，补充均线、收益、回撤、波动率等分析字段。';
  if (lower.includes('/api/v1/fundamentals/financials')) return '获取财务报表数据，补充营收、利润、现金流和成长性。';
  if (lower.includes('/api/v1/fundamentals/indicators')) return '获取基本面指标，补充 ROE、毛利率、净利率和估值质量。';
  if (lower.includes('/api/v1/announcements')) return '获取公告和事件数据，补充行情变化的事件背景。';
  if (lower.includes('/api/market')) return '检查生成页面的同源行情代理是否可用。';
  return '调用本地行情后端获取真实数据。';
};

const describeFileTarget = (target: string, action?: ToolAction): string | undefined => {
  const normalized = target.replaceAll('\\', '/');
  if (!normalized) return undefined;
  if (normalized.endsWith('.quantpilot/run_plan.json')) return '记录本次分析计划、标的、数据需求和验收项。';
  if (normalized.endsWith('.quantpilot/events.jsonl')) return '追加可见执行事件，便于复盘每个阶段。';
  if (normalized.endsWith('evidence/sources.json')) return '记录数据来源、接口、抓取时间和来源说明。';
  if (normalized.endsWith('evidence/data_quality.json')) return '记录数据质量、缺失字段、异常和限制。';
  if (normalized.endsWith('data_file/final/dashboard-data.json')) return '写入最终看板数据，页面将基于它渲染图表。';
  if (normalized.endsWith('app/page.tsx')) return action === 'Read' ? '读取看板页面代码，确认当前渲染结构。' : '生成或更新量化可视化看板页面。';
  if (normalized.endsWith('app/globals.css')) return action === 'Read' ? '读取页面样式，确认图表和布局基础。' : '更新看板样式，保证布局、图表和响应式体验。';
  if (normalized.endsWith('next.config.js')) return '检查 Next.js 配置，确保预览和构建链路可用。';
  if (normalized.endsWith('package.json')) return '检查项目依赖和脚本，确保 build/dev 可执行。';
  return undefined;
};

const describeSkill = (toolName?: string): string | undefined => {
  if (!toolName || !/^quant-[a-z0-9-]+$/i.test(toolName)) return undefined;
  const lower = toolName.toLowerCase();
  if (lower.includes('run-planner')) return '建立分析计划，明确标的、数据需求、看板模块和验证规则。';
  if (lower.includes('symbol-resolver')) return '解析股票名称或代码，确保后续接口使用正确标的。';
  if (lower.includes('market-data')) return '获取实时行情，补充最新价、涨跌幅、成交额和行情时间。';
  if (lower.includes('a-share-history')) return '获取历史 K 线和成交量数据，为趋势与均线分析做准备。';
  if (lower.includes('technical-indicators')) return '计算技术指标，形成均线、回撤、波动率和量价信号。';
  if (lower.includes('fundamental')) return '获取财务和基本面数据，补充经营质量分析。';
  if (lower.includes('announcement')) return '获取公告和事件信息，补充行情背景。';
  if (lower.includes('data-quality')) return '检查数据覆盖率、缺失字段、来源和可用性。';
  if (lower.includes('visualization')) return '基于最终数据生成可视化看板页面。';
  if (lower.includes('comparison')) return '组织多标的对比数据，生成横向研究视角。';
  return '执行量化分析 skill，推进当前阶段。';
};

const buildToolMetadata = (block: Record<string, unknown>): Record<string, unknown> => {
  const metadata: Record<string, unknown> = {};
  const toolName = pickFirstString(block.name) ?? (typeof block.name === 'string' ? block.name : undefined);
  const toolInput = block.input;
  const inputRecord = toolInput && typeof toolInput === 'object' ? (toolInput as Record<string, unknown>) : undefined;

  if (toolName) {
    metadata.toolName = toolName;
    metadata.tool_name = toolName;
  }

  if (toolInput !== undefined) {
    metadata.toolInput = toolInput;
  }

  let action =
    normalizeAction(block.action) ??
    normalizeAction(block.operation) ??
    (inputRecord ? normalizeAction(inputRecord.action) ?? normalizeAction(inputRecord.operation) : undefined) ??
    inferActionFromToolName(toolName);

  const directPath =
    pickFirstString(block.filePath) ??
    pickFirstString(block.file_path) ??
    pickFirstString(block.targetPath) ??
    pickFirstString(block.target_path) ??
    pickFirstString(block.path);

  let filePath = directPath ?? extractPathFromInput(toolInput, action);

  if (!filePath && inputRecord) {
    filePath =
      extractPathFromInput(inputRecord, action) ??
      pickFirstString(inputRecord.filePath) ??
      pickFirstString(inputRecord.file_path);
  }

  if (!filePath && inputRecord) {
    const command =
      pickFirstString(inputRecord.command) ??
      pickFirstString(inputRecord.cmd) ??
      pickFirstString(inputRecord.shellCommand) ??
      pickFirstString(inputRecord.shell_command);
    if (command) {
      metadata.command = command;
      filePath = command;
      if (!action) {
        action = 'Executed';
      }
    }
  }

  if (filePath) {
    metadata.filePath = filePath;
  }

  if (action) {
    metadata.action = action;
  }

  const summary =
    pickFirstString(block.summary) ??
    pickFirstString(block.description) ??
    pickFirstString(block.result) ??
    pickFirstString(block.resultSummary) ??
    pickFirstString(block.result_summary) ??
    (inputRecord ? pickFirstString(inputRecord.summary) ?? pickFirstString(inputRecord.description) : undefined) ??
    pickFirstString(block.diff) ??
    pickFirstString(block.diffInfo) ??
    pickFirstString(block.diff_info);

  if (summary) {
    metadata.summary = summary;
  }

  if (!metadata.summary) {
    const command = pickFirstString(metadata.command) ?? (filePath && filePath.includes('curl') ? filePath : undefined);
    metadata.summary =
      describeSkill(toolName) ??
      (command ? describeCurlCommand(command) : undefined) ??
      (filePath ? describeFileTarget(filePath, action) : undefined);
  }

  return metadata;
};

const stringifyToolResultContent = (value: unknown): string => {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'string') {
    return value.trim();
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => {
        if (typeof entry === 'string') {
          return entry;
        }
        if (entry && typeof entry === 'object') {
          const record = entry as Record<string, unknown>;
          const text = pickFirstString(record.text) ?? pickFirstString(record.content) ?? pickFirstString(record.value);
          if (text) {
            return text;
          }
        }
        try {
          return JSON.stringify(entry);
        } catch {
          return String(entry);
        }
      })
      .filter((entry) => entry.trim().length > 0)
      .join('\n')
      .trim();
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const text = pickFirstString(record.text) ?? pickFirstString(record.content) ?? pickFirstString(record.value);
    if (text) {
      return text;
    }
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  return String(value).trim();
};

const buildToolResultMetadata = (
  block: Record<string, unknown>,
  toolNameById: Map<string, string>
): Record<string, unknown> => {
  const toolUseId =
    pickFirstString(block.tool_use_id) ??
    pickFirstString(block.toolUseId) ??
    pickFirstString(block.toolCallId) ??
    pickFirstString(block.tool_call_id) ??
    pickFirstString(block.id);
  const rawToolName =
    pickFirstString(block.name) ??
    pickFirstString(block.tool_name) ??
    pickFirstString(block.toolName) ??
    (toolUseId ? toolNameById.get(toolUseId) : undefined);
  const skillName =
    block.content && typeof block.content === 'object'
      ? pickFirstString((block.content as Record<string, unknown>).skill)
      : undefined;
  const metadata: Record<string, unknown> = {};

  if (rawToolName || skillName) {
    metadata.toolName = rawToolName ?? skillName;
    metadata.tool_name = rawToolName ?? skillName;
    if (skillName) {
      metadata.skill = skillName;
      metadata.skillName = skillName;
    }
  }

  if (toolUseId) {
    metadata.toolUseId = toolUseId;
    metadata.tool_use_id = toolUseId;
    metadata.toolCallId = toolUseId;
    metadata.tool_call_id = toolUseId;
  }

  if (typeof block.is_error === 'boolean') {
    metadata.isError = block.is_error;
    metadata.is_error = block.is_error;
  }

  const resultText = stringifyToolResultContent(block.content ?? block.result ?? block.output ?? block.text ?? block.value);
  const resultPath = extractPathFromToolText(resultText);
  if (resultPath) {
    metadata.filePath = resultPath;
    metadata.file_path = resultPath;
  }
  if (!metadata.summary && resultText) {
    if (/error|failed|失败|报错/i.test(resultText)) {
      metadata.summary = '工具返回异常，需要根据错误信息调整后续步骤。';
    } else if (resultPath) {
      metadata.summary = describeFileTarget(resultPath, inferActionFromToolName(rawToolName));
    }
  }

  return metadata;
};

const dispatchToolResultBlock = async ({
  projectId,
  block,
  toolNameById,
  requestId,
  dedupeStore,
}: {
  projectId: string;
  block: Record<string, unknown>;
  toolNameById: Map<string, string>;
  requestId?: string;
  dedupeStore: Set<string>;
}): Promise<void> => {
  const metadata = buildToolResultMetadata(block, toolNameById);
  const resultValue = block.content ?? block.result ?? block.output ?? block.text ?? block.value;
  const resultText = stringifyToolResultContent(resultValue);

  if (!resultText) {
    return;
  }

  const persistedResultText = compactToolOutputForPersistence(resultText);
  metadata.toolOutput = persistedResultText;
  if (persistedResultText.length !== resultText.length) {
    metadata.toolOutputTruncated = true;
    metadata.toolOutputOriginalChars = resultText.length;
  }

  await dispatchToolMessage({
    projectId,
    metadata,
    content: persistedResultText,
    requestId,
    persist: true,
    isStreaming: false,
    messageType: 'tool_result',
    dedupeKey: computeToolMessageSignature(metadata, resultText, 'tool_result'),
    dedupeStore,
  });
};

interface ToolPlaceholderDetails {
  raw: string;
  toolName?: string;
  target?: string;
  summary?: string;
  action?: ToolAction;
  isResult: boolean;
}

const parseToolPlaceholderText = (text: string): ToolPlaceholderDetails | null => {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  let toolName: string | undefined;
  let target: string | undefined;
  let summary: string | undefined;
  let isResult = false;

  const bracketMatch = trimmed.match(/^\[Tool:\s*([^\]\n]+)\s*\](.*)$/i);
  if (bracketMatch) {
    toolName = bracketMatch[1]?.trim();
    const trailing = bracketMatch[2]?.trim();
    if (trailing) {
      target = trailing;
    }
  }

  const usingToolMatch = trimmed.match(/^Using tool:\s*([^\n]+?)(?:\s+on\s+(.+))?$/i);
  if (usingToolMatch) {
    toolName = toolName ?? usingToolMatch[1]?.trim();
    const maybeTarget = usingToolMatch[2]?.trim();
    if (maybeTarget) {
      target = maybeTarget;
    }
  }

  const toolResultMatch = trimmed.match(/^Tool result:\s*(.+)$/i);
  if (toolResultMatch) {
    summary = toolResultMatch[1]?.trim() || undefined;
    isResult = true;
  }

  if (!toolName && !target && !summary) {
    return null;
  }

  const action = inferActionFromToolName(toolName) ?? (isResult ? undefined : 'Executed');

  return {
    raw: trimmed,
    toolName,
    target,
    summary,
    action,
    isResult,
  };
};

const buildMetadataFromPlaceholder = (details: ToolPlaceholderDetails): Record<string, unknown> => {
  const metadata: Record<string, unknown> = {};

  if (details.toolName) {
    metadata.toolName = details.toolName;
    metadata.tool_name = details.toolName;
  }

  if (details.target) {
    metadata.filePath = details.target;
    metadata.file_path = details.target;
  }

  if (details.summary) {
    metadata.summary = details.summary;
  }

  const action = details.action ?? inferActionFromToolName(details.toolName);
  if (action) {
    metadata.action = action;
  }

  metadata.placeholderType = details.isResult ? 'result' : 'start';

  return metadata;
};

const mergeMetadata = (
  base: Record<string, unknown> | undefined,
  extension: Record<string, unknown>
): Record<string, unknown> => {
  const result: Record<string, unknown> = { ...(base ?? {}) };
  for (const [key, value] of Object.entries(extension)) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return result;
};

const normalizeSignatureValue = (value?: string | null): string => {
  if (typeof value !== 'string') {
    return '';
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.toLowerCase() : '';
};

const computeToolMessageSignature = (
  metadata: Record<string, unknown>,
  content: string,
  messageType: 'tool_use' | 'tool_result' = 'tool_use'
): string => {
  const meta = metadata ?? {};
  const toolName =
    pickFirstString(meta.toolName) ?? pickFirstString(meta.tool_name);
  const filePath =
    pickFirstString(meta.filePath) ??
    pickFirstString(meta.file_path) ??
    pickFirstString(meta.targetPath) ??
    pickFirstString(meta.target_path);
  const summary =
    pickFirstString(meta.summary) ??
    pickFirstString(meta.resultSummary) ??
    pickFirstString(meta.result_summary) ??
    pickFirstString(meta.description);
  const command = pickFirstString(meta.command);
  const action = pickFirstString(meta.action);

  return [
    normalizeSignatureValue(messageType),
    normalizeSignatureValue(toolName),
    normalizeSignatureValue(filePath),
    normalizeSignatureValue(summary),
    normalizeSignatureValue(command),
    normalizeSignatureValue(action),
    normalizeSignatureValue(content),
  ].join('|');
};

const createToolMessageContent = (details: ToolPlaceholderDetails): string => {
  if (details.isResult && details.summary) {
    return `Tool result: ${details.summary}`;
  }
  if (details.toolName) {
    const targetSegment = details.target ? ` on ${details.target}` : '';
    return `Using tool: ${details.toolName}${targetSegment}`;
  }
  return details.raw;
};

const dispatchToolMessage = async ({
  projectId,
  metadata,
  content,
  requestId,
  persist = true,
  isStreaming = false,
  messageType = 'tool_use',
  dedupeKey,
  dedupeStore,
}: {
  projectId: string;
  metadata: Record<string, unknown>;
  content: string;
  requestId?: string;
  persist?: boolean;
  isStreaming?: boolean;
  messageType?: 'tool_use' | 'tool_result';
  dedupeKey?: string;
  dedupeStore?: Set<string>;
}): Promise<void> => {
  const trimmedContent = content.trim();
  if (!trimmedContent) {
    return;
  }

  const enrichedMetadata = {
    ...(metadata ?? {}),
  };

  if (requestId && !enrichedMetadata.requestId) {
    enrichedMetadata.requestId = requestId;
  }

  if (persist && dedupeStore && dedupeKey) {
    const normalizedKey = dedupeKey.trim();
    if (normalizedKey.length > 0) {
      if (dedupeStore.has(normalizedKey)) {
        return;
      }
      dedupeStore.add(normalizedKey);
    }
  }

  if (!persist) {
    const transientMetadata = {
      ...enrichedMetadata,
      isTransientToolMessage: true,
    };
    streamManager.publish(projectId, {
      type: 'message',
      data: createRealtimeMessage({
        projectId,
        role: 'tool',
        content: trimmedContent,
        messageType,
        metadata: transientMetadata,
        requestId,
        isStreaming,
      }),
    });
    return;
  }

  try {
    const savedMessage = await createMessage({
      projectId,
      role: 'tool',
      messageType,
      content: trimmedContent,
      metadata: enrichedMetadata,
      cliSource: 'claude',
      requestId: requestId ?? null,
    });

    streamManager.publish(projectId, {
      type: 'message',
      data: serializeMessage(savedMessage, {
        requestId,
        isStreaming,
        isFinal: !isStreaming,
      }),
    });
  } catch (error) {
    console.error('[ClaudeService] Failed to persist tool message:', error);
  }
};

const handleToolPlaceholderMessage = async (
  projectId: string,
  placeholderText: string,
  requestId: string | undefined,
  baseMetadata?: Record<string, unknown>,
  options?: { dedupeStore?: Set<string> }
): Promise<boolean> => {
  const details = parseToolPlaceholderText(placeholderText);
  if (!details) {
    return false;
  }

  const metadata = mergeMetadata(baseMetadata, buildMetadataFromPlaceholder(details));
  const content = createToolMessageContent(details);
  const messageType: 'tool_use' | 'tool_result' = details.isResult ? 'tool_result' : 'tool_use';
  const signature = computeToolMessageSignature(metadata, content, messageType);

  await dispatchToolMessage({
    projectId,
    metadata,
    content,
    requestId,
    persist: true,
    isStreaming: false,
    messageType,
    dedupeKey: signature,
    dedupeStore: options?.dedupeStore,
  });

  return true;
};

function resolveRequestedModelId(model?: string | null): string {
  void model;
  return DEEPSEEK_MODEL_ID;
}

type ClaudeRuntimeModelResolution = {
  requestedModel: string;
  runtimeModel: string;
};

function resolveClaudeRuntimeModel(model?: string | null): ClaudeRuntimeModelResolution {
  const requestedModel = resolveRequestedModelId(model);
  return {
    requestedModel,
    runtimeModel: DEEPSEEK_MODEL_ID,
  };
}

export function buildClaudeRuntimeEnv(runtimeModel: string): Record<string, string | undefined> {
  const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
  const inheritedKeys = [
    'PATH',
    'HOME',
    'USER',
    'LOGNAME',
    'SHELL',
    'TMPDIR',
    'TMP',
    'TEMP',
    'LANG',
    'LC_ALL',
    'TERM',
    'COLORTERM',
    'CI',
    'XDG_CONFIG_HOME',
    'XDG_CACHE_HOME',
    'XDG_DATA_HOME',
    'NODE_EXTRA_CA_CERTS',
    'SSL_CERT_FILE',
    'SSL_CERT_DIR',
  ];
  const runtimeEnv: Record<string, string | undefined> = {};
  for (const key of inheritedKeys) {
    if (process.env[key] !== undefined) {
      runtimeEnv[key] = process.env[key];
    }
  }
  if (process.env.QUANTPILOT_AGENT_INHERIT_PROXY === '1') {
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY']) {
      if (process.env[key] !== undefined) runtimeEnv[key] = process.env[key];
    }
  } else {
    runtimeEnv.NO_PROXY = '127.0.0.1,localhost';
  }

  return {
    ...runtimeEnv,
    ANTHROPIC_BASE_URL: DEEPSEEK_OFFICIAL_ANTHROPIC_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ANTHROPIC_API_KEY: apiKey,
    ANTHROPIC_MODEL: runtimeModel,
    ANTHROPIC_SMALL_FAST_MODEL: runtimeModel,
    ANTHROPIC_DEFAULT_SONNET_MODEL: runtimeModel,
    ANTHROPIC_DEFAULT_OPUS_MODEL: runtimeModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: runtimeModel,
    CLAUDE_CODE_SUBAGENT_MODEL: runtimeModel,
    CLAUDE_CODE_EFFORT_LEVEL: 'max',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_AGENT_SDK_CLIENT_APP: 'QuantPilot/1.0',
  };
}

async function realpathOfNearestExistingAncestor(candidate: string): Promise<string> {
  let current = path.resolve(candidate);
  while (true) {
    try {
      return await fs.realpath(current);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) throw new Error(`无法解析项目路径的现有父目录：${candidate}`);
      current = parent;
    }
  }
}

function pathIsWithin(basePath: string, candidate: string): boolean {
  const relative = path.relative(basePath, candidate);
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

export async function validateAgentProjectPath(projectPath: string, projectsDir: string): Promise<string> {
  const absoluteBasePath = path.resolve(projectsDir);
  const absoluteProjectPath = path.resolve(projectPath);
  if (!pathIsWithin(absoluteBasePath, absoluteProjectPath)) {
    throw new Error(`Security violation: Project path must be within ${absoluteBasePath}. Got: ${absoluteProjectPath}`);
  }

  const [canonicalBasePath, canonicalAncestor] = await Promise.all([
    fs.realpath(absoluteBasePath),
    realpathOfNearestExistingAncestor(absoluteProjectPath),
  ]);
  if (!pathIsWithin(canonicalBasePath, canonicalAncestor)) {
    throw new Error(`Security violation: Project path resolves outside ${canonicalBasePath}. Got: ${canonicalAncestor}`);
  }

  try {
    const canonicalProjectPath = await fs.realpath(absoluteProjectPath);
    if (!pathIsWithin(canonicalBasePath, canonicalProjectPath)) {
      throw new Error(`Security violation: Project path resolves outside ${canonicalBasePath}. Got: ${canonicalProjectPath}`);
    }
    return canonicalProjectPath;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Security violation:')) throw error;
    return absoluteProjectPath;
  }
}

async function isToolPathWithinProject(projectPath: string, candidate: string): Promise<boolean> {
  if (!candidate || /^(?:https?|data):/i.test(candidate)) return true;
  const root = await fs.realpath(projectPath).catch(() => path.resolve(projectPath));
  const resolved = path.resolve(projectPath, candidate);
  const lexicalRelative = path.relative(root, resolved);
  if (lexicalRelative.startsWith('..') || path.isAbsolute(lexicalRelative)) return false;

  let ancestor = resolved;
  while (ancestor !== path.dirname(ancestor)) {
    const realAncestor = await fs.realpath(ancestor).catch(() => null);
    if (realAncestor) {
      const realRelative = path.relative(root, realAncestor);
      return !realRelative.startsWith('..') && !path.isAbsolute(realRelative);
    }
    ancestor = path.dirname(ancestor);
  }
  return false;
}

function collectToolPaths(input: Record<string, unknown>): string[] {
  const paths: string[] = [];
  const seen = new Set<object>();
  const pathKeys = new Set(['file', 'filepath', 'path', 'paths', 'dir', 'directory', 'projectpath', 'cwd', 'root']);

  const visit = (value: unknown, key = '', depth = 0) => {
    if (depth > 6) return;
    const normalizedKey = key.toLowerCase().replaceAll('_', '').replaceAll('-', '');
    if (pathKeys.has(normalizedKey)) {
      if (typeof value === 'string') paths.push(value);
      if (Array.isArray(value)) {
        paths.push(...value.filter((item): item is string => typeof item === 'string'));
      }
    }
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, '', depth + 1));
      return;
    }
    Object.entries(value as Record<string, unknown>).forEach(([nestedKey, nestedValue]) =>
      visit(nestedValue, nestedKey, depth + 1),
    );
  };

  visit(input);
  return paths;
}

function inferImageMediaType(image: ClaudeImageAttachment): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | null {
  const source = `${image.mimeType ?? ''} ${image.name ?? ''} ${image.path ?? ''}`.toLowerCase();
  if (source.includes('png') || source.endsWith('.png')) return 'image/png';
  if (source.includes('jpeg') || source.includes('jpg') || source.endsWith('.jpeg') || source.endsWith('.jpg')) return 'image/jpeg';
  if (source.includes('gif') || source.endsWith('.gif')) return 'image/gif';
  if (source.includes('webp') || source.endsWith('.webp')) return 'image/webp';
  return null;
}

async function buildClaudePromptInput(
  promptText: string,
  model: string,
  images?: ClaudeImageAttachment[]
): Promise<string | AsyncIterable<SDKUserMessage>> {
  const validImages = (images ?? []).filter((image) => image.path && image.path.trim().length > 0);
  const modelSupportsImages = getClaudeModelDefinition(model)?.supportsImages === true;
  if (validImages.length === 0 || !modelSupportsImages) {
    return promptText;
  }

  const content: unknown[] = [{ type: 'text', text: promptText }];

  for (const image of validImages) {
    const mediaType = inferImageMediaType(image);
    if (!mediaType) {
      content.push({
        type: 'text',
        text: `图片 ${image.name} 的格式暂不支持直接视觉输入，请改为读取附件路径：${image.path}`,
      });
      continue;
    }

    try {
      const data = await fs.readFile(image.path, 'base64');
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaType,
          data,
        },
      });
    } catch (error) {
      content.push({
        type: 'text',
        text: `图片 ${image.name} 读取失败，请尝试通过附件路径检查：${image.path}。错误：${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  async function* promptStream(): AsyncIterable<SDKUserMessage> {
    yield {
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: content as any,
      },
    };
  }

  return promptStream();
}

/**
 * Execute command using Claude Agent SDK
 *
 * @param projectId - Project ID
 * @param projectPath - Project directory path
 * @param instruction - Command to pass to AI
 * @param model - Claude model to use (default: claude-sonnet-4-6)
 * @param sessionId - Previous session ID (maintains conversation context)
 * @param requestId - (Optional) User request tracking ID
 */
export async function executeClaude(
  projectId: string,
  projectPath: string,
  instruction: string,
  model: string = CLAUDE_DEFAULT_MODEL,
  sessionId?: string,
  requestId?: string,
  images?: ClaudeImageAttachment[]
): Promise<void> {
  console.log(`\n========================================`);
  console.log(`[DeepSeekService] 🚀 Starting DeepSeek V4 Flash agent`);
  console.log(`[ClaudeService] Project: ${projectId}`);
  const modelResolution = resolveClaudeRuntimeModel(model);
  const resolvedModel = modelResolution.runtimeModel;
  const modelLabel = getClaudeModelDisplayName(resolvedModel);
  console.log(`[DeepSeekService] Model: ${modelLabel} [${resolvedModel}]`);
  console.log(`[ClaudeService] Session ID: ${sessionId || 'new session'}`);
  console.log(`[ClaudeService] Instruction: ${instruction.substring(0, 100)}...`);
  console.log(`========================================\n`);

  const configuredMaxTokens = Number(process.env.DEEPSEEK_AGENT_MAX_OUTPUT_TOKENS);
  const maxOutputTokens = Number.isFinite(configuredMaxTokens) && configuredMaxTokens > 0
    ? configuredMaxTokens
    : 12000;
  const configuredMaxTurns = Number(process.env.DEEPSEEK_AGENT_MAX_TURNS);
  const maxTurns = Number.isFinite(configuredMaxTurns) && configuredMaxTurns > 0
    ? configuredMaxTurns
    : 48;
  const idleTimeoutMs = readPositiveMsEnv('DEEPSEEK_AGENT_IDLE_TIMEOUT_MS', 5 * 60 * 1000);
  const totalTimeoutMs = readPositiveMsEnv('DEEPSEEK_AGENT_EXECUTION_TIMEOUT_MS', 20 * 60 * 1000);
  const quantArtifactCheckIntervalMs = readPositiveMsEnv('QUANTPILOT_ARTIFACT_CHECK_INTERVAL_MS', 12 * 1000);
  const quantArtifactStableMs = readPositiveMsEnv('QUANTPILOT_ARTIFACT_STABLE_MS', 45 * 1000);
  const abortController = new AbortController();
  let response: ReturnType<typeof query> | null = null;
  let idleTimer: NodeJS.Timeout | null = null;
  let totalTimer: NodeJS.Timeout | null = null;
  let artifactCompletionTimer: NodeJS.Timeout | null = null;
  let abortReason: string | null = null;
  let gracefulAbortReason: string | null = null;
  let runtimeRegistered = false;
  let executionCompleted = false;

  let emittedAgentCompletedStatus = false;

  const safeMarkRunning = async () => {
    if (!requestId) return;
    try {
      await markUserRequestAsRunning(requestId);
    } catch (error) {
      console.error(`[ClaudeService] Failed to mark request ${requestId} as running:`, error);
    }
  };

  const publishStatus = (status: string, message?: string) => {
    streamManager.publish(projectId, {
      type: 'status',
      data: {
        status,
        ...(message ? { message } : {}),
        ...(requestId ? { requestId } : {}),
      },
    });
  };

  const clearExecutionTimers = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (totalTimer) {
      clearTimeout(totalTimer);
      totalTimer = null;
    }
    if (artifactCompletionTimer) {
      clearInterval(artifactCompletionTimer);
      artifactCompletionTimer = null;
    }
  };

  const abortClaudeExecution = (message: string, status?: 'agent_paused') => {
    if (abortReason) return;
    abortReason = message;
    console.warn(`[ClaudeService] ${message}`);
    if (status) {
      publishStatus(status, message);
    }
    try {
      abortController.abort(new Error(message));
    } catch {
      abortController.abort();
    }
    response?.close();
  };

  registerAgentRun({
    projectId,
    requestId,
    cli: 'claude',
    cancel: (reason) => abortClaudeExecution(reason, 'agent_paused'),
  });
  runtimeRegistered = true;

  const completeClaudeExecutionFromArtifacts = async (message: string) => {
    if (abortReason) return;
    abortReason = message;
    gracefulAbortReason = message;
    emittedAgentCompletedStatus = true;
    console.warn(`[ClaudeService] ${message}`);
    publishStatus('agent_execution_completed', message);
    try {
      abortController.abort(new Error(message));
    } catch {
      abortController.abort();
    }
    response?.close();
  };

  const refreshIdleTimer = () => {
    if (idleTimeoutMs <= 0) return;
    if (idleTimer) {
      clearTimeout(idleTimer);
    }
    idleTimer = setTimeout(() => {
      abortClaudeExecution(`DeepSeek Agent 超过 ${Math.round(idleTimeoutMs / 1000)} 秒没有返回执行事件，已自动终止本次执行。`);
    }, idleTimeoutMs);
    idleTimer.unref?.();
  };

  const startQuantArtifactCompletionWatch = async (absoluteProjectPath: string) => {
    if (artifactCompletionTimer || quantArtifactCheckIntervalMs <= 0 || quantArtifactStableMs <= 0) {
      return;
    }

    const baselineSnapshot = await inspectQuantDashboardArtifacts(absoluteProjectPath);
    const baselineSignature = baselineSnapshot.signature;
    let hasObservedAgentMutation = false;
    let firstCompleteAt: number | null = null;
    let lastSignature = '';

    artifactCompletionTimer = setInterval(() => {
      void (async () => {
        if (abortReason || emittedAgentCompletedStatus) {
          return;
        }

        const snapshot = await inspectQuantDashboardArtifacts(absoluteProjectPath);
        if (!snapshot.complete) {
          firstCompleteAt = null;
          lastSignature = '';
          return;
        }

        if (!hasObservedAgentMutation) {
          if (snapshot.signature === baselineSignature) {
            return;
          }
          hasObservedAgentMutation = true;
          firstCompleteAt = null;
          lastSignature = '';
        }

        const now = Date.now();
        if (snapshot.signature !== lastSignature) {
          firstCompleteAt = now;
          lastSignature = snapshot.signature;
          return;
        }

        if (firstCompleteAt && now - firstCompleteAt >= quantArtifactStableMs) {
          const message = 'QuantPilot 已检测到量化看板关键产物完成并稳定，自动结束 Agent 执行并进入验证。';
          await appendQuantExecutionEvent(absoluteProjectPath, {
            event_type: 'agent_auto_completed',
            stage: 'execution',
            status: 'success',
            run_id: requestId,
            summary: `${snapshot.summary}。${message}`,
          });
          await completeClaudeExecutionFromArtifacts(message);
        }
      })().catch((error) => {
        console.warn('[ClaudeService] Quant artifact completion check failed:', error);
      });
    }, quantArtifactCheckIntervalMs);
    artifactCompletionTimer.unref?.();
  };

  // Send start notification via SSE
  publishStatus('starting', '正在初始化 DeepSeek V4 Flash...');

  await safeMarkRunning();

  // Collect stderr from SDK process for better diagnostics
  const stderrBuffer: string[] = [];
  const placeholderHistory = new Map<string, Set<string>>();
  const persistedToolMessageSignatures = new Set<string>();
  const toolNameById = new Map<string, string>();
  const markPlaceholderHandled = (sessionKey: string, placeholder: string): boolean => {
    const normalized = placeholder.trim();
    if (!normalized) {
      return false;
    }
    let entries = placeholderHistory.get(sessionKey);
    if (!entries) {
      entries = new Set<string>();
      placeholderHistory.set(sessionKey, entries);
    }
    if (entries.has(normalized)) {
      return false;
    }
    entries.add(normalized);
    return true;
  };

  try {
    if (requestId && (await isUserRequestCancelled(requestId))) {
      abortClaudeExecution('用户暂停了当前任务', 'agent_paused');
      throw new Error('用户暂停了当前任务');
    }
    if (!process.env.DEEPSEEK_API_KEY?.trim()) {
      throw new Error('DEEPSEEK_API_KEY 未配置，请在 .env.local 中填写 DeepSeek 官方 API Key。');
    }

    // Verify project exists (prevents foreign key constraint errors)
    console.log(`[ClaudeService] 🔍 Verifying project exists...`);
    const project = await getProjectById(projectId);
    if (!project) {
      const errorMessage = `Project not found: ${projectId}. Cannot create messages for non-existent project.`;
      console.error(`[ClaudeService] ❌ ${errorMessage}`);
      throw new Error(errorMessage);
    }

    console.log(`[ClaudeService] ✅ Project verified: ${project.name}`);

    // Validate and prepare project path
    console.log(`[ClaudeService] 🔒 Validating project path...`);

    // Convert to absolute path
    let absoluteProjectPath = path.isAbsolute(projectPath)
      ? path.resolve(projectPath)
      : path.resolve(process.cwd(), projectPath);

    // Security: Verify project path is within allowed directory
    const allowedBasePath = path.resolve(process.cwd(), process.env.PROJECTS_DIR || './data/projects');
    await fs.mkdir(allowedBasePath, { recursive: true });
    try {
      absoluteProjectPath = await validateAgentProjectPath(absoluteProjectPath, allowedBasePath);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`[ClaudeService] ❌ ${errorMessage}`);
      throw new Error(errorMessage);
    }

    // Check project directory exists and create if needed
    try {
      await fs.access(absoluteProjectPath);
      console.log(`[ClaudeService] ✅ Project directory exists: ${absoluteProjectPath}`);
    } catch {
      console.log(`[ClaudeService] 📁 Creating project directory: ${absoluteProjectPath}`);
      await fs.mkdir(absoluteProjectPath, { recursive: true });
    }
    absoluteProjectPath = await validateAgentProjectPath(absoluteProjectPath, allowedBasePath);

    // Send ready notification via SSE
    publishStatus('ready', 'Project verified. Starting AI...');

    const availableSkills = await ensureClaudeSkillsForProject(absoluteProjectPath);
    const quantManifest = await readQuantPilotManifest(absoluteProjectPath);

    // Claude Agent SDK is used only as the local tool-execution engine.
    console.log(`[DeepSeekService] 🤖 Querying DeepSeek official API...`);
    console.log(`[ClaudeService] 📁 Working Directory: ${absoluteProjectPath}`);
    console.log(`[ClaudeService] 🧩 Skills: ${availableSkills.join(', ') || 'none'}`);
    if (totalTimeoutMs > 0) {
      totalTimer = setTimeout(() => {
        abortClaudeExecution(`DeepSeek Agent 执行超过 ${Math.round(totalTimeoutMs / 1000)} 秒，已自动终止本次执行。`);
      }, totalTimeoutMs);
      totalTimer.unref?.();
    }
    refreshIdleTimer();
    await startQuantArtifactCompletionWatch(absoluteProjectPath);

    const taskPrompt = await buildQuantPilotTaskPrompt(
      instruction,
      absoluteProjectPath,
      quantManifest
    );
    const promptInput = await buildClaudePromptInput(taskPrompt, resolvedModel, images);
    const mcpServers = buildQuantPilotMcpServers(absoluteProjectPath);

    response = query({
      prompt: promptInput,
      options: {
        abortController,
        cwd: absoluteProjectPath,
        additionalDirectories: [absoluteProjectPath],
        model: resolvedModel,
        resume: sessionId, // Resume previous session
        permissionMode: 'default',
        canUseTool: (toolName: string, input: Record<string, unknown>) =>
          guardClaudeToolUse(toolName, input, absoluteProjectPath),
        settingSources: [],
        skills: availableSkills,
        mcpServers: mcpServers as any,
        systemPrompt: buildQuantPilotSystemPrompt(),
        maxOutputTokens,
        maxTurns,
        env: buildClaudeRuntimeEnv(resolvedModel),
        // Capture SDK stderr so we can surface real errors instead of just exit code
        stderr: (data: string) => {
          const line = String(data).trimEnd();
          if (!line) return;
          // Keep only the last ~200 lines to avoid memory bloat
          if (stderrBuffer.length > 200) stderrBuffer.shift();
          stderrBuffer.push(line);
          // Also mirror to server logs for live debugging
          console.error(`[ClaudeSDK][stderr] ${line}`);
        },
      } as any,
    });

    let currentSessionId: string | undefined = sessionId;

    interface AssistantStreamState {
      messageId: string;
      content: string;
      hasSentUpdate: boolean;
      finalized: boolean;
    }

    const assistantStreamStates = new Map<string, AssistantStreamState>();
    const completedStreamSessions = new Set<string>();

    // Handle streaming response
    for await (const message of response) {
      refreshIdleTimer();
      console.log('[ClaudeService] Message type:', message.type);

      if (message.type === 'stream_event') {
        const event: any = (message as any).event ?? {};
        const sessionKey = (message.session_id ?? message.uuid ?? 'default').toString();
        console.log('[ClaudeService] Stream event type:', event.type);

        let streamState = assistantStreamStates.get(sessionKey);

        switch (event.type) {
          case 'message_start': {
            const newState: AssistantStreamState = {
              messageId: randomUUID(),
              content: '',
              hasSentUpdate: false,
              finalized: false,
            };
            assistantStreamStates.set(sessionKey, newState);
            break;
          }
          case 'content_block_start': {
            const contentBlock = event.content_block;
            if (contentBlock && typeof contentBlock === 'object' && contentBlock.type === 'tool_use') {
              const toolUseBlock = contentBlock as Record<string, unknown>;
              const metadata = buildToolMetadata(toolUseBlock);
              const toolUseId = pickFirstString(toolUseBlock.id);
              if (toolUseId) {
                metadata.toolCallId = toolUseId;
                metadata.tool_call_id = toolUseId;
                metadata.toolUseId = toolUseId;
                metadata.tool_use_id = toolUseId;
                const name = pickFirstString(toolUseBlock.name);
                if (name) {
                  toolNameById.set(toolUseId, name);
                }
              }
              await dispatchToolMessage({
                projectId,
                metadata,
                content: `Using tool: ${toolUseBlock.name ?? 'tool'}`,
                requestId,
                persist: false,
                isStreaming: true,
              });
            }
            if (contentBlock && typeof contentBlock === 'object' && contentBlock.type === 'tool_result') {
              await dispatchToolResultBlock({
                projectId,
                block: contentBlock as Record<string, unknown>,
                toolNameById,
                requestId,
                dedupeStore: persistedToolMessageSignatures,
              });
            }
            break;
          }
          case 'tool_result': {
            await dispatchToolResultBlock({
              projectId,
              block: event as Record<string, unknown>,
              toolNameById,
              requestId,
              dedupeStore: persistedToolMessageSignatures,
            });
            break;
          }
          case 'content_block_delta': {
            const delta = event.delta;
            let textChunk = '';

            if (typeof delta === 'string') {
              textChunk = delta;
            } else if (delta && typeof delta === 'object') {
              if (typeof delta.text === 'string') {
                textChunk = delta.text;
              } else if (typeof delta.delta === 'string') {
                textChunk = delta.delta;
              } else if (typeof delta.partial === 'string') {
                textChunk = delta.partial;
              }
            }

            if (typeof textChunk !== 'string' || textChunk.length === 0) {
              break;
            }

            if (!streamState || streamState.finalized) {
              streamState = {
                messageId: randomUUID(),
                content: '',
                hasSentUpdate: false,
                finalized: false,
              };
              assistantStreamStates.set(sessionKey, streamState);
            }

            streamState.content += textChunk;
            const trimmedContent = streamState.content.trim();
            const isPlaceholderLine =
              trimmedContent.length > 0 &&
              ((/^\[Tool:\s*.+\]$/i.test(trimmedContent) && !trimmedContent.includes('\n')) ||
                /^Using tool:/i.test(trimmedContent) ||
                /^Tool result:/i.test(trimmedContent));

            if (trimmedContent.length === 0) {
              streamState.content = '';
              streamState.hasSentUpdate = false;
              break;
            }

            if (isPlaceholderLine) {
              const shouldHandle = markPlaceholderHandled(sessionKey, trimmedContent);
              if (shouldHandle) {
                try {
                  await handleToolPlaceholderMessage(
                    projectId,
                    trimmedContent,
                    requestId,
                    undefined,
                    { dedupeStore: persistedToolMessageSignatures }
                  );
                } catch (error) {
                  console.error('[ClaudeService] Failed to handle streaming tool placeholder:', error);
                }
              }
              streamState.content = '';
              streamState.hasSentUpdate = false;
              break;
            }

            streamState.hasSentUpdate = true;

            streamManager.publish(projectId, {
              type: 'message',
              data: createRealtimeMessage({
                id: streamState.messageId,
                projectId,
                role: 'assistant',
                content: streamState.content,
                messageType: 'chat',
                requestId,
                isStreaming: true,
              }),
            });
            break;
          }
          case 'message_stop': {
            if (streamState && streamState.hasSentUpdate && !streamState.finalized) {
              const trimmedContent = streamState.content.trim();
              const isPlaceholderLine =
                trimmedContent.length > 0 &&
                ((/^\[Tool:\s*.+\]$/i.test(trimmedContent) && !trimmedContent.includes('\n')) ||
                  /^Using tool:/i.test(trimmedContent) ||
                  /^Tool result:/i.test(trimmedContent));

              if (isPlaceholderLine) {
                const shouldHandle = markPlaceholderHandled(sessionKey, trimmedContent);
                if (shouldHandle) {
                  try {
                    await handleToolPlaceholderMessage(
                      projectId,
                      trimmedContent,
                      requestId,
                      undefined,
                      { dedupeStore: persistedToolMessageSignatures }
                    );
                  } catch (error) {
                    console.error('[ClaudeService] Failed to handle tool placeholder on stop:', error);
                  }
                }
              }

              if (
                trimmedContent.length === 0 ||
                isPlaceholderLine
              ) {
                streamState.hasSentUpdate = false;
              }

              if (!streamState.hasSentUpdate) {
                streamState.content = '';
                assistantStreamStates.delete(sessionKey);
                break;
              }

              streamState.finalized = true;

              const savedMessage = await createMessage({
                id: streamState.messageId,
                projectId,
                role: 'assistant',
                messageType: 'chat',
                content: streamState.content,
                cliSource: 'claude',
                requestId: requestId ?? null,
              });

              streamManager.publish(projectId, {
                type: 'message',
                data: serializeMessage(savedMessage, {
                  isStreaming: false,
                  isFinal: true,
                  requestId,
                }),
              });

              completedStreamSessions.add(sessionKey);
            }

            assistantStreamStates.delete(sessionKey);
            break;
          }
          default:
            break;
        }

        continue;
      }

      // Handle by message type
      if (message.type === 'system' && message.subtype === 'init') {
        // Initialize session
        currentSessionId = message.session_id;
        console.log(`[ClaudeService] Session initialized: ${currentSessionId}`);

        // Save session ID to project
        if (currentSessionId) {
          await updateProject(projectId, {
            activeClaudeSessionId: currentSessionId,
          });
        }

        // Send connection notification via SSE
        streamManager.publish(projectId, {
          type: 'connected',
          data: {
            projectId,
            sessionId: currentSessionId,
            timestamp: new Date().toISOString(),
            connectionStage: 'assistant',
          },
        });
      } else if (message.type === 'assistant') {
        const sessionKey = (message.session_id ?? message.uuid ?? 'default').toString();
        if (completedStreamSessions.has(sessionKey)) {
          completedStreamSessions.delete(sessionKey);
          continue;
        }

        // Assistant message
        const assistantMessage = message.message;
        let content = '';

        // Extract content
        if (typeof assistantMessage.content === 'string') {
          content = assistantMessage.content;
        } else if (Array.isArray(assistantMessage.content)) {
          const parts: string[] = [];
          for (const block of assistantMessage.content as unknown[]) {
            if (!block || typeof block !== 'object') {
              continue;
            }

            const safeBlock = block as any;

            if (safeBlock.type === 'text') {
              const text = typeof safeBlock.text === 'string' ? safeBlock.text : '';
              const trimmed = text.trim();
              if (!trimmed) {
                continue;
              }

              const isPlaceholderLine =
                /^\[Tool:\s*/i.test(trimmed) ||
                /^Using tool:/i.test(trimmed) ||
                /^Tool result:/i.test(trimmed);

              if (isPlaceholderLine) {
                const shouldHandle = markPlaceholderHandled(sessionKey, trimmed);
                if (shouldHandle) {
                  try {
                    await handleToolPlaceholderMessage(
                      projectId,
                      trimmed,
                      requestId,
                      undefined,
                      { dedupeStore: persistedToolMessageSignatures }
                    );
                  } catch (error) {
                    console.error('[ClaudeService] Failed to handle assistant tool placeholder:', error);
                  }
                }
                continue;
              }

              parts.push(text);
              continue;
            }

            if (safeBlock.type === 'tool_use') {
              const metadata = buildToolMetadata(safeBlock as Record<string, unknown>);
              const toolUseId = pickFirstString(safeBlock.id);
              if (toolUseId) {
                metadata.toolCallId = toolUseId;
                metadata.tool_call_id = toolUseId;
                metadata.toolUseId = toolUseId;
                metadata.tool_use_id = toolUseId;
                const safeToolName = pickFirstString(safeBlock.name);
                if (safeToolName) {
                  toolNameById.set(toolUseId, safeToolName);
                }
              }
              const name = typeof safeBlock.name === 'string' ? safeBlock.name : pickFirstString(safeBlock.name);
              const toolContent = `Using tool: ${name ?? 'tool'}`;
              await dispatchToolMessage({
                projectId,
                metadata,
                content: toolContent,
                requestId,
                persist: true,
                isStreaming: false,
                messageType: 'tool_use',
                dedupeKey: computeToolMessageSignature(metadata, toolContent, 'tool_use'),
                dedupeStore: persistedToolMessageSignatures,
              });
              continue;
            }

            if (safeBlock.type === 'tool_result') {
              await dispatchToolResultBlock({
                projectId,
                block: safeBlock as Record<string, unknown>,
                toolNameById,
                requestId,
                dedupeStore: persistedToolMessageSignatures,
              });
              continue;
            }
          }

          content = parts.join('\n');
        }

        console.log('[ClaudeService] Assistant message:', content.substring(0, 100));

        // Save message to DB
        if (content) {
          const savedMessage = await createMessage({
            projectId,
            role: 'assistant',
            messageType: 'chat',
            content,
            // sessionId is Session table foreign key, so don't store Claude SDK session ID
            // Claude SDK session ID is stored in project.activeClaudeSessionId
            cliSource: 'claude',
            requestId: requestId ?? null,
          });

          // Send via SSE in real-time
          streamManager.publish(projectId, {
            type: 'message',
            data: serializeMessage(savedMessage, { requestId }),
          });
        }
      } else if (message.type === 'user') {
        const userMessage = (message as any).message;
        const contentBlocks = Array.isArray(userMessage?.content) ? userMessage.content : [];

        for (const block of contentBlocks) {
          if (!block || typeof block !== 'object') {
            continue;
          }
          const safeBlock = block as Record<string, unknown>;
          if (safeBlock.type === 'tool_result') {
            await dispatchToolResultBlock({
              projectId,
              block: safeBlock,
              toolNameById,
              requestId,
              dedupeStore: persistedToolMessageSignatures,
            });
          }
        }
      } else if (message.type === 'result') {
        // The SDK result terminates only the Agent execution stage. Validation,
        // persistent preview startup, and the overall request terminal state are
        // owned by the QuantPilot generation orchestrator.
        console.log('[ClaudeService] Task completed:', message.subtype);
        if (message.subtype !== 'success' || message.is_error) {
          const details = 'errors' in message && Array.isArray(message.errors)
            ? message.errors.filter(Boolean).join('; ')
            : '';
          throw new Error(
            details || `DeepSeek Agent 执行失败：${message.subtype}`
          );
        }
        if (!emittedAgentCompletedStatus) {
          publishStatus('agent_execution_completed');
          emittedAgentCompletedStatus = true;
        }
      }
    }

    console.log('[ClaudeService] Streaming completed');
    if (abortReason) {
      if (gracefulAbortReason) {
        executionCompleted = true;
        return;
      }
      throw new Error(abortReason);
    }
    executionCompleted = true;
    if (!emittedAgentCompletedStatus) {
      publishStatus('agent_execution_completed');
      emittedAgentCompletedStatus = true;
    }
  } catch (error) {
    if (gracefulAbortReason) {
      console.log(`[ClaudeService] Claude execution ended after artifact completion: ${gracefulAbortReason}`);
      executionCompleted = true;
      return;
    }

    const cancelled =
      isAgentRunCancelled(projectId, requestId) ||
      Boolean(requestId && (await isUserRequestCancelled(requestId)));
    if (cancelled) {
      const cancellationMessage = abortReason ?? '用户暂停了当前任务';
      console.log(`[ClaudeService] Agent execution cancelled: ${cancellationMessage}`);
      throw new Error(cancellationMessage);
    }

    console.error(`[ClaudeService] Failed to execute Claude:`, error);

    let errorMessage = abortReason ?? 'Unknown error';

    if (!abortReason && error instanceof Error) {
      errorMessage = error.message;

      // Detect Claude Code CLI not installed
      if (errorMessage.includes('command not found') || errorMessage.includes('not found: claude')) {
        errorMessage = 'DeepSeek Agent 运行引擎不可用，请重新安装项目依赖。';
      }
      // Detect authentication failure
      else if (errorMessage.includes('not authenticated') || errorMessage.includes('authentication')) {
        errorMessage = 'DeepSeek 官方 API 鉴权失败，请检查 .env.local 中的 DEEPSEEK_API_KEY。';
      }
      // Permission error
      else if (errorMessage.includes('permission') || errorMessage.includes('EACCES')) {
        errorMessage = `No file access permission. Please check project directory permissions.`;
      }
      // Token limit exceeded
      else if (errorMessage.includes('max_tokens')) {
        errorMessage = `Generation length is too long. Please shorten the prompt or split the request into smaller parts.`;
      }
      // Generic process exit without details – attempt to surface last stderr lines
      else if (/process exited with code \d+/.test(errorMessage) && stderrBuffer.length > 0) {
        // Heuristics: extract likely actionable hints from stderr
        const tail = stderrBuffer.slice(-15).join('\n');
        // Common auth hints
        if (/auth\s+login|not\s+logged\s+in|sign\s+in/i.test(tail)) {
          errorMessage = `DeepSeek 官方 API 鉴权失败，请检查 DEEPSEEK_API_KEY。\n\nDetailed log:\n${tail}`;
        } else if (/network|ENOTFOUND|ECONN|timeout/i.test(tail)) {
          errorMessage = `DeepSeek 官方 API 网络连接失败，请检查网络后重试。\n\nDetailed log:\n${tail}`;
        } else if (/permission|EACCES|EPERM|denied/i.test(tail)) {
          errorMessage = `Execution interrupted due to file access permission error. Please check project directory permissions.\n\nDetailed log:\n${tail}`;
        } else if (/model|unsupported|invalid\s+model/i.test(tail)) {
          errorMessage = `There is a problem with the model settings. Please try changing the model.\n\nDetailed log:\n${tail}`;
        } else {
          errorMessage = `${errorMessage}\n\nDetailed log:\n${tail}`;
        }
      }
    }

    publishStatus('agent_execution_failed', errorMessage);

    throw new Error(errorMessage);
  } finally {
    clearExecutionTimers();
    if (runtimeRegistered) {
      if (executionCompleted) {
        completeAgentRun(projectId, requestId);
      } else {
        failAgentRun(projectId, requestId);
      }
    }
  }
}

/**
 * Initialize a Next.js project with DeepSeek V4 Flash.
 *
 * @param projectId - Project ID
 * @param projectPath - Project directory path
 * @param initialPrompt - Initial prompt
 * @param model - Locked to DeepSeek V4 Flash.
 * @param requestId - (Optional) User request tracking ID
 */
export async function initializeNextJsProject(
  projectId: string,
  projectPath: string,
  initialPrompt: string,
  model: string = CLAUDE_DEFAULT_MODEL,
  requestId?: string
): Promise<void> {
  console.log(`[ClaudeService] Initializing Next.js project: ${projectId}`);

  // The platform has already scaffolded the app and prefetched quantitative data.
  // Frame initial execution as a focused enhancement so the Agent does not reset
  // the validation-safe workspace or introduce an unconfigured styling stack.
  const fullPrompt = `
Enhance the existing, platform-scaffolded Next.js 16 application for this requirement:
${initialPrompt}

Keep the existing App Router, TypeScript, package setup, local plain CSS, market proxy,
platform-prefetched run plan, final data, evidence, and dashboard data binding.
Do not recreate the project, reset package.json, add a styling framework, or replace
platform-owned quantitative artifacts. Focus on the requested production dashboard.

Preserve a validation-safe information order. At 390x844, the first viewport must
show the instrument and price, at least two real metrics, and the body of the main
chart/matrix/table. Do not stack every summary, source, disclaimer, or signal card
above the main visualization. Keep document-level horizontal overflow at zero;
wide tables may scroll only inside their own bounded wrapper and every grid child
must allow min-width: 0. At 1440x900, keep the primary visualization above the fold.

Inspect large JSON inputs with targeted Grep or bounded Read ranges instead of
dumping whole files. Before finishing, audit the mobile breakpoint, DOM order, and
chart dimensions against these viewport requirements. Let QuantPilot run build,
preview, and validation after your edits.
`.trim();

  await executeClaude(projectId, projectPath, fullPrompt, model, undefined, requestId);
}

/**
 * Apply changes to project
 *
 * @param projectId - Project ID
 * @param projectPath - Project directory path
 * @param instruction - Change request command
 * @param model - Locked to DeepSeek V4 Flash.
 * @param sessionId - Session ID
 * @param requestId - (Optional) User request tracking ID
 */
export async function applyChanges(
  projectId: string,
  projectPath: string,
  instruction: string,
  model: string = CLAUDE_DEFAULT_MODEL,
  sessionId?: string,
  requestId?: string,
  images?: ClaudeImageAttachment[]
): Promise<void> {
  console.log(`[ClaudeService] Applying changes to project: ${projectId}`);
  await executeClaude(projectId, projectPath, instruction, model, sessionId, requestId, images);
}
