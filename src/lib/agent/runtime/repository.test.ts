import { describe, expect, it, vi } from 'vitest';
import { InMemoryAgentRuntimeRepository } from './in-memory-repository';
import type { AgentRunRecord, AgentWriteFence, CreateAgentRunInput } from './types';

const START = new Date('2026-07-15T01:00:00.000Z');

function fixture() {
  let now = new Date(START);
  let uuidSequence = 0;
  const repository = new InMemoryAgentRuntimeRepository({
    now: () => new Date(now),
    uuid: () => {
      uuidSequence += 1;
      return `00000000-0000-4000-8000-${String(uuidSequence).padStart(12, '0')}`;
    },
  });
  return {
    repository,
    now: () => new Date(now),
    advance(ms: number) {
      now = new Date(now.getTime() + ms);
    },
  };
}

function runInput(overrides: Partial<CreateAgentRunInput> = {}): CreateAgentRunInput {
  return {
    id: 'moagent_test-run',
    projectId: 'project_test',
    workspaceKey: 'sha256:workspace-key',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    frameworkVersion: 'moagent:1.0.0',
    buildRevision: 'test:repository',
    profileHash: 'sha256:profile',
    promptHash: 'sha256:prompt',
    toolHash: 'sha256:tools',
    skillHash: 'sha256:skills',
    workspaceHash: 'sha256:workspace',
    leaseOwner: 'worker:test',
    leaseExpiresAt: new Date(START.getTime() + 60_000),
    ...overrides,
  };
}

