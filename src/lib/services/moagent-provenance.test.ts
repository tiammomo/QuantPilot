import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  hashMoAgentProvenance,
  hashMoAgentWorkspace,
  hashMoAgentWorkspaceIdentity,
} from './moagent-provenance';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    fs.rm(directory, { recursive: true, force: true })
  ));
});

describe('MoAgent provenance', () => {
  it('hashes object keys canonically', () => {
    expect(hashMoAgentProvenance({ b: 2, a: { y: true, x: 'v' } })).toBe(
      hashMoAgentProvenance({ a: { x: 'v', y: true }, b: 2 })
    );
  });

  it('changes the workspace hash on relevant content and ignores runtime-only directories', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'moagent-provenance-'));
    temporaryDirectories.push(root);
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.mkdir(path.join(root, 'node_modules', 'ignored'), { recursive: true });
    await fs.mkdir(path.join(root, '.moagent-workspace.lock'), { recursive: true });
    await fs.writeFile(path.join(root, 'src', 'page.tsx'), 'export default 1;');
    await fs.writeFile(path.join(root, 'node_modules', 'ignored', 'index.js'), 'first');
    await fs.writeFile(path.join(root, '.moagent-workspace.lock', 'owner.json'), 'first');

    const first = await hashMoAgentWorkspace(root);
    await fs.writeFile(path.join(root, 'node_modules', 'ignored', 'index.js'), 'second');
    await fs.writeFile(path.join(root, '.moagent-workspace.lock', 'owner.json'), 'second');
    const ignoredChange = await hashMoAgentWorkspace(root);
    await fs.writeFile(path.join(root, 'src', 'page.tsx'), 'export default 2;');
    const sourceChange = await hashMoAgentWorkspace(root);

    expect(ignoredChange.sha256).toBe(first.sha256);
    expect(sourceChange.sha256).not.toBe(first.sha256);
    expect(first).toMatchObject({ fileCount: 1, metadataOnlyFiles: 0 });
  });

  it('derives workspace identity from namespace and canonical realpath, not contents', async () => {
    const parent = await fs.mkdtemp(path.join(os.tmpdir(), 'moagent-identity-'));
    temporaryDirectories.push(parent);
    const root = path.join(parent, 'workspace');
    const alias = path.join(parent, 'workspace-alias');
    await fs.mkdir(root);
    await fs.symlink(root, alias, 'dir');
    await fs.writeFile(path.join(root, 'page.tsx'), 'first');

    const direct = await hashMoAgentWorkspaceIdentity(root, 'deployment-a');
    const viaAlias = await hashMoAgentWorkspaceIdentity(alias, 'deployment-a');
    await fs.writeFile(path.join(root, 'page.tsx'), 'second');
    const afterContentChange = await hashMoAgentWorkspaceIdentity(root, 'deployment-a');
    const otherNamespace = await hashMoAgentWorkspaceIdentity(root, 'deployment-b');

    expect(direct).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(viaAlias).toBe(direct);
    expect(afterContentChange).toBe(direct);
    expect(otherNamespace).not.toBe(direct);
  });
});
