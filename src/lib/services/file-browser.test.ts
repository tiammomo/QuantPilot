import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withMoAgentWorkspaceResourceLock } from '@/lib/agent/runtime/workspace-resource-lock';

const mocks = vi.hoisted(() => ({
  getProjectById: vi.fn(),
}));

vi.mock('@/lib/services/project', () => ({
  getProjectById: mocks.getProjectById,
}));

import { writeProjectFileContent } from './file-browser';

describe('file browser workspace mutation coordination', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'file-browser-lock-'));
    await fs.mkdir(path.join(workspace, 'app'));
    await fs.writeFile(path.join(workspace, 'app/page.tsx'), 'before', 'utf8');
    mocks.getProjectById.mockResolvedValue({
      id: 'project-lock-test',
      repoPath: workspace,
    });
  });

  afterEach(async () => {
    mocks.getProjectById.mockReset();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('waits for the shared MoAgent workspace lock before saving a UI edit', async () => {
    let release!: () => void;
    let entered!: () => void;
    const lockEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = withMoAgentWorkspaceResourceLock(workspace, async () => {
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }, { ownerId: 'test-moagent-writer' });
    await lockEntered;

    let saveCompleted = false;
    const save = writeProjectFileContent(
      'project-lock-test',
      'app/page.tsx',
      'after',
    ).then(() => {
      saveCompleted = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(saveCompleted).toBe(false);
    expect(await fs.readFile(path.join(workspace, 'app/page.tsx'), 'utf8')).toBe('before');

    release();
    await held;
    await save;
    expect(await fs.readFile(path.join(workspace, 'app/page.tsx'), 'utf8')).toBe('after');
  });
});
