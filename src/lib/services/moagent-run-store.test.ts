import { describe, expect, it, vi } from 'vitest';

import { createMoAgentOperationId } from '@/lib/agent/core/operation-id';
import {
  InMemoryAgentRuntimeRepository,
  type AppendAgentEventInput,
  type CompleteAgentToolExecutionInput,
  type HeartbeatAgentRunInput,
  type PrepareAgentToolExecutionInput,
  type SaveAgentCheckpointInput,
} from '@/lib/agent/runtime';
import type { MoAgentEvent, MoAgentToolCall } from '@/lib/agent/types';
import {
  createMoAgentDurableRunSession,
  MoAgentToolReplayBlockedError,
  type MoAgentRunStoreScheduler,
} from './moagent-run-store';

const START = new Date('2026-07-15T02:00:00.000Z');
const SECRET = 'durable-secret-must-not-survive';
const BEFORE_HASH = 'a'.repeat(64);
const AFTER_HASH = 'b'.repeat(64);

class RecordingRepository extends InMemoryAgentRuntimeRepository {
  readonly calls: string[] = [];

  override async appendEvent(input: AppendAgentEventInput) {
    this.calls.push(`event:${input.eventType}`);
    return super.appendEvent(input);
  }

  override async saveCheckpoint(input: SaveAgentCheckpointInput) {
    this.calls.push(`checkpoint:${input.boundary}`);
    return super.saveCheckpoint(input);
  }

  override async prepareToolExecution(input: PrepareAgentToolExecutionInput) {
    this.calls.push(`prepare:${input.operationId}`);
    return super.prepareToolExecution(input);
  }

  override async completeToolExecution(input: CompleteAgentToolExecutionInput) {
    this.calls.push(`complete:${input.operationId}:${input.status}`);
    return super.completeToolExecution(input);
  }
}

class ManualScheduler implements MoAgentRunStoreScheduler {
  callback: (() => void) | null = null;
  readonly clear = vi.fn();

  setInterval(callback: () => void): unknown {
    this.callback = callback;
    return 'heartbeat-handle';
  }

  clearInterval(handle: unknown): void {
    this.clear(handle);
    this.callback = null;
  }

