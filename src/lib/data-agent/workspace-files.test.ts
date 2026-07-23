import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { writeWorkspaceJsonAtomic } from './workspace-files';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('atomic workspace files', () => {
  it('commits complete JSON and rejects path escapes', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'data-agent-files-'));
    roots.push(root);
    await writeWorkspaceJsonAtomic(root, '.data-agent/workspace.json', { ready: true });
    await expect(fs.readFile(
      path.join(root, '.data-agent/workspace.json'),
      'utf8',
    )).resolves.toBe('{\n  "ready": true\n}\n');
    await expect(writeWorkspaceJsonAtomic(root, '../outside.json', {}))
      .rejects.toThrow('safe relative path');
  });

  it('rejects a nested symlink escape', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'data-agent-files-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'data-agent-outside-'));
    roots.push(root, outside);
    await fs.symlink(outside, path.join(root, 'evidence'));
    await expect(writeWorkspaceJsonAtomic(root, 'evidence/nested/result.json', {}))
      .rejects.toThrow('escapes through a symbolic link');
    await expect(fs.access(path.join(outside, 'nested'))).rejects.toThrow();
  });
});
