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

import {
  listProjectDirectory,
  readProjectFileContent,
  writeProjectFileContent,
} from './file-browser';

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

  it('hides credential files and rejects generic read or write access', async () => {
    await fs.writeFile(path.join(workspace, '.env'), 'API_KEY=secret', 'utf8');
    await fs.writeFile(path.join(workspace, '.env.production'), 'TOKEN=secret', 'utf8');
    await fs.writeFile(path.join(workspace, '.env.example'), 'API_KEY=', 'utf8');
    await fs.writeFile(path.join(workspace, 'client.key'), 'private-key', 'utf8');
    await fs.mkdir(path.join(workspace, '.ssh'));
    await fs.writeFile(path.join(workspace, '.ssh/id_ed25519'), 'private-key', 'utf8');
    await fs.symlink(path.join(workspace, '.env'), path.join(workspace, 'linked-config'));

    const rootEntries = await listProjectDirectory('project-lock-test');
    expect(rootEntries.map((entry) => entry.name)).toContain('.env.example');
    expect(rootEntries.map((entry) => entry.name)).not.toEqual(
      expect.arrayContaining(['.env', '.env.production', '.ssh', 'client.key']),
    );

    await expect(
      readProjectFileContent('project-lock-test', '.env'),
    ).rejects.toMatchObject({ status: 404, message: 'File not found' });
    await expect(
      listProjectDirectory('project-lock-test', '.ssh'),
    ).rejects.toMatchObject({ status: 404, message: 'File not found' });
    await expect(
      writeProjectFileContent('project-lock-test', '.env', 'API_KEY=replaced'),
    ).rejects.toMatchObject({ status: 404, message: 'File not found' });
    await expect(
      readProjectFileContent('project-lock-test', 'linked-config'),
    ).rejects.toMatchObject({ status: 404, message: 'File not found' });

    expect(await fs.readFile(path.join(workspace, '.env'), 'utf8')).toBe('API_KEY=secret');
    await expect(
      readProjectFileContent('project-lock-test', '.env.example'),
    ).resolves.toMatchObject({ content: 'API_KEY=' });
  });
});
