import fs from 'node:fs/promises';
import path from 'node:path';

import { DeepSeekProvider } from '@/lib/agent/providers/deepseek';
import { OpenAICompatibleProvider } from '@/lib/agent/providers/openai-compatible';
import type { PiAgentMessage, PiAgentModelProvider } from '@/lib/agent/types';
import { getProjectLlmConfig } from '@/lib/config/llm';
import {
  getProjectIntegrationScope,
  modelPortScopeHeaders,
} from '@/lib/platform/context/integration-scope';
import { getRecentChatMessagesByConversation } from '@/lib/services/message';
import { readPiAgentAcceptedMissionSnapshot } from '@/lib/services/pi-agent-mission-store';

type JsonRecord = Record<string, unknown>;

const MAX_HISTORY_MESSAGES = 12;
const MAX_HISTORY_MESSAGE_CHARS = 6_000;
const CHAT_TIMEOUT_MS = 55_000;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

function select(record: JsonRecord | null, keys: readonly string[]): JsonRecord {
  if (!record) return {};
  const selected: JsonRecord = {};
  for (const key of keys) {
    if (record[key] !== undefined) selected[key] = record[key];
  }
  return selected;
}

async function readJson(filePath: string): Promise<JsonRecord | null> {
  try {
    return asRecord(JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown);
  } catch {
    return null;
  }
}

/**
 * Keep the model context bounded and decision-relevant. Raw K-lines and
 * provider payloads are deliberately excluded from ordinary follow-up turns.
 */
export function projectDashboardChatData(data: JsonRecord | null): JsonRecord {
  if (!data) return { available: false };

  const assets = asArray(data.assets)
    .map(asRecord)
    .filter((asset): asset is JsonRecord => Boolean(asset))
    .slice(0, 20)
    .map((asset) => ({
      ...select(asset, [
        'symbol',
        'name',
        'market',
        'asset_type',
        'source',
        'currency',
        'as_of',
      ]),
      quote: select(asRecord(asset.quote), [
        'price',
        'open',
        'high',
        'low',
        'previous_close',
        'change_percent',
        'change_amount',
        'turnover',
        'volume',
        'amount',
        'market_cap',
        'float_market_cap',
        'pe_ttm',
        'pb_mrq',
        'industry',
        'quote_time',
        'data_quality',
      ]),
      computedMetrics: select(asRecord(asset.computedMetrics), [
        'periodReturn',
        'return20d',
        'return60d',
        'return120d',
        'periodHigh',
        'periodLow',
        'maxDrawdown',
        'volatility20d',
        'avgVolume20d',
        'avgAmount20d',
        'ma5',
        'ma10',
        'ma20',
        'ma60',
      ]),
      financialQuality: select(asRecord(asset.financialQuality), [
        'latest_report_date',
        'roe_pct',
        'gross_margin_pct',
        'net_margin_pct',
        'revenue_yoy_pct',
        'net_profit_yoy_pct',
        'quality_score',
        'quality_label',
        'strengths',
        'watch_items',
      ]),
    }));

  return {
    available: true,
    ...select(data, [
      'schemaVersion',
      'generatedAt',
      'as_of',
      'runId',
      'primarySymbol',
      'requestedSymbols',
      'symbols',
      'assetCount',
      'portfolio',
      'holdings',
      'comparison',
      'correlation',
      'selectionRanking',
      'conclusion',
      'warnings',
    ]),
    assets,
  };
}

interface DashboardChatContextDependencies {
  readAcceptedMission(
    projectId: string,
    requestId: string,
  ): ReturnType<typeof readPiAgentAcceptedMissionSnapshot>;
}

const defaultContextDependencies: DashboardChatContextDependencies = {
  readAcceptedMission: readPiAgentAcceptedMissionSnapshot,
};

export async function buildDashboardChatContext(
  input: { projectId: string; projectPath: string },
  dependencies: DashboardChatContextDependencies = defaultContextDependencies,
): Promise<JsonRecord> {
  const [data, validation] = await Promise.all([
    readJson(path.join(input.projectPath, 'data_file', 'final', 'dashboard-data.json')),
    readJson(path.join(input.projectPath, '.data-agent', 'validation.json')),
  ]);
  const dataRunId = nonEmptyString(data?.runId);
  const validationRunId = nonEmptyString(validation?.runId);
  const validationPassed = validation?.status === 'passed' && validation?.passed === true;

  if (!data || !validation || !dataRunId || dataRunId !== validationRunId || !validationPassed) {
    return {
      dashboard: { available: false },
      validation: { status: 'unavailable' },
      evidenceBoundary: {
        acceptedRequestId: null,
        reason: '当前数据与平台验证报告不是同一次通过的运行，拒绝把候选数据用于问答。',
      },
    };
  }

  const accepted = await dependencies.readAcceptedMission(input.projectId, dataRunId);
  if (
    !accepted ||
    accepted.missionStatus !== 'completed' ||
    accepted.requestId !== dataRunId ||
    !accepted.acceptedReceiptId ||
    !accepted.acceptedReceiptHash
  ) {
    return {
      dashboard: { available: false },
      validation: { status: 'unavailable' },
      evidenceBoundary: {
        acceptedRequestId: null,
        reason: '当前运行缺少已提交的 Mission 验收凭据，拒绝用于问答。',
      },
    };
  }

  const checks = asArray(validation.checks)
    .map(asRecord)
    .filter((check): check is JsonRecord => Boolean(check))
    .slice(0, 30)
    .map((check) => select(check, ['id', 'status', 'summary']));

  return {
    dashboard: projectDashboardChatData(data),
    validation: {
      ...select(validation, ['status', 'passed', 'runId', 'createdAt', 'updatedAt']),
      checks,
    },
    evidenceBoundary: {
      acceptedRequestId: accepted.requestId,
      acceptedAt: accepted.acceptedAt,
      acceptedReceiptId: accepted.acceptedReceiptId,
      acceptedReceiptHash: accepted.acceptedReceiptHash,
      note: '上下文只来自同一 runId 的最终数据、通过的验证报告和已提交的 Mission 验收凭据。',
    },
  };
}

