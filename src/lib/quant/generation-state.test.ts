import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cancelQuantGenerationRun,
  readQuantGenerationState,
  startQuantGenerationRun,
  updateQuantGenerationStep,
} from './generation-state';

const temporaryProjects: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryProjects.splice(0).map((projectPath) =>
      fs.rm(projectPath, { recursive: true, force: true })
    )
  );
});

describe('generation state terminal transitions', () => {
  it('does not turn a cancelled request back into completed', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'quantpilot-generation-state-'));
    temporaryProjects.push(projectPath);
    const identifiers = {
      projectPath,
      projectId: 'project-state',
      requestId: 'request-state',
    };

    await startQuantGenerationRun({
      ...identifiers,
      instruction: 'generate a dashboard',
    });
    await cancelQuantGenerationRun({ ...identifiers, reason: 'user paused' });
    await updateQuantGenerationStep({
      ...identifiers,
      stepId: 'completed',
      status: 'success',
      summary: 'late completion',
      runStatus: 'completed',
    });

    expect(await readQuantGenerationState(projectPath)).toMatchObject({
      status: 'cancelled',
      requestId: 'request-state',
    });
  });
});
