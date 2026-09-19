import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  queryRewrite: null as unknown,
  cancelled: vi.fn(), completed: vi.fn(), failed: vi.fn(),
  start: vi.fn(), update: vi.fn(), progress: vi.fn(),
  reserve: vi.fn(), settle: vi.fn(), release: vi.fn(), usage: vi.fn(),
  prefetch: vi.fn(), knowledge: vi.fn(), mission: vi.fn(),
  toolStart: vi.fn(), toolResult: vi.fn(), publish: vi.fn(), message: vi.fn(),
}));

vi.mock('@/lib/domains/finance/workspace', async original => {
  const actual = await original<typeof import('@/lib/domains/finance/workspace')>();
  return { ...actual, writeInitialRunPlan: (input: Parameters<typeof actual.writeInitialRunPlan>[0]) =>
    actual.writeInitialRunPlan({ ...input, queryRewrite: mocks.queryRewrite as NonNullable<typeof input.queryRewrite> }) };
});
vi.mock('@/lib/services/user-requests', () => ({
  isUserRequestCancelled: mocks.cancelled,
  markUserRequestAsCompleted: mocks.completed,
  markUserRequestAsFailed: mocks.failed,
}));
vi.mock('./generation-state', () => ({ startQuantGenerationRun: mocks.start, updateQuantGenerationStep: mocks.update }));
vi.mock('@/lib/quota', () => ({
  reserveQuota: mocks.reserve, settleQuotaReservation: mocks.settle,
  releaseQuotaReservation: mocks.release, recordQuotaUsage: mocks.usage,
}));
vi.mock('./data-prefetch', () => ({ prefetchQuantDataForRunPlan: mocks.prefetch }));
vi.mock('@/lib/platform/knowledge', () => ({ prepareGovernedKnowledge: mocks.knowledge }));
vi.mock('@/lib/services/pi-agent-mission-control', () => ({ createQuantPiAgentMission: mocks.mission }));
vi.mock('@/lib/services/pi-agent-turn-metrics', () => ({ collectPiAgentTurnMetrics: vi.fn(async () => null) }));
vi.mock('@/lib/services/stream', () => ({ streamManager: { publish: mocks.publish } }));
vi.mock('@/lib/services/message', () => ({ createMessage: mocks.message }));
vi.mock('@/lib/serializers/chat', () => ({ serializeMessage: (message: unknown) => message }));
vi.mock('./chat-act-support', async original => ({
  ...await original<object>(),
  publishQuantPipelineToolStart: mocks.toolStart,
  publishQuantPipelineToolMessage: mocks.toolResult,
}));

import { rewriteQuantQuery } from '@/lib/domains/finance/query-rewrite';
import { prepareFinanceActGenerationUnderLease } from './finance-act-preparation';

let projectPath: string;
beforeEach(async () => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'qp-planning-failure-'));
  mocks.cancelled.mockResolvedValue(false);
  mocks.start.mockResolvedValue({ status: 'running' });
  mocks.update.mockResolvedValue(undefined);
  mocks.progress.mockResolvedValue(undefined);
  mocks.reserve.mockResolvedValue({ reservation: { id: 'quota-1' } });
  mocks.settle.mockResolvedValue({});
  mocks.release.mockResolvedValue({});
  mocks.usage.mockResolvedValue({});
  mocks.toolStart.mockImplementation(async ({ toolName }) => `tool-${toolName}`);
  mocks.toolResult.mockResolvedValue(undefined);
  mocks.message.mockResolvedValue({ id: 'clarification-1' });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(projectPath, { recursive: true, force: true });
});

function prepare() {
  return prepareFinanceActGenerationUnderLease({
    projectId: 'project-1', projectPath, requestId: 'request-1',
    finalInstruction: '分析贵州茅台', effectiveInstruction: '分析贵州茅台', effectiveDisplayInstruction: '分析贵州茅台',
    isInitialPrompt: false, cliPreference: 'pi', selectedModel: 'fixture-model', conversationId: null,
    processedImageCount: 0, previousRunPlan: null, quotaActorUserId: 'member-1', userMessageId: 'message-1',
    relatedAgentRequestIds: new Set(), publishWorkspaceProgress: mocks.progress,
  });
}

describe('finance planning failure boundary', () => {
  it.each([
    ['LLM_NOT_CONFIGURED', 0, false],
    ['LLM_NETWORK_ERROR', 1, true],
    ['LLM_INVALID_OUTPUT', 1, true],
  ] as const)('fails %s before data, knowledge or Mission execution', async (code, quantity, retryable) => {
    mocks.queryRewrite = await rewriteQuantQuery('分析贵州茅台', {
      semanticRewriter: async () => ({ ok: false, code, retryable }),
    });
    const result = await prepare();
    expect(result.response).toMatchObject({ status: 503, body: {
      success: false, error: 'QUERY_REWRITE_LLM_UNAVAILABLE', retryable,
    } });
    expect(mocks.settle).toHaveBeenCalledWith(expect.objectContaining({ actualQuantity: quantity }));
    expect(mocks.release).not.toHaveBeenCalled();
    expect(mocks.completed).not.toHaveBeenCalled();
    expect(mocks.failed).toHaveBeenCalledWith('project-1', 'request-1', expect.any(String));
    expect(mocks.prefetch).not.toHaveBeenCalled();
    expect(mocks.knowledge).not.toHaveBeenCalled();
    expect(mocks.mission).not.toHaveBeenCalled();
    expect(mocks.message).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenLastCalledWith(expect.objectContaining({
      stepId: 'planning', status: 'failed', runStatus: 'failed',
      metadata: { errorCode: 'QUERY_REWRITE_LLM_UNAVAILABLE', retryable },
    }));
    for (const toolName of ['query-rewrite', 'run-planner']) {
      expect(mocks.toolResult).toHaveBeenCalledWith(expect.objectContaining({ toolName, success: false, resultStatus: 'failed' }));
    }
    expect(mocks.progress).toHaveBeenLastCalledWith({ stage: 5, failureReason: expect.any(String) });
    expect(mocks.publish).toHaveBeenLastCalledWith('project-1', expect.objectContaining({
      type: 'status', data: expect.objectContaining({ status: 'quant_data_preparation_failed' }),
    }));
    expect(JSON.parse(await fs.readFile(path.join(projectPath, '.data-agent/task.json'), 'utf8')).status).toBe('failed');
  });

  it('still requests clarification for an unresolved target after a successful model call', async () => {
    mocks.queryRewrite = await rewriteQuantQuery('分析贵州茅台', {
      semanticRewriter: async () => ({ ok: true, provider: 'fixture', model: 'fixture-model', data: {
        targetCandidates: ['贵州茅台'], timeRange: null, analysisFocusId: 'comprehensive',
        outputIntent: 'dashboard', answerOnlyEvidence: null, broadUniverse: false,
        broadUniverseEvidence: null, confidence: 1,
      } }),
      resolver: async () => ({ results: [] }),
    });
    const result = await prepare();
    expect(result.response).toMatchObject({ status: 200, body: { status: 'intent_clarification_required' } });
    expect(mocks.failed).not.toHaveBeenCalled();
    expect(mocks.completed).toHaveBeenCalledWith('project-1', 'request-1');
    expect(mocks.settle).toHaveBeenCalledWith(expect.objectContaining({ actualQuantity: 1 }));
    expect(mocks.message).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ type: 'intent_clarification' }) }));
    expect(mocks.prefetch).not.toHaveBeenCalled();
    expect(mocks.knowledge).not.toHaveBeenCalled();
    expect(mocks.mission).not.toHaveBeenCalled();
  });
});