function fence(run: AgentRunRecord, now?: Date): AgentWriteFence {
  return {
    runId: run.id,
    expectedVersion: run.version,
    leaseOwner: run.leaseOwner!,
    fencingToken: run.fencingToken,
    workspaceFencingToken: run.workspaceFencingToken,
    ...(now ? { now } : {}),
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

describe('InMemoryAgentRuntimeRepository', () => {
  it('creates a provenance-bound run with an independent instance UUID and optional request', async () => {
    const { repository } = fixture();
    const run = await repository.createRun(runInput());

    expect(run).toMatchObject({
      id: 'moagent_test-run',
      runInstanceId: '00000000-0000-4000-8000-000000000001',
      projectId: 'project_test',
      requestId: null,
      status: 'running',
      fencingToken: 1,
      version: 0,
      lastEventSequence: 0,
      provider: 'deepseek',
      buildRevision: 'test:repository',
      profileHash: 'sha256:profile',
      workspaceKey: 'sha256:workspace-key',
      workspaceFencingToken: 1,
    });
    expect(await repository.getWorkspaceLease('project_test')).toMatchObject({
      status: 'held',
      activeRunId: run.id,
      fencingToken: 1,
    });
  });

  it('serializes project/workspace acquisition and atomically fences an expired owner', async () => {
    const clock = fixture();
    const first = await clock.repository.createRun(
      runInput({ leaseExpiresAt: new Date(START.getTime() + 1_000) })
    );

    await expectCode(
      clock.repository.createRun(runInput({ id: 'moagent_parallel-run' })),
      'WORKSPACE_BUSY'
    );
    await expectCode(
      clock.repository.createRun(runInput({
        id: 'moagent_alias-project',
        projectId: 'project_alias',
      })),
      'WORKSPACE_BINDING_CONFLICT'
    );

    clock.advance(2_000);
    const replacement = await clock.repository.createRun(runInput({
      id: 'moagent_replacement',
      leaseExpiresAt: new Date(clock.now().getTime() + 60_000),
    }));
    expect(replacement.workspaceFencingToken).toBe(2);
    expect(await clock.repository.getRun(first.id)).toMatchObject({
      status: 'interrupted',
      errorCode: 'WORKSPACE_LEASE_EXPIRED_REPLAN_REQUIRED',
    });
    expect(await clock.repository.getWorkspaceLease(first.projectId)).toMatchObject({
      status: 'held',
      activeRunId: replacement.id,
      fencingToken: 2,
    });
  });

  it('extends and releases both run and workspace leases under one fence', async () => {
    const clock = fixture();
    const run = await clock.repository.createRun(runInput());
    const extendedExpiry = new Date(START.getTime() + 120_000);
    const heartbeated = await clock.repository.heartbeat({
      ...fence(run, clock.now()),
      leaseExpiresAt: extendedExpiry,
    });
    expect(heartbeated.leaseExpiresAt).toEqual(extendedExpiry);
    expect(await clock.repository.getWorkspaceLease(run.projectId)).toMatchObject({
      leaseExpiresAt: extendedExpiry,
      activeRunId: run.id,
    });

    await clock.repository.completeRun({
      ...fence(heartbeated, clock.now()),
      status: 'completed',
      turnCount: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cachedInputTokens: 0,
        cacheMissInputTokens: 0,
        reasoningTokens: 0,
      },
    });
    expect(await clock.repository.getWorkspaceLease(run.projectId)).toMatchObject({
      status: 'free',
      activeRunId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
      fencingToken: 1,
    });
  });

  it('fences stale workers after an expired lease is claimed', async () => {
    const clock = fixture();
    const first = await clock.repository.createRun(
      runInput({ leaseExpiresAt: new Date(START.getTime() + 1_000) })
    );
    clock.advance(2_000);

    const claimed = await clock.repository.claimLease({
      runId: first.id,
      expectedVersion: first.version,
      leaseOwner: 'worker:reconciler',
      leaseExpiresAt: new Date(clock.now().getTime() + 60_000),
      now: clock.now(),
    });
    expect(claimed).toMatchObject({
      status: 'reconciling',
      fencingToken: 2,
      version: 1,
      leaseOwner: 'worker:reconciler',
    });

    await expectCode(
      clock.repository.appendEvent({
        runId: first.id,
        expectedVersion: claimed.version,
        leaseOwner: first.leaseOwner!,
        fencingToken: first.fencingToken,
        workspaceFencingToken: first.workspaceFencingToken,
        now: clock.now(),
        eventId: `${first.id}:2`,
        sequence: 2,
        eventType: 'turn_started',
        payload: { turn: 1 },
        occurredAt: clock.now(),
      }),
      'LEASE_LOST'
    );
  });

  it('persists sparse monotonic public events and makes an identical retry idempotent', async () => {
    const clock = fixture();
    const run = await clock.repository.createRun(runInput());
    const input = {
      ...fence(run, clock.now()),
      eventId: `${run.id}:7`,
      sequence: 7,
      eventType: 'assistant_message',
      payload: { turn: 1, finishReason: 'tool_calls' },
      occurredAt: clock.now(),
    } as const;

    const appended = await clock.repository.appendEvent(input);
    expect(appended.run).toMatchObject({ lastEventSequence: 7, version: 1 });

    // Simulates a successful commit whose response was lost: the caller still
    // carries version 0, but the exact same event resolves idempotently.
    const replayed = await clock.repository.appendEvent(input);
    expect(replayed.event.id).toBe(appended.event.id);
    expect(replayed.run.version).toBe(1);

    await expectCode(
      clock.repository.appendEvent({
        ...input,
        payload: { turn: 2 },
      }),
      'CONFLICT'
    );
  });

  it('rejects private reasoning and raw message history from durable public JSON', async () => {
    const clock = fixture();
    const run = await clock.repository.createRun(runInput());

    await expectCode(
      clock.repository.appendEvent({
        ...fence(run, clock.now()),
        eventId: `${run.id}:1`,
        sequence: 1,
        eventType: 'unsafe_event',
        payload: { nested: { reasoningContent: 'private chain of thought' } },
        occurredAt: clock.now(),
      }),
      'INVALID_STATE'
    );

    await expectCode(
      clock.repository.appendEvent({
        ...fence(run, clock.now()),
        eventId: `${run.id}:2`,
        sequence: 2,
        eventType: 'unsafe_event',
        payload: { messages: [{ role: 'system', content: 'private prompt' }] },
        occurredAt: clock.now(),
      }),
      'INVALID_STATE'
    );
  });

  it('stores checkpoints only behind durable events and marks recovery as replan-required', async () => {
    const clock = fixture();
    const created = await clock.repository.createRun(runInput());
    const afterEvent = (
      await clock.repository.appendEvent({
        ...fence(created, clock.now()),
        eventId: `${created.id}:4`,
        sequence: 4,
        eventType: 'assistant_message',
        payload: { turn: 1, finishReason: 'stop' },
        occurredAt: clock.now(),
      })
    ).run;

    const saved = await clock.repository.saveCheckpoint({
      ...fence(afterEvent, clock.now()),
      sequence: 4,
      turn: 1,
      boundary: 'model_turn_completed',
      publicState: { lastPublicEventId: `${created.id}:4` },
      opaque: { codec: 'reference-v1', value: 'workspace-snapshot:abc' },
      stateHash: 'sha256:checkpoint',
      stateVersion: 1,
    });

    expect(saved.checkpoint).toMatchObject({
      sequence: 4,
      boundary: 'model_turn_completed',
      recoveryMode: 'replan_required',
      opaqueCodec: 'reference-v1',
    });
    expect(saved.run.latestCheckpointSequence).toBe(4);

    await expectCode(
      clock.repository.saveCheckpoint({
        ...fence(saved.run, clock.now()),
        sequence: 5,
        turn: 2,
        boundary: 'model_turn_completed',
        publicState: {},
        stateHash: 'sha256:ahead',
        stateVersion: 1,
      }),
      'INVALID_STATE'
    );
  });

  it('uses operationId as an idempotency ledger and rejects identity drift', async () => {
    const clock = fixture();
    const run = await clock.repository.createRun(runInput());
    const preparation = {
      ...fence(run, clock.now()),
      operationId: `${run.runInstanceId}:tool:1`,
      toolCallId: 'call_1',
      toolName: 'write_file',
      inputHash: 'sha256:input',
      effect: 'workspace_write',
      idempotency: 'operation_key',
      idempotencyKey: 'workspace:operation:1',
      preStateHash: 'sha256:before',
    } as const;

    const first = await clock.repository.prepareToolExecution(preparation);
    expect(first).toMatchObject({ created: true, execution: { status: 'prepared' } });

    const replayed = await clock.repository.prepareToolExecution(preparation);
    expect(replayed.created).toBe(false);
    expect(replayed.execution.id).toBe(first.execution.id);

    await expectCode(
      clock.repository.prepareToolExecution({
        ...preparation,
        inputHash: 'sha256:different',
      }),
      'OPERATION_CONFLICT'
    );
  });

  it('allows response-lost ledger reads only under the current live fence', async () => {
    const clock = fixture();
    const created = await clock.repository.createRun(
      runInput({ leaseExpiresAt: new Date(START.getTime() + 1_000) })
    );
    const preparation = {
      ...fence(created, clock.now()),
      operationId: `${created.runInstanceId}:tool:fenced-replay`,
      toolCallId: 'call_fenced_replay',
      toolName: 'write_file',
      inputHash: 'sha256:fenced-replay',
      effect: 'workspace_write',
      idempotency: 'reconcile_required',
    } as const;
    const prepared = await clock.repository.prepareToolExecution(preparation);
    clock.advance(2_000);
    await clock.repository.claimLease({
      runId: created.id,
      expectedVersion: prepared.run.version,
      leaseOwner: 'worker:new-owner',
      leaseExpiresAt: new Date(clock.now().getTime() + 60_000),
      now: clock.now(),
    });

    await expectCode(clock.repository.prepareToolExecution(preparation), 'LEASE_LOST');
  });

  it('backfills observed file pre/post hashes only during prepared-to-terminal completion', async () => {
    const clock = fixture();
    const run = await clock.repository.createRun(runInput());
    const prepared = await clock.repository.prepareToolExecution({
      ...fence(run, clock.now()),
      operationId: `${run.runInstanceId}:tool:file-write`,
      toolCallId: 'call_file_write',
      toolName: 'write_file',
      inputHash: 'sha256:file-input',
      effect: 'workspace_write',
      idempotency: 'operation_key',
      idempotencyKey: 'workspace:file-write:1',
    });
    expect(prepared.execution.preStateHash).toBeNull();

    const completionInput = {
      ...fence(prepared.run, clock.now()),
      operationId: prepared.execution.operationId,
      status: 'succeeded',
      preStateHash: 'sha256:file-before',
      postStateHash: 'sha256:file-after',
      resultReceipt: {
        beforeSha256: 'file-before',
        afterSha256: 'file-after',
      },
    } as const;
    await expect(clock.repository.commitWorkspaceMutation(
      { ...fence(prepared.run, clock.now()), operationId: prepared.execution.operationId },
      async () => undefined
    )).resolves.toBeUndefined();
    const completed = await clock.repository.completeToolExecution(completionInput);
    expect(completed.execution).toMatchObject({
      status: 'succeeded',
      preStateHash: 'sha256:file-before',
      postStateHash: 'sha256:file-after',
    });

    const replayed = await clock.repository.completeToolExecution(completionInput);
    expect(replayed.execution.id).toBe(completed.execution.id);

    await expectCode(
      clock.repository.completeToolExecution({
        ...completionInput,
        preStateHash: 'sha256:different-before',
      }),
      'OPERATION_CONFLICT'
    );
  });

  it('holds the workspace fence across the physical mutation commit callback', async () => {
    const clock = fixture();
    const created = await clock.repository.createRun(
      runInput({ leaseExpiresAt: new Date(START.getTime() + 1_000) })
    );
    const prepared = await clock.repository.prepareToolExecution({
      ...fence(created, clock.now()),
      operationId: `${created.runInstanceId}:tool:locked-commit`,
      toolCallId: 'call_locked_commit',
      toolName: 'write_file',
      inputHash: 'sha256:locked-commit',
      effect: 'workspace_write',
      idempotency: 'reconcile_required',
    });
    let releaseCommit!: () => void;
    const commitBlocked = new Promise<void>((resolve) => { releaseCommit = resolve; });
    let entered = false;
    const committing = clock.repository.commitWorkspaceMutation(
      { ...fence(prepared.run, clock.now()), operationId: prepared.execution.operationId },
      async () => {
        entered = true;
        await commitBlocked;
        return 'renamed';
      }
    );
    await vi.waitFor(() => expect(entered).toBe(true));
    clock.advance(2_000);
    await expectCode(
      clock.repository.createRun(runInput({
        id: 'moagent_takeover-during-commit',
        leaseExpiresAt: new Date(clock.now().getTime() + 60_000),
      })),
      'WORKSPACE_BUSY'
    );
    releaseCommit();
    await expect(committing).resolves.toBe('renamed');
  });

  it('surfaces prepared side effects for reconciliation without replaying or failing them', async () => {
    const clock = fixture();
    const created = await clock.repository.createRun(
      runInput({ leaseExpiresAt: new Date(START.getTime() + 1_000) })
    );
    const prepared = await clock.repository.prepareToolExecution({
      ...fence(created, clock.now()),
      operationId: `${created.runInstanceId}:tool:1`,
      toolCallId: 'call_external',
      toolName: 'publish_report',
      inputHash: 'sha256:publish-input',
      effect: 'external_write',
      idempotency: 'reconcile_required',
      preStateHash: 'sha256:remote-before',
    });
    clock.advance(2_000);

    const candidates = await clock.repository.listReconciliationCandidates({
      now: clock.now(),
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].unresolvedToolExecutions).toEqual([
      expect.objectContaining({
        operationId: prepared.execution.operationId,
        status: 'prepared',
        effect: 'external_write',
      }),
    ]);
    expect((await clock.repository.getToolExecution(prepared.execution.operationId))?.status)
      .toBe('prepared');
  });

  it('keeps terminal runs with unresolved mutations visible to reconciliation', async () => {
    const clock = fixture();
    const created = await clock.repository.createRun(runInput());
    const prepared = await clock.repository.prepareToolExecution({
      ...fence(created, clock.now()),
      operationId: `${created.runInstanceId}:tool:cancelled-write`,
      toolCallId: 'call_cancelled_write',
      toolName: 'write_file',
      inputHash: 'sha256:cancelled-write',
      effect: 'workspace_write',
      idempotency: 'reconcile_required',
    });
    await clock.repository.completeRun({
      ...fence(prepared.run, clock.now()),
      status: 'cancelled',
      turnCount: 1,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cachedInputTokens: 0,
        cacheMissInputTokens: 0,
        reasoningTokens: 0,
      },
      error: { code: 'CANCELLED', message: 'Cancelled during a mutating tool.' },
    });

    const candidates = await clock.repository.listReconciliationCandidates({ now: clock.now() });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      run: { status: 'cancelled' },
      unresolvedToolExecutions: [
        { status: 'prepared', effect: 'workspace_write' },
      ],
    });
  });

  it('allows a new fenced owner to classify an effect as uncertain and blocks replan', async () => {
    const clock = fixture();
    const created = await clock.repository.createRun(
      runInput({ leaseExpiresAt: new Date(START.getTime() + 1_000) })
    );
    const prepared = await clock.repository.prepareToolExecution({
      ...fence(created, clock.now()),
      operationId: `${created.runInstanceId}:tool:1`,
      toolCallId: 'call_external',
      toolName: 'publish_report',
      inputHash: 'sha256:publish-input',
      effect: 'external_write',
      idempotency: 'reconcile_required',
    });
    clock.advance(2_000);
    const claimed = await clock.repository.claimLease({
      runId: created.id,
      expectedVersion: prepared.run.version,
      leaseOwner: 'worker:reconciler',
      leaseExpiresAt: new Date(clock.now().getTime() + 60_000),
      now: clock.now(),
    });

    const completed = await clock.repository.completeToolExecution({
      ...fence(claimed, clock.now()),
      operationId: prepared.execution.operationId,
      status: 'uncertain',
      resultReceipt: { reconciliation: 'manual_review_required' },
      error: { code: 'EFFECT_UNKNOWN', message: 'Remote outcome cannot be proven.' },
    });
    expect(completed.execution).toMatchObject({
      status: 'uncertain',
      errorCode: 'EFFECT_UNKNOWN',
      fencingToken: 1,
    });

    const interrupted = await clock.repository.completeRun({
      ...fence(completed.run, clock.now()),
      status: 'interrupted',
      turnCount: 0,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        cachedInputTokens: 0,
        cacheMissInputTokens: 0,
        reasoningTokens: 0,
      },
      error: {
        code: 'REPLAN_REQUIRED',
        message: 'Expired DeepSeek run cannot resume without private reasoning.',
      },
    });
    expect(interrupted.status).toBe('interrupted');

    await expectCode(
      clock.repository.createRun(
        runInput({
          id: 'moagent_replanned-attempt',
          leaseExpiresAt: new Date(clock.now().getTime() + 60_000),
        })
      ),
      'RECONCILIATION_REQUIRED'
    );
    expect((await clock.repository.getRun(interrupted.id))?.status).toBe('interrupted');
  });

  it('blocks another mutation in the same run after an unresolved outcome', async () => {
    const clock = fixture();
    const created = await clock.repository.createRun(runInput());
    const prepared = await clock.repository.prepareToolExecution({
      ...fence(created, clock.now()),
      operationId: `${created.runInstanceId}:tool:uncertain`,
      toolCallId: 'call_uncertain',
      toolName: 'publish_report',
      inputHash: 'sha256:uncertain-input',
      effect: 'external_write',
      idempotency: 'reconcile_required',
    });
    const uncertain = await clock.repository.completeToolExecution({
      ...fence(prepared.run, clock.now()),
      operationId: prepared.execution.operationId,
      status: 'uncertain',
      resultReceipt: { reconciliation: 'required' },
      error: { code: 'EFFECT_UNKNOWN', message: 'Outcome cannot be proven.' },
    });

    await expectCode(clock.repository.prepareToolExecution({
      ...fence(uncertain.run, clock.now()),
      operationId: `${created.runInstanceId}:tool:must-not-start`,
      toolCallId: 'call_must_not_start',
      toolName: 'write_file',
      inputHash: 'sha256:must-not-start',
      effect: 'workspace_write',
      idempotency: 'reconcile_required',
    }), 'RECONCILIATION_REQUIRED');
    expect(await clock.repository.getToolExecution(
      `${created.runInstanceId}:tool:must-not-start`
    )).toBeNull();
  });

  it('completes a run under CAS and clears its lease', async () => {
    const clock = fixture();
    const run = await clock.repository.createRun(runInput({ requestId: 'request_1' }));
    const completed = await clock.repository.completeRun({
      ...fence(run, clock.now()),
      status: 'completed',
      turnCount: 3,
      usage: {
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
        cachedInputTokens: 20,
        cacheMissInputTokens: 80,
        reasoningTokens: 10,
      },
    });

    expect(completed).toMatchObject({
      requestId: 'request_1',
      status: 'completed',
      turnCount: 3,
      totalTokens: 140,
      leaseOwner: null,
      leaseExpiresAt: null,
      version: 1,
    });
  });

  it('treats candidate_complete as a physical run terminal and releases its lease', async () => {
    const clock = fixture();
    const run = await clock.repository.createRun(runInput());

    const candidate = await clock.repository.completeRun({
      ...fence(run, clock.now()),
      status: 'candidate_complete',
      turnCount: 2,
      usage: {
        inputTokens: 80,
        outputTokens: 20,
        totalTokens: 100,
        cachedInputTokens: 10,
        cacheMissInputTokens: 70,
        reasoningTokens: 5,
      },
    });

    expect(candidate).toMatchObject({
      status: 'candidate_complete',
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(await clock.repository.getWorkspaceLease(run.projectId)).toMatchObject({
      status: 'free',
      activeRunId: null,
    });
  });
});
