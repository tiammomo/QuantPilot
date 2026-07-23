import fs from 'node:fs/promises';
import path from 'node:path';

const PROJECT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u;

export interface ManagedWorkspaceLocationOptions {
  projectsDir?: string;
  cwd?: string;
}

export function assertManagedProjectId(projectId: string): string {
  const normalized = projectId.trim();
  if (!PROJECT_ID_PATTERN.test(normalized)) {
    throw new Error('Managed workspace project ID is invalid.');
  }
  return normalized;
}

export function managedProjectsRoot(
  options: ManagedWorkspaceLocationOptions = {},
): string {
  const cwd = options.cwd ?? process.cwd();
  const configured = options.projectsDir ?? process.env.PROJECTS_DIR ?? './data/projects';
  return path.resolve(cwd, configured);
}

/**
 * Resolves only the canonical managed workspace path. A database repoPath is
 * treated as an identity assertion, not as permission to select another path.
 */
export function resolveManagedWorkspacePath(
  projectId: string,
  repoPath?: string | null,
  options: ManagedWorkspaceLocationOptions = {},
): string {
  const root = managedProjectsRoot(options);
  const expected = path.join(root, assertManagedProjectId(projectId));
  if (repoPath) {
    const asserted = path.resolve(options.cwd ?? process.cwd(), repoPath);
    if (asserted !== expected) {
      throw new Error(
        `Project ${projectId} repoPath is outside its canonical managed workspace.`,
      );
    }
  }
  return expected;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function assertManagedWorkspaceExists(
  projectId: string,
  repoPath?: string | null,
  options: ManagedWorkspaceLocationOptions = {},
): Promise<string> {
  const target = resolveManagedWorkspacePath(projectId, repoPath, options);
  const root = managedProjectsRoot(options);
  const [rootStat, realRoot, targetStat] = await Promise.all([
    fs.lstat(root),
    fs.realpath(root),
    fs.lstat(target),
  ]);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('Managed projects root must be a real directory.');
  }
  if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
    throw new Error(`Project ${projectId} workspace must be a real directory.`);
  }
  const realTarget = await fs.realpath(target);
  if (!isWithin(realRoot, realTarget) || realTarget === realRoot) {
    throw new Error(`Project ${projectId} workspace escapes the managed projects root.`);
  }
  return target;
}

export async function assertManagedWorkspaceAvailable(
  projectId: string,
  options: ManagedWorkspaceLocationOptions = {},
): Promise<string> {
  const root = managedProjectsRoot(options);
  const target = resolveManagedWorkspacePath(projectId, null, options);
  await fs.mkdir(root, { recursive: true });
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('Managed projects root must be a real directory.');
  }
  const existing = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing) {
    throw new Error(`Managed workspace already exists for project ${projectId}.`);
  }
  return target;
}
