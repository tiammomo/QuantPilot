import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient, type AgentMission } from '@prisma/client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaAgentRuntimeRepository } from './prisma-repository';
import { withMoAgentWorkspaceResourceLock } from './workspace-resource-lock';
import type { AgentRunRecord, AgentWriteFence, CreateAgentRunInput } from './types';

const TEST_DATABASE_URL = process.env.MOAGENT_TEST_DATABASE_URL?.trim();
const TEST_SCOPE = `moagent_pg_it_${randomUUID().replaceAll('-', '')}`;
const ZERO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cachedInputTokens: 0,
  cacheMissInputTokens: 0,
  reasoningTokens: 0,
} as const;

describe.skipIf(!TEST_DATABASE_URL)('PrismaAgentRuntimeRepository (PostgreSQL integration)', () => {
  let clientA: PrismaClient;
  let clientB: PrismaClient;
  let repositoryA: PrismaAgentRuntimeRepository;
  let repositoryB: PrismaAgentRuntimeRepository;
  let sequence = 0;
  const projectIds = new Set<string>();

  function uniqueId(label: string): string {
    sequence += 1;
    return `${TEST_SCOPE}:${label}:${sequence}`;
  }

  function workspaceKey(label: string): string {
    return `sha256:${TEST_SCOPE}:${label}`;
  }

  function runInput(
    projectId: string,
    workspace: string,
    label: string,
    overrides: Partial<CreateAgentRunInput> = {}
  ): CreateAgentRunInput {
    return {
      id: uniqueId(`run:${label}`),
      projectId,
      workspaceKey: workspace,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
      frameworkVersion: 'moagent:integration-test',
      buildRevision: 'test:postgres-integration',
      profileHash: 'sha256:integration-profile',
      promptHash: 'sha256:integration-prompt',
      toolHash: 'sha256:integration-tools',
      skillHash: 'sha256:integration-skills',
      workspaceHash: 'sha256:integration-workspace',
      leaseOwner: uniqueId(`worker:${label}`),
      leaseExpiresAt: new Date(Date.now() + 120_000),
      ...overrides,
    };
  }

  function fence(run: AgentRunRecord): AgentWriteFence {
    return {
      runId: run.id,
      expectedVersion: run.version,
      leaseOwner: run.leaseOwner!,
      fencingToken: run.fencingToken,
      workspaceFencingToken: run.workspaceFencingToken,
    };
  }

  function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  async function createProject(label: string): Promise<string> {
    const id = uniqueId(`project:${label}`);
    await clientA.project.create({
      data: { id, name: `MoAgent PostgreSQL integration: ${label}` },
    });
    projectIds.add(id);
    return id;
  }

  beforeAll(async () => {
    clientA = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL! });
    clientB = new PrismaClient({ datasourceUrl: TEST_DATABASE_URL! });
    await Promise.all([clientA.$connect(), clientB.$connect()]);
    repositoryA = new PrismaAgentRuntimeRepository(clientA);
    repositoryB = new PrismaAgentRuntimeRepository(clientB);
  });

  afterAll(async () => {
    try {
      const ids = [...projectIds];
      if (ids.length > 0) {
        await clientA.agentMission.deleteMany({ where: { projectId: { in: ids } } });
        await clientA.agentRun.deleteMany({ where: { projectId: { in: ids } } });
        await clientA.agentWorkspaceLease.deleteMany({ where: { projectId: { in: ids } } });
        await clientA.userRequest.deleteMany({ where: { projectId: { in: ids } } });
        await clientA.project.deleteMany({ where: { id: { in: ids } } });
      }
    } finally {
      await Promise.allSettled([clientA.$disconnect(), clientB.$disconnect()]);
    }
  });

  it('allows only one concurrent lease acquisition for the same project', async () => {
    const projectId = await createProject('same-project-race');
    const workspace = workspaceKey('same-project-race');

    const outcomes = await Promise.allSettled([
      repositoryA.createRun(runInput(projectId, workspace, 'racer-a')),
      repositoryB.createRun(runInput(projectId, workspace, 'racer-b')),
    ]);
    const fulfilled = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<AgentRunRecord> => outcome.status === 'fulfilled'
    );
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: 'WORKSPACE_BUSY' });
    expect(await clientA.agentRun.count({ where: { projectId } })).toBe(1);
    expect(await repositoryA.getWorkspaceLease(projectId)).toMatchObject({
      status: 'held',
      activeRunId: fulfilled[0].value.id,
    });
  });

  it('rejects the same canonical workspaceKey across different projects', async () => {
    const firstProjectId = await createProject('workspace-owner');
    const secondProjectId = await createProject('workspace-alias');
    const workspace = workspaceKey('cross-project-conflict');

    await repositoryA.createRun(runInput(firstProjectId, workspace, 'workspace-owner'));

    await expect(
      repositoryB.createRun(runInput(secondProjectId, workspace, 'workspace-alias'))
    ).rejects.toMatchObject({ code: 'WORKSPACE_BINDING_CONFLICT' });
    expect(await clientA.agentRun.count({ where: { projectId: secondProjectId } })).toBe(0);
  });

  it('allows only one active Mission generation per project across Prisma clients', async () => {
    const projectId = await createProject('mission-generation-slot');
    const firstRequestId = uniqueId('request:mission-a');
    const secondRequestId = uniqueId('request:mission-b');
    await clientA.userRequest.createMany({
      data: [
        {
          id: firstRequestId,
          projectId,
          instruction: 'First concurrent Mission candidate.',
        },
        {
          id: secondRequestId,
          projectId,
          instruction: 'Second concurrent Mission candidate.',
        },
      ],
    });
    const missionData = (requestId: string, label: string) => ({
      id: uniqueId(`mission:${label}`),
      generationId: randomUUID(),
      projectId,
      requestId,
      spec: { schemaVersion: 1, testScope: TEST_SCOPE, requestId },
      specHash: `sha256:${label}`,
    });
    const firstData = missionData(firstRequestId, 'slot-a');
    const secondData = missionData(secondRequestId, 'slot-b');

    const outcomes = await Promise.allSettled([
      clientA.agentMission.create({ data: firstData }),
      clientB.agentMission.create({ data: secondData }),
    ]);
    const fulfilled = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<AgentMission> =>
        outcome.status === 'fulfilled',
    );
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: 'P2002' });
    expect(await clientA.agentMission.count({ where: { projectId } })).toBe(1);

    await clientA.agentMission.update({
      where: { id: fulfilled[0].value.id },
      data: { status: 'failed', activeSlot: null, completedAt: new Date() },
    });
    const replacementData = fulfilled[0].value.requestId === firstRequestId
      ? secondData
      : firstData;
    await expect(clientB.agentMission.create({ data: replacementData })).resolves.toMatchObject({
      projectId,
      activeSlot: 1,
    });
  });

  it('derives lease expiry from the PostgreSQL clock despite worker clock skew', async () => {
    const projectId = await createProject('database-clock');
    const workspace = workspaceKey('database-clock');
    const skewedNow = new Date(Date.now() + 60 * 60 * 1_000);
    const skewedRepository = new PrismaAgentRuntimeRepository(
      clientA,
      () => new Date(skewedNow)
    );
    const run = await skewedRepository.createRun(
      runInput(projectId, workspace, 'database-clock', {
        leaseExpiresAt: new Date(skewedNow.getTime() + 120_000),
      })
    );

    const remainingMs = run.leaseExpiresAt!.getTime() - Date.now();
    expect(remainingMs).toBeGreaterThan(100_000);
    expect(remainingMs).toBeLessThan(140_000);

    const heartbeat = await skewedRepository.heartbeat({
      ...fence(run),
      now: skewedNow,
      leaseExpiresAt: new Date(skewedNow.getTime() + 180_000),
    });
    const heartbeatRemainingMs = heartbeat.leaseExpiresAt!.getTime() - Date.now();
    expect(heartbeatRemainingMs).toBeGreaterThan(160_000);
    expect(heartbeatRemainingMs).toBeLessThan(200_000);
  });

  it('rejects a requestId owned by a different project', async () => {
    const requestProjectId = await createProject('request-owner');
    const runProjectId = await createProject('request-mismatch');
    const requestId = uniqueId('request:foreign');
    await clientA.userRequest.create({
      data: {
        id: requestId,
        projectId: requestProjectId,
        instruction: 'Exercise the composite request/project ownership guard.',
      },
    });

    await expect(
      repositoryA.createRun(
        runInput(runProjectId, workspaceKey('request-mismatch'), 'request-mismatch', {
          requestId,
        })
      )
    ).rejects.toMatchObject({ code: 'INVALID_STATE' });
    expect(await clientA.agentRun.count({ where: { projectId: runProjectId } })).toBe(0);
  });

  it('requires a prepared workspace-write ledger entry before physical commit', async () => {
    const projectId = await createProject('prepared-ledger');
    const run = await repositoryA.createRun(
      runInput(projectId, workspaceKey('prepared-ledger'), 'prepared-ledger')
    );
    const operationId = uniqueId('operation:workspace-write');
    const unpreparedCommit = vi.fn(async () => 'must-not-run');

    await expect(
      repositoryA.commitWorkspaceMutation(
        { ...fence(run), operationId },
        unpreparedCommit
      )
    ).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    expect(unpreparedCommit).not.toHaveBeenCalled();

    const prepared = await repositoryA.prepareToolExecution({
      ...fence(run),
      operationId,
      toolCallId: uniqueId('tool-call:workspace-write'),
      toolName: 'write_file',
      inputHash: 'sha256:integration-write-input',
      effect: 'workspace_write',
      idempotency: 'reconcile_required',
    });
    const preparedCommit = vi.fn(async () => 'committed');

    await expect(
      repositoryA.commitWorkspaceMutation(
        { ...fence(prepared.run), operationId },
        preparedCommit
      )
    ).resolves.toBe('committed');
    expect(preparedCommit).toHaveBeenCalledOnce();
    expect(await repositoryA.getToolExecution(operationId)).toMatchObject({
      status: 'commit_authorized',
    });

    const duplicateCommit = vi.fn(async () => 'must-not-repeat');
    await expect(repositoryB.commitWorkspaceMutation(
      { ...fence(prepared.run), operationId },
      duplicateCommit
    )).rejects.toMatchObject({ code: 'OPERATION_CONFLICT' });
    expect(duplicateCommit).not.toHaveBeenCalled();
  });

  it('blocks another mutation in the same run after an unresolved outcome', async () => {
    const projectId = await createProject('uncertain-fail-closed');
    const run = await repositoryA.createRun(
      runInput(projectId, workspaceKey('uncertain-fail-closed'), 'uncertain-fail-closed')
    );
    const firstOperationId = uniqueId('operation:uncertain');
    const prepared = await repositoryA.prepareToolExecution({
      ...fence(run),
      operationId: firstOperationId,
      toolCallId: uniqueId('tool-call:uncertain'),
      toolName: 'publish_report',
      inputHash: 'sha256:uncertain',
      effect: 'external_write',
      idempotency: 'reconcile_required',
    });
    const uncertain = await repositoryA.completeToolExecution({
      ...fence(prepared.run),
      operationId: firstOperationId,
      status: 'uncertain',
      resultReceipt: { reconciliation: 'required' },
      error: { code: 'EFFECT_UNKNOWN', message: 'Outcome cannot be proven.' },
    });
    const nextOperationId = uniqueId('operation:must-not-start');

    await expect(repositoryB.prepareToolExecution({
      ...fence(uncertain.run),
      operationId: nextOperationId,
      toolCallId: uniqueId('tool-call:must-not-start'),
      toolName: 'write_file',
      inputHash: 'sha256:must-not-start',
      effect: 'workspace_write',
      idempotency: 'reconcile_required',
    })).rejects.toMatchObject({ code: 'RECONCILIATION_REQUIRED' });
    expect(await repositoryA.getToolExecution(nextOperationId)).toBeNull();
  });

  it('releases both run and workspace leases when a run completes', async () => {
    const projectId = await createProject('terminal-release');
    const workspace = workspaceKey('terminal-release');
    const run = await repositoryA.createRun(runInput(projectId, workspace, 'first-owner'));

    const completed = await repositoryA.completeRun({
      ...fence(run),
      status: 'completed',
      turnCount: 1,
      usage: ZERO_USAGE,
    });

    expect(completed).toMatchObject({
      status: 'completed',
      leaseOwner: null,
      leaseExpiresAt: null,
    });
    expect(await repositoryA.getWorkspaceLease(projectId)).toMatchObject({
      status: 'free',
      activeRunId: null,
      leaseOwner: null,
      leaseExpiresAt: null,
    });

    const nextRun = await repositoryB.createRun(
      runInput(projectId, workspace, 'next-owner')
    );
    expect(nextRun).toMatchObject({
      status: 'running',
      workspaceFencingToken: run.workspaceFencingToken + 1,
    });
  });

  it('persists cumulative usage in the same transaction as a usage event', async () => {
    const projectId = await createProject('incremental-usage');
    const run = await repositoryA.createRun(
      runInput(projectId, workspaceKey('incremental-usage'), 'incremental-usage')
    );
    const cumulativeUsage = {
      inputTokens: 900,
      outputTokens: 120,
      totalTokens: 1_020,
      cachedInputTokens: 300,
      cacheMissInputTokens: 600,
      reasoningTokens: 25,
    } as const;

    const appended = await repositoryA.appendEvent({
      ...fence(run),
      eventId: uniqueId('event:incremental-usage'),
      sequence: 1,
      eventType: 'usage',
      payload: { turn: 1, totalUsage: cumulativeUsage },
      cumulativeUsage,
      occurredAt: new Date(),
    });

    expect(appended.run).toMatchObject(cumulativeUsage);
    expect(await clientB.agentRun.findUniqueOrThrow({ where: { id: run.id } }))
      .toMatchObject(cumulativeUsage);
  });

  it('never lets a reconciliation owner execute an old prepared operation', async () => {
    const projectId = await createProject('stale-operation-owner');
    const workspace = workspaceKey('stale-operation-owner');
    const run = await repositoryA.createRun(
      runInput(projectId, workspace, 'stale-operation-owner')
    );
    const operationId = uniqueId('operation:stale-owner');
    const prepared = await repositoryA.prepareToolExecution({
      ...fence(run),
      operationId,
      toolCallId: uniqueId('tool-call:stale-owner'),
      toolName: 'write_file',
      inputHash: 'sha256:stale-owner',
      effect: 'workspace_write',
      idempotency: 'reconcile_required',
    });
    const expiredAt = new Date(Date.now() - 1_000);
    await clientA.$transaction([
      clientA.agentRun.update({
        where: { id: run.id },
        data: { leaseExpiresAt: expiredAt },
      }),
      clientA.agentWorkspaceLease.update({
        where: { projectId },
        data: { leaseExpiresAt: expiredAt },
      }),
    ]);
    const claimed = await repositoryB.claimLease({
      runId: run.id,
      expectedVersion: prepared.run.version,
      leaseOwner: uniqueId('worker:reconciler'),
      leaseExpiresAt: new Date(Date.now() + 120_000),
    });
    const staleEffect = vi.fn(async () => 'must-not-run');

    await expect(repositoryB.commitWorkspaceMutation(
      { ...fence(claimed), operationId },
      staleEffect
    )).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(staleEffect).not.toHaveBeenCalled();
    expect(await repositoryA.getToolExecution(operationId)).toMatchObject({
      status: 'prepared',
      fencingToken: run.fencingToken,
      workspaceFencingToken: run.workspaceFencingToken,
    });
  });

  it('atomically fences an expired safe owner before creating its replacement', async () => {
    const projectId = await createProject('expired-takeover');
    const workspace = workspaceKey('expired-takeover');
    const stale = await repositoryA.createRun(
      runInput(projectId, workspace, 'expired-owner')
    );
    const expiredAt = new Date(Date.now() - 1_000);
    await clientA.$transaction([
      clientA.agentRun.update({
        where: { id: stale.id },
        data: { leaseExpiresAt: expiredAt },
      }),
      clientA.agentWorkspaceLease.update({
        where: { projectId },
        data: { leaseExpiresAt: expiredAt },
      }),
    ]);

    const replacement = await repositoryB.createRun(
      runInput(projectId, workspace, 'replacement')
    );

    expect(replacement.workspaceFencingToken).toBe(stale.workspaceFencingToken + 1);
    expect(await repositoryA.getRun(stale.id)).toMatchObject({
      status: 'interrupted',
      leaseOwner: null,
      errorCode: 'WORKSPACE_LEASE_EXPIRED_REPLAN_REQUIRED',
    });
    expect(await repositoryA.getWorkspaceLease(projectId)).toMatchObject({
      activeRunId: replacement.id,
      leaseOwner: replacement.leaseOwner,
    });
  });

  it('holds takeover behind a physical commit and then blocks on its unresolved ledger', async () => {
    const projectId = await createProject('commit-takeover-order');
    const workspace = workspaceKey('commit-takeover-order');
    const leaseExpiresAt = new Date(Date.now() + 500);
    const run = await repositoryA.createRun(
      runInput(projectId, workspace, 'commit-owner', { leaseExpiresAt })
    );
    const operationId = uniqueId('operation:commit-takeover-order');
    const prepared = await repositoryA.prepareToolExecution({
      ...fence(run),
      operationId,
      toolCallId: uniqueId('tool-call:commit-takeover-order'),
      toolName: 'write_file',
      inputHash: 'sha256:commit-takeover-order',
      effect: 'workspace_write',
      idempotency: 'reconcile_required',
    });
    const enteredCommit = deferred();
    const releaseCommit = deferred();
    const physicalWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moagent-pg-lock-'));
    try {
      const physicalCommit = withMoAgentWorkspaceResourceLock(
        physicalWorkspace,
        () => repositoryA.commitWorkspaceMutation(
          { ...fence(prepared.run), operationId },
          async () => {
            enteredCommit.resolve();
            await releaseCommit.promise;
            return 'renamed';
          }
        )
      );
      await enteredCommit.promise;
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, leaseExpiresAt.getTime() - Date.now() + 25))
      );

      let takeoverSettled = false;
      const takeover = withMoAgentWorkspaceResourceLock(
        physicalWorkspace,
        () => repositoryB.createRun(runInput(projectId, workspace, 'blocked-takeover'))
      ).finally(() => {
        takeoverSettled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(takeoverSettled).toBe(false);

      releaseCommit.resolve();
      await expect(physicalCommit).resolves.toBe('renamed');
      await expect(takeover).rejects.toMatchObject({ code: 'RECONCILIATION_REQUIRED' });
      expect(await clientA.agentRun.count({ where: { projectId } })).toBe(1);
      expect(await repositoryA.getToolExecution(operationId)).toMatchObject({
        status: 'commit_authorized',
      });
    } finally {
      await fs.rm(physicalWorkspace, { recursive: true, force: true });
    }
  });
});