  fire(): void {
    this.callback?.();
  }
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class SerializedRepository extends InMemoryAgentRuntimeRepository {
  readonly appendEntered = deferred();
  readonly releaseAppend = deferred();
  readonly callOrder: string[] = [];
  activeWrites = 0;
  maxActiveWrites = 0;

  private enter(label: string): void {
    this.callOrder.push(`${label}:start`);
    this.activeWrites += 1;
    this.maxActiveWrites = Math.max(this.maxActiveWrites, this.activeWrites);
  }

  private leave(label: string): void {
    this.activeWrites -= 1;
    this.callOrder.push(`${label}:end`);
  }

  override async appendEvent(input: AppendAgentEventInput) {
    this.enter('append');
    this.appendEntered.resolve();
    await this.releaseAppend.promise;
    try {
      return await super.appendEvent(input);
    } finally {
      this.leave('append');
    }
  }

  override async heartbeat(input: HeartbeatAgentRunInput) {
    this.enter('heartbeat');
    try {
      return await super.heartbeat(input);
    } finally {
      this.leave('heartbeat');
    }
  }
}

function runOptions(repository: InMemoryAgentRuntimeRepository) {
  return {
    repository,
    run: {
      runId: 'moagent_durable-test',
      projectId: 'project_durable-test',
      workspaceKey: 'sha256:project-durable-workspace',
      requestId: 'request_durable-test',
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      frameworkVersion: 'moagent:1.0.0',
      buildRevision: 'test:durable-store',
      profileHash: 'sha256:profile',
      promptHash: 'sha256:prompt',
      toolHash: 'sha256:tools',
      skillHash: 'sha256:skills',
      workspaceHash: 'sha256:workspace',
    },
    leaseOwner: 'worker:durable-test',
    clock: () => new Date(START),
  } as const;
}

function eventBase(sequence: number) {
  return {
    runId: 'moagent_durable-test',
    sequence,
    eventId: `moagent_durable-test:${sequence}`,
    timestamp: START.getTime(),
  };
}

function runStarted(sequence = 1): MoAgentEvent {
  return {
    ...eventBase(sequence),
    type: 'run_started',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    limits: { maxTurns: 20, maxTokens: 12_000, timeoutMs: 60_000 },
  };
}

function call(argumentsJson = JSON.stringify({ path: `private/${SECRET}.ts` })):
  MoAgentToolCall {
  return { id: 'call-write-1', name: 'write_file', arguments: argumentsJson };
}

function toolBase(sequence: number, toolCall = call()) {
  return {
    ...eventBase(sequence),
    turn: 1,
    toolCall,
    operationId: createMoAgentOperationId('moagent_durable-test', 1, toolCall),
    effect: 'workspace_write' as const,
    idempotency: 'reconcile_required' as const,
  };
}

describe('MoAgentDurableRunSession', () => {
  it('records deterministic pre-commit workspace rejections as failed, not uncertain', async () => {
    const repository = new RecordingRepository({ now: () => new Date(START) });
    const session = await createMoAgentDurableRunSession({
      ...runOptions(repository),
      heartbeatEnabled: false,
    });
    const toolCall = call(JSON.stringify({
      path: 'app/page.tsx',
      oldText: 'missing',
      newText: 'replacement',
    }));
    const operationId = toolBase(2, toolCall).operationId;

    await session.record(runStarted());
    await session.record({ ...toolBase(2, toolCall), type: 'tool_started' });
    await session.record({
      ...toolBase(3, toolCall),
      type: 'tool_failed',
      durationMs: 1,
      result: {
        ok: false,
        error: { code: 'EDIT_MATCH_NOT_FOUND', message: 'oldText was not found' },
      },
    });

    expect(await repository.getToolExecution(operationId)).toMatchObject({
      status: 'failed',
      errorCode: 'EDIT_MATCH_NOT_FOUND',
    });
    await session.close();
  });

  it('prepares/completes the ledger before events, skips deltas, and persists only safe checkpoints', async () => {
    const repository = new RecordingRepository({ now: () => new Date(START) });
    const session = await createMoAgentDurableRunSession({
      ...runOptions(repository),
      heartbeatEnabled: false,
    });
    const toolCall = call();
    const operationId = toolBase(5, toolCall).operationId;
    const invalidCall = {
      ...call('{invalid-json'),
      id: 'call-write-invalid',
    };
    const invalidOperationId = toolBase(3, invalidCall).operationId;

    await session.record(runStarted());
    await session.record({
      ...eventBase(2),
      type: 'text_delta',
      turn: 1,
      delta: SECRET,
    });
    await session.record({ ...toolBase(3, invalidCall), type: 'tool_started' });
    const invalidFailure: MoAgentEvent = {
      ...toolBase(4, invalidCall),
      type: 'tool_failed',
      durationMs: 1,
      result: {
        ok: false,
        error: { code: 'INVALID_TOOL_ARGUMENTS', message: SECRET },
      },
    };
    await session.record(invalidFailure);
    await expect(session.record(invalidFailure)).resolves.toBeUndefined();
    await session.record({ ...toolBase(5, toolCall), type: 'tool_started' });
    await session.record({
      ...toolBase(6, toolCall),
      type: 'tool_failed',
      durationMs: 4,
      result: {
        ok: false,
        error: { code: 'WRITE_FAILED', message: `raw ${SECRET}` },
        content: SECRET,
      },
    });

    const execution = await repository.getToolExecution(operationId);
    expect(execution).toMatchObject({ status: 'uncertain', errorCode: 'WRITE_FAILED' });
    expect(await repository.getToolExecution(invalidOperationId)).toMatchObject({
      status: 'failed',
      errorCode: 'INVALID_TOOL_ARGUMENTS',
    });
    expect(repository.calls.indexOf(`prepare:${operationId}`)).toBeLessThan(
      repository.calls.lastIndexOf('event:tool_started')
    );
    expect(repository.calls.indexOf(`complete:${operationId}:uncertain`)).toBeLessThan(
      repository.calls.lastIndexOf('event:tool_failed')
    );

    const events = await repository.listEventsAfter(session.run.id, 0);
    expect(events.map((event) => event.sequence)).toEqual([1, 3, 4, 5, 6]);
    const checkpoint = await repository.getLatestCheckpoint(session.run.id);
    expect(checkpoint?.publicState).toEqual({
      recoveryMode: 'replan_required',
      stage: 'tools_completed',
      turn: 1,
      sourceSequence: 6,
      completedOperationIds: [invalidOperationId, operationId],
    });
    expect(JSON.stringify({ events, checkpoint, execution })).not.toContain(SECRET);
    expect(JSON.stringify(checkpoint)).not.toContain('messages');
    expect(JSON.stringify(checkpoint)).not.toContain('prompt');
    expect(JSON.stringify(checkpoint)).not.toContain('reasoning');
    await session.close();
  });

  it('backfills safe file hashes and maps the final engine status after appending run_finished', async () => {
    const repository = new RecordingRepository({ now: () => new Date(START) });
    const session = await createMoAgentDurableRunSession({
      ...runOptions(repository),
      heartbeatEnabled: false,
    });
    const toolCall = call('{}');
    const operationId = toolBase(2, toolCall).operationId;

    await session.record(runStarted());
    await session.record({ ...toolBase(2, toolCall), type: 'tool_started' });
    await session.commitWorkspaceMutation(operationId, async () => undefined);
    await session.record({
      ...toolBase(3, toolCall),
      type: 'tool_completed',
      terminal: false,
      durationMs: 5,
      result: {
        ok: true,
        data: {
          beforeSha256: BEFORE_HASH,
          afterSha256: AFTER_HASH,
          privateValue: SECRET,
        },
      },
    });
    await session.record({
      ...eventBase(4),
      type: 'run_finished',
      result: {
        status: 'stopped',
        turns: 1,
        usage: { inputTokens: 12, outputTokens: 8, totalTokens: 20 },
        startedAt: START.getTime(),
        finishedAt: START.getTime() + 10,
        error: { code: 'TERMINAL_TOOL_REQUIRED', message: SECRET },
      },
    });

    expect(await repository.getToolExecution(operationId)).toMatchObject({
      status: 'succeeded',
      preStateHash: `sha256:${BEFORE_HASH}`,
      postStateHash: `sha256:${AFTER_HASH}`,
    });
    const run = await repository.getRun(session.run.id);
    expect(run).toMatchObject({
      status: 'failed',
      turnCount: 1,
      totalTokens: 20,
      leaseOwner: null,
      errorCode: 'TERMINAL_TOOL_REQUIRED',
    });
    expect(JSON.stringify(run)).not.toContain(SECRET);
    expect(repository.calls.at(-1)).toBe('event:run_finished');
    await session.close();
  });

  it('persists cumulative token usage before the run reaches a terminal event', async () => {
    const repository = new RecordingRepository({ now: () => new Date(START) });
    const session = await createMoAgentDurableRunSession({
      ...runOptions(repository),
      heartbeatEnabled: false,
    });

    await session.record(runStarted());
    await session.record({
      ...eventBase(2),
      type: 'usage',
      turn: 1,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cachedInputTokens: 30,
        cacheMissInputTokens: 70,
        reasoningTokens: 5,
      },
      totalUsage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cachedInputTokens: 30,
        cacheMissInputTokens: 70,
        reasoningTokens: 5,
      },
    });
    expect(await repository.getRun(session.run.id)).toMatchObject({
      status: 'running',
      inputTokens: 100,
      outputTokens: 20,
      totalTokens: 120,
      cachedInputTokens: 30,
      cacheMissInputTokens: 70,
      reasoningTokens: 5,
    });

    await session.record({
      ...eventBase(3),
      type: 'usage',
      turn: 2,
      usage: {
        inputTokens: 40,
        outputTokens: 15,
        totalTokens: 55,
        cachedInputTokens: 10,
        cacheMissInputTokens: 30,
        reasoningTokens: 3,
      },
      totalUsage: {
        inputTokens: 140,
        outputTokens: 35,
        totalTokens: 175,
        cachedInputTokens: 40,
        cacheMissInputTokens: 100,
        reasoningTokens: 8,
      },
    });
    await session.interrupt({ code: 'PROCESS_SHUTDOWN' });

    expect(await repository.getRun(session.run.id)).toMatchObject({
      status: 'interrupted',
      turnCount: 2,
      inputTokens: 140,
      outputTokens: 35,
      totalTokens: 175,
      cachedInputTokens: 40,
      cacheMissInputTokens: 100,
      reasoningTokens: 8,
    });
    await session.close();
  });

