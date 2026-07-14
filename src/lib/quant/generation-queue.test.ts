import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  markQuantGenerationQueueCancelled,
  QuantGenerationCancelledError,
  readQuantGenerationQueue,
  runQuantGenerationQueued,
} from './generation-queue';

const temporaryProjects: string[] = [];

async function createProject() {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'quantpilot-generation-queue-'));
  temporaryProjects.push(projectPath);
  return projectPath;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

afterEach(async () => {
  await Promise.all(
    temporaryProjects.splice(0).map((projectPath) =>
      fs.rm(projectPath, { recursive: true, force: true })
    )
  );
});

describe('generation queue concurrency', () => {
  it('serializes tasks for the same project', async () => {
    const projectPath = await createProject();
    const projectId = `project-${Date.now()}`;
    const firstStarted = deferred();
    const releaseFirst = deferred();
    const order: string[] = [];

    const first = runQuantGenerationQueued({
      projectPath,
      projectId,
      requestId: 'request-1',
      instruction: 'first',
      task: async () => {
        order.push('first:start');
        firstStarted.resolve();
        await releaseFirst.promise;
        order.push('first:end');
      },
    });
    await firstStarted.promise;

    const second = runQuantGenerationQueued({
      projectPath,
      projectId,
      requestId: 'request-2',
      instruction: 'second',
      task: async () => {
        order.push('second:start');
        order.push('second:end');
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(['first:start']);
    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('does not start or overwrite a queued request after it is cancelled', async () => {
    const projectPath = await createProject();
    const projectId = `project-cancel-${Date.now()}`;
    const firstStarted = deferred();
    const releaseFirst = deferred();
    let secondStarted = false;

    const first = runQuantGenerationQueued({
      projectPath,
      projectId,
      requestId: 'request-running',
      instruction: 'running',
      task: async () => {
        firstStarted.resolve();
        await releaseFirst.promise;
      },
    });
    await firstStarted.promise;

    const secondResult = runQuantGenerationQueued({
      projectPath,
      projectId,
      requestId: 'request-cancelled',
      instruction: 'cancel me',
      task: async () => {
        secondStarted = true;
      },
    }).catch((error) => error);

    await markQuantGenerationQueueCancelled({
      projectPath,
      projectId,
      requestId: 'request-cancelled',
      reason: 'test cancellation',
    });
    releaseFirst.resolve();
    await first;

    const cancellation = await secondResult;
    expect(cancellation).toBeInstanceOf(QuantGenerationCancelledError);
    expect(secondStarted).toBe(false);
    const queue = await readQuantGenerationQueue(projectPath, projectId);
    expect(queue.items.find((item) => item.requestId === 'request-cancelled')).toMatchObject({
      status: 'cancelled',
      errorMessage: 'test cancellation',
    });
  });
});
