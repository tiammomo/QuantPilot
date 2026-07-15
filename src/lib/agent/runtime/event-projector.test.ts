import { describe, expect, it } from 'vitest';

import { createMoAgentOperationId } from '../core/operation-id';
import type { MoAgentEvent, MoAgentToolCall } from '../types';
import { auditUtf8, projectMoAgentEvent, sha256 } from './event-projector';

const SECRET = 'secret-DO-NOT-PERSIST-7c440d';

const base = {
  runId: 'run_projector',
  sequence: 1,
  eventId: 'run_projector:1',
  timestamp: 1_720_000_000_000,
};

function serialized(event: MoAgentEvent): string {
  return JSON.stringify(projectMoAgentEvent(event));
}

function toolCall(argumentsValue = JSON.stringify({ path: `/private/${SECRET}.tsx` })):
  MoAgentToolCall {
  return { id: 'call-1', name: 'write_file', arguments: argumentsValue };
}

function toolEventBase(call = toolCall()) {
  return {
    ...base,
    turn: 2,
    toolCall: call,
    operationId: createMoAgentOperationId(base.runId, 2, call),
    effect: 'workspace_write' as const,
    idempotency: 'reconcile_required' as const,
  };
}

describe('MoAgent durable event projector', () => {
  it('provides exact UTF-8 byte and SHA-256 audit helpers', () => {
    expect(auditUtf8('量化 A')).toEqual({
      utf8Bytes: 8,
      sha256: sha256('量化 A'),
    });
    expect(sha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('drops high-volume model deltas instead of making them durable', () => {
    expect(
      projectMoAgentEvent({ ...base, type: 'text_delta', turn: 1, delta: SECRET })
    ).toBeNull();
    expect(
      projectMoAgentEvent({
        ...base,
        type: 'tool_call_delta',
        turn: 1,
        index: 0,
        argumentsDelta: SECRET,
      })
    ).toBeNull();
  });

  it('stores assistant text and tool identities only as audits', () => {
    const event = {
      ...base,
      type: 'assistant_message',
      turn: 1,
      finishReason: 'tool_calls',
      message: {
        role: 'assistant',
        content: `Visible but non-durable ${SECRET}`,
        reasoningContent: `hidden reasoning ${SECRET}`,
        toolCalls: [
          {
            id: 'call-1',
            name: 'write_file',
            arguments: JSON.stringify({ token: SECRET }),
          },
        ],
      },
    } as unknown as MoAgentEvent;

    const projection = projectMoAgentEvent(event);
    expect(projection).toMatchObject({
      finishReason: 'tool_calls',
      toolCallCount: 1,
      textAudit: auditUtf8(`Visible but non-durable ${SECRET}`),
    });
    expect(serialized(event)).not.toContain(SECRET);
    expect(serialized(event)).not.toContain('reasoningContent');
    expect(serialized(event)).not.toContain('arguments');
  });

  it('projects tool input, target, result data and content as non-reversible audits', () => {
    const started: MoAgentEvent = {
      ...toolEventBase(),
      type: 'tool_started',
    };
    const completed = {
      ...toolEventBase(),
      type: 'tool_completed',
      terminal: false,
      durationMs: 9,
      result: {
        ok: true,
        data: { nested: { value: SECRET }, rows: [SECRET] },
        content: `raw content ${SECRET}`,
        metadata: { privateValue: SECRET },
        reasoning: SECRET,
      },
    } as unknown as MoAgentEvent;

    const startedProjection = projectMoAgentEvent(started);
    expect(startedProjection).toMatchObject({
      operationId: toolEventBase().operationId,
      toolName: 'write_file',
      inputAudit: auditUtf8(toolCall().arguments),
      target: {
        field: 'path',
        valueAudit: auditUtf8(`/private/${SECRET}.tsx`),
      },
    });
    expect(serialized(started)).not.toContain(SECRET);
    expect(serialized(completed)).not.toContain(SECRET);
    expect(serialized(completed)).not.toContain('raw content');
    expect(projectMoAgentEvent(completed)).toMatchObject({
      resultAudit: {
        ok: true,
        dataAudit: { kind: 'object' },
        textAudit: auditUtf8(`raw content ${SECRET}`),
      },
    });
  });

  it('drops failure details, causes, messages and unrestricted content', () => {
    const failed = {
      ...toolEventBase(),
      type: 'tool_failed',
      durationMs: 11,
      result: {
        ok: false,
        error: {
          code: 'WRITE_FAILED',
          message: `provider message ${SECRET}`,
          details: { diagnostic: SECRET },
          cause: new Error(SECRET),
        },
        content: `failure content ${SECRET}`,
        metadata: { privateValue: SECRET },
      },
      cause: new Error(SECRET),
    } as unknown as MoAgentEvent;
    const finished = {
      ...base,
      type: 'run_finished',
      result: {
        status: 'failed',
        turns: 2,
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
        startedAt: 100,
        finishedAt: 200,
        error: {
          code: 'RUN_FAILED',
          message: `do not retain ${SECRET}`,
          cause: new Error(SECRET),
        },
      },
    } as unknown as MoAgentEvent;

    const failedProjection = projectMoAgentEvent(failed);
    expect(failedProjection).toMatchObject({
      errorCode: 'WRITE_FAILED',
      resultAudit: { ok: false, errorCode: 'WRITE_FAILED' },
    });
    expect(projectMoAgentEvent(finished)).toMatchObject({ errorCode: 'RUN_FAILED' });

    for (const event of [failed, finished]) {
      const output = serialized(event);
      expect(output).not.toContain(SECRET);
      expect(output).not.toContain('cause');
      expect(output).not.toContain('provider message');
      expect(output).not.toContain('do not retain');
    }
  });

  it('uses the framework operation ID and derives a valid fallback for malformed input', () => {
    const call = toolCall('{}');
    const expected = createMoAgentOperationId(base.runId, 2, call);
    const valid: MoAgentEvent = {
      ...toolEventBase(call),
      type: 'tool_started',
    };
    const malformed = {
      ...valid,
      operationId: `model-controlled-${SECRET}`,
    } as MoAgentEvent;

    expect(projectMoAgentEvent(valid)).toMatchObject({ operationId: expected });
    expect(projectMoAgentEvent(malformed)).toMatchObject({ operationId: expected });
    expect(serialized(malformed)).not.toContain(SECRET);
  });

  it('projects every low-volume lifecycle event through the public JSON policy', () => {
    const events: MoAgentEvent[] = [
      {
        ...base,
        type: 'run_started',
        model: 'test-model',
        provider: 'test-provider',
        limits: { maxTurns: 3, maxTokens: 100, timeoutMs: 1_000 },
      },
      { ...base, type: 'turn_started', turn: 1 },
      {
        ...base,
        type: 'provider_retry',
        turn: 1,
        attempt: 2,
        maxAttempts: 3,
        delayMs: 50,
        code: 'NETWORK_ERROR',
        status: 503,
      },
      {
        ...base,
        type: 'model_started',
        turn: 1,
        responseId: `provider-id-${SECRET}`,
        model: 'test-model',
      },
      {
        ...base,
        type: 'usage',
        turn: 1,
        usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
        totalUsage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
      },
      {
        ...base,
        type: 'context_compacted',
        turn: 2,
        originalInputTokens: 200,
        preparedInputTokens: 100,
        inputBudgetTokens: 120,
        removedReasoningMessages: 1,
        summarizedToolResults: 2,
        droppedGroups: 3,
      },
      {
        ...base,
        type: 'prompt_prepared',
        turn: 2,
        systemSha256: 'a'.repeat(64),
        messagesSha256: 'b'.repeat(64),
        toolsSha256: 'c'.repeat(64),
        messageCount: 7,
        toolCount: 3,
        requestUtf8Bytes: 4096,
        longestCommonPrefixMessages: 5,
        longestCommonPrefixUtf8Bytes: 2048,
        change: 'request_local_suffix_rotated',
        toolSetChanged: true,
        compactionApplied: false,
        requestLocalControlSuffix: false,
      },
      {
        ...base,
        type: 'convergence_prompt',
        turn: 2,
        reasons: ['post_write_read_loop', 'turn_limit'],
        remainingTurns: 4,
        remainingToolCalls: 12,
        successfulWorkspaceWrites: 2,
        consecutiveReadOnlyTurns: 3,
      },
      { ...toolEventBase(toolCall('{}')), type: 'tool_started' },
      {
        ...base,
        type: 'run_finished',
        result: {
          status: 'completed',
          turns: 2,
          usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 },
          startedAt: 100,
          finishedAt: 200,
        },
      },
    ];

    for (const event of events) {
      const projection = projectMoAgentEvent(event);
      expect(projection).not.toBeNull();
      expect(JSON.stringify(projection)).not.toContain(SECRET);
    }
  });
});
