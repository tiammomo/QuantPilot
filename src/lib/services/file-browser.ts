/**
 * File Browser Service - Project file browsing utility
 */

import fs from 'fs/promises';
import path from 'path';
import {
  MoAgentWorkspaceResourceLockError,
  withMoAgentWorkspaceResourceLock,
} from '@/lib/agent/runtime/workspace-resource-lock';
import { getProjectById } from '@/lib/services/project';
import type { ProjectFileEntry } from '@/types/backend';
import type { Project } from '@/types/backend';

const EXCLUDED_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.next',
  '.turbo',
  '.cache',
  '.vercel',
  '.idea',
  '.vscode',
]);

const EXCLUDED_FILES = new Set(['.DS_Store']);

const SENSITIVE_DIRECTORY_NAMES = new Set([
  '.aws',
  '.azure',
  '.gnupg',
  '.secrets',
  '.ssh',
]);

const SENSITIVE_FILE_NAMES = new Set([
  '.envrc',
  '.git-credentials',
  '.htpasswd',
  '.netrc',
  '.npmrc',
  '.pypirc',
  'credentials.json',
  'docker-config.json',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
  'kubeconfig',
  'secret.json',
  'secrets.json',
  'secrets.yaml',
  'secrets.yml',
  'service-account.json',
  'service_account.json',
]);

const SENSITIVE_FILE_SUFFIXES = [
  '.jks',
  '.key',
  '.keystore',
  '.p12',
  '.pem',
  '.pfx',
  '.tfstate',
  '.tfstate.backup',
];

const SAFE_ENV_TEMPLATE_PATTERN = /^\.env\.(?:example|sample|template)$/i;

/**
 * Files that may contain credentials are never exposed through the generic
 * project-file APIs. Secret management must use its dedicated API; this guard
 * is intentionally independent from route-level role checks so a future route
 * cannot accidentally make credentials readable to viewers.
 */
export function isSensitiveProjectPath(targetPath: string): boolean {
  const segments = targetPath
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.');
  const normalizedSegments = segments.map((segment) => segment.toLowerCase());

  if (normalizedSegments.some((segment) => SENSITIVE_DIRECTORY_NAMES.has(segment))) {
    return true;
  }

  const fileName = normalizedSegments.at(-1);
  if (!fileName) return false;
  if (fileName === '..' || normalizedSegments.includes('..')) return true;
  if (fileName.startsWith('.env') && !SAFE_ENV_TEMPLATE_PATTERN.test(fileName)) {
    return true;
  }
  if (SENSITIVE_FILE_NAMES.has(fileName)) return true;
  return SENSITIVE_FILE_SUFFIXES.some((suffix) => fileName.endsWith(suffix));
}

export function assertProjectFilePathAllowed(targetPath: string): void {
  if (isSensitiveProjectPath(targetPath)) {
    // Use the same response as a missing file to avoid disclosing secret names.
    throw new FileBrowserError('File not found', 404);
  }
}

export class FileBrowserError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'FileBrowserError';
    this.status = status;
  }
}

function resolveRepoRoot(project: Project): string {
  const repoPath =
    project.repoPath || path.join('data', 'projects', project.id);
  const absolutePath = path.isAbsolute(repoPath)
    ? repoPath
    : path.resolve(/*turbopackIgnore: true*/ process.cwd(), repoPath);
  return absolutePath;
}

async function resolveSafePath(base: string, target: string): Promise<string> {
  const normalizedBase = path.resolve(base);
  const resolvedTarget = path.resolve(normalizedBase, target);

  // Validate base path exists
  try {
    await fs.access(normalizedBase);
  } catch {
    throw new FileBrowserError('Base path does not exist', 400);
  }

  // Validate path is within base directory
  if (
    resolvedTarget !== normalizedBase &&
    !resolvedTarget.startsWith(normalizedBase + path.sep)
  ) {
    throw new FileBrowserError('Path traversal not allowed', 400);
  }

  // Lexical containment is insufficient when a caller addresses a symlink
  // directly. Resolve existing targets and verify both canonical containment
  // and the canonical relative path against the credential policy.
  try {
    const [canonicalBase, canonicalTarget] = await Promise.all([
      fs.realpath(normalizedBase),
      fs.realpath(resolvedTarget),
    ]);
    if (
      canonicalTarget !== canonicalBase &&
      !canonicalTarget.startsWith(canonicalBase + path.sep)
    ) {
      throw new FileBrowserError('Path traversal not allowed', 400);
    }
    assertProjectFilePathAllowed(path.relative(canonicalBase, canonicalTarget) || '.');
  } catch (error) {
    if (error instanceof FileBrowserError) throw error;
    // Missing targets retain the existing caller-specific 404 behavior.
  }

  return resolvedTarget;
}

function normalizeRelativePath(dir: string): string {
  const cleaned = dir
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/\/+$/, '');
  if (cleaned === '') {
    return '.';
  }
  return cleaned;
}

function joinRelativePath(parent: string, child: string): string {
  if (parent === '.' || parent === '') {
    return child;
  }
  return `${parent.replace(/\\/g, '/')}/${child}`;
}

