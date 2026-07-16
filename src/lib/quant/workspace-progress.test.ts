import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  ensureMessage: vi.fn(),
  publish: vi.fn(),
  collectMetrics: vi.fn(),
}));

vi.mock('@/lib/services/message', () => ({
  ensureMessage: mocks.ensureMessage,
}));

vi.mock('@/lib/services/stream', () => ({
  streamManager: { publish: mocks.publish },
}));

vi.mock('@/lib/services/moagent-turn-metrics', () => ({
  collectMoAgentTurnMetrics: mocks.collectMetrics,
}));

vi.mock('@/lib/serializers/chat', () => ({
  serializeMessage: vi.fn((message) => message),
}));

import {
  createWorkspaceProgressPublisher,
  workspaceProgressMessageId,
} from './workspace-progress';

describe('workspace progress publisher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.collectMetrics.mockResolvedValue({
      schemaVersion: 1,
      elapsedMs: 12_000,
      agentRunCount: 1,
      modelTurnCount: 2,
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cachedInputTokens: 60,
      cacheMissInputTokens: 40,
      reasoningTokens: 5,
      tokenAccounting: 'provider',
    });
    mocks.ensureMessage.mockImplementation(async (input) => ({
      ...input,
      id: `progress-${input.metadata.progressStep}`,
    }));
  });

  it('persists each stage once and keeps intermediate progress non-terminal', async () => {
    const publish = createWorkspaceProgressPublisher({
      projectId: 'project-a',
      requestId: 'request-a',
      conversationId: 'conversation-a',
      cliSource: 'moagent',
    });

    await publish({ stage: 1 });
    await publish({ stage: 1 });
    await publish({
      stage: 5,
      validationCheckCount: 12,
      previewUrl: 'http://127.0.0.1:3000',
    });

    expect(mocks.ensureMessage).toHaveBeenCalledTimes(2);
    expect(mocks.ensureMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({
      id: workspaceProgressMessageId('project-a', 'request-a', 1),
      role: 'assistant',
      messageType: 'chat',
      requestId: 'request-a',
      metadata: expect.objectContaining({
        isWorkspaceProgress: true,
        isMissionIntermediate: true,
        progressStep: 1,
        progressTotal: 5,
      }),
    }));
    expect(mocks.ensureMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
      id: workspaceProgressMessageId('project-a', 'request-a', 5),
      metadata: expect.objectContaining({
        isWorkspaceProgress: true,
        isMoAgentFinal: true,
        isMissionFinal: true,
        validationPassed: true,
        progressStep: 5,
        turnMetrics: expect.objectContaining({ totalTokens: 120 }),
      }),
    }));
    expect(mocks.publish).toHaveBeenCalledTimes(2);
    expect(mocks.collectMetrics).toHaveBeenCalledTimes(1);
  });

  it('does not mark a paused terminal projection as a successful final answer', async () => {
    const publish = createWorkspaceProgressPublisher({
      projectId: 'project-a',
      requestId: 'request-paused',
      cliSource: 'moagent',
    });

    await publish({ stage: 5, cancelledReason: '用户暂停了当前任务' });

    expect(mocks.ensureMessage).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        isWorkspaceProgress: true,
        isMissionFinal: true,
        progressStatus: 'cancelled',
        turnMetrics: expect.objectContaining({ totalTokens: 120 }),
      }),
    }));
    const metadata = mocks.ensureMessage.mock.calls[0]?.[0]?.metadata;
    expect(metadata).not.toHaveProperty('isMoAgentFinal');
    expect(metadata).not.toHaveProperty('validationPassed');
  });

  it('does not query metrics for intermediate stages', async () => {
    const publish = createWorkspaceProgressPublisher({
      projectId: 'project-a',
      requestId: 'request-running',
    });

    await publish({ stage: 2 });

    expect(mocks.collectMetrics).not.toHaveBeenCalled();
    expect(mocks.ensureMessage.mock.calls[0]?.[0]?.metadata).not.toHaveProperty(
      'turnMetrics',
    );
  });

  it('keeps the terminal Mission projection when metrics collection fails', async () => {
    mocks.collectMetrics.mockRejectedValueOnce(new Error('metrics unavailable'));
    const publish = createWorkspaceProgressPublisher({
      projectId: 'project-a',
      requestId: 'request-failed',
    });

    await publish({ stage: 5, failureReason: 'validation failed' });

    expect(mocks.ensureMessage).toHaveBeenCalledTimes(1);
    expect(mocks.ensureMessage.mock.calls[0]?.[0]?.metadata).toEqual(
      expect.objectContaining({
        isMissionFinal: true,
        progressStatus: 'failed',
      }),
    );
    expect(mocks.ensureMessage.mock.calls[0]?.[0]?.metadata).not.toHaveProperty(
      'turnMetrics',
    );
    expect(mocks.publish).toHaveBeenCalledTimes(1);
  });
});
