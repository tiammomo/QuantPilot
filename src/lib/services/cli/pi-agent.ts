/** QuantPilot integration for the upstream PI Agent runtime. */

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { prisma } from '@/lib/db/client';
import { assertPiAgentSchemaReady } from '@/lib/db/pi-agent-schema-readiness';
import { PiAgentContextManager } from '@/lib/agent/context';
import { createPiAgentPhaseGraph } from '@/lib/agent/core';
import {
  PI_AGENT_BUILD_REVISION,
  PI_AGENT_FRAMEWORK_VERSION,
  PI_AGENT_VERSION,
} from '@/lib/agent/framework-identity';
import { parsePiAgentToolArguments } from '@/lib/agent/core/tool-arguments';
import { DeepSeekProvider, DeepSeekProviderError } from '@/lib/agent/providers/deepseek';
import {
  OpenAICompatibleProvider,
  OpenAICompatibleProviderError,
} from '@/lib/agent/providers/openai-compatible';
import { PiAgentDeterministicToolPlanProvider } from '@/lib/agent/providers/deterministic-tool-plan';
import { PiAgentRunEngine } from '@/lib/agent/pi/run-engine';
import { withPiAgentWorkspaceResourceLock } from '@/lib/agent/runtime/workspace-resource-lock';
import { compilePiAgentSkills } from '@/lib/agent/skills';
import {
  type PiAgentToolProfile,
} from '@/lib/agent/tools';
import type {
  PiAgentEvent,
  PiAgentMessage,
  PiAgentRunResult,
  PiAgentToolCall,
  PiAgentToolResult,
} from '@/lib/agent/types';
import {
  PI_AGENT_DEFAULT_MODEL,
  normalizePiAgentModelId,
} from '@/lib/constants/models';
import { createRealtimeMessage, serializeMessage } from '@/lib/serializers/chat';
import {
  assessPlatformPreparedQuantArtifacts,
  buildQuantPilotSystemPrompt,
  buildQuantPilotTaskPrompt,
  buildQuantPilotUserPrompt,
} from '@/lib/services/pi-agent-prompts';
import {
  completeAgentRun,
  failAgentRun,
  isAgentRunCancelled,
  registerAgentRun,
} from '@/lib/services/agent-runtime';
import {
  createMessage,
  getRecentChatMessagesByProjectId,
} from '@/lib/services/message';
import {
  createPrismaPiAgentDurableRunSession,
  type PiAgentDurableRunSession,
} from '@/lib/services/pi-agent-run-store';
import { createPrismaPiAgentToolApprovalHandler } from '@/lib/services/pi-agent-tool-approval-store';
import {
  hashPiAgentProvenance,
  hashPiAgentWorkspace,
  hashPiAgentWorkspaceIdentity,
} from '@/lib/services/pi-agent-provenance';
import { auditPrismaPiAgentRecovery } from '@/lib/services/pi-agent-recovery';
import {
  classifyPiAgentExecutionError,
  PiAgentExecutionError,
} from '@/lib/services/pi-agent-execution-error';
import { getProjectById } from '@/lib/services/project';
import { streamManager } from '@/lib/services/stream';
import {
  isUserRequestCancelled,
  markUserRequestAsRunning,
} from '@/lib/services/user-requests';
import { DEFAULT_QUANT_CAPABILITY_ID } from '@/lib/domains/finance/capabilities';
import { readQuantRunPlan } from '@/lib/domains/finance/workspace';
import { serializeQuantVisualizationTemplate } from '@/lib/domains/finance/visualization-templates';
import { quantValidationRepairWritableGlobs } from "@/lib/quant/validation/repair";
import { readQuantValidationReport } from "@/lib/quant/validation/reports";
import { validatePiAgentProjectPath } from './pi-agent-workspace';
import type { PiAgentCandidateSubmission } from '@/lib/agent/mission';
import { candidateFromPiAgentRun } from '@/lib/services/pi-agent-candidate';
import { getProjectLlmConfig } from '@/lib/config/llm';
import {
  getProjectIntegrationScope,
  modelPortScopeHeaders,
} from '@/lib/platform/context/integration-scope';
import type { PersonalizationCapsule } from '@/lib/platform/memory';
import type { GovernedKnowledgeCapsule } from '@/lib/platform/knowledge';
import {
  createFinancePiAgentTools,
  createInspectDashboardContractTool,
  FINANCE_PREPARED_SOURCE_WRITE_GLOBS,
  getFinanceSkillCapabilityDescriptor,
  isDashboardSpecCapabilitySupported,
} from '@/lib/domains/finance';

export type PiAgentImageAttachment = {
  name: string;
  path: string;
  url?: string;
  publicUrl?: string;
  mimeType?: string;
  size?: number;
};

const PROJECTS_DIR = process.env.PROJECTS_DIR || './data/projects';
const PROJECTS_DIR_ABSOLUTE = path.isAbsolute(PROJECTS_DIR)
  ? PROJECTS_DIR
  : path.resolve(/* turbopackIgnore: true */ process.cwd(), PROJECTS_DIR);
const HISTORY_FETCH_LIMIT = 30;
const HISTORY_MESSAGE_LIMIT = 8;
const HISTORY_CHARACTER_BUDGET = 8_000;
const HISTORY_MESSAGE_CHARACTER_LIMIT = 2_000;
const VALIDATION_REPAIR_REQUEST_ID = /-validation-repair(?:-\d+)?$/;
const DATA_REPAIR_CHECK_IDS = new Set([
  'final_data_file',
  'evidence_files',
  'artifact_contracts',
  'dashboard_data_binding',
]);
const DASHBOARD_REPAIR_CHECK_IDS = new Set([
  'next_build',
  'preview_http_200',
  'visual_presentation',
  'artifact_policy',
  'dashboard_data_binding',
  'chart_presence',
  'market_proxy',
]);

export type PiAgentPreparedIntent = 'standard' | 'custom';

const PREPARED_CUSTOMIZATION_ACTION =
  '(?:修改|调整|重构|优化|美化|定制|自定义|替换|改为|改成|不要|去掉|取消|新增|增加|添加|删除|移动|移到|重排|折叠|展开|隐藏|避免)';
const PREPARED_CUSTOMIZATION_TARGET =
  '(?:页面|看板|布局|样式|视觉|界面|交互|动效|响应式|配色|颜色|字体|字号|指标卡|卡片|首屏|导航|侧栏|模块|图表|区域|主题|数据源渠道)';
const PREPARED_CUSTOMIZATION_SIGNAL = new RegExp(
  `(?:${PREPARED_CUSTOMIZATION_ACTION}.{0,20}${PREPARED_CUSTOMIZATION_TARGET}|${PREPARED_CUSTOMIZATION_TARGET}.{0,20}${PREPARED_CUSTOMIZATION_ACTION}|customi[sz]e|restyle|redesign|refactor|layout|theme|color|font|sidebar|navigation|responsive|remove|replace|without\\s+cards?)`,
  'iu',
);

/**
 * Conservative, platform-owned routing for an already prepared workspace.
 * Ambiguous presentation changes use the bounded semantic-edit surface; only
 * ordinary generation requests receive the trusted template compiler.
 */
export function classifyPiAgentPreparedIntent(instruction: string): PiAgentPreparedIntent {
  return PREPARED_CUSTOMIZATION_SIGNAL.test(instruction.normalize('NFKC'))
    ? 'custom'
    : 'standard';
}

type AssistantStreamState = {
  id: string;
  content: string;
};

function positiveIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeIntegerEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function optionalPositiveIntegerEnv(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer when configured.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException('The operation was aborted.', 'AbortError');
}

async function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function parseToolArguments(toolCall: PiAgentToolCall): unknown {
  try {
    return parsePiAgentToolArguments(toolCall.arguments).value;
  } catch {
    return { rawArguments: toolCall.arguments };
  }
}

function auditDigest(value: unknown): { chars: number; sha256: string } {
  let serialized: string;
  try {
    serialized = typeof value === 'string' ? value : JSON.stringify(value) ?? '';
  } catch {
    serialized = '[unserializable]';
  }
  return {
    chars: serialized.length,
    sha256: createHash('sha256').update(serialized).digest('hex'),
  };
}

