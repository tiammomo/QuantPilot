import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MOAGENT_WORKSPACE_RESOURCE_LOCK_DIRECTORY,
  withMoAgentWorkspaceResourceLock,
} from './workspace-resource-lock';

describe('MoAgent workspace resource lock', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moagent-resource-lock-'));
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('serializes physical workspace operations', async () => {
    let releaseFirst!: () => void;
    let firstEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const first = withMoAgentWorkspaceResourceLock(workspace, async () => {
      firstEntered();
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      return 'first';
    }, {
      retryIntervalMs: 5,
      ownerId: 'startup:run-test',
      metadata: {
        purpose: 'run_startup',
        projectId: 'project-test',
        runId: 'run-test',
      },
    });
    await entered;
    const owner = JSON.parse(await fs.readFile(path.join(
      workspace,
      MOAGENT_WORKSPACE_RESOURCE_LOCK_DIRECTORY,
      'owner.json'
    ), 'utf8')) as Record<string, unknown>;
    expect(owner).toMatchObject({
      schemaVersion: 2,
      ownerId: 'startup:run-test',
      pid: process.pid,
      purpose: 'run_startup',
      projectId: 'project-test',
      runId: 'run-test',
    });
    expect(owner.hostname).toEqual(expect.any(String));
    expect(owner.instanceId).toEqual(expect.any(String));

    let secondEntered = false;
    const second = withMoAgentWorkspaceResourceLock(workspace, async () => {
      secondEntered = true;
      return 'second';
    }, { retryIntervalMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(secondEntered).toBe(false);

    releaseFirst();
    await expect(first).resolves.toBe('first');
    await expect(second).resolves.toBe('second');
  });

  it('does not auto-break an orphaned lock', async () => {
    const lockPath = path.join(workspace, MOAGENT_WORKSPACE_RESOURCE_LOCK_DIRECTORY);
    await fs.mkdir(lockPath);
    await fs.writeFile(path.join(lockPath, 'owner.json'), '{"ownerId":"orphan"}\n');

    await expect(withMoAgentWorkspaceResourceLock(
      workspace,
      async () => undefined,
      { waitTimeoutMs: 10, retryIntervalMs: 5 }
    )).rejects.toMatchObject({ code: 'WORKSPACE_RESOURCE_LOCKED' });
    await expect(fs.stat(lockPath)).resolves.toBeDefined();
  });

  it('releases its own lock when the protected operation fails', async () => {
    await expect(withMoAgentWorkspaceResourceLock(workspace, async () => {
      throw new Error('commit failed');
    })).rejects.toThrow('commit failed');

    await expect(fs.stat(path.join(workspace, MOAGENT_WORKSPACE_RESOURCE_LOCK_DIRECTORY)))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
});
