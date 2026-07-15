import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
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

  it('lets startup recovery quarantine a provably dead same-host owner', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    const pid = child.pid;
    if (pid === undefined) throw new Error('Failed to start lock-owner child process.');
    child.kill('SIGKILL');
    await once(child, 'exit');

    const lockPath = path.join(workspace, MOAGENT_WORKSPACE_RESOURCE_LOCK_DIRECTORY);
    await fs.mkdir(lockPath);
    await fs.writeFile(path.join(lockPath, 'owner.json'), `${JSON.stringify({
      schemaVersion: 2,
      ownerId: 'dead-writer',
      pid,
      hostname: os.hostname(),
      instanceId: `${os.hostname()}:${pid}`,
      acquiredAt: new Date().toISOString(),
      purpose: 'workspace_write',
    })}\n`);

    let entered = false;
    await expect(withMoAgentWorkspaceResourceLock(workspace, async () => {
      entered = true;
      return 'recovered';
    }, {
      recoverDeadLocalOwner: true,
      waitTimeoutMs: 100,
      retryIntervalMs: 5,
    })).resolves.toBe('recovered');
    expect(entered).toBe(true);
    await expect(fs.stat(lockPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('never quarantines a live lock that replaced the dead owner it observed', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    const pid = child.pid;
    if (pid === undefined) throw new Error('Failed to start lock-owner child process.');
    child.kill('SIGKILL');
    await once(child, 'exit');

    const lockPath = path.join(workspace, MOAGENT_WORKSPACE_RESOURCE_LOCK_DIRECTORY);
    await fs.mkdir(lockPath);
    await fs.writeFile(path.join(lockPath, 'owner.json'), `${JSON.stringify({
      schemaVersion: 2,
      ownerId: 'dead-observed-owner',
      pid,
      hostname: os.hostname(),
    })}\n`);

    let resumeObserver!: () => void;
    let observerPaused!: () => void;
    const paused = new Promise<void>((resolve) => {
      observerPaused = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      resumeObserver = resolve;
    });
    let observerClock = 0;
    let staleObserverEntered = false;
    const staleObserver = withMoAgentWorkspaceResourceLock(workspace, async () => {
      staleObserverEntered = true;
    }, {
      recoverDeadLocalOwner: true,
      ownerId: 'stale-observer',
      waitTimeoutMs: 100,
      retryIntervalMs: 5,
      now: () => observerClock,
      recoveryTestHooks: {
        afterDeadOwnerObserved: async () => {
          observerPaused();
          await resume;
        },
      },
    });
    await paused;

    let releaseLiveOwner!: () => void;
    let liveOwnerEntered!: () => void;
    const liveEntered = new Promise<void>((resolve) => {
      liveOwnerEntered = resolve;
    });
    const liveOwner = withMoAgentWorkspaceResourceLock(workspace, async () => {
      liveOwnerEntered();
      await new Promise<void>((resolve) => {
        releaseLiveOwner = resolve;
      });
      return 'live-owner-complete';
    }, {
      recoverDeadLocalOwner: true,
      ownerId: 'replacement-live-owner',
      waitTimeoutMs: 500,
      retryIntervalMs: 5,
    });
    await liveEntered;

    observerClock = 100;
    resumeObserver();
    await expect(staleObserver).rejects.toMatchObject({ code: 'WORKSPACE_RESOURCE_LOCKED' });
    expect(staleObserverEntered).toBe(false);

    const replacementOwner = JSON.parse(
      await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8')
    ) as Record<string, unknown>;
    expect(replacementOwner.ownerId).toBe('replacement-live-owner');
    await expect(fs.stat(path.join(lockPath, '.recovery-claim.json')))
      .rejects.toMatchObject({ code: 'ENOENT' });

    releaseLiveOwner();
    await expect(liveOwner).resolves.toBe('live-owner-complete');
  });

  it('releases its own lock when the protected operation fails', async () => {
    await expect(withMoAgentWorkspaceResourceLock(workspace, async () => {
      throw new Error('commit failed');
    })).rejects.toThrow('commit failed');

    await expect(fs.stat(path.join(workspace, MOAGENT_WORKSPACE_RESOURCE_LOCK_DIRECTORY)))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
});
