#!/usr/bin/env node

import { randomUUID } from 'node:crypto';

import { OpenAICompatibleProvider } from '../../src/lib/agent/providers/openai-compatible';
import type {
  MoAgentMessage,
  MoAgentModelEvent,
  MoAgentTokenUsage,
} from '../../src/lib/agent/types';
import { getProjectLlmConfig } from '../../src/lib/config/llm';
import {
  LOCAL_QWEN_MODEL_ID,
  MODELPORT_DEEPSEEK_MODEL_ID,
} from '../../src/lib/constants/models';
import { memoryCompatibilityIssues } from '../../src/lib/platform/memory/compatibility';
import { getMemoryIntegrationConfig } from '../../src/lib/platform/memory/config';
import { EvolvableMemoryHttpAdapter } from '../../src/lib/platform/memory/evolvable-memory-http';
import {
  MEMORY_INTEGRATION_CAPABILITIES,
  type PersonalizationCapsule,
} from '../../src/lib/platform/memory/types';
import { rewriteQuantQuerySemanticsWithConfiguredProvider } from '../../src/lib/domains/finance/query-rewrite-llm';
import { buildQuantPilotUserPrompt } from '../../src/lib/services/moagent-prompts';

const argv = process.argv.slice(2);
const writeMode = argv.includes('--write');