  it('treats an existing operation ledger entry as a hard execution gate', async () => {
    const repository = new RecordingRepository({ now: () => new Date(START) });
    const session = await createMoAgentDurableRunSession({
      ...runOptions(repository),
      heartbeatEnabled: false,
    });
    const started = { ...toolBase(1), type: 'tool_started' } as const;
    await session.record(started);

    await expect(session.record(started)).rejects.toBeInstanceOf(MoAgentToolReplayBlockedError);
    expect(session.failure).toBeInstanceOf(MoAgentToolReplayBlockedError);
    expect((await repository.getToolExecution(started.operationId))?.status).toBe('prepared');
    expect((await repository.listEventsAfter(session.run.id, 0))).toHaveLength(1);
    await session.close();
  });

  it('commits a physical workspace mutation only through the prepared durable fence', async () => {
    const repository = new RecordingRepository({ now: () => new Date(START) });
    const session = await createMoAgentDurableRunSession({
      ...runOptions(repository),
      heartbeatEnabled: false,
    });
    const started = { ...toolBase(1), type: 'tool_started' } as const;
    await session.record(started);
    await expect(session.assertWorkspaceFence()).resolves.toBeUndefined();

    const commit = vi.fn(async () => 'renamed');
    await expect(session.commitWorkspaceMutation(started.operationId, commit))
      .resolves.toBe('renamed');
    expect(commit).toHaveBeenCalledOnce();

    await session.record({
      ...toolBase(2),
      type: 'tool_completed',
      terminal: false,
      durationMs: 2,
      result: { ok: true, data: { afterSha256: AFTER_HASH } },
    });
    expect(await repository.getToolExecution(started.operationId)).toMatchObject({
      status: 'succeeded',
      postStateHash: `sha256:${AFTER_HASH}`,
    });
    await session.close();
  });