function auditToolInput(toolName: string, value: unknown): Record<string, unknown> {
  const audit: Record<string, unknown> = { ...auditDigest(value) };
  if (!isRecord(value)) return audit;
  const target = toolTarget(value);
  if (target) audit.target = target.slice(0, 2_048);
  const safeScalarKeys = [
    'path', 'imagePath', 'attachmentContextPath', 'endpoint', 'startLine', 'endLine',
    'recursive', 'maxDepth', 'maxEntries', 'fileGlob', 'timeoutMs', 'kind', 'symbol',
    'selector', 'templateId', 'variantId', 'beforeSha256',
  ];
  for (const key of safeScalarKeys) {
    const candidate = value[key];
    if (typeof candidate === 'string') audit[key] = candidate.slice(0, 2_048);
    else if (typeof candidate === 'number' || typeof candidate === 'boolean') audit[key] = candidate;
  }
  if (typeof value.content === 'string') audit.content = auditDigest(value.content);
  if (typeof value.oldText === 'string') audit.oldText = auditDigest(value.oldText);
  if (typeof value.newText === 'string') audit.newText = auditDigest(value.newText);
  if (typeof value.query === 'string') audit.query = auditDigest(value.query);
  if (typeof value.prompt === 'string') audit.prompt = auditDigest(value.prompt);
  if (typeof value.summary === 'string') audit.summary = auditDigest(value.summary);
  if (Array.isArray(value.edits)) audit.editCount = value.edits.length;
  if (Array.isArray(value.artifacts)) {
    audit.artifacts = value.artifacts
      .filter((entry): entry is string => typeof entry === 'string')
      .slice(0, 50)
      .map((entry) => entry.slice(0, 2_048));
  }
  audit.tool = toolName;
  return audit;
}

function toolTarget(input: unknown): string | undefined {
  if (!isRecord(input)) return undefined;
  for (const key of ['path', 'imagePath', 'attachmentContextPath', 'endpoint']) {
    if (typeof input[key] === 'string' && input[key].trim()) {
      return input[key].trim().replace(/[\r\n\0]/g, ' ').slice(0, 2_048);
    }
  }
  return undefined;
}

function toolAction(name: string): string {
  if (/^(?:write_file)$/i.test(name)) return 'Created';
  if (/^(?:edit_file|apply_patch|semantic_edit|apply_dashboard_spec)$/i.test(name)) return 'Edited';
  if (/^(?:read_file|read_file_range|query_json|query_text_file|inspect_dashboard_contract|quant_extract_uploaded_image|extract_image_evidence)$/i.test(name)) return 'Read';
  if (/^(?:list_files|search_files)$/i.test(name)) return 'Searched';
  if (/^(?:quant_api_get)$/i.test(name)) return 'Executed';
  return 'Generated';
}

function toolStartSummary(name: string, target?: string): string {
  if (name === 'query_json') return `正在读取 ${target || '结构化数据'} 的必要字段。`;
  if (name === 'query_text_file') return `正在定位 ${target || '源码文件'} 的相关实现。`;
  if (name === 'inspect_dashboard_contract') return '正在核验看板结构、数据绑定和可编辑入口。';
  if (name === 'apply_dashboard_spec') return '正在按权威任务合同编译标准看板。';
  if (name === 'semantic_edit') return `正在对 ${target || '目标源码'} 执行版本化语义编辑。`;
  if (name === 'quant_api_get') return `正在从 ${target || '量化数据接口'} 获取真实数据。`;
  if (name === 'quant_extract_uploaded_image' || name === 'extract_image_evidence') {
    return '正在提取图片中的可验证金融字段。';
  }
  if (name === 'submit_result') return '正在提交本次候选产物，后续由平台独立验证。';
  if (name === 'write_file' || name === 'edit_file') return `正在更新 ${target || '目标文件'}。`;
  return `正在执行 ${name}。`;
}

function toolResultSummary(
  toolCall: PiAgentToolCall,
  result: PiAgentToolResult,
): string {
  const target = toolTarget(parseToolArguments(toolCall));
  if (!result.ok) {
    if (/^(?:INVALID_TOOL_ARGUMENTS|INVALID_TOOL_INPUT)$/.test(result.error.code)) {
      return `${toolCall.name} 参数需要调整，PI Agent 将依据错误码修正调用。`;
    }
    if (/^(?:PATH_NOT_FOUND|EDIT_MATCH_NOT_FOUND)$/.test(result.error.code)) {
      const details = isRecord(result.error.details) ? result.error.details : null;
      const suggestions = Array.isArray(details?.suggestions)
        ? details.suggestions.filter((value): value is string => typeof value === 'string').slice(0, 3)
        : [];
      return suggestions.length > 0
        ? `${target || toolCall.name} 不存在；可改用 ${suggestions.join('、')}。`
        : `${target || toolCall.name} 不存在，需要按工作区真实路径重新定位。`;
    }
    return `${toolCall.name} 本次未完成（${result.error.code}），后续步骤将按错误类型恢复。`;
  }
  if (toolCall.name === 'query_json') {
    const data = isRecord(result.data) ? result.data : null;
    if (data?.pathResolved === true) {
      const requested = typeof data.requestedPath === 'string' ? data.requestedPath : target;
      const resolved = typeof data.resolvedPath === 'string' ? data.resolvedPath : data.path;
      const verb = data.correctionReason === 'artifact_handle' ? '解析' : '自动纠正';
      return `已${verb} ${requested || '数据产物'} → ${resolved || '标准数据文件'}，并读取所需字段。`;
    }
    return `已读取 ${target || '结构化数据'} 的所需字段。`;
  }
  if (toolCall.name === 'query_text_file') return `已定位 ${target || '源码文件'} 的相关实现。`;
  if (toolCall.name === 'inspect_dashboard_contract') return '已取得看板结构、数据绑定和可编辑入口。';
  if (toolCall.name === 'apply_dashboard_spec') return '已按权威任务合同编译标准看板页面与样式。';
  if (toolCall.name === 'semantic_edit') return `已完成 ${target || '目标源码'} 的版本化语义编辑。`;
  if (toolCall.name === 'edit_file') return `已更新 ${target || '目标文件'}。`;
  if (toolCall.name === 'write_file') return `已写入 ${target || '目标文件'}。`;
  if (toolCall.name === 'submit_result') return '已提交本次变更产物。';
  return `${toolCall.name} 已完成。`;
}

function auditToolResult(result: PiAgentToolResult): Record<string, unknown> {
  const source = result.ok ? result.data : result.error;
  const audit: Record<string, unknown> = {
    success: result.ok,
    ...auditDigest(source),
    ...(result.content === undefined ? {} : { content: auditDigest(result.content) }),
  };
  if (!result.ok) {
    audit.errorCode = result.error.code;
    return audit;
  }
  if (isRecord(result.data)) {
    const safeKeys = [
      'path', 'endpoint', 'bytes', 'created', 'replacements', 'entryCount', 'matchCount',
      'statusCode', 'truncated', 'skippedUnsafeLinks', 'skippedSensitivePaths', 'artifactCount',
      'beforeSha256', 'afterSha256', 'requestedPath', 'resolvedPath', 'correctionReason',
      'pathResolved', 'pathCorrected',
    ];
    for (const key of safeKeys) {
      const value = result.data[key];
      if (typeof value === 'string') audit[key] = value.slice(0, 2_048);
      else if (typeof value === 'number' || typeof value === 'boolean') audit[key] = value;
    }
  }
  return audit;
}

function getTerminalSummary(result: PiAgentRunResult): string | null {
  const terminal = result.terminalResult;
  if (!terminal?.ok) return null;
  if (isRecord(terminal.data) && typeof terminal.data.summary === 'string') {
    return terminal.data.summary.trim() || null;
  }
  return terminal.content?.trim() || null;
}

