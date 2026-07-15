import { describe, expect, it } from 'vitest';

import { InMemoryAgentRuntimeRepository } from '@/lib/agent/runtime';
import { reconcileExpiredMoAgentRuns } from './moagent-recovery';

const START = new Date('2026-07-15T00:00:00.000Z');

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
    frameworkVersion: 'moagent:1.1.0',
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

describe('MoAgent replan recovery audit', () => {
  it('closes an expired attempt with no unresolved mutation as interrupted', async () => {
    let now = START;
    const repository = new InMemoryAgentRuntimeRepository({ now: () => now });
    await expiredRun(repository, 'moagent-expired-safe');
    now = new Date(START.getTime() + 2_000);

    const result = await reconcileExpiredMoAgentRuns({
      repository,
      projectId: 'project-recovery',
      now,
      ownerId: 'reconciler:test',
    });

    expect(result).toEqual({
      interruptedRunIds: ['moagent-expired-safe'],
      blocked: [],
      racedRunIds: [],
    });
    expect(await repository.getRun('moagent-expired-safe')).toMatchObject({
      status: 'interrupted',
      errorCode: 'LEASE_EXPIRED_REPLAN_REQUIRED',
    });
  });

  it('fails closed around an expired prepared workspace mutation', async () => {
    const preparationTime = new Date(START.getTime() + 500);
    let now = preparationTime;
    const repository = new InMemoryAgentRuntimeRepository({ now: () => now });
    const run = await expiredRun(repository, 'moagent-expired-write');
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

    const result = await reconcileExpiredMoAgentRuns({
      repository,
      projectId: 'project-recovery',
      now,
      ownerId: 'reconciler:test',
    });

    expect(result.blocked).toEqual([{
      runId: 'moagent-expired-write',
      operationIds: [`op_${'a'.repeat(64)}`],
    }]);
    expect((await repository.getRun('moagent-expired-write'))?.status).toBe('running');
  });
});
