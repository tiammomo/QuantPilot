import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  InMemoryAgentRuntimeRepository,
  listPiAgentWorkspaceMutationJournals,
  preparePiAgentWorkspaceMutationJournal,
  setPiAgentWorkspaceMutationJournalState,
} from '@/lib/agent/runtime';
import { reconcileExpiredPiAgentRuns } from './pi-agent-recovery';
import { PiAgentCheckpointIntegrityError } from './pi-agent-checkpoint';

const START = new Date('2026-07-15T00:00:00.000Z');

function hash(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

async function expiredRun(
  repository: InMemoryAgentRuntimeRepository,
  id: string,
) {
  return repository.createRun({
    id,
    projectId: 'project-recovery',
    workspaceKey: 'sha256:project-recovery-workspace',
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    frameworkVersion: 'pi-agent:1.1.0',
    buildRevision: 'test:recovery',
    profileHash: 'sha256:profile',
    promptHash: 'sha256:prompt',
    toolHash: 'sha256:tool',
    skillHash: 'sha256:skill',
    workspaceHash: 'sha256:workspace',
    status: 'running',
    leaseOwner: 'worker:old',
    leaseExpiresAt: new Date(START.getTime() + 1_000),
    startedAt: START,
  });
}

describe('PI Agent replan recovery audit', () => {
  it('fails closed before reconciliation when a v2 checkpoint hash is invalid', async () => {
    let now = START;
    const repository = new InMemoryAgentRuntimeRepository({ now: () => now });
    const run = await expiredRun(repository, 'pi-agent-expired-tampered-checkpoint');
    const appended = await repository.appendEvent({
      runId: run.id,
      expectedVersion: run.version,
      leaseOwner: run.leaseOwner!,
      fencingToken: run.fencingToken,
      workspaceFencingToken: run.workspaceFencingToken,
      now,
      eventId: `${run.id}:progress:1`,
      sequence: 1,
      eventType: 'progress_evaluated',
      payload: { turn: 1 },
      occurredAt: now,
    });
    await repository.saveCheckpoint({
      runId: run.id,
      expectedVersion: appended.run.version,
      leaseOwner: run.leaseOwner!,
      fencingToken: run.fencingToken,
      workspaceFencingToken: run.workspaceFencingToken,
      now,
      sequence: 1,
      turn: 1,
      boundary: 'model_turn_completed',
      publicState: {
        recoveryMode: 'replan_required',
        stage: 'model_turn_completed',
        turn: 1,
        sourceSequence: 1,
        completedOperationIds: [],
        progressOracle: {
          version: 1,
          turnsObserved: 1,
          consecutiveNoProgressTurns: 1,
          seenTrustedFactFingerprints: [],
          seenWorkspaceFingerprints: ['a'.repeat(64)],
          lastWorkspaceFingerprint: 'a'.repeat(64),
          lastFailedCheckCount: null,
          seenToolObservationFingerprints: [],
        },
      },
      stateHash: `sha256:${'0'.repeat(64)}`,
      stateVersion: 2,
    });
    now = new Date(START.getTime() + 2_000);

    await expect(reconcileExpiredPiAgentRuns({
      repository,
      projectId: 'project-recovery',
      now,
      ownerId: 'reconciler:test',
    })).rejects.toBeInstanceOf(PiAgentCheckpointIntegrityError);
    expect((await repository.getRun(run.id))?.status).toBe('running');
  });

  it('closes an expired attempt with no unresolved mutation as interrupted', async () => {
    let now = START;
    const repository = new InMemoryAgentRuntimeRepository({ now: () => now });
    const run = await expiredRun(repository, 'pi-agent-expired-safe');
    const cumulativeUsage = {
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
      cachedInputTokens: 30,
      cacheMissInputTokens: 50,
      reasoningTokens: 5,
    } as const;
    await repository.appendEvent({
      runId: run.id,
      expectedVersion: run.version,
      leaseOwner: run.leaseOwner!,
      fencingToken: run.fencingToken,
      workspaceFencingToken: run.workspaceFencingToken,
      now,
      eventId: `${run.id}:usage:1`,
      sequence: 1,
      eventType: 'usage',
      payload: { turn: 1, totalUsage: cumulativeUsage },
      cumulativeUsage,
      occurredAt: now,
    });
    now = new Date(START.getTime() + 2_000);

    const result = await reconcileExpiredPiAgentRuns({
      repository,
      projectId: 'project-recovery',
      now,
      ownerId: 'reconciler:test',
    });

    expect(result).toEqual({
      interruptedRunIds: ['pi-agent-expired-safe'],
      blocked: [],
      racedRunIds: [],
    });
    expect(await repository.getRun('pi-agent-expired-safe')).toMatchObject({
      status: 'interrupted',
      errorCode: 'LEASE_EXPIRED_REPLAN_REQUIRED',
      inputTokens: 80,
      outputTokens: 20,
      totalTokens: 100,
      cachedInputTokens: 30,
      cacheMissInputTokens: 50,
      reasoningTokens: 5,
    });
  });

  it('fails closed around an expired prepared workspace mutation', async () => {
    const preparationTime = new Date(START.getTime() + 500);
    let now = preparationTime;
    const repository = new InMemoryAgentRuntimeRepository({ now: () => now });
    const run = await expiredRun(repository, 'pi-agent-expired-write');
    await repository.prepareToolExecution({
      runId: run.id,
      expectedVersion: run.version,
      leaseOwner: 'worker:old',
      fencingToken: run.fencingToken,
      workspaceFencingToken: run.workspaceFencingToken,
      now,
      operationId: `op_${'a'.repeat(64)}`,
      toolCallId: 'sha256:call',
      toolName: 'write_file',
      inputHash: 'sha256:input',
      effect: 'workspace_write',
      idempotency: 'reconcile_required',
    });
    now = new Date(START.getTime() + 2_000);

    const result = await reconcileExpiredPiAgentRuns({
      repository,
      projectId: 'project-recovery',
      now,
      ownerId: 'reconciler:test',
    });

    expect(result.blocked).toEqual([{
      runId: 'pi-agent-expired-write',
      operationIds: [`op_${'a'.repeat(64)}`],
    }]);
    expect((await repository.getRun('pi-agent-expired-write'))?.status).toBe('running');
  });

  it('terminalizes a prepared workspace operation that never created a physical journal', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-agent-recovery-prepared-'));
    try {
      const preparationTime = new Date(START.getTime() + 500);
      let now = preparationTime;
      const repository = new InMemoryAgentRuntimeRepository({ now: () => now });
      const run = await expiredRun(repository, 'pi-agent-expired-prepared-only');
      const operationId = `op_${'e'.repeat(64)}`;
      await repository.prepareToolExecution({
        runId: run.id,
        expectedVersion: run.version,
        leaseOwner: 'worker:old',
        fencingToken: run.fencingToken,
        workspaceFencingToken: run.workspaceFencingToken,
        now,
        operationId,
        toolCallId: 'sha256:prepared-call',
        toolName: 'write_file',
        inputHash: 'sha256:prepared-input',
        effect: 'workspace_write',
        idempotency: 'reconcile_required',
      });
      now = new Date(START.getTime() + 2_000);

      const result = await reconcileExpiredPiAgentRuns({
        repository,
        projectId: 'project-recovery',
        workspaceRoot: workspace,
        now,
        ownerId: 'reconciler:test',
      });

      expect(result.blocked).toEqual([]);
      expect(result.interruptedRunIds).toEqual([run.id]);
      expect(await repository.getToolExecution(operationId)).toMatchObject({
        status: 'failed',
        errorCode: 'WORKSPACE_MUTATION_ROLLED_BACK',
        resultReceipt: { journal: 'no_physical_commit' },
      });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it('rolls a partially applied multi-file commit back and terminalizes its ledger', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-agent-recovery-partial-'));
    try {
      await fs.mkdir(path.join(workspace, 'app'));
      await Promise.all([
        fs.writeFile(path.join(workspace, 'app', 'page.tsx'), 'before page\n'),
        fs.writeFile(path.join(workspace, 'app', 'globals.css'), 'before css\n'),
      ]);
      const preparationTime = new Date(START.getTime() + 500);
      let now = preparationTime;
      const repository = new InMemoryAgentRuntimeRepository({ now: () => now });
      const run = await expiredRun(repository, 'pi-agent-expired-partial-write');
      const operationId = `op_${'b'.repeat(64)}`;
      const prepared = await repository.prepareToolExecution({
        runId: run.id,
        expectedVersion: run.version,
        leaseOwner: 'worker:old',
        fencingToken: run.fencingToken,
        workspaceFencingToken: run.workspaceFencingToken,
        now,
        operationId,
        toolCallId: 'sha256:partial-call',
        toolName: 'apply_dashboard_spec',
        inputHash: 'sha256:partial-input',
        effect: 'workspace_write',
        idempotency: 'reconcile_required',
      });
      const journal = await preparePiAgentWorkspaceMutationJournal({
        workspaceRoot: workspace,
        runId: run.id,
        operationId,
        files: [
          {
            target: 'app/page.tsx',
            content: Buffer.from('after page\n'),
            existedBefore: true,
            mode: 0o644,
            beforeSha256: hash('before page\n'),
            afterSha256: hash('after page\n'),
          },
          {
            target: 'app/globals.css',
            content: Buffer.from('after css\n'),
            existedBefore: true,
            mode: 0o644,
            beforeSha256: hash('before css\n'),
            afterSha256: hash('after css\n'),
          },
        ],
      });
      await repository.commitWorkspaceMutation({
        runId: run.id,
        expectedVersion: prepared.run.version,
        leaseOwner: 'worker:old',
        fencingToken: run.fencingToken,
        workspaceFencingToken: run.workspaceFencingToken,
        now,
        operationId,
      }, async () => {
        await setPiAgentWorkspaceMutationJournalState(journal, 'committing');
        await fs.rename(
          path.join(journal.transactionDirectory, 'staged', '0'),
          path.join(workspace, 'app', 'page.tsx'),
        );
      });
      now = new Date(START.getTime() + 2_000);

      const result = await reconcileExpiredPiAgentRuns({
        repository,
        projectId: 'project-recovery',
        workspaceRoot: workspace,
        now,
        ownerId: 'reconciler:test',
      });

      expect(result).toEqual({
        interruptedRunIds: [run.id],
        blocked: [],
        racedRunIds: [],
      });
      await expect(fs.readFile(path.join(workspace, 'app', 'page.tsx'), 'utf8'))
        .resolves.toBe('before page\n');
      await expect(fs.readFile(path.join(workspace, 'app', 'globals.css'), 'utf8'))
        .resolves.toBe('before css\n');
      expect(await repository.getToolExecution(operationId)).toMatchObject({
        status: 'failed',
        errorCode: 'WORKSPACE_MUTATION_ROLLED_BACK',
      });
      expect(await repository.getRun(run.id)).toMatchObject({ status: 'interrupted' });
      await expect(listPiAgentWorkspaceMutationJournals(workspace)).resolves.toEqual([]);
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it('recovers a terminal attempt that crashed with a prepared journal', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-agent-recovery-terminal-'));
    try {
      await fs.mkdir(path.join(workspace, 'app'));
      await fs.writeFile(path.join(workspace, 'app', 'page.tsx'), 'before\n');
      const preparationTime = new Date(START.getTime() + 500);
      let now = preparationTime;
      const repository = new InMemoryAgentRuntimeRepository({ now: () => now });
      const run = await expiredRun(repository, 'pi-agent-terminal-unresolved-write');
      const operationId = `op_${'c'.repeat(64)}`;
      const prepared = await repository.prepareToolExecution({
        runId: run.id,
        expectedVersion: run.version,
        leaseOwner: 'worker:old',
        fencingToken: run.fencingToken,
        workspaceFencingToken: run.workspaceFencingToken,
        now,
        operationId,
        toolCallId: 'sha256:terminal-call',
        toolName: 'write_file',
        inputHash: 'sha256:terminal-input',
        effect: 'workspace_write',
        idempotency: 'reconcile_required',
      });
      await preparePiAgentWorkspaceMutationJournal({
        workspaceRoot: workspace,
        runId: run.id,
        operationId,
        files: [{
          target: 'app/page.tsx',
          content: Buffer.from('after\n'),
          existedBefore: true,
          mode: 0o644,
          beforeSha256: hash('before\n'),
          afterSha256: hash('after\n'),
        }],
      });
      await repository.completeRun({
        runId: run.id,
        expectedVersion: prepared.run.version,
        leaseOwner: 'worker:old',
        fencingToken: run.fencingToken,
        workspaceFencingToken: run.workspaceFencingToken,
        now,
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
        error: { code: 'CANCELLED', message: 'cancelled' },
      });
      now = new Date(START.getTime() + 2_000);

      const result = await reconcileExpiredPiAgentRuns({
        repository,
        projectId: 'project-recovery',
        workspaceRoot: workspace,
        now,
        ownerId: 'reconciler:test',
      });

      expect(result.blocked).toEqual([]);
      expect(result.interruptedRunIds).toEqual([run.id]);
      expect(await repository.getToolExecution(operationId)).toMatchObject({ status: 'failed' });
      expect(await repository.getRun(run.id)).toMatchObject({ status: 'interrupted' });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });

  it('keeps recovery blocked without overwriting a user edit after an interrupted commit', async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-agent-recovery-conflict-'));
    try {
      await fs.mkdir(path.join(workspace, 'app'));
      await fs.writeFile(path.join(workspace, 'app', 'page.tsx'), 'before\n');
      const preparationTime = new Date(START.getTime() + 500);
      let now = preparationTime;
      const repository = new InMemoryAgentRuntimeRepository({ now: () => now });
      const run = await expiredRun(repository, 'pi-agent-expired-user-conflict');
      const operationId = `op_${'d'.repeat(64)}`;
      const prepared = await repository.prepareToolExecution({
        runId: run.id,
        expectedVersion: run.version,
        leaseOwner: 'worker:old',
        fencingToken: run.fencingToken,
        workspaceFencingToken: run.workspaceFencingToken,
        now,
        operationId,
        toolCallId: 'sha256:conflict-call',
        toolName: 'write_file',
        inputHash: 'sha256:conflict-input',
        effect: 'workspace_write',
        idempotency: 'reconcile_required',
      });
      const journal = await preparePiAgentWorkspaceMutationJournal({
        workspaceRoot: workspace,
        runId: run.id,
        operationId,
        files: [{
          target: 'app/page.tsx',
          content: Buffer.from('after\n'),
          existedBefore: true,
          mode: 0o644,
          beforeSha256: hash('before\n'),
          afterSha256: hash('after\n'),
        }],
      });
      await repository.commitWorkspaceMutation({
        runId: run.id,
        expectedVersion: prepared.run.version,
        leaseOwner: 'worker:old',
        fencingToken: run.fencingToken,
        workspaceFencingToken: run.workspaceFencingToken,
        now,
        operationId,
      }, async () => {
        await setPiAgentWorkspaceMutationJournalState(journal, 'committing');
        await fs.rename(
          path.join(journal.transactionDirectory, 'staged', '0'),
          path.join(workspace, 'app', 'page.tsx'),
        );
      });
      await fs.writeFile(path.join(workspace, 'app', 'page.tsx'), 'user edit\n');
      now = new Date(START.getTime() + 2_000);

      const result = await reconcileExpiredPiAgentRuns({
        repository,
        projectId: 'project-recovery',
        workspaceRoot: workspace,
        now,
        ownerId: 'reconciler:test',
      });

      expect(result.blocked).toEqual([{ runId: run.id, operationIds: [operationId] }]);
      await expect(fs.readFile(path.join(workspace, 'app', 'page.tsx'), 'utf8'))
        .resolves.toBe('user edit\n');
      expect(await repository.getToolExecution(operationId)).toMatchObject({
        status: 'commit_authorized',
      });
    } finally {
      await fs.rm(workspace, { recursive: true, force: true });
    }
  });
});