async function buildBoundedHistory(
  projectId: string,
  requestId?: string,
): Promise<PiAgentMessage[]> {
  const messages = (await getRecentChatMessagesByProjectId(projectId, HISTORY_FETCH_LIMIT))
    .filter((message) => {
      if (requestId && message.requestId === requestId) return false;
      if (message.role === 'user') return true;
      if (message.role !== 'assistant') return false;
      if (message.cliSource === 'validator') return false;
      if (message.requestId && VALIDATION_REPAIR_REQUEST_ID.test(message.requestId)) return false;

      let metadata: Record<string, unknown> | null = null;
      if (message.metadataJson) {
        try {
          const parsed = JSON.parse(message.metadataJson) as unknown;
          metadata = isRecord(parsed) ? parsed : null;
        } catch {
          // Malformed historical metadata is not sufficient evidence to drop
          // a user-visible assistant message.
        }
      }
      // PI Agent streams useful progress narration while it is operating tools,
      // but that narration is not conversation state. Replaying dozens of
      // "let me verify" turns made later runs spend context and model turns
      // re-litigating work that the workspace already records. New PI Agent
      // messages are explicit: only the terminal projection is inheritable.
      if (metadata?.isPiAgentIntermediateTurn === true) return false;
      if (
        message.cliSource === 'pi' &&
        message.requestId &&
        metadata?.isPiAgentFinal !== true) return false;
      return metadata?.isQuantPilotPipelineStep !== true &&
        metadata?.toolName !== 'QuantPilot 自动验证' &&
        !(typeof metadata?.validationStatus === 'string' &&
          metadata?.reportPath === '.data-agent/validation.json');
    });
  const selected: PiAgentMessage[] = [];
  let characters = 0;

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (selected.length >= HISTORY_MESSAGE_LIMIT) break;
    const message = messages[index];
    if (message.role !== 'user' && message.role !== 'assistant') continue;
    const content = message.content.slice(0, HISTORY_MESSAGE_CHARACTER_LIMIT).trim();
    if (!content) continue;
    if (characters + content.length > HISTORY_CHARACTER_BUDGET) break;
    selected.push({ role: message.role, content });
    characters += content.length;
  }
  return selected.reverse();
}

function formatRunFailure(
  result: PiAgentRunResult,
  provider: { label: string; credentialEnv: string },
): string {
  const cause = result.error?.cause;
  if (cause instanceof DeepSeekProviderError || cause instanceof OpenAICompatibleProviderError) {
    if (cause.status === 401 || cause.status === 403) {
      return `${provider.label} 鉴权失败，请检查运行环境中的 ${provider.credentialEnv}。`;
    }
    if (cause.status === 429) {
      return `${provider.label} 当前触发限流，请稍后重试。`;
    }
    return `${provider.label} 请求失败${cause.status ? `（HTTP ${cause.status}）` : ''}。`;
  }
  switch (result.status) {
    case 'max_turns':
      return `PI Agent 已达到最大执行轮数（${result.turns}），任务未正常提交。`;
    case 'max_tokens':
      if (result.error?.code === 'MAX_RUN_INPUT_TOKENS') {
        return 'PI Agent 已达到本次累计输入 Token 成本预算，任务未正常提交。';
      }
      if (result.error?.code === 'MAX_RUN_CACHE_MISS_INPUT_TOKENS') {
        return 'PI Agent 已达到本次非缓存输入 Token 成本预算，任务未正常提交。';
      }
      if (result.error?.code === 'MAX_RUN_PREPARED_INPUT_TOKENS') {
        return 'PI Agent 已达到网络请求前的累计输入 Token 预留上限，任务未正常提交。';
      }
      return 'PI Agent 已达到本次输出 Token 预算，任务未正常提交。';
    case 'timeout':
      return 'PI Agent 执行超时，任务已终止。';
    case 'stopped':
      return result.error?.message === 'The model stopped without successfully calling the terminal tool.'
        ? 'PI Agent 未通过 submit_result 提交完成结果，本次执行按未完成处理。'
        : result.error?.message ?? 'PI Agent 提前停止。';
    default:
      return result.error?.message ?? 'PI Agent 执行失败。';
  }
}