function option(name: string): string | null {
  const prefix = `--${name}=`;
  return argv.find((value) => value.startsWith(prefix))?.slice(prefix.length).trim() || null;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function jsonRecord(value: unknown, label: string): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} is not an object.`);
  return value as Record<string, unknown>;
}

function modelCatalogUrl(baseUrl: string): string {
  return new URL('models', `${baseUrl.replace(/\/$/, '')}/`).toString();
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = 5_000,
): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

interface ProviderRoundTrip {
  toolCallId: string;
  toolName: string;
  toolArguments: string;
  usage: MoAgentTokenUsage;
  responseModel: string;
  continuationUsage: MoAgentTokenUsage;
  continuationCharacters: number;
}

interface CollectedProviderTurn {
  responseModel: string;
  text: string;
  toolCallId: string;
  toolName: string;
  toolArguments: string;
  usage: MoAgentTokenUsage | null;
  finishReason: string | null;
}

async function collectProviderTurn(
  events: AsyncIterable<MoAgentModelEvent>,
): Promise<CollectedProviderTurn> {
  let responseModel = '';
  let text = '';
  let toolCallId = '';
  let toolName = '';
  let toolArguments = '';
  let usage: MoAgentTokenUsage | null = null;
  let finishReason: string | null = null;
  for await (const event of events) {
    if (event.type === 'response_start') responseModel = event.model;
    if (event.type === 'text_delta') text += event.delta;
    if (event.type === 'tool_call_delta' && event.index === 0) {
      toolCallId += event.id ?? '';
      toolName += event.nameDelta ?? '';
      toolArguments += event.argumentsDelta ?? '';
    }
    if (event.type === 'usage') usage = event.usage;
    if (event.type === 'finish') finishReason = event.reason;
  }
  return { responseModel, text, toolCallId, toolName, toolArguments, usage, finishReason };
}

function createModelPortProvider(apiKey: string, baseUrl: string): OpenAICompatibleProvider {
  return new OpenAICompatibleProvider({
    providerName: 'openai',
    apiKey,
    baseUrl,
    headers: { 'X-Client-App': 'QuantPilot-Long-Term-Integration-Check/1' },
    maxRetries: 1,
    initialRetryDelayMs: 100,
    maxRetryDelayMs: 250,
  });
}

async function providerToolRoundTrip(params: {
  provider: OpenAICompatibleProvider;
  model: string;
  personalization?: PersonalizationCapsule | null;
}): Promise<ProviderRoundTrip> {
  const personalizationExpected = Boolean(params.personalization);
  const userContent = params.personalization
    ? buildQuantPilotUserPrompt({
        taskPacket: '# Task Packet\nRun the integration acceptance protocol.',
        skillContext: '# Skill Context\nNo task skill is required.',
        personalizationContext: params.personalization.content,
        initialDashboardContract: null,
        requireDashboardContract: false,
      })
    : 'Run the integration acceptance protocol without personal memory.';
  const messages: MoAgentMessage[] = [
    {
      role: 'system',
      content: [
        'You are a protocol acceptance worker.',
        'Call integration_acceptance exactly once.',
        `Set memoryApplied to ${personalizationExpected ? 'true' : 'false'}.`,
        'Set status to triad-ok.',
      ].join(' '),
    },
    {
      role: 'system',
      content: 'Preserve this second leading trusted-context protocol boundary.',
    },
    { role: 'user', content: userContent },
  ];
  const turn = await collectProviderTurn(params.provider.complete({
    model: params.model,
    messages,
    tools: [{
      name: 'integration_acceptance',
      description: 'Return the bounded three-module acceptance result.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['status', 'memoryApplied'],
        properties: {
          status: { type: 'string', enum: ['triad-ok'] },
          memoryApplied: { type: 'boolean' },
        },
      },
    }],
    toolChoice: { name: 'integration_acceptance' },
    maxTokens: 256,
    temperature: 0,
    reasoning: { enabled: false },
    metadata: { purpose: 'long_term_integration_acceptance' },
  }));
  assert(turn.responseModel === params.model, 'ModelPort returned an unexpected model ID.');
  assert(turn.finishReason === 'tool_calls', 'ModelPort model did not finish with a tool call.');
  assert(turn.toolCallId, 'ModelPort tool call ID is missing.');
  assert(turn.toolName === 'integration_acceptance', 'ModelPort model called an unexpected tool.');
  assert(turn.usage, 'ModelPort model did not return token usage.');
  const toolArguments = jsonRecord(JSON.parse(turn.toolArguments), 'ModelPort tool arguments');
  assert(toolArguments.status === 'triad-ok', 'ModelPort model returned an invalid acceptance status.');
  assert(
    toolArguments.memoryApplied === personalizationExpected,
    'ModelPort model did not preserve the bounded personalization flag.',
  );

  const continuation = await collectProviderTurn(params.provider.complete({
    model: params.model,
    messages: [
      ...messages,
      {
        role: 'assistant',
        content: null,
        toolCalls: [{
          id: turn.toolCallId,
          name: turn.toolName,
          arguments: turn.toolArguments,
        }],
      },
      {
        role: 'tool',
        toolCallId: turn.toolCallId,
        name: turn.toolName,
        content: JSON.stringify({ ok: true }),
      },
    ],
    toolChoice: 'none',
    maxTokens: 512,
    temperature: 0,
    reasoning: { enabled: false },
    metadata: { purpose: 'long_term_integration_continuation' },
  }));
  assert(continuation.finishReason === 'stop', 'ModelPort continuation did not finish normally.');
  assert(continuation.text.trim(), 'ModelPort continuation returned no text.');
  assert(continuation.usage, 'ModelPort continuation did not return token usage.');
  return {
    toolCallId: turn.toolCallId,
    toolName: turn.toolName,
    toolArguments: turn.toolArguments,
    usage: turn.usage,
    responseModel: turn.responseModel,
    continuationUsage: continuation.usage,
    continuationCharacters: continuation.text.trim().length,
  };
}

async function checkQwen() {
  const llm = getProjectLlmConfig();
  assert(llm.profileId === LOCAL_QWEN_MODEL_ID, 'QuantPilot default LLM profile is not local Qwen.');
  assert(llm.provider === 'openai', 'Local Qwen must use the OpenAI-compatible provider boundary.');
  const apiKey = process.env[llm.credentialEnv]?.trim();
  assert(apiKey, `${llm.credentialEnv} is not configured.`);

  const catalogResponse = await fetchWithTimeout(modelCatalogUrl(llm.baseUrl), {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  assert(catalogResponse.ok, `ModelPort model discovery returned HTTP ${catalogResponse.status}.`);
  const catalog = jsonRecord(await catalogResponse.json(), 'ModelPort model catalog');
  assert(Array.isArray(catalog.data), 'ModelPort model catalog has no data array.');
  const advertised = catalog.data.some((item) => (
    item !== null && typeof item === 'object' && !Array.isArray(item)
      && (item as Record<string, unknown>).id === llm.model
  ));
  assert(advertised, `ModelPort does not advertise the configured model ${llm.model}.`);

  const rejectedResponse = await fetchWithTimeout(modelCatalogUrl(llm.baseUrl), {
    headers: { Authorization: 'Bearer quantpilot-deliberately-invalid-integration-key' },
  });
  assert(rejectedResponse.status === 401, 'ModelPort did not reject an invalid API key.');

  const provider = createModelPortProvider(apiKey, llm.baseUrl);
  const roundTrip = await providerToolRoundTrip({ provider, model: llm.model });
  const queryController = new AbortController();
  const queryTimeout = setTimeout(() => {
    queryController.abort(new DOMException('Query rewrite acceptance timed out.', 'TimeoutError'));
  }, Math.max(15_000, llm.queryRewrite.timeoutMs + 1_000));
  queryTimeout.unref?.();
  let queryRewrite;
  try {
    queryRewrite = await rewriteQuantQuerySemanticsWithConfiguredProvider({
      originalQuery: '分析大位科技最近一个季度的财务与估值，并生成看板',
      normalizedQuery: '分析大位科技最近一个季度的财务与估值，并生成看板',
      trigger: 'primary',
      requestedModel: llm.model,
      signal: queryController.signal,
    });
  } finally {
    clearTimeout(queryTimeout);
  }
  assert(queryRewrite.ok, `Qwen Query Rewrite failed: ${queryRewrite.ok ? '' : queryRewrite.code}`);
  assert(queryRewrite.data.targetCandidates.includes('大位科技'), 'Qwen Query Rewrite missed 大位科技.');
  assert(!queryRewrite.data.targetCandidates.includes('大为科技'), 'Qwen Query Rewrite changed 大位科技 to 大为科技.');

  return {
    llm,
    apiKey,
    provider,
    summary: {
      provider: llm.provider,
      model: llm.model,
      discovery: 'qualified-model-visible',
      invalidCredentialBoundary: 'rejected',
      toolRoundTrip: 'passed',
      continuation: 'passed',
      usage: {
        firstTurnTokens: roundTrip.usage.totalTokens,
        continuationTokens: roundTrip.continuationUsage.totalTokens,
      },
      queryRewrite: {
        status: 'llm-applied',
        target: '大位科技',
        analysisFocusId: queryRewrite.data.analysisFocusId,
        outputIntent: queryRewrite.data.outputIntent,
      },
    },
  };
}

async function checkModelPortDeepSeek(apiKey: string) {
  const llm = getProjectLlmConfig(MODELPORT_DEEPSEEK_MODEL_ID);
  assert(llm.provider === 'openai', 'ModelPort DeepSeek must use the OpenAI-compatible boundary.');
  const catalogResponse = await fetchWithTimeout(modelCatalogUrl(llm.baseUrl), {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  assert(catalogResponse.ok, `ModelPort DeepSeek discovery returned HTTP ${catalogResponse.status}.`);
  const catalog = jsonRecord(await catalogResponse.json(), 'ModelPort model catalog');
  assert(Array.isArray(catalog.data), 'ModelPort model catalog has no data array.');
  assert(catalog.data.some((item) => (
    item !== null && typeof item === 'object' && !Array.isArray(item)
      && (item as Record<string, unknown>).id === llm.model
  )), `ModelPort does not advertise ${llm.model}.`);

  const provider = createModelPortProvider(apiKey, llm.baseUrl);
  const roundTrip = await providerToolRoundTrip({ provider, model: llm.model });
  return {
    provider: llm.provider,
    model: llm.model,
    clientProtocol: 'openai-chat-completions',
    upstreamProtocol: 'anthropic-messages',
    discovery: 'qualified-model-visible',
    toolRoundTrip: 'passed',
    continuation: 'passed',
    usage: {
      firstTurnTokens: roundTrip.usage.totalTokens,
      continuationTokens: roundTrip.continuationUsage.totalTokens,
    },
  };
}

async function checkMemoryReadOnly() {
  const config = getMemoryIntegrationConfig();
  assert(config.enabled, 'QuantPilot personal memory integration is disabled.');
  const adapter = new EvolvableMemoryHttpAdapter(config);
  const info = await adapter.discover('triad-readiness');
  const compatibilityIssues = memoryCompatibilityIssues(
    info,
    config,
    MEMORY_INTEGRATION_CAPABILITIES,
  );
  assert(compatibilityIssues.length === 0, `Memory compatibility failed: ${compatibilityIssues.join(', ')}`);
  await adapter.checkReady('triad-readiness');
  return { config, info };
}

async function checkMemoryClosedLoop(params: {
  projectId: string;
  otherProjectId: string | null;
  provider: OpenAICompatibleProvider;
  model: string;
}) {
  const actorUserId = option('subject') || 'quantpilot-long-term-integration-check-v1';
  const runId = randomUUID();
  const service = await import('../../src/lib/platform/memory/service');
  const { prisma } = await import('../../src/lib/db/client');
  try {
    const control = await service.setPersonalMemoryEnabled(actorUserId, true);
    const preferenceInput = {
      projectId: params.projectId,
      actorUserId,
      eventId: 'triad-pref-v1',
      key: 'output.answer_style',
      value: '联调验收：先给结论，再列风险和证据',
      evidenceText: 'QuantPilot 三方长期集成的隔离合成验收偏好',
      confidence: 0.99,
      scope: 'project' as const,
    };
    const firstWrite = await service.rememberPersonalPreference(preferenceInput);
    const replayedWrite = await service.rememberPersonalPreference(preferenceInput);
    assert(firstWrite.revisionId === replayedWrite.revisionId, 'Memory write replay changed revision.');
    assert(replayedWrite.idempotentReplay, 'Memory write replay was not idempotent.');

    const recallRequestId = `triad-recall-${runId}`;
    const recalled = await service.recallPersonalization({
      projectId: params.projectId,
      actorUserId,
      requestId: recallRequestId,
      instruction: '生成一份带有结论、证据和风险的验收摘要',
      capabilityId: 'stock_diagnosis',
    });
    assert(recalled.status === 'prepared' && recalled.capsule, 'Project-scoped memory was not recalled.');

    let projectIsolation: 'passed' | 'not-requested' = 'not-requested';
    if (params.otherProjectId) {
      const isolated = await service.recallPersonalization({
        projectId: params.otherProjectId,
        actorUserId,
        requestId: `triad-isolation-${runId}`,
        instruction: '生成一份带有结论、证据和风险的验收摘要',
        capabilityId: 'stock_diagnosis',
      });
      assert(isolated.status === 'empty', 'Project-scoped memory crossed the project boundary.');
      projectIsolation = 'passed';
    }

    const exposed = await service.exposePersonalization({
      projectId: params.projectId,
      actorUserId,
      requestId: recallRequestId,
      recall: recalled,
    });
    assert(exposed, 'Prepared memory attribution was not committed before provider exposure.');
    const combinedRoundTrip = await providerToolRoundTrip({
      provider: params.provider,
      model: params.model,
      personalization: exposed,
    });
    const outcomeInput = {
      projectId: params.projectId,
      actorUserId,
      requestId: recallRequestId,
      revisionId: exposed.revisionIds[0],
      eventId: `triad-outcome-${runId}`,
      kind: 'helpful' as const,
      weight: 1,
      note: '隔离合成三方联调验收通过',
    };
    const firstOutcome = await service.recordPersonalMemoryFeedback(outcomeInput);
    const replayedOutcome = await service.recordPersonalMemoryFeedback(outcomeInput);
    assert(firstOutcome.outcomeId === replayedOutcome.outcomeId, 'Memory outcome replay changed ID.');
    assert(replayedOutcome.idempotentReplay, 'Memory outcome replay was not idempotent.');

    return {
      mode: 'synthetic-write',
      subject: 'isolated-synthetic-subject',
      controlEnabled: control.personalizationEnabled,
      preferenceWriteIdempotency: 'passed',
      recall: 'applied',
      exposedMemoryCount: recalled.exposedMemoryCount,
      projectIsolation,
      quantPromptToQwen: 'passed',
      qwenContinuation: combinedRoundTrip.continuationCharacters > 0 ? 'passed' : 'failed',
      outcomeIdempotency: 'passed',
    };
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

async function main() {
  const qwen = await checkQwen();
  const deepseek = await checkModelPortDeepSeek(qwen.apiKey);
  const memory = await checkMemoryReadOnly();
  const projectId = option('project');
  const otherProjectId = option('other-project');
  if (writeMode) assert(projectId, '--write requires --project=<existing-project-id>.');
  const closedLoop = writeMode
    ? await checkMemoryClosedLoop({
        projectId: projectId!,
        otherProjectId,
        provider: qwen.provider,
        model: qwen.llm.model,
      })
    : { mode: 'read-only', syntheticWrites: 'not-requested' };

  console.log(JSON.stringify({
    status: 'ok',
    checkedAt: new Date().toISOString(),
    quantpilot: {
      defaultModel: qwen.llm.model,
      providerBoundary: 'openai-compatible',
      memoryBoundary: 'personal-memory-port',
    },
    modelport: {
      qwen: qwen.summary,
      deepseek,
    },
    memory: {
      contract: memory.info.apiContract,
      readiness: 'ready',
      productionReady: memory.info.productionReady,
      productionBlockers: memory.info.productionBlockers,
      closedLoop,
    },
    decoupling: {
      sharedSourceImports: false,
      sharedDatabase: false,
      providerContract: 'OpenAI-compatible HTTP',
      memoryContract: memory.info.apiContract,
    },
  }, null, 2));
}

main().catch((error) => {
  const providerError = error !== null && typeof error === 'object'
    ? error as { status?: unknown; responseBody?: unknown; requestId?: unknown }
    : null;
  console.error(JSON.stringify({
    status: 'failed',
    error: error instanceof Error ? error.message : String(error),
    ...(typeof providerError?.status === 'number' ? { httpStatus: providerError.status } : {}),
    ...(typeof providerError?.requestId === 'string' ? { requestId: providerError.requestId } : {}),
    ...(typeof providerError?.responseBody === 'string'
      ? { providerResponse: providerError.responseBody }
      : {}),
  }, null, 2));
  process.exitCode = 1;
});