function createProvider(projectId: string, selectedModel?: string | null): {
  provider: PiAgentModelProvider;
  model: string;
} {
  const config = getProjectLlmConfig(selectedModel);
  if (!config.agent.enabled) throw new Error('当前模型的问答能力未启用。');
  const apiKey = process.env[config.credentialEnv]?.trim();
  if (!apiKey) throw new Error(`问答模型未配置：缺少 ${config.credentialEnv}。`);

  const common = {
    apiKey,
    baseUrl: config.baseUrl,
    headers: { 'X-Client-App': 'QuantPilot-Dashboard-Chat/1' },
    maxRequestBytes: 512_000,
    maxTextChars: 24_000,
    maxReasoningChars: 8_000,
    maxRetries: 1,
    initialRetryDelayMs: 300,
    maxRetryDelayMs: 1_500,
  };

  if (config.provider === 'deepseek') {
    return { provider: new DeepSeekProvider(common), model: config.model };
  }
  return {
    provider: new OpenAICompatibleProvider({
      ...common,
      providerName: 'openai',
      headers: {
        ...common.headers,
        ...modelPortScopeHeaders(getProjectIntegrationScope(projectId)),
      },
    }),
    model: config.model,
  };
}

export async function answerDashboardQuestion(input: {
  projectId: string;
  projectPath: string;
  question: string;
  conversationId?: string | null;
  requestId: string;
  selectedModel?: string | null;
  hasAttachments?: boolean;
  signal?: AbortSignal;
}): Promise<{
  answer: string;
  provider: string;
  model: string;
  acceptedRequestId: string | null;
}> {
  const [context, recentMessages] = await Promise.all([
    buildDashboardChatContext({
      projectId: input.projectId,
      projectPath: input.projectPath,
    }),
    getRecentChatMessagesByConversation(
      input.projectId,
      input.conversationId,
      MAX_HISTORY_MESSAGES,
    ),
  ]);
  const history: PiAgentMessage[] = recentMessages
    .filter((message) => message.requestId !== input.requestId)
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => ({
      role: message.role as 'user' | 'assistant',
      content: message.content.slice(0, MAX_HISTORY_MESSAGE_CHARS),
    }));
  const { provider, model } = createProvider(input.projectId, input.selectedModel);
  const controller = new AbortController();
  const abort = () => controller.abort(input.signal?.reason);
  if (input.signal?.aborted) abort();
  else input.signal?.addEventListener('abort', abort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Dashboard chat timed out.', 'TimeoutError')),
    CHAT_TIMEOUT_MS,
  );
  timeout.unref?.();
  let answer = '';

  const systemPrompt = [
    '你是 QuantPilot 当前看板的只读研究助手。',
    '只能根据 CURRENT_DASHBOARD_CONTEXT 和同一会话历史回答；没有证据时明确说不知道，不得补造实时行情、指标或信源。',
    '如果 dashboard.available=false，说明当前没有可验证的已验收看板，并建议用户显式选择“生成看板”；不得改用候选文件猜测。',
    '“这个、哪个、它、前者、后者”等指代优先从当前看板标的和会话历史解析，不要重复询问看板已经提供的信息。',
    '你不能修改文件、生成看板、创建执行计划、调用工具或声称已经刷新数据。',
    input.hasAttachments
      ? '本轮带有附件，但只读问答不读取新附件；如果问题依赖附件，请明确提示用户切换到生成看板模式。'
      : '',
    '涉及买卖选择时，只能表述为当前证据下的研究优先级，并列出依据、反方风险和数据时点，不承诺收益。',
    '使用简洁中文回答。',
    `CURRENT_DASHBOARD_CONTEXT=${JSON.stringify(context)}`,
  ].filter(Boolean).join('\n');

  try {
    for await (const event of provider.complete({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: input.question },
      ],
      toolChoice: 'none',
      maxTokens: 2_000,
      temperature: 0.2,
      reasoning: { enabled: false },
      signal: controller.signal,
      metadata: {
        purpose: 'dashboard_read_only_chat',
        projectId: input.projectId,
        requestId: input.requestId,
      },
    })) {
      if (event.type === 'text_delta') answer += event.delta;
    }
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', abort);
  }

  const normalizedAnswer = answer.trim();
  if (!normalizedAnswer) throw new Error('问答模型没有返回有效内容。');
  const acceptedRequestId = nonEmptyString(
    asRecord(context.evidenceBoundary)?.acceptedRequestId,
  );
  return {
    answer: normalizedAnswer,
    provider: provider.name,
    model,
    acceptedRequestId,
  };
}