async function persistAssistantMessage(params: {
  projectId: string;
  requestId?: string;
  id?: string;
  content: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const content = params.content.trim();
  if (!content) return;
  const message = await createMessage({
    id: params.id,
    projectId: params.projectId,
    role: 'assistant',
    messageType: 'chat',
    content,
    metadata: params.metadata,
    cliSource: 'pi',
    requestId: params.requestId ?? null,
  });
  try {
    streamManager.publish(params.projectId, {
      type: 'message',
      data: serializeMessage(message, {
        requestId: params.requestId,
        isStreaming: false,
        isFinal: true,
      }),
    });
  } catch (error) {
    console.error('[PI Agent] Failed to publish persisted assistant message:', error);
  }
}

async function persistToolMessage(params: {
  projectId: string;
  requestId?: string;
  messageType: 'tool_use' | 'tool_result';
  content: string;
  metadata: Record<string, unknown>;
}): Promise<void> {
  const message = await createMessage({
    projectId: params.projectId,
    role: 'tool',
    messageType: params.messageType,
    content: params.content,
    metadata: params.metadata,
    cliSource: 'pi',
    requestId: params.requestId ?? null,
  });
  try {
    streamManager.publish(params.projectId, {
      type: 'message',
      data: serializeMessage(message, { requestId: params.requestId }),
    });
  } catch (error) {
    console.error('[PI Agent] Failed to publish persisted tool message:', error);
  }
}

/**
 * Execute one upstream PI Agent run. QuantPilot owns planning/validation and
 * overall request completion; this function owns only the agent execution stage.
 */
export async function executePiAgent(
  projectId: string,
  projectPath: string,
  instruction: string,
  model: string = PI_AGENT_DEFAULT_MODEL,
  requestId?: string,
  images?: PiAgentImageAttachment[],
  personalization?: PersonalizationCapsule | null,
  governedKnowledge?: GovernedKnowledgeCapsule | null,
): Promise<PiAgentCandidateSubmission> {
  return executePiAgentPhase({
    projectId,
    projectPath,
    instruction,
    model,
    requestId,
    images,
    personalization,
    governedKnowledge,
    profile: 'generation',
  });
}

interface ExecutePiAgentPhaseOptions {
  projectId: string;
  projectPath: string;
  instruction: string;
  model: string;
  requestId?: string;
  images?: PiAgentImageAttachment[];
  personalization?: PersonalizationCapsule | null;
  governedKnowledge?: GovernedKnowledgeCapsule | null;
  profile: PiAgentToolProfile;
  /**
   * Repair requests have a derived request ID, but cancellation is owned by
   * the original user request. Registering the run under that parent ID makes
   * a scoped pause abort the active repair immediately.
   */
  parentRequestId?: string;
}

async function executePiAgentPhase(
  options: ExecutePiAgentPhaseOptions,
): Promise<PiAgentCandidateSubmission> {
  const {
    projectId,
    projectPath,
    instruction,
    requestId,
    images,
    personalization,
    governedKnowledge,
    model,
    profile,
    parentRequestId,
  } = options;
  const resolvedModel = normalizePiAgentModelId(model);
  const llmConfig = getProjectLlmConfig(resolvedModel);
  const integrationScope = getProjectIntegrationScope(projectId);
  const apiKey = process.env[llmConfig.credentialEnv]?.trim();
  const providerLabel = llmConfig.provider === 'deepseek'
    ? 'DeepSeek 官方 API'
    : 'ModelPort OpenAI-compatible API';
  const abortController = new AbortController();
  const totalTimeoutMs = positiveIntegerEnv('PI_AGENT_TIMEOUT_MS', 20 * 60 * 1_000);
  const deadlineAt = Date.now() + totalTimeoutMs;
  let deadlineTimedOut = false;
  const deadlineTimer = setTimeout(() => {
    deadlineTimedOut = true;
    abortController.abort(new DOMException('PI Agent total execution deadline exceeded.', 'TimeoutError'));
  }, totalTimeoutMs);
  deadlineTimer.unref?.();
  const cancellationScopeRequestId = parentRequestId ?? requestId;
  const cancellationRequestIds = Array.from(
    new Set([requestId, parentRequestId].filter((value): value is string => Boolean(value))),
  );
  const assistantStreams = new Map<number, AssistantStreamState>();
  const physicalRunInstanceId = randomUUID();
  const runInstanceId = `pi_${physicalRunInstanceId}`;
  let durableSession: PiAgentDurableRunSession | null = null;
  let durableStoreFailure: Error | null = null;
  let runtimeRegistered = false;
  let executionCompleted = false;
  let cancellationReason: string | null = null;
  let pausedPublished = false;
  let assistantMessageCount = 0;
  let lastAssistantContent = '';
  let successfulWorkspaceWriteCount = 0;

  const publishStatus = (status: string, message?: string, metadata?: Record<string, unknown>) => {
    try {
      streamManager.publish(projectId, {
        type: 'status',
        data: {
          status,
          ...(message ? { message } : {}),
          ...(requestId ? { requestId } : {}),
          ...(metadata ? { metadata } : {}),
        },
      });
    } catch (error) {
      console.error(`[PI Agent] Failed to publish ${status} status:`, error);
    }
  };
  const publishPaused = (reason: string) => {
    if (pausedPublished) return;
    pausedPublished = true;
    publishStatus('agent_paused', reason);
  };
  const cancellationRequested = async (): Promise<boolean> => {
    for (const candidateRequestId of cancellationRequestIds) {
      if (await isUserRequestCancelled(projectId, candidateRequestId)) return true;
    }
    return false;
  };
  const stopForCancellation = (reason = '用户暂停了当前任务'): never => {
    cancellationReason = reason;
    publishPaused(reason);
    if (!abortController.signal.aborted) {
      abortController.abort(new DOMException(reason, 'AbortError'));
    }
    throw new Error(reason);
  };
  const interruptDurableRun = async (code: string): Promise<void> => {
    const session = durableSession;
    if (!session || !['pending', 'running', 'reconciling', 'waiting'].includes(session.run.status)) {
      return;
    }
    await session.interrupt({ code }).catch((interruptError) => {
      console.error('[PI Agent] Failed to mark durable run interrupted:', interruptError);
    });
  };

  try {
    if (await cancellationRequested()) stopForCancellation();
    // Never mutate schema from a request path. A deployment with a partial or
    // stale durable-runtime catalog must fail before leases or provider calls.
    await raceWithAbort(assertPiAgentSchemaReady(prisma), abortController.signal);
    const project = await getProjectById(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    const workspace = await validatePiAgentProjectPath(projectPath, PROJECTS_DIR_ABSOLUTE);
    if (!project.repoPath) {
      throw new Error(`Project workspace is not configured: ${projectId}`);
    }
    const persistedWorkspace = await fs.realpath(path.resolve(project.repoPath)).catch(() => null);
    const matchesPersistedWorkspace = persistedWorkspace
      ? persistedWorkspace === workspace
      : path.resolve(project.repoPath) === path.resolve(projectPath);
    if (!matchesPersistedWorkspace) {
      throw new Error('Security violation: project path does not match the persisted project workspace.');
    }

    registerAgentRun({
      projectId,
      requestId: cancellationScopeRequestId,
      cli: 'pi',
      cancel: (reason) => {
        cancellationReason = reason;
        publishPaused(reason);
        abortController.abort(new DOMException(reason, 'AbortError'));
      },
    });
    runtimeRegistered = true;
    if (requestId) {
      const claimed = await markUserRequestAsRunning(projectId, requestId);
      if (!claimed) {
        if (await cancellationRequested()) stopForCancellation();
        throw new Error(`PI Agent 请求已不处于可运行状态：${requestId}`);
      }
    }
    // Close the pause-before-registration race: once registered, re-check both
    // the child repair request and its parent before contacting the provider.
    if (cancellationReason || abortController.signal.aborted || await cancellationRequested()) {
      stopForCancellation(cancellationReason ?? '用户暂停了当前任务');
    }
    publishStatus('starting', '正在初始化 PI Agent 并核验可信工作区状态...');

    const runPlan = await readQuantRunPlan(workspace);
    const capabilityId = runPlan?.requestedCapabilityId ?? runPlan?.capabilityId ?? null;
    const [preparedAssessment, repairReport] = await Promise.all([
      assessPlatformPreparedQuantArtifacts(workspace, runPlan),
      profile === 'repair' ? readQuantValidationReport(workspace) : Promise.resolve(null),
    ]);
    const platformPrepared = preparedAssessment.ready;
    const skillPhase = profile === 'repair'
      ? 'validation-repair' as const
      : platformPrepared && !images?.length
        ? 'workspace-generation' as const
        : 'data-preparation' as const;
    const visualization = serializeQuantVisualizationTemplate(
      capabilityId ?? DEFAULT_QUANT_CAPABILITY_ID,
      {
        instruction: runPlan?.question ?? instruction,
        symbolCount: runPlan?.symbols?.length,
        requestedVariantId: runPlan?.visualization?.variantId,
        dataSignals: runPlan?.visualization?.dataSignals,
      },
    );
    const templateId = runPlan?.visualization?.templateId ?? visualization.templateId;
    const variantId = runPlan?.visualization?.variantId ?? visualization.variantId;
    const standardCompilerEligible =
      classifyPiAgentPreparedIntent(instruction) === 'standard' &&
      isDashboardSpecCapabilitySupported(templateId, variantId) &&
      preparedAssessment.dashboardSpecReady;
    const preparedIntent = profile === 'generation' && platformPrepared && !images?.length
      ? standardCompilerEligible ? 'standard' as const : 'custom' as const
      : null;
    const phaseGraph = createPiAgentPhaseGraph({
      profile,
      platformPrepared,
      preparedIntent,
      hasAttachments: Boolean(images?.length),
      dashboardSpecReady: preparedAssessment.dashboardSpecReady,
    });
    if (phaseGraph.providerMode === 'model' && !llmConfig.agent.enabled) {
      throw new Error('项目 LLM Agent 已由 QUANTPILOT_LLM_AGENT_ENABLED 禁用。');
    }
    if (phaseGraph.providerMode === 'model' && !apiKey) {
      throw new Error(
        `${llmConfig.credentialEnv} 未配置，请在运行环境中注入 ${providerLabel} 凭据。`,
      );
    }
    publishStatus(
      'agent_phase_selected',
      phaseGraph.providerMode === 'deterministic'
        ? '已进入可信标准看板编译路径，本轮不调用模型。'
        : `已进入 ${phaseGraph.phase} 执行阶段。`,
      {
        lane: phaseGraph.lane,
        phase: phaseGraph.phase,
        providerMode: phaseGraph.providerMode,
        maxTurns: phaseGraph.budgets.maxTurns,
        maxToolCalls: phaseGraph.budgets.maxToolCalls,
      },
    );
    if (
      profile === 'repair' &&
      (!repairReport ||
        repairReport.status !== 'failed' ||
        !repairReport.checks.some((check) => check.status === 'failed') ||
        repairReport.checks.some((check) => check.id === 'validation_report_stale'))
    ) {
      throw new Error('PI Agent repair 缺少当前平台失败报告或明确失败项，拒绝扩大写权限。');
    }
    const failedRepairIds = new Set(
      repairReport?.checks
        .filter((check) => check.status === 'failed')
        .map((check) => check.id) ?? [],
    );
    const needsDataRepairSkill = Array.from(failedRepairIds)
      .some((checkId) => DATA_REPAIR_CHECK_IDS.has(checkId));
    const hasKnownDashboardRepair = Array.from(failedRepairIds)
      .some((checkId) => DASHBOARD_REPAIR_CHECK_IDS.has(checkId));
    const hasUnknownRepair = Array.from(failedRepairIds)
      .some((checkId) =>
        !DATA_REPAIR_CHECK_IDS.has(checkId) && !DASHBOARD_REPAIR_CHECK_IDS.has(checkId));
    const needsDashboardRepairSkill = hasKnownDashboardRepair || hasUnknownRepair;
    const selectedSkillIds = profile === 'repair'
      ? [
          ...(needsDataRepairSkill ? ['data-quality'] : []),
          ...(needsDashboardRepairSkill ? ['dashboard-visualization'] : []),
        ]
      : platformPrepared
        ? [
            ...(images?.length ? ['data-quality', 'image-extraction'] : []),
            'dashboard-visualization',
          ]
        : undefined;
    const dashboardContractRequired = profile !== 'repair' || needsDashboardRepairSkill;
    const repairWriteGlobs = repairReport
      ? quantValidationRepairWritableGlobs(repairReport)
      : undefined;
    if (profile === 'repair' && (!repairWriteGlobs || repairWriteGlobs.length === 0)) {
      throw new Error('PI Agent repair 无法把当前失败安全归因到明确文件，拒绝启动宽权限自动修复。');
    }
    const repairNeedsSourceWrites = repairWriteGlobs?.some((glob) => glob.startsWith('app/')) ?? false;
    const repairUsesCertifiedSourceScope = repairWriteGlobs?.every((glob) =>
      FINANCE_PREPARED_SOURCE_WRITE_GLOBS.includes(
        glob as (typeof FINANCE_PREPARED_SOURCE_WRITE_GLOBS)[number],
      ),
    ) ?? false;
    const repairProfileWriteGlobs = repairWriteGlobs;
    const runtimeProfileWriteGlobs = profile === 'repair'
      ? repairProfileWriteGlobs
      : preparedIntent
        ? [...FINANCE_PREPARED_SOURCE_WRITE_GLOBS]
        : undefined;
    const canWriteDashboardSource = profile !== 'repair' || repairNeedsSourceWrites;
    // Validation repair has already received a deterministic platform repair
    // attempt. Do not expose the full renderer again to the model: if its
    // preconditions changed, the call can only fail deterministically and burn
    // another turn. Remaining source failures use one hash-guarded edit lane.
    const includeDashboardSpec = profile !== 'repair' &&
      canWriteDashboardSource && preparedIntent === 'standard';
    const repairNeedsFileWrites = profile === 'repair' && Boolean(
      needsDataRepairSkill || repairWriteGlobs?.some((glob) => !glob.startsWith('app/')),
    );
    const allowedRepairMutationToolNames = profile === 'repair'
      ? [
          ...(repairNeedsFileWrites ? ['write_file', 'edit_file'] : []),
          ...(repairNeedsSourceWrites ? ['semantic_edit'] : []),
        ]
      : undefined;
    const repairPreparedSurface = profile === 'repair' &&
      repairNeedsSourceWrites &&
      repairUsesCertifiedSourceScope &&
      !repairNeedsFileWrites
        ? 'custom' as const
        : null;
    const supplementalWriteGlobs = profile === 'repair'
      ? []
      : !platformPrepared || images?.length
        ? [
            'evidence/image_extraction.json',
            'evidence/data_quality.json',
            'evidence/sources.json',
            'data_file/final/dashboard-data.json',
          ]
        : [];
    const maxToolOutputChars = positiveIntegerEnv('PI_AGENT_TOOL_OUTPUT_CHARS', 6_000);
    const tools = createFinancePiAgentTools({
      workspaceRoot: workspace,
      profile,
      ...(runtimeProfileWriteGlobs
        ? {
            profileAllowedWriteGlobs: runtimeProfileWriteGlobs,
            includeDefaultWriteGlobs: false,
          }
        : {}),
      maxOutputChars: maxToolOutputChars,
      includeImageExtraction: Boolean(images?.length),
      includeQuantApi: !(platformPrepared || repairPreparedSurface),
      targetedReadsOnly: platformPrepared || Boolean(repairPreparedSurface),
      ...(preparedIntent || repairPreparedSurface
        ? { preparedSurface: preparedIntent ?? repairPreparedSurface! }
        : {}),
      includeDashboardSpec,
      includeDashboardInspector:
        !(platformPrepared || repairPreparedSurface) && dashboardContractRequired,
      includeSemanticEdit: canWriteDashboardSource,
      ...(allowedRepairMutationToolNames
        ? { allowedMutationToolNames: allowedRepairMutationToolNames }
        : {}),
      resourceLockWaitTimeoutMs: positiveIntegerEnv(
        'PI_AGENT_RESOURCE_LOCK_WAIT_MS',
        5_000
      ),
      ...(supplementalWriteGlobs.length > 0
        ? { allowedWriteGlobs: supplementalWriteGlobs }
        : {}),
    });
    const availableToolNames = tools.map((tool) => tool.name);
    const [skillBundle, taskPrompt, history] = await raceWithAbort(Promise.all([
      compilePiAgentSkills({
        // Runtime work is always a generated financial workspace. Falling
        // back to the default quant capability avoids the compiler's broad
        // "all stable skills" mode, which includes platform-only UI guidance.
        capabilityId: capabilityId ?? DEFAULT_QUANT_CAPABILITY_ID,
        capability: getFinanceSkillCapabilityDescriptor(
          capabilityId ?? DEFAULT_QUANT_CAPABILITY_ID,
        ),
        ...(selectedSkillIds ? { requiredSkillIds: selectedSkillIds } : {}),
        phase: skillPhase,
        activatedSkillIds: images?.length
          ? ['image-extraction', 'data-quality']
          : [],
        excludedSkillIds: [
          ...(!images?.length ? ['image-extraction'] : []),
          ...(runPlan?.symbols?.length ? ['quant-symbol-resolver'] : []),
        ],
        templateId,
        variantId,
        availableToolNames,
        maxSystemContextChars: platformPrepared
          ? positiveIntegerEnv('PI_AGENT_PREFETCHED_SKILL_CONTEXT_CHARS', 4_000)
          : positiveIntegerEnv('PI_AGENT_SKILL_CONTEXT_CHARS', 6_000),
      }),
      buildQuantPilotTaskPrompt(instruction, workspace, {
        runPlan,
        platformPrepared,
        preparedIntent,
        phase: skillPhase,
        hasAttachments: Boolean(images?.length),
      }),
      buildBoundedHistory(projectId, requestId),
    ]), abortController.signal);

    let initialDashboardContract: string | null = null;
    if (platformPrepared && dashboardContractRequired) {
      if (preparedIntent === 'standard' && includeDashboardSpec) {
        initialDashboardContract = JSON.stringify({
          schemaVersion: 1,
          mode: 'trusted_dashboard_spec',
          templateId,
          variantId,
          dataArtifact: 'final_dashboard',
          digest: `sha256:${hashPiAgentProvenance({
            runId: runPlan?.runId,
            templateId,
            variantId,
            panels: runPlan?.visualization?.panels,
          })}`,
        });
      } else {
        // The inspector is a platform-side preflight, not provider-visible
        // schema. Custom/repair runs receive its bounded result directly.
        const inspector = createInspectDashboardContractTool({
          workspaceRoot: workspace,
          maxOutputChars: maxToolOutputChars,
        });
        const parsedInput = inspector.parseInput ? inspector.parseInput({}) : {};
        const inspection = await raceWithAbort(Promise.resolve(inspector.execute(parsedInput, {
          runId: runInstanceId,
          turn: 0,
          toolCallId: 'platform-initial-dashboard-contract',
          operationId: `${runInstanceId}:initial-dashboard-contract`,
          signal: abortController.signal,
        })), abortController.signal);
        if (inspection.ok && inspection.content?.trim()) {
          initialDashboardContract = inspection.content.trim();
        }
      }
    }
    const systemPrompt = buildQuantPilotSystemPrompt({
      phase: skillPhase,
      preparedIntent,
      skillManifest: skillBundle.systemContext,
    });
    const userPrompt = buildQuantPilotUserPrompt({
      taskPacket: taskPrompt,
      skillContext: skillBundle.taskContext,
      personalizationContext: personalization?.content ?? null,
      governedKnowledgeContext: governedKnowledge?.content ?? null,
      initialDashboardContract,
      requireDashboardContract: dashboardContractRequired,
    });
    const messages: PiAgentMessage[] = [
      { role: 'system', content: systemPrompt },
      ...history,
      { role: 'user', content: userPrompt },
    ];

    const baseProvider = phaseGraph.providerMode === 'deterministic'
      ? new PiAgentDeterministicToolPlanProvider({
          name: 'pi-agent-trusted-renderer',
          steps: [
            {
              name: 'apply_dashboard_spec',
              arguments: { templateId, variantId },
            },
            {
              name: 'submit_result',
              arguments: {
                summary: `已通过可信渲染器生成 ${templateId}/${variantId} 标准量化看板。`,
                artifacts: ['app/page.tsx', 'app/globals.css'],
                notes: '零模型 Token 的确定性编译结果，等待平台独立验证。',
              },
            },
          ],
        })
      : llmConfig.provider === 'deepseek'
        ? new DeepSeekProvider({
            apiKey: apiKey!,
            baseUrl: llmConfig.baseUrl,
            headers: {
              'X-Client-App': `QuantPilot-PI-Agent/${PI_AGENT_VERSION}`,
            },
            maxRequestBytes: positiveIntegerEnv('PI_AGENT_MAX_REQUEST_BYTES', 2_000_000),
            maxRetries: nonNegativeIntegerEnv('PI_AGENT_PROVIDER_MAX_RETRIES', 2),
            initialRetryDelayMs: nonNegativeIntegerEnv('PI_AGENT_PROVIDER_RETRY_BASE_MS', 500),
            maxRetryDelayMs: nonNegativeIntegerEnv('PI_AGENT_PROVIDER_RETRY_MAX_MS', 10_000),
          })
        : new OpenAICompatibleProvider({
            providerName: 'openai',
            apiKey: apiKey!,
            baseUrl: llmConfig.baseUrl,
            headers: {
              'X-Client-App': `QuantPilot-PI-Agent/${PI_AGENT_VERSION}`,
              ...modelPortScopeHeaders(integrationScope),
            },
            maxRequestBytes: positiveIntegerEnv('PI_AGENT_MAX_REQUEST_BYTES', 2_000_000),
            maxRetries: nonNegativeIntegerEnv('PI_AGENT_PROVIDER_MAX_RETRIES', 2),
            initialRetryDelayMs: nonNegativeIntegerEnv('PI_AGENT_PROVIDER_RETRY_BASE_MS', 500),
            maxRetryDelayMs: nonNegativeIntegerEnv('PI_AGENT_PROVIDER_RETRY_MAX_MS', 10_000),
          });
    const runtimeModel = phaseGraph.providerMode === 'deterministic'
      ? 'pi-agent-deterministic-renderer-v1'
      : resolvedModel;
    const configuredMaxTurnOutputTokens = phaseGraph.providerMode === 'deterministic'
      ? 1
      : positiveIntegerEnv('PI_AGENT_MAX_TURN_OUTPUT_TOKENS', 12_000);
    const maxRunOutputTokens = Math.min(
      optionalPositiveIntegerEnv('PI_AGENT_MAX_RUN_OUTPUT_TOKENS') ??
        phaseGraph.budgets.maxOutputTokens,
      phaseGraph.budgets.maxOutputTokens,
    );
    const maxTurnOutputTokens = Math.min(
      configuredMaxTurnOutputTokens,
      maxRunOutputTokens,
    );
    const contextManager = phaseGraph.providerMode === 'model' ? new PiAgentContextManager({
      // Reserve only one provider turn. The cumulative run output budget is a
      // separate control and must not shrink every turn's input context.
      contextWindowTokens: positiveIntegerEnv('PI_AGENT_CONTEXT_WINDOW_TOKENS', 128_000),
      reservedOutputTokens: maxTurnOutputTokens,
      maxInputTokens: Math.min(
        positiveIntegerEnv('PI_AGENT_MAX_INPUT_TOKENS', 48_000),
        phaseGraph.budgets.maxPreparedInputTokens,
      ),
      contextCapsuleMaxUtf8Bytes: Math.min(
        optionalPositiveIntegerEnv('PI_AGENT_CONTEXT_CAPSULE_MAX_BYTES') ?? 2_048,
        2_048,
      ),
    }) : undefined;
    const configuredMaxTurns = optionalPositiveIntegerEnv('PI_AGENT_MAX_TURNS');
    const configuredMaxToolCalls = optionalPositiveIntegerEnv('PI_AGENT_MAX_TOTAL_TOOL_CALLS');
    const maxRunInputTokens =
      optionalPositiveIntegerEnv('PI_AGENT_MAX_RUN_INPUT_TOKENS') ?? 160_000;
    const maxRunCacheMissInputTokens = Math.min(
      optionalPositiveIntegerEnv('PI_AGENT_MAX_RUN_CACHE_MISS_INPUT_TOKENS') ??
        phaseGraph.budgets.maxCacheMissInputTokens,
      phaseGraph.budgets.maxCacheMissInputTokens,
    );
    const maxRunPreparedInputTokens = Math.min(
      phaseGraph.budgets.maxCumulativePreparedInputTokens,
      maxRunInputTokens,
    );
    const engine = new PiAgentRunEngine({
      provider: baseProvider,
      model: runtimeModel,
      tools,
      contextManager,
      maxTurns: Math.min(
        configuredMaxTurns ?? phaseGraph.budgets.maxTurns,
        phaseGraph.budgets.maxTurns,
      ),
      maxTotalToolCalls: Math.min(
        configuredMaxToolCalls ?? phaseGraph.budgets.maxToolCalls,
        phaseGraph.budgets.maxToolCalls,
      ),
      preWriteReadOnlyTurnThreshold: positiveIntegerEnv(
        'PI_AGENT_PRE_WRITE_READ_ONLY_TURNS',
        3,
      ),
      postWriteReadOnlyTurnThreshold: positiveIntegerEnv(
        'PI_AGENT_POST_WRITE_READ_ONLY_TURNS',
        2,
      ),
      maxTokens: maxRunOutputTokens,
      maxTokensPerTurn: maxTurnOutputTokens,
      maxRunInputTokens,
      maxRunCacheMissInputTokens,
      ...(phaseGraph.providerMode === 'model'
        ? { maxRunPreparedInputTokens }
        : {}),
      progressStallTurns: phaseGraph.budgets.progressStallTurns,
      timeoutMs: Math.max(1, deadlineAt - Date.now()),
      requireTerminalTool: true,
      requireWorkspaceWriteBeforeTerminal: true,
      toolApprovalHandler: createPrismaPiAgentToolApprovalHandler(
        positiveIntegerEnv('PI_AGENT_APPROVAL_POLL_INTERVAL_MS', 500),
      ),
    });

    const startup = await withPiAgentWorkspaceResourceLock(workspace, async () => {
      const recoveryAudit = await auditPrismaPiAgentRecovery(projectId, workspace);
      if (recoveryAudit.blocked.length > 0 || recoveryAudit.racedRunIds.length > 0) {
        throw new Error(
          'PI Agent 检测到旧执行仍有未调和的写操作或并发调和，本次新执行已拒绝启动。'
        );
      }
      // Recovery may have restored an interrupted batch. Capture provenance
      // only after that rollback, under the same physical lock used by final
      // file commits, so the new attempt is bound to the actual replan state.
      const [workspaceSnapshot, workspaceKey] = await raceWithAbort(
        Promise.all([
          hashPiAgentWorkspace(workspace),
          hashPiAgentWorkspaceIdentity(workspace),
        ]),
        abortController.signal,
      );
      const session = await createPrismaPiAgentDurableRunSession({
        run: {
          runId: runInstanceId,
          runInstanceId: physicalRunInstanceId,
          projectId,
          workspaceKey,
          requestId,
          provider: baseProvider.name,
          model: runtimeModel,
          frameworkVersion: PI_AGENT_FRAMEWORK_VERSION,
          buildRevision: PI_AGENT_BUILD_REVISION,
          profileHash: `sha256:${hashPiAgentProvenance({
            profile,
            capabilityId,
            skillPhase,
            platformPrepared,
            preparedIntent,
            phaseGraph,
            templateId,
            variantId,
          })}`,
          promptHash: `sha256:${hashPiAgentProvenance(messages)}`,
          toolHash: `sha256:${hashPiAgentProvenance(tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            effect: tool.effect,
            idempotency: tool.idempotency,
            observationCache: tool.observationCache,
            approval: tool.approval
              ? {
                  reason: tool.approval.reason,
                  allowedDecisions:
                    tool.approval.allowedDecisions ?? ['approve', 'reject'],
                  timeoutMs: tool.approval.timeoutMs ?? 10 * 60 * 1_000,
                  publicInputProjector: 'first_party_v1',
                }
              : null,
            contextReceiptProjector: tool.projectContextReceipt ? 'first_party_v1' : null,
            terminal: tool.terminal === true,
          })))}`,
          skillHash: `sha256:${hashPiAgentProvenance(skillBundle.skills)}`,
          workspaceHash: `sha256:${workspaceSnapshot.sha256}`,
        },
        leaseTtlMs: positiveIntegerEnv('PI_AGENT_LEASE_TTL_MS', 60_000),
        heartbeatIntervalMs: positiveIntegerEnv('PI_AGENT_HEARTBEAT_INTERVAL_MS', 15_000),
        onFatal: (error) => {
          durableStoreFailure = error instanceof Error
            ? error
            : new Error('PI Agent durable state persistence failed.');
          if (!abortController.signal.aborted) {
            abortController.abort(
              new DOMException('PI Agent durable lease or state persistence was lost.', 'AbortError')
            );
          }
        },
      });
      return { recoveryAudit, session };
    }, {
      signal: abortController.signal,
      waitTimeoutMs: positiveIntegerEnv('PI_AGENT_RESOURCE_LOCK_WAIT_MS', 5_000),
      ownerId: `startup:${runInstanceId}`,
      recoverDeadLocalOwner: true,
      metadata: {
        purpose: 'run_startup',
        projectId,
        runId: runInstanceId,
        ...(requestId ? { requestId } : {}),
      },
    });
    const recoveryAudit = startup.recoveryAudit;
    if (recoveryAudit.interruptedRunIds.length > 0) {
      publishStatus(
        'replan_recovery_detected',
        'PI Agent 已关闭过期 attempt；本次将基于当前工作空间重新规划。',
        { interruptedAttempts: recoveryAudit.interruptedRunIds.length },
      );
    }
    durableSession = startup.session;

    const activeDurableSession = durableSession;
    const result = await engine.run({
      messages,
      runId: runInstanceId,
      signal: abortController.signal,
      temperature: 0.2,
      reasoning: {
        enabled: phaseGraph.providerMode === 'model' && process.env.PI_AGENT_REASONING !== '0',
        effort: phaseGraph.reasoningEffort,
      },
      metadata: {
        projectId,
        requestId,
        capabilityId,
        profile,
        skillPhase,
        platformPrepared,
        preparedIntent,
        phaseGraph,
        templateId,
        variantId,
        skillContextCharacters: skillBundle.totalCharacters,
      },
      commitWorkspaceMutation: (operationId, commit) =>
        activeDurableSession.commitWorkspaceMutation(operationId, commit),
    }, {
      durableSink: (event) => activeDurableSession.record(event),
      observers: [async (event: PiAgentEvent) => {
      switch (event.type) {
        case 'run_started':
          streamManager.publish(projectId, {
            type: 'connected',
            data: {
              projectId,
              runtime: 'pi',
              runId: event.runId,
              eventId: event.eventId,
              sequence: event.sequence,
              timestamp: new Date(event.timestamp).toISOString(),
              connectionStage: 'assistant',
            },
          });
          break;
        case 'provider_retry':
          publishStatus(
            'provider_retry',
            `${providerLabel} 暂时不可用，PI Agent 将进行第 ${event.attempt}/${event.maxAttempts} 次尝试。`,
            {
              runtime: 'pi',
              eventId: event.eventId,
              sequence: event.sequence,
              delayMs: event.delayMs,
              code: event.code,
              ...(event.status === undefined ? {} : { status: event.status }),
            },
          );
          break;
        case 'progress_evaluated':
          if (event.decision.stalled) {
            publishStatus(
              'progress_stalled',
              'PI Agent 检测到本轮没有可验证进展，正在收紧读取并推动写入或提交。',
              {
                runtime: 'pi',
                eventId: event.eventId,
                sequence: event.sequence,
                turn: event.turn,
                consecutiveNoProgressTurns:
                  event.decision.consecutiveNoProgressTurns,
                stallSignals: [...event.decision.stallSignals],
              },
            );
          }
          break;
        case 'text_delta': {
          const state = assistantStreams.get(event.turn) ?? { id: randomUUID(), content: '' };
          state.content += event.delta;
          assistantStreams.set(event.turn, state);
          streamManager.publish(projectId, {
            type: 'message',
            data: createRealtimeMessage({
              id: state.id,
              projectId,
              role: 'assistant',
              messageType: 'chat',
              content: state.content,
              cliSource: 'pi',
              requestId,
              isStreaming: true,
              metadata: {
                runtime: 'pi',
                isPiAgentIntermediateTurn: true,
                hidden_from_ui: true,
              },
            }),
          });
          break;
        }
        case 'assistant_message': {
          const state = assistantStreams.get(event.turn);
          const content = (event.message.content ?? state?.content ?? '').trim();
          const submitted = event.message.toolCalls?.some((call) => call.name === 'submit_result') ?? false;
          assistantStreams.delete(event.turn);
          if (content) {
            await persistAssistantMessage({
              projectId,
              requestId,
              id: state?.id,
              content,
              metadata: submitted
                ? {
                    runtime: 'pi',
                    isPiAgentCandidate: true,
                    hidden_from_ui: true,
                  }
                : {
                    runtime: 'pi',
                    isPiAgentIntermediateTurn: true,
                    hidden_from_ui: true,
                  },
            });
            assistantMessageCount += 1;
            lastAssistantContent = content;
          }
          break;
        }
        case 'tool_approval_requested':
          publishStatus(
            'tool_approval_required',
            `PI Agent 正在等待确认：${event.request.reason}`,
            {
              runtime: 'pi',
              eventId: event.eventId,
              sequence: event.sequence,
              turn: event.turn,
              approvalId: event.request.approvalId,
              toolName: event.request.toolName,
              effect: event.request.effect,
              publicInput: event.request.publicInput,
              allowedDecisions: [...event.request.allowedDecisions],
              expiresAt: new Date(event.request.expiresAt).toISOString(),
            },
          );
          break;
        case 'tool_approval_resolved':
          publishStatus(
            'tool_approval_resolved',
            event.decision === 'reject'
              ? `工具 ${event.toolName} 的执行已拒绝。`
              : event.decision === 'edit'
                ? `工具 ${event.toolName} 的参数已修改并批准。`
                : `工具 ${event.toolName} 已批准执行。`,
            {
              runtime: 'pi',
              eventId: event.eventId,
              sequence: event.sequence,
              turn: event.turn,
              approvalId: event.approvalId,
              toolName: event.toolName,
              decision: event.decision,
              ...(event.resolvedBy ? { resolvedBy: event.resolvedBy } : {}),
            },
          );
          break;
        case 'tool_started': {
          const input = parseToolArguments(event.toolCall);
          const persistedInput = auditToolInput(event.toolCall.name, input);
          const target = toolTarget(input);
          await persistToolMessage({
            projectId,
            requestId,
            messageType: 'tool_use',
            content: `Using tool: ${event.toolCall.name}${target ? ` on ${target}` : ''}`,
            metadata: {
              runtime: 'pi',
              toolName: event.toolCall.name,
              toolCallId: event.toolCall.id,
              tool_call_id: event.toolCall.id,
              operationId: event.operationId,
              action: toolAction(event.toolCall.name),
              summary: toolStartSummary(event.toolCall.name, target),
              isTransientToolMessage: true,
              resultStatus: 'running',
              eventId: event.eventId,
              eventSequence: event.sequence,
              ...(target ? { filePath: target, target } : {}),
              input: persistedInput,
              toolInput: persistedInput,
            },
          });
          break;
        }
        case 'tool_completed':
        case 'tool_failed': {
          if (event.type === 'tool_completed' && event.effect === 'workspace_write') {
            successfulWorkspaceWriteCount += 1;
          }
          const output = auditToolResult(event.result);
          const summary = toolResultSummary(event.toolCall, event.result);
          const resultData = event.result.ok && isRecord(event.result.data)
            ? event.result.data
            : null;
          const resultTarget = typeof resultData?.resolvedPath === 'string'
            ? resultData.resolvedPath
            : typeof resultData?.path === 'string'
              ? resultData.path
              : undefined;
          await persistToolMessage({
            projectId,
            requestId,
            messageType: 'tool_result',
            content: event.result.ok
              ? `Tool completed: ${event.toolCall.name}`
              : `Tool failed: ${event.toolCall.name} (${event.result.error.code})`,
            metadata: {
              runtime: 'pi',
              toolName: event.toolCall.name,
              toolCallId: event.toolCall.id,
              tool_call_id: event.toolCall.id,
              operationId: event.operationId,
              success: event.result.ok,
              resultStatus: event.result.ok ? 'completed' : 'failed',
              isTransientToolMessage: false,
              summary,
              ...(resultTarget ? { target: resultTarget, filePath: resultTarget } : {}),
              ...(resultData?.pathResolved === true ? {
                pathResolved: true,
                pathCorrected: resultData.pathCorrected === true,
                requestedPath: resultData.requestedPath,
                correctionReason: resultData.correctionReason,
              } : {}),
              durationMs: event.durationMs,
              eventId: event.eventId,
              eventSequence: event.sequence,
              outputAudit: output,
              ...(event.type === 'tool_completed' ? { terminal: event.terminal } : {
                errorCode: event.result.error.code,
              }),
            },
          });
          break;
        }
        default:
          break;
      }
      }],
      onObserverError: (error, event) => {
        console.error(
          `[PI Agent] Best-effort observer failed for ${event.type}:`,
          error instanceof Error ? error.message : 'unknown observer error',
        );
      },
    });

    if (durableStoreFailure || activeDurableSession.failure) {
      throw new Error('PI Agent 持久化状态或运行租约失效，本次执行已安全中断。', {
        cause: durableStoreFailure ?? activeDurableSession.failure,
      });
    }

    if (deadlineTimedOut || result.status === 'timeout') {
      throw new Error('PI Agent 执行超时，任务已终止。');
    }
    if (result.status === 'cancelled') {
      const reason = cancellationReason ?? '用户暂停了当前任务';
      publishPaused(reason);
      throw new Error(reason);
    }
    if (result.status !== 'completed') {
      throw new PiAgentExecutionError(
        result.error?.code ?? `PI_AGENT_${result.status.toUpperCase()}`,
        formatRunFailure(result, {
          label: providerLabel,
          credentialEnv: llmConfig.credentialEnv,
        }),
        {
          cause: result.error?.cause,
          repairableByValidation:
            successfulWorkspaceWriteCount > 0 && (
              result.status === 'max_turns' ||
              result.status === 'max_tokens' ||
              result.status === 'stopped'
            ),
        },
      );
    }

    const summary = getTerminalSummary(result);
    if (summary && (assistantMessageCount === 0 || !lastAssistantContent.includes(summary))) {
      await persistAssistantMessage({
        projectId,
        requestId,
        content: summary,
        metadata: {
          runtime: 'pi',
          isPiAgentCandidate: true,
          hidden_from_ui: true,
        },
      }).catch((error) => {
        console.error('[PI Agent] Failed to persist terminal summary projection:', error);
      });
    }
    const candidate = await candidateFromPiAgentRun({
      workspaceRoot: workspace,
      requestId,
      result,
    });
    publishStatus('agent_candidate_complete', summary ?? undefined, {
      runtime: 'pi',
      turns: result.turns,
      usage: result.usage,
      lane: phaseGraph.lane,
      providerMode: phaseGraph.providerMode,
      skills: skillBundle.selectedSkillIds,
      candidateWorkspaceSha256: candidate.workspaceSha256,
    });
    executionCompleted = true;
    return candidate;
  } catch (error) {
    const durableFailure = durableStoreFailure ?? durableSession?.failure;
    if (durableFailure) {
      await interruptDurableRun('DURABLE_STATE_LOST');
      const message = 'PI Agent 持久化状态或运行租约失效，本次执行已安全中断。';
      publishStatus('agent_execution_failed', message);
      throw new Error(message, { cause: durableFailure });
    }
    if (deadlineTimedOut) {
      await interruptDurableRun('EXECUTION_DEADLINE_EXCEEDED');
      const message = 'PI Agent 执行超时，任务已终止。';
      publishStatus('agent_execution_failed', message);
      throw new Error(message, { cause: error });
    }
    const cancelled = Boolean(cancellationReason) ||
      isAgentRunCancelled(projectId, cancellationScopeRequestId) ||
      await cancellationRequested();
    if (cancelled) {
      await interruptDurableRun('CANCELLED_BEFORE_TERMINAL_EVENT');
      const reason = cancellationReason ?? (error instanceof Error ? error.message : '用户暂停了当前任务');
      publishPaused(reason);
      throw new Error(reason);
    }
    await interruptDurableRun('PRODUCT_PHASE_INTERRUPTED');
    const classifiedFailure = classifyPiAgentExecutionError(error);
    const message = classifiedFailure?.message ??
      (error instanceof Error ? error.message : String(error));
    publishStatus('agent_execution_failed', message);
    if (classifiedFailure) throw classifiedFailure;
    throw new Error(message, { cause: error });
  } finally {
    clearTimeout(deadlineTimer);
    await durableSession?.close().catch((closeError) => {
      console.error('[PI Agent] Failed to close durable run session:', closeError);
    });
    if (runtimeRegistered) {
      if (executionCompleted) completeAgentRun(projectId, cancellationScopeRequestId);
      else failAgentRun(projectId, cancellationScopeRequestId);
    }
  }
}

export async function initializeNextJsProject(
  projectId: string,
  projectPath: string,
  initialPrompt: string,
  model: string = PI_AGENT_DEFAULT_MODEL,
  requestId?: string,
  personalization?: PersonalizationCapsule | null,
  governedKnowledge?: GovernedKnowledgeCapsule | null,
): Promise<PiAgentCandidateSubmission> {
  const instruction = `Enhance the existing, platform-scaffolded Next.js 16 application for this requirement:
${initialPrompt}

Keep the App Router, TypeScript, package setup, local CSS, market proxy, platform-prefetched run plan, final data, evidence, and dashboard data binding. Do not recreate the project or reset package.json. At 390x844 the first viewport must show the instrument, price, at least two real metrics, and the main visualization body. At 1440x900 keep the primary visualization above the fold. QuantPilot will run build, preview, and validation after submit_result.`;
  return executePiAgent(
    projectId,
    projectPath,
    instruction,
    model,
    requestId,
    undefined,
    personalization,
    governedKnowledge,
  );
}

export async function applyChanges(
  projectId: string,
  projectPath: string,
  instruction: string,
  model: string = PI_AGENT_DEFAULT_MODEL,
  requestId?: string,
  images?: PiAgentImageAttachment[],
  personalization?: PersonalizationCapsule | null,
  governedKnowledge?: GovernedKnowledgeCapsule | null,
): Promise<PiAgentCandidateSubmission> {
  return executePiAgent(
    projectId,
    projectPath,
    instruction,
    model,
    requestId,
    images,
    personalization,
    governedKnowledge,
  );
}

/** Trusted orchestration entry point for validation-directed repairs only. */
export async function applyRepairChanges(
  projectId: string,
  projectPath: string,
  instruction: string,
  model: string = PI_AGENT_DEFAULT_MODEL,
  requestId?: string,
  parentRequestId?: string,
): Promise<PiAgentCandidateSubmission> {
  return executePiAgentPhase({
    projectId,
    projectPath,
    instruction,
    model,
    requestId,
    parentRequestId,
    profile: 'repair',
  });
}