async function directoryHasVisibleChildren(
  absolutePath: string,
  relativePath: string,
): Promise<boolean> {
  try {
    const entries = await fs.readdir(absolutePath, { withFileTypes: true });
    return entries.some((entry) => {
      if (entry.isSymbolicLink()) return false;
      if (isSensitiveProjectPath(joinRelativePath(relativePath, entry.name))) {
        return false;
      }
      if (entry.isDirectory()) {
        return !EXCLUDED_DIRECTORIES.has(entry.name);
      }
      return !EXCLUDED_FILES.has(entry.name);
    });
  } catch {
    return false;
  }
}

export async function listProjectDirectory(
  projectId: string,
  dir = '.'
): Promise<ProjectFileEntry[]> {
  const project = await getProjectById(projectId);
  if (!project) {
    throw new FileBrowserError('Project not found', 404);
  }

  const repoRoot = resolveRepoRoot(project);
  const targetDir = normalizeRelativePath(dir);
  assertProjectFilePathAllowed(targetDir);
  const absoluteDir = await resolveSafePath(repoRoot, targetDir === '.' ? '.' : targetDir);

  let stats;
  try {
    stats = await fs.stat(absoluteDir);
  } catch (error) {
    throw new FileBrowserError('Directory not found', 404);
  }

  if (!stats.isDirectory()) {
    throw new FileBrowserError('Not a directory', 400);
  }

  let dirEntries;
  try {
    dirEntries = await fs.readdir(absoluteDir, { withFileTypes: true });
  } catch (error) {
    throw new FileBrowserError('Failed to read directory', 500);
  }

  const entries: ProjectFileEntry[] = [];

  for (const entry of dirEntries) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const relativePath = joinRelativePath(targetDir, entry.name);
    if (isSensitiveProjectPath(relativePath)) {
      continue;
    }
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) {
      continue;
    }
    if (!entry.isDirectory() && EXCLUDED_FILES.has(entry.name)) {
      continue;
    }

    const absolutePath = await resolveSafePath(repoRoot, relativePath);

    if (entry.isDirectory()) {
      const hasChildren = await directoryHasVisibleChildren(absolutePath, relativePath);
      entries.push({
        name: entry.name,
        path: relativePath.replace(/\\/g, '/'),
        type: 'directory',
        hasChildren,
      });
    } else {
      const fileStats = await fs.stat(absolutePath);
      entries.push({
        name: entry.name,
        path: relativePath.replace(/\\/g, '/'),
        type: 'file',
        size: fileStats.size,
        hasChildren: false,
      });
    }
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });

  return entries;
}

const MAX_FILE_BYTES = 500_000; // 500KB safeguard

export async function readProjectFileContent(
  projectId: string,
  filePath: string
): Promise<{ path: string; content: string }> {
  const project = await getProjectById(projectId);
  if (!project) {
    throw new FileBrowserError('Project not found', 404);
  }

  const repoRoot = resolveRepoRoot(project);
  const normalizedPath = normalizeRelativePath(filePath);
  assertProjectFilePathAllowed(normalizedPath);
  const absolutePath = await resolveSafePath(
    repoRoot,
    normalizedPath === '.' ? '.' : normalizedPath
  );

  let stats;
  try {
    stats = await fs.stat(absolutePath);
  } catch (error) {
    throw new FileBrowserError('File not found', 404);
  }

  if (!stats.isFile()) {
    throw new FileBrowserError('Not a file', 400);
  }

  if (stats.size > MAX_FILE_BYTES) {
    throw new FileBrowserError('File too large to display', 400);
  }

  try {
    const content = await fs.readFile(absolutePath, 'utf-8');
    return {
      path: normalizedPath.replace(/\\/g, '/'),
      content,
    };
  } catch (error) {
    throw new FileBrowserError('Failed to read file', 500);
  }
}

const MAX_WRITE_BYTES = 1_000_000; // 1MB safeguard

export async function writeProjectFileContent(
  projectId: string,
  filePath: string,
  content: string
): Promise<void> {
  const project = await getProjectById(projectId);
  if (!project) {
    throw new FileBrowserError('Project not found', 404);
  }

  if (typeof content !== 'string') {
    throw new FileBrowserError('Invalid file content', 400);
  }

  const repoRoot = resolveRepoRoot(project);
  if (content.length > MAX_WRITE_BYTES) {
    throw new FileBrowserError('File content too large', 400);
  }

  try {
    await withMoAgentWorkspaceResourceLock(repoRoot, async () => {
      const normalizedPath = normalizeRelativePath(filePath);
      assertProjectFilePathAllowed(normalizedPath);
      const absolutePath = await resolveSafePath(
        repoRoot,
        normalizedPath === '.' ? '.' : normalizedPath,
      );
      let stats;
      try {
        stats = await fs.stat(absolutePath);
      } catch {
        throw new FileBrowserError('File not found', 404);
      }
      if (!stats.isFile()) {
        throw new FileBrowserError('Not a file', 400);
      }
      await fs.writeFile(absolutePath, content, 'utf-8');
    }, {
      metadata: { purpose: 'other', projectId },
    });
  } catch (error) {
    if (error instanceof FileBrowserError) throw error;
    if (
      error instanceof MoAgentWorkspaceResourceLockError &&
      error.code === 'WORKSPACE_RESOURCE_LOCKED'
    ) {
      throw new FileBrowserError('Project files are busy; retry after generation finishes', 409);
    }
    throw new FileBrowserError('Failed to write file', 500);
  }
}