  it('serializes an independent heartbeat behind an in-flight event write', async () => {
    const repository = new SerializedRepository({ now: () => new Date(START) });
    const scheduler = new ManualScheduler();
    const session = await createMoAgentDurableRunSession({
      ...runOptions(repository),
      scheduler,
    });

    const recording = session.record({
      ...eventBase(1),
      type: 'turn_started',
      turn: 1,
    });
    await repository.appendEntered.promise;
    scheduler.fire();
    await Promise.resolve();
    expect(repository.callOrder).toEqual(['append:start']);

    repository.releaseAppend.resolve();
    await recording;
    await vi.waitFor(() => {
      expect(repository.callOrder).toContain('heartbeat:end');
    });
    expect(repository.maxActiveWrites).toBe(1);
    expect(repository.callOrder).toEqual([
      'append:start',
      'append:end',
      'heartbeat:start',
      'heartbeat:end',
    ]);
    expect(session.failure).toBeNull();
    await session.close();
  });

  it('interrupts under the current fence and reports heartbeat failures through onFatal', async () => {
    class FailingHeartbeatRepository extends InMemoryAgentRuntimeRepository {
      override async heartbeat(_input: HeartbeatAgentRunInput): Promise<never> {
        throw new Error('heartbeat unavailable');
      }
    }

    const scheduler = new ManualScheduler();
    const onFatal = vi.fn();
    const failingRepository = new FailingHeartbeatRepository({
      now: () => new Date(START),
    });
    const failedSession = await createMoAgentDurableRunSession({
      ...runOptions(failingRepository),
      scheduler,
      onFatal,
    });
    scheduler.fire();
    await vi.waitFor(() => expect(failedSession.failure?.message).toBe('heartbeat unavailable'));
    expect(onFatal).toHaveBeenCalledOnce();
    await failedSession.close();

    const repository = new InMemoryAgentRuntimeRepository({ now: () => new Date(START) });
    const session = await createMoAgentDurableRunSession({
      ...runOptions(repository),
      heartbeatEnabled: false,
    });
    await session.interrupt({ code: 'PROCESS_SHUTDOWN' });
    expect(await repository.getRun(session.run.id)).toMatchObject({
      status: 'interrupted',
      errorCode: 'PROCESS_SHUTDOWN',
      leaseOwner: null,
    });
    await session.close();
  });
});
