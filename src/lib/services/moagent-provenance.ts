import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, type Hash } from 'node:crypto';

const SNAPSHOT_VERSION = 'moagent-workspace-snapshot-v1';
const IDENTITY_VERSION = 'moagent-workspace-identity-v1';
const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_HASHED_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_FILE_HASH_BYTES = 8 * 1024 * 1024;
const IGNORED_DIRECTORIES = new Set([
  '.git',
  '.next',
  'node_modules',
  // Internal concurrency metadata is not generated-project content. The
  // startup snapshot is intentionally taken while this lock directory exists.
  '.moagent-workspace.lock',
]);

export interface MoAgentWorkspaceSnapshot {
  sha256: string;
  fileCount: number;
  hashedBytes: number;
  metadataOnlyFiles: number;
}

function canonicalJson(value: unknown, ancestors = new WeakSet<object>()): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('MoAgent provenance cannot hash non-finite numbers.');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new Error('MoAgent provenance cannot hash cyclic values.');
    ancestors.add(value);
    try {
      return `[${value.map((item) => canonicalJson(item, ancestors)).join(',')}]`;
    } finally {
      ancestors.delete(value);
    }
  }
  if (typeof value === 'object' && value !== null) {
    if (ancestors.has(value)) throw new Error('MoAgent provenance cannot hash cyclic values.');
    ancestors.add(value);
    try {
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
      return `{${entries.map(([key, item]) =>
        `${JSON.stringify(key)}:${canonicalJson(item, ancestors)}`
      ).join(',')}}`;
    } finally {
      ancestors.delete(value);
    }
  }
  throw new Error(`MoAgent provenance cannot hash ${typeof value} values.`);
}

export function hashMoAgentProvenance(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export async function hashMoAgentWorkspaceIdentity(
  workspaceRoot: string,
  namespace = process.env.MOAGENT_WORKSPACE_NAMESPACE ?? 'quantpilot-local'
): Promise<string> {
  if (!namespace.trim() || Buffer.byteLength(namespace, 'utf8') > 256) {
    throw new Error('MoAgent workspace namespace must be between 1 and 256 UTF-8 bytes.');
  }
  const canonicalRoot = await fs.realpath(path.resolve(workspaceRoot));
  const hash = createHash('sha256');
  updateFramed(hash, 'version', IDENTITY_VERSION);
  updateFramed(hash, 'namespace', namespace);
  updateFramed(hash, 'canonical-root', canonicalRoot);
  return `sha256:${hash.digest('hex')}`;
}

function updateFramed(hash: Hash, label: string, value: string | Buffer): void {
  const bytes = typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
  hash.update(label).update('\0').update(String(bytes.byteLength)).update('\0').update(bytes);
}

export async function hashMoAgentWorkspace(
  workspaceRoot: string,
  options: {
    maxFiles?: number;
    maxHashedBytes?: number;
    maxFileHashBytes?: number;
  } = {}
): Promise<MoAgentWorkspaceSnapshot> {
  const root = await fs.realpath(path.resolve(workspaceRoot));
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxHashedBytes = options.maxHashedBytes ?? DEFAULT_MAX_HASHED_BYTES;
  const maxFileHashBytes = options.maxFileHashBytes ?? DEFAULT_MAX_FILE_HASH_BYTES;
  for (const [label, value] of Object.entries({ maxFiles, maxHashedBytes, maxFileHashBytes })) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${label} must be a positive safe integer.`);
    }
  }

  const hash = createHash('sha256');
  updateFramed(hash, 'version', SNAPSHOT_VERSION);
  let fileCount = 0;
  let hashedBytes = 0;
  let metadataOnlyFiles = 0;

  const visit = async (absoluteDirectory: string, relativeDirectory: string): Promise<void> => {
    const entries = await fs.readdir(absoluteDirectory, { withFileTypes: true });
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0
    );
    for (const entry of entries) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const absolutePath = path.join(absoluteDirectory, entry.name);
      const stat = await fs.lstat(absolutePath);
      if (stat.isSymbolicLink()) {
        fileCount += 1;
        if (fileCount > maxFiles) throw new Error(`Workspace snapshot exceeded ${maxFiles} entries.`);
        updateFramed(hash, 'symlink-path', relativePath);
        updateFramed(hash, 'symlink-target', await fs.readlink(absolutePath));
        continue;
      }
      if (stat.isDirectory()) {
        updateFramed(hash, 'directory', relativePath);
        await visit(absolutePath, relativePath);
        continue;
      }
      if (!stat.isFile()) continue;

      fileCount += 1;
      if (fileCount > maxFiles) throw new Error(`Workspace snapshot exceeded ${maxFiles} entries.`);
      updateFramed(hash, 'file-path', relativePath);
      updateFramed(hash, 'file-size', String(stat.size));
      if (stat.size <= maxFileHashBytes && hashedBytes + stat.size <= maxHashedBytes) {
        const content = await fs.readFile(absolutePath);
        hashedBytes += content.byteLength;
        updateFramed(hash, 'file-content', content);
      } else {
        metadataOnlyFiles += 1;
        updateFramed(hash, 'file-metadata-only', `${stat.size}:${Math.trunc(stat.mtimeMs)}`);
      }
    }
  };

  await visit(root, '');
  return {
    sha256: hash.digest('hex'),
    fileCount,
    hashedBytes,
    metadataOnlyFiles,
  };
}
