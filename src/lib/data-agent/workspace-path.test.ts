import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  assertManagedWorkspaceAvailable,
  assertManagedWorkspaceExists,
  resolveManagedWorkspacePath,
} from './workspace-path';

const roots: string[] = [];

async function temporaryProjectsRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'data-agent-workspaces-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, {
    recursive: true,
    force: true,
  })));
});

describe('managed Data Agent workspaces', () => {
  it('resolves only the project canonical path', async () => {
    const root = await temporaryProjectsRoot();
    const expected = path.join(root, 'project-1');
    expect(resolveManagedWorkspacePath('project-1', expected, { projectsDir: root }))
      .toBe(expected);
    expect(() => resolveManagedWorkspacePath(
      'project-1',
      path.join(root, 'project-2'),
      { projectsDir: root },
    )).toThrow('outside its canonical managed workspace');
    expect(() => resolveManagedWorkspacePath('../escape', null, { projectsDir: root }))
      .toThrow('project ID is invalid');
  });

  it('rejects existing targets and symlink workspaces', async () => {
    const root = await temporaryProjectsRoot();
    const target = await assertManagedWorkspaceAvailable('project-1', {
      projectsDir: root,
    });
    await fs.mkdir(target);
    await expect(assertManagedWorkspaceAvailable('project-1', {
      projectsDir: root,
    })).rejects.toThrow('already exists');
    await expect(assertManagedWorkspaceExists('project-1', target, {
      projectsDir: root,
    })).resolves.toBe(target);

    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'data-agent-outside-'));
    roots.push(outside);
    await fs.symlink(outside, path.join(root, 'project-2'));
    await expect(assertManagedWorkspaceExists('project-2', null, {
      projectsDir: root,
    })).rejects.toThrow('must be a real directory');
  });

  it('rejects a symlink configured as the managed projects root', async () => {
    const parent = await temporaryProjectsRoot();
    const realRoot = path.join(parent, 'real-projects');
    const aliasRoot = path.join(parent, 'projects-alias');
    await fs.mkdir(realRoot);
    await fs.symlink(realRoot, aliasRoot);
    await expect(assertManagedWorkspaceAvailable('project-1', {
      projectsDir: aliasRoot,
    })).rejects.toThrow('projects root must be a real directory');
  });
});
