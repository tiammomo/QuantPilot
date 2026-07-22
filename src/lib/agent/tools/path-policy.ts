import fs from 'node:fs/promises';
import path from 'node:path';
import { MoAgentToolError } from './errors';

const PLATFORM_OWNED_DIRECTORIES = new Set(['.data-agent']);
const FORBIDDEN_DIRECTORY_SEGMENTS = new Set([
  '.git',
  '.moagent-mutation-journal',
  '.moagent-workspace.lock',
  '.next',
  '.data-agent',
  'node_modules',
  'scripts',
]);
const FORBIDDEN_FILE_NAMES = new Set([
  'bun.lock',
  'bun.lockb',
  'package-lock.json',
  'package.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]);
const SENSITIVE_READ_DIRECTORY_SEGMENTS = new Set([
  '.aws',
  '.azure',
  '.git',
  '.gnupg',
  '.moagent-mutation-journal',
  '.moagent-workspace.lock',
  '.ssh',
]);
const SENSITIVE_READ_FILE_NAMES = new Set([
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.yarnrc',
  'credentials',
  'credentials.json',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'id_rsa',
]);
const EXECUTABLE_CONFIG_PATTERN = /^(?:next|postcss|tailwind|eslint|vitest|jest|playwright)\.config\.[cm]?[jt]s$/i;
const PUBLIC_ASSET_PATTERN = /\.(?:avif|bmp|css|gif|ico|jpe?g|json|png|svg|webp|woff2?|ttf|otf)$/i;
const STYLE_PATTERN = /\.(?:css|scss|sass|less)$/i;
const SOURCE_PATTERN = /\.(?:css|ts|tsx)$/i;
const SOURCE_DIRECTORIES = new Set(['hooks', 'lib', 'src', 'types']);
const VIRTUAL_WORKSPACE_ROOTS = new Set([
  '.data-agent',
  'app',
  'components',
  'data_file',
  'evidence',
  'hooks',
  'lib',
  'public',
  'src',
  'styles',
  'types',
  'uploads',
]);

export const DEFAULT_ALLOWED_WRITE_GLOBS = [
  'app/**',
  'components/**',
  'hooks/**',
  'lib/**',
  'src/app/**',
  'src/components/**',
  'src/hooks/**',
  'src/lib/**',
  'src/styles/**',
  'src/types/**',
  'styles/**',
  'types/**',
  'public/**',
] as const;

export interface MoAgentWorkspacePolicyOptions {
  workspaceRoot: string;
  allowedWriteGlobs?: readonly string[];
  /** Defaults true. Repair scopes can remove the normal source-write surface. */
  includeDefaultWriteGlobs?: boolean;
}

export interface ResolvedWorkspacePath {
  absolutePath: string;
  canonicalPath: string;
  relativePath: string;
  canonicalRelativePath: string;
  exists: boolean;
}

function isWithin(basePath: string, candidate: string): boolean {
  const relative = path.relative(basePath, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function escapeRegExp(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

/** Supports the profile glob subset MoAgent needs: `*`, `?`, and `**`. */
export function matchesWorkspaceGlob(relativePath: string, glob: string): boolean {
  const normalizedPath = relativePath.replaceAll('\\', '/').replace(/^\.\//, '');
  const normalizedGlob = glob.replaceAll('\\', '/').replace(/^\.\//, '');
  let pattern = '';
  for (let index = 0; index < normalizedGlob.length; index += 1) {
    const character = normalizedGlob[index];
    if (character === '*' && normalizedGlob[index + 1] === '*') {
      if (normalizedGlob[index + 2] === '/') {
        pattern += '(?:.*/)?';
        index += 2;
      } else {
        pattern += '.*';
        index += 1;
      }
    } else if (character === '*') {
      pattern += '[^/]*';
    } else if (character === '?') {
      pattern += '[^/]';
    } else {
      pattern += escapeRegExp(character);
    }
  }
  return new RegExp(`^${pattern}$`).test(normalizedPath);
}

function normalizeRequestedPath(requestedPath: string, allowRoot: boolean): string {
  if (typeof requestedPath !== 'string' || requestedPath.length === 0) {
    throw new MoAgentToolError('INVALID_PATH', 'A non-empty workspace-relative path is required.');
  }
  if (requestedPath.includes('\0') || /[\r\n]/.test(requestedPath)) {
    throw new MoAgentToolError('INVALID_PATH', 'Workspace paths cannot contain control characters.');
  }
  const virtualRootMatch = requestedPath.match(/^\/([^/]+)(?:\/|$)/);
  const normalizedRequest = virtualRootMatch && VIRTUAL_WORKSPACE_ROOTS.has(virtualRootMatch[1])
    ? requestedPath.slice(1)
    : requestedPath;
  if (path.isAbsolute(normalizedRequest) || path.win32.isAbsolute(normalizedRequest)) {
    throw new MoAgentToolError('ABSOLUTE_PATH_DENIED', 'MoAgent tools accept workspace-relative paths only.');
  }
  if (normalizedRequest.includes('\\')) {
    throw new MoAgentToolError('INVALID_PATH', 'Use forward slashes in MoAgent workspace paths.');
  }

  const normalized = path.posix.normalize(normalizedRequest.replace(/^\.\//, ''));
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new MoAgentToolError('PATH_TRAVERSAL_DENIED', 'Path traversal outside the workspace is denied.');
  }
  if (!allowRoot && (normalized === '.' || normalized === '')) {
    throw new MoAgentToolError('INVALID_PATH', 'A file path is required.');
  }
  return normalized;
}

async function nearestExistingAncestor(candidate: string): Promise<{
  ancestor: string;
  canonicalAncestor: string;
}> {
  let current = candidate;
  while (true) {
    try {
      return { ancestor: current, canonicalAncestor: await fs.realpath(current) };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
      const parent = path.dirname(current);
      if (parent === current) {
        throw new MoAgentToolError('PATH_RESOLUTION_FAILED', `Cannot resolve an existing ancestor for ${candidate}.`);
      }
      current = parent;
    }
  }
}

function isPlatformOwned(relativePath: string): boolean {
  const firstSegment = relativePath.split('/')[0]?.toLowerCase();
  return PLATFORM_OWNED_DIRECTORIES.has(firstSegment);
}

function assertNotSensitiveReadPath(relativePath: string): void {
  if (relativePath === '.' || relativePath === '') return;
  const segments = relativePath.split('/').filter(Boolean);
  const normalizedSegments = segments.map((segment) => segment.toLowerCase());
  const basename = normalizedSegments.at(-1) ?? '';
  if (
    normalizedSegments.some((segment) => SENSITIVE_READ_DIRECTORY_SEGMENTS.has(segment)) ||
    basename === '.env' ||
    basename.startsWith('.env.') ||
    SENSITIVE_READ_FILE_NAMES.has(basename) ||
    /\.(?:key|p12|pfx|pem)$/i.test(basename) ||
    /(?:^|[-_.])(?:private[-_.]?key|service[-_.]?account|secrets?)(?:[-_.]|$)/i.test(basename)
  ) {
    throw new MoAgentToolError(
      'SENSITIVE_READ_PATH_DENIED',
      `Reading sensitive workspace path ${relativePath} is not permitted.`,
    );
  }
}

function assertNotSensitiveWritePath(relativePath: string): void {
  const segments = relativePath.split('/').filter(Boolean);
  const basename = segments.at(-1)?.toLowerCase() ?? '';
  if (isPlatformOwned(relativePath)) {
    throw new MoAgentToolError(
      'PLATFORM_PATH_READ_ONLY',
      'Data Agent control directories are platform-owned and permanently read-only to MoAgent.',
    );
  }
  if (segments.some((segment) => FORBIDDEN_DIRECTORY_SEGMENTS.has(segment.toLowerCase()))) {
    throw new MoAgentToolError('SENSITIVE_PATH_DENIED', `Writing to ${relativePath} is not permitted.`);
  }
  if (FORBIDDEN_FILE_NAMES.has(basename) || basename === '.env' || basename.startsWith('.env.')) {
    throw new MoAgentToolError('SENSITIVE_PATH_DENIED', `Writing to ${relativePath} is not permitted.`);
  }
  if (EXECUTABLE_CONFIG_PATTERN.test(basename)) {
    throw new MoAgentToolError('EXECUTABLE_CONFIG_DENIED', `MoAgent cannot modify executable build configuration: ${relativePath}.`);
  }
}

function isDefaultWritablePath(relativePath: string): boolean {
  if (relativePath.startsWith('app/') || relativePath.startsWith('components/')) {
    return SOURCE_PATTERN.test(relativePath);
  }
  if (relativePath.startsWith('styles/')) return STYLE_PATTERN.test(relativePath);
  if (relativePath.startsWith('public/')) return PUBLIC_ASSET_PATTERN.test(relativePath);
  if (!SOURCE_PATTERN.test(relativePath)) return false;
  const segments = relativePath.split('/');
  const [topLevel, secondLevel] = segments;
  if (segments.length < 2) return false;
  if (SOURCE_DIRECTORIES.has(topLevel) && topLevel !== 'src') return true;
  if (topLevel !== 'src' || !secondLevel) return false;
  return new Set(['app', 'components', 'hooks', 'lib', 'styles', 'types']).has(secondLevel);
}

async function assertNoSymlinkComponents(workspaceRoot: string, absolutePath: string): Promise<void> {
  const relative = path.relative(workspaceRoot, absolutePath);
  let current = workspaceRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    });
    if (!stat) return;
    if (stat.isSymbolicLink()) {
      throw new MoAgentToolError(
        'SYMLINK_WRITE_DENIED',
        `MoAgent will not write through a symbolic link component: ${toPosix(relative)}.`,
      );
    }
  }
}

export class MoAgentWorkspacePolicy {
  readonly workspaceRoot: string;
  readonly allowedWriteGlobs: readonly string[];
  readonly includeDefaultWriteGlobs: boolean;

  private constructor(
    workspaceRoot: string,
    allowedWriteGlobs: readonly string[],
    includeDefaultWriteGlobs: boolean,
  ) {
    this.workspaceRoot = workspaceRoot;
    this.allowedWriteGlobs = allowedWriteGlobs;
    this.includeDefaultWriteGlobs = includeDefaultWriteGlobs;
  }

  static async create(options: MoAgentWorkspacePolicyOptions): Promise<MoAgentWorkspacePolicy> {
    const absoluteRoot = path.resolve(options.workspaceRoot);
    const canonicalRoot = await fs.realpath(absoluteRoot).catch((error: NodeJS.ErrnoException) => {
      throw new MoAgentToolError(
        'INVALID_WORKSPACE',
        `MoAgent workspace must be an existing directory: ${absoluteRoot}.`,
        { cause: error.message },
      );
    });
    const stat = await fs.stat(canonicalRoot);
    if (!stat.isDirectory()) {
      throw new MoAgentToolError('INVALID_WORKSPACE', `MoAgent workspace is not a directory: ${absoluteRoot}.`);
    }
    return new MoAgentWorkspacePolicy(
      canonicalRoot,
      options.allowedWriteGlobs ?? [],
      options.includeDefaultWriteGlobs !== false,
    );
  }

  async resolveReadPath(requestedPath: string, options: { allowRoot?: boolean } = {}): Promise<ResolvedWorkspacePath> {
    const relativePath = normalizeRequestedPath(requestedPath, options.allowRoot ?? false);
    const absolutePath = path.resolve(this.workspaceRoot, relativePath);
    if (!isWithin(this.workspaceRoot, absolutePath)) {
      throw new MoAgentToolError('PATH_TRAVERSAL_DENIED', 'Path traversal outside the workspace is denied.');
    }

    let canonicalPath: string;
    try {
      canonicalPath = await fs.realpath(absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new MoAgentToolError('PATH_NOT_FOUND', `Workspace path does not exist: ${relativePath}.`);
      }
      throw error;
    }
    if (!isWithin(this.workspaceRoot, canonicalPath)) {
      throw new MoAgentToolError('SYMLINK_ESCAPE_DENIED', `Workspace path resolves outside the workspace: ${relativePath}.`);
    }
    const canonicalRelativePath = toPosix(path.relative(this.workspaceRoot, canonicalPath)) || '.';
    assertNotSensitiveReadPath(relativePath);
    assertNotSensitiveReadPath(canonicalRelativePath);
    return {
      absolutePath,
      canonicalPath,
      relativePath,
      canonicalRelativePath,
      exists: true,
    };
  }

  async resolveWritePath(requestedPath: string): Promise<ResolvedWorkspacePath> {
    const relativePath = normalizeRequestedPath(requestedPath, false);
    const absolutePath = path.resolve(this.workspaceRoot, relativePath);
    if (!isWithin(this.workspaceRoot, absolutePath)) {
      throw new MoAgentToolError('PATH_TRAVERSAL_DENIED', 'Path traversal outside the workspace is denied.');
    }

    assertNotSensitiveWritePath(relativePath);
    const { ancestor, canonicalAncestor } = await nearestExistingAncestor(absolutePath);
    if (!isWithin(this.workspaceRoot, canonicalAncestor)) {
      throw new MoAgentToolError('SYMLINK_ESCAPE_DENIED', `Workspace path resolves outside the workspace: ${relativePath}.`);
    }
    const unresolvedSuffix = path.relative(ancestor, absolutePath);
    const canonicalPath = path.resolve(canonicalAncestor, unresolvedSuffix);
    if (!isWithin(this.workspaceRoot, canonicalPath)) {
      throw new MoAgentToolError('SYMLINK_ESCAPE_DENIED', `Workspace path resolves outside the workspace: ${relativePath}.`);
    }
    const canonicalRelativePath = toPosix(path.relative(this.workspaceRoot, canonicalPath));
    assertNotSensitiveWritePath(canonicalRelativePath);
    await assertNoSymlinkComponents(this.workspaceRoot, absolutePath);

    let exists = false;
    try {
      const targetStat = await fs.lstat(absolutePath);
      exists = true;
      if (targetStat.isSymbolicLink()) {
        throw new MoAgentToolError(
          'SYMLINK_WRITE_DENIED',
          `MoAgent will not replace or write through a symbolic link: ${relativePath}.`,
        );
      }
      if (targetStat.isDirectory()) {
        throw new MoAgentToolError('NOT_A_FILE', `Expected a file path, received a directory: ${relativePath}.`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const extraAllowsLexical = this.allowedWriteGlobs.some((glob) => matchesWorkspaceGlob(relativePath, glob));
    const extraAllowsCanonical = this.allowedWriteGlobs.some((glob) => matchesWorkspaceGlob(canonicalRelativePath, glob));
    const lexicalAllowed =
      (this.includeDefaultWriteGlobs && isDefaultWritablePath(relativePath)) || extraAllowsLexical;
    const canonicalAllowed =
      (this.includeDefaultWriteGlobs && isDefaultWritablePath(canonicalRelativePath)) ||
      extraAllowsCanonical;
    if (!lexicalAllowed || !canonicalAllowed) {
      throw new MoAgentToolError(
        'WRITE_PATH_DENIED',
        `MoAgent profile does not allow writing to ${relativePath}.`,
        {
          allowedWriteGlobs: [
            ...(this.includeDefaultWriteGlobs ? DEFAULT_ALLOWED_WRITE_GLOBS : []),
            ...this.allowedWriteGlobs,
          ],
        },
      );
    }

    return { absolutePath, canonicalPath, relativePath, canonicalRelativePath, exists };
  }
}
