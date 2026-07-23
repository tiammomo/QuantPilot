import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { relative, resolve } from 'node:path';

export const MOAGENT_VERSION = '1.13.0' as const;
export const MOAGENT_FRAMEWORK_VERSION = `moagent:${MOAGENT_VERSION}` as const;

const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/+~-]{0,191}$/;
const GIT_REVISION_PATTERN = /^[a-f0-9]{7,64}$/i;
const MAX_GIT_PATH_LIST_BYTES = 2 * 1024 * 1024;
const MAX_TRACKED_DIFF_BYTES = 8 * 1024 * 1024;
const MAX_UNTRACKED_CONTENT_BYTES = 8 * 1024 * 1024;

export interface MoAgentBuildIdentity {
  frameworkVersion: typeof MOAGENT_FRAMEWORK_VERSION;
  buildRevision: string;
  gitRevision: string | null;
}

function normalizedRevision(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return REVISION_PATTERN.test(normalized) ? normalized : null;
}

function normalizedGitRevision(value: unknown): string | null {
  const normalized = normalizedRevision(value);
  return normalized && GIT_REVISION_PATTERN.test(normalized)
    ? normalized.toLowerCase()
    : null;
}

function readRepositoryRevision(): string | null {
  try {
    return normalizedGitRevision(execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }));
  } catch {
    return null;
  }
}

interface UntrackedFingerprintEntry {
  kind: 'file' | 'symlink';
  content: Buffer;
}

/**
 * Hashes both the path and content of every untracked file. The hard aggregate
 * budget is deliberate: callers must surface `unavailable` instead of silently
 * issuing a revision that only represents a prefix of the workspace.
 */
export function fingerprintUntrackedFiles(
  paths: readonly string[],
  options: {
    cwd?: string;
    maxContentBytes?: number;
    readEntry?: (absolutePath: string) => UntrackedFingerprintEntry;
  } = {},
): string {
  const cwd = resolve(/* turbopackIgnore: true */ options.cwd ?? process.cwd());
  const maxContentBytes = options.maxContentBytes ?? MAX_UNTRACKED_CONTENT_BYTES;
  const readEntry = options.readEntry ?? ((absolutePath: string) => {
    const stat = lstatSync(/* turbopackIgnore: true */ absolutePath);
    if (stat.isSymbolicLink()) {
      return {
        kind: 'symlink' as const,
        content: Buffer.from(readlinkSync(/* turbopackIgnore: true */ absolutePath), 'utf8'),
      };
    }
    if (!stat.isFile()) {
      throw new Error(`Unsupported untracked entry: ${absolutePath}`);
    }
    return {
      kind: 'file' as const,
      content: readFileSync(/* turbopackIgnore: true */ absolutePath),
    };
  });
  const normalizedPaths = [...new Set(paths)].sort((left, right) =>
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')),
  );
  const hash = createHash('sha256');
  let consumedBytes = 0;

  for (const path of normalizedPaths) {
    if (!path || path.includes('\0')) {
      throw new Error('Invalid untracked path');
    }
    const absolutePath = resolve(cwd, path);
    const relativePath = relative(cwd, absolutePath);
    if (relativePath === '..' || relativePath.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
      throw new Error(`Untracked path escapes workspace: ${path}`);
    }
    const entry = readEntry(absolutePath);
    consumedBytes += entry.content.byteLength;
    if (consumedBytes > maxContentBytes) {
      throw new Error(
        `Untracked content exceeds fingerprint budget (${maxContentBytes} bytes)`,
      );
    }
    const contentDigest = createHash('sha256').update(entry.content).digest();
    const pathBytes = Buffer.from(path, 'utf8');
    hash
      .update(String(pathBytes.byteLength), 'utf8')
      .update(':', 'utf8')
      .update(pathBytes)
      .update('\0', 'utf8')
      .update(entry.kind, 'utf8')
      .update('\0', 'utf8')
      .update(String(entry.content.byteLength), 'utf8')
      .update('\0', 'utf8')
      .update(contentDigest);
  }

  return hash.digest('hex');
}

function parseNullSeparatedPaths(output: Buffer): string[] {
  if (output.byteLength === 0) return [];
  const paths = output.toString('utf8').split('\0');
  if (paths.at(-1) === '') paths.pop();
  if (paths.some((path) => path.includes('\uFFFD'))) {
    throw new Error('Untracked path list is not valid UTF-8');
  }
  return paths;
}

function readWorkspaceFingerprint(): string | null {
  try {
    const status = execFileSync(
      'git',
      ['status', '--porcelain=v1', '--untracked-files=all'],
      {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: MAX_GIT_PATH_LIST_BYTES,
      },
    );
    if (!status.toString('utf8').trim()) return null;
    const diff = execFileSync(
      'git',
      ['diff', '--no-ext-diff', '--binary', 'HEAD', '--'],
      {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: MAX_TRACKED_DIFF_BYTES,
      },
    );
    const untrackedPaths = execFileSync(
      'git',
      ['ls-files', '--others', '--exclude-standard', '-z'],
      {
        cwd: process.cwd(),
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: MAX_GIT_PATH_LIST_BYTES,
      },
    );
    const untrackedFingerprint = fingerprintUntrackedFiles(
      parseNullSeparatedPaths(untrackedPaths),
    );
    return createHash('sha256')
      .update(status)
      .update('\0')
      .update(diff)
      .update('\0')
      .update(untrackedFingerprint, 'utf8')
      .digest('hex')
      .slice(0, 20);
  } catch {
    // A dirty tree that exceeds the bounded fingerprint budget remains visibly
    // unversioned instead of being mislabeled as its clean HEAD.
    return 'unavailable';
  }
}

export function resolveMoAgentBuildIdentity(options: {
  environment?: NodeJS.ProcessEnv;
  readGitRevision?: () => string | null;
  readWorkspaceFingerprint?: () => string | null;
} = {}): MoAgentBuildIdentity {
  const environment = options.environment ?? process.env;
  const deploymentGitRevision = [
    environment.VERCEL_GIT_COMMIT_SHA,
    environment.GITHUB_SHA,
    environment.CI_COMMIT_SHA,
    environment.SOURCE_VERSION,
  ].map(normalizedGitRevision).find(Boolean) ?? null;
  const repositoryGitRevision = deploymentGitRevision ??
    normalizedGitRevision((options.readGitRevision ?? readRepositoryRevision)());
  const explicitBuildRevision = normalizedRevision(environment.MOAGENT_BUILD_REVISION);
  const workspaceFingerprint = explicitBuildRevision
    ? null
    : normalizedRevision(
        (options.readWorkspaceFingerprint ?? readWorkspaceFingerprint)(),
      );
  const inferredBuildRevision = repositoryGitRevision && workspaceFingerprint
    ? `${repositoryGitRevision}-dirty.${workspaceFingerprint}`
    : repositoryGitRevision;

  return Object.freeze({
    frameworkVersion: MOAGENT_FRAMEWORK_VERSION,
    buildRevision: explicitBuildRevision ?? inferredBuildRevision ??
      `unversioned:${MOAGENT_FRAMEWORK_VERSION}`,
    gitRevision: repositoryGitRevision,
  });
}

/** Immutable process/build identity shared by runtime provenance and eval reports. */
export const MOAGENT_BUILD_IDENTITY = resolveMoAgentBuildIdentity();
export const MOAGENT_BUILD_REVISION = MOAGENT_BUILD_IDENTITY.buildRevision;
export const MOAGENT_GIT_REVISION = MOAGENT_BUILD_IDENTITY.gitRevision;
