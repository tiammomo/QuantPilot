import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { MoAgentTool } from '@/lib/agent/types';
import { withMoAgentWorkspaceResourceLock } from '@/lib/agent/runtime/workspace-resource-lock';
import { MoAgentToolError, throwIfAborted } from './errors';
import { inputRecord, optionalBoolean, optionalInteger, optionalString, requiredString } from './input';
import { matchesWorkspaceGlob, MoAgentWorkspacePolicy } from './path-policy';
import {
  DEFAULT_TOOL_OUTPUT_CHARS,
  DEFAULT_TOOL_TIMEOUT_MS,
  executeMoAgentTool,
  truncateToolOutput,
} from './runtime';

const DEFAULT_MAX_FILE_BYTES = 1_000_000;
const DEFAULT_MAX_WRITE_BYTES = 1_000_000;
const DEFAULT_MAX_LIST_ENTRIES = 300;
const DEFAULT_MAX_SEARCH_RESULTS = 100;
const IGNORED_SEARCH_DIRECTORIES = new Set([
  '.git',
  '.moagent-workspace.lock',
  '.next',
  'node_modules',
]);

export interface MoAgentFileToolOptions {
  workspaceRoot: string;
  allowedWriteGlobs?: readonly string[];
  includeDefaultWriteGlobs?: boolean;
  /** JSON paths that must be inspected through one batched query_json call, never raw readers. */
  structuredJsonReadGlobs?: readonly string[];
  timeoutMs?: number;
  maxOutputChars?: number;
  maxFileBytes?: number;
  maxWriteBytes?: number;
  resourceLockWaitTimeoutMs?: number;
}

interface FileToolRuntime {
  policy(): Promise<MoAgentWorkspacePolicy>;
  timeoutMs: number;
  maxOutputChars: number;
  maxFileBytes: number;
  maxWriteBytes: number;
  resourceLockWaitTimeoutMs?: number;
  structuredJsonReadGlobs: readonly string[];
}

function createRuntime(options: MoAgentFileToolOptions): FileToolRuntime {
  let policyPromise: Promise<MoAgentWorkspacePolicy> | undefined;
  return {
    policy: () => policyPromise ??= MoAgentWorkspacePolicy.create({
      workspaceRoot: options.workspaceRoot,
      allowedWriteGlobs: options.allowedWriteGlobs,
      includeDefaultWriteGlobs: options.includeDefaultWriteGlobs,
    }),
    timeoutMs: options.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
    maxOutputChars: options.maxOutputChars ?? DEFAULT_TOOL_OUTPUT_CHARS,
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    maxWriteBytes: options.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES,
    resourceLockWaitTimeoutMs: options.resourceLockWaitTimeoutMs,
    structuredJsonReadGlobs: options.structuredJsonReadGlobs ?? [],
  };
}

function assertPlainText(buffer: Buffer, relativePath: string): string {
  if (buffer.includes(0)) {
    throw new MoAgentToolError('BINARY_FILE_DENIED', `Cannot read binary file as text: ${relativePath}.`);
  }
  return buffer.toString('utf8');
}

async function readTextFile(
  policy: MoAgentWorkspacePolicy,
  relativePath: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{
  content: string;
  bytes: number;
  sha256: string;
  relativePath: string;
  canonicalRelativePath: string;
}> {
  throwIfAborted(signal);
  const resolved = await policy.resolveReadPath(relativePath);
  const stat = await fs.stat(resolved.canonicalPath);
  if (!stat.isFile()) {
    throw new MoAgentToolError('NOT_A_FILE', `Expected a file: ${resolved.relativePath}.`);
  }
  if (stat.size > maxBytes) {
    throw new MoAgentToolError(
      'FILE_TOO_LARGE',
      `File is ${stat.size} bytes; MoAgent file tools allow at most ${maxBytes} bytes.`,
    );
  }
  const buffer = await fs.readFile(resolved.canonicalPath, { signal });
  return {
    content: assertPlainText(buffer, resolved.relativePath),
    bytes: buffer.byteLength,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    relativePath: resolved.relativePath,
    canonicalRelativePath: resolved.canonicalRelativePath,
  };
}

function isValidJson(content: string): boolean {
  try {
    JSON.parse(content);
    return true;
  } catch {
    return false;
  }
}

function assertRawJsonReadAllowed(
  runtime: FileToolRuntime,
  relativePath: string,
  canonicalRelativePath: string,
  content: string,
): void {
  if (
    (!/\.json$/i.test(relativePath) && !/\.json$/i.test(canonicalRelativePath)) ||
    !isValidJson(content)
  ) return;
  const explicitlyStructured = runtime.structuredJsonReadGlobs.some((glob) =>
    matchesWorkspaceGlob(relativePath, glob) || matchesWorkspaceGlob(canonicalRelativePath, glob)
  );
  if (!explicitlyStructured && content.length <= runtime.maxOutputChars) return;
  throw new MoAgentToolError(
    'STRUCTURED_JSON_QUERY_REQUIRED',
    `Use one query_json call with all required paths in its pointers array for ${relativePath}; raw JSON reads are disabled to prevent sequential scans and context inflation.`,
    {
      path: relativePath,
      characters: content.length,
      reason: explicitlyStructured ? 'structured_path_policy' : 'large_json',
    },
  );
}

interface ListedEntry {
  path: string;
  type: 'file' | 'directory' | 'symlink';
  bytes?: number;
}

async function sha256File(filePath: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(64 * 1024);
  const handle = await fs.open(filePath, 'r');
  let position = 0;
  try {
    while (true) {
      throwIfAborted(signal);
      const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function collectEntries(params: {
  policy: MoAgentWorkspacePolicy;
  startPath: string;
  recursive: boolean;
  maxDepth: number;
  maxEntries: number;
  signal: AbortSignal;
  ignoreSearchDirectories?: boolean;
}): Promise<{
  entries: ListedEntry[];
  truncated: boolean;
  skippedUnsafeLinks: number;
  skippedSensitivePaths: number;
}> {
  const start = await params.policy.resolveReadPath(params.startPath, { allowRoot: true });
  const startStat = await fs.stat(start.canonicalPath);
  if (!startStat.isDirectory()) {
    return {
      entries: [{ path: start.relativePath, type: 'file', bytes: startStat.size }],
      truncated: false,
      skippedUnsafeLinks: 0,
      skippedSensitivePaths: 0,
    };
  }

  const entries: ListedEntry[] = [];
  const visitedDirectories = new Set<string>();
  let truncated = false;
  let skippedUnsafeLinks = 0;
  let skippedSensitivePaths = 0;

  const visit = async (lexicalDirectory: string, canonicalDirectory: string, depth: number): Promise<void> => {
    throwIfAborted(params.signal);
    if (entries.length >= params.maxEntries) {
      truncated = true;
      return;
    }
    const canonicalKey = await fs.realpath(canonicalDirectory);
    if (visitedDirectories.has(canonicalKey)) return;
    visitedDirectories.add(canonicalKey);

    const directoryEntries = await fs.readdir(canonicalDirectory, { withFileTypes: true });
    directoryEntries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of directoryEntries) {
      throwIfAborted(params.signal);
      if (entries.length >= params.maxEntries) {
        truncated = true;
        return;
      }
      if (params.ignoreSearchDirectories && entry.isDirectory() && IGNORED_SEARCH_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const relativePath = lexicalDirectory === '.' ? entry.name : `${lexicalDirectory}/${entry.name}`;
      let resolved;
      try {
        resolved = await params.policy.resolveReadPath(relativePath);
      } catch (error) {
        if (entry.isSymbolicLink() && error instanceof MoAgentToolError && error.code === 'SYMLINK_ESCAPE_DENIED') {
          skippedUnsafeLinks += 1;
          continue;
        }
        if (error instanceof MoAgentToolError && error.code === 'SENSITIVE_READ_PATH_DENIED') {
          skippedSensitivePaths += 1;
          continue;
        }
        throw error;
      }
      const stat = await fs.stat(resolved.canonicalPath);
      const type: ListedEntry['type'] = entry.isSymbolicLink()
        ? 'symlink'
        : stat.isDirectory()
          ? 'directory'
          : 'file';
      entries.push({ path: relativePath, type, ...(stat.isFile() ? { bytes: stat.size } : {}) });
      if (
        params.recursive &&
        stat.isDirectory() &&
        depth < params.maxDepth &&
        !(params.ignoreSearchDirectories && IGNORED_SEARCH_DIRECTORIES.has(entry.name))
      ) {
        await visit(relativePath, resolved.canonicalPath, depth + 1);
      }
    }
  };

  await visit(start.relativePath, start.canonicalPath, 0);
  return { entries, truncated, skippedUnsafeLinks, skippedSensitivePaths };
}

interface AtomicWriteParams {
  policy: MoAgentWorkspacePolicy;
  relativePath: string;
  content: Buffer;
  maxBytes: number;
  signal: AbortSignal;
  expectedBeforeSha256?: string | null;
  resourceLockWaitTimeoutMs?: number;
  lockIdentity: { runId: string; operationId: string };
  commitWorkspaceMutation?: <T>(commit: () => Promise<T>) => Promise<T>;
}

interface AtomicWriteResult {
  path: string;
  bytes: number;
  created: boolean;
  beforeSha256: string | null;
  afterSha256: string;
}

async function atomicWrite(params: AtomicWriteParams): Promise<AtomicWriteResult> {
  throwIfAborted(params.signal);
  if (!params.commitWorkspaceMutation) {
    throw new MoAgentToolError(
      'WORKSPACE_COMMIT_FENCE_REQUIRED',
      'Workspace writes require a durable mutation commit fence.',
    );
  }
  if (params.content.byteLength > params.maxBytes) {
    throw new MoAgentToolError(
      'WRITE_TOO_LARGE',
      `Write is ${params.content.byteLength} bytes; MoAgent allows at most ${params.maxBytes} bytes.`,
    );
  }
  return withMoAgentWorkspaceResourceLock(
    params.policy.workspaceRoot,
    () => atomicWriteWithResourceLock(params),
    {
      signal: params.signal,
      ...(params.resourceLockWaitTimeoutMs === undefined
        ? {}
        : { waitTimeoutMs: params.resourceLockWaitTimeoutMs }),
      ownerId: `write:${params.lockIdentity.operationId}`,
      metadata: {
        purpose: 'workspace_write',
        runId: params.lockIdentity.runId,
        operationId: params.lockIdentity.operationId,
      },
    }
  );
}

async function atomicWriteWithResourceLock(
  params: AtomicWriteParams
): Promise<AtomicWriteResult> {
  throwIfAborted(params.signal);
  const firstResolution = await params.policy.resolveWritePath(params.relativePath);
  // Create through the already-canonicalized path. A lexical parent may be an
  // in-workspace symlink and must never be followed after the policy check.
  await fs.mkdir(path.dirname(firstResolution.canonicalPath), { recursive: true });
  const resolved = await params.policy.resolveWritePath(params.relativePath);
  const previousMode = resolved.exists ? (await fs.stat(resolved.canonicalPath)).mode : 0o644;
  const beforeSha256 = resolved.exists
    ? await sha256File(resolved.canonicalPath, params.signal)
    : null;
  if (
    params.expectedBeforeSha256 !== undefined &&
    params.expectedBeforeSha256 !== beforeSha256
  ) {
    throw new MoAgentToolError(
      'WORKSPACE_WRITE_CONFLICT',
      `The target changed before MoAgent could commit: ${resolved.relativePath}.`,
    );
  }
  const afterSha256 = createHash('sha256').update(params.content).digest('hex');
  const temporaryPath = path.join(
    path.dirname(resolved.canonicalPath),
    `.${path.basename(resolved.canonicalPath)}.moagent-${randomUUID()}.tmp`,
  );
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temporaryPath, 'wx', previousMode & 0o777);
    throwIfAborted(params.signal);
    await handle.writeFile(params.content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    throwIfAborted(params.signal);
    await params.commitWorkspaceMutation!(async () => {
      throwIfAborted(params.signal);
      // The shared-filesystem resource lock remains held across this final
      // target revalidation and rename. The repository has already committed
      // a one-shot authorization under the current DB fence.
      const finalResolution = await params.policy.resolveWritePath(params.relativePath);
      if (finalResolution.exists !== resolved.exists) {
        throw new MoAgentToolError(
          'WORKSPACE_WRITE_CONFLICT',
          `The target existence changed before commit: ${resolved.relativePath}.`,
        );
      }
      if (
        finalResolution.exists &&
        await sha256File(finalResolution.canonicalPath, params.signal) !== beforeSha256
      ) {
        throw new MoAgentToolError(
          'WORKSPACE_WRITE_CONFLICT',
          `The target content changed before commit: ${resolved.relativePath}.`,
        );
      }
      await fs.rename(temporaryPath, finalResolution.canonicalPath);
    });
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return {
    path: resolved.relativePath,
    bytes: params.content.byteLength,
    created: !resolved.exists,
    beforeSha256,
    afterSha256,
  };
}

interface ListFilesInput {
  path: string;
  recursive: boolean;
  maxDepth: number;
  maxEntries: number;
}

function parseListFilesInput(value: unknown): ListFilesInput {
  const record = inputRecord(value);
  return {
    path: optionalString(record, 'path', '.', { maxLength: 1_024 }),
    recursive: optionalBoolean(record, 'recursive', true),
    maxDepth: optionalInteger(record, 'maxDepth', 4, { min: 0, max: 12 }),
    maxEntries: optionalInteger(record, 'maxEntries', DEFAULT_MAX_LIST_ENTRIES, { min: 1, max: 1_000 }),
  };
}

export function createListFilesTool(options: MoAgentFileToolOptions): MoAgentTool<ListFilesInput> {
  const runtime = createRuntime(options);
  return {
    name: 'list_files',
    description: 'List files in the MoAgent workspace. Paths must be relative; host filesystem access is unavailable.',
    effect: 'read',
    idempotency: 'intrinsic',
    observationCache: 'workspace_generation',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative directory. Defaults to .'},
        recursive: { type: 'boolean', default: true },
        maxDepth: { type: 'integer', minimum: 0, maximum: 12, default: 4 },
        maxEntries: { type: 'integer', minimum: 1, maximum: 1000, default: DEFAULT_MAX_LIST_ENTRIES },
      },
      additionalProperties: false,
    },
    parseInput: parseListFilesInput,
    execute: (input, context) => executeMoAgentTool(context.signal, runtime.timeoutMs, async (signal) => {
      const result = await collectEntries({
        policy: await runtime.policy(),
        startPath: input.path,
        recursive: input.recursive,
        maxDepth: input.maxDepth,
        maxEntries: input.maxEntries,
        signal,
      });
      const rendered = result.entries
        .map((entry) => `${entry.type === 'directory' ? 'dir' : entry.type}${entry.bytes === undefined ? '' : ` ${entry.bytes}b`}\t${entry.path}`)
        .join('\n');
      const output = truncateToolOutput(rendered, runtime.maxOutputChars);
      return {
        ok: true,
        data: {
          entryCount: result.entries.length,
          truncated: result.truncated || output.truncated,
          skippedUnsafeLinks: result.skippedUnsafeLinks,
          skippedSensitivePaths: result.skippedSensitivePaths,
        },
        content: output.text,
      };
    }),
  };
}

interface ReadFileInput { path: string }

function parseReadFileInput(value: unknown): ReadFileInput {
  return { path: requiredString(inputRecord(value), 'path', { maxLength: 1_024 }) };
}

export function createReadFileTool(options: MoAgentFileToolOptions): MoAgentTool<ReadFileInput> {
  const runtime = createRuntime(options);
  return {
    name: 'read_file',
    description: 'Read a UTF-8 text file inside the MoAgent workspace. Use one batched query_json call for final/evidence JSON; raw reads of structured or large valid JSON are rejected.',
    effect: 'read',
    idempotency: 'intrinsic',
    observationCache: 'workspace_generation',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Workspace-relative file path.' } },
      required: ['path'],
      additionalProperties: false,
    },
    parseInput: parseReadFileInput,
    execute: (input, context) => executeMoAgentTool(context.signal, runtime.timeoutMs, async (signal) => {
      const file = await readTextFile(await runtime.policy(), input.path, runtime.maxFileBytes, signal);
      assertRawJsonReadAllowed(
        runtime,
        file.relativePath,
        file.canonicalRelativePath,
        file.content,
      );
      const output = truncateToolOutput(file.content, runtime.maxOutputChars);
      return {
        ok: true,
        data: {
          path: input.path,
          bytes: file.bytes,
          truncated: output.truncated,
          originalChars: output.originalChars,
        },
        content: output.text,
      };
    }),
  };
}

interface ReadFileRangeInput { path: string; startLine: number; endLine: number }

function parseReadFileRangeInput(value: unknown): ReadFileRangeInput {
  const record = inputRecord(value);
  const startLine = optionalInteger(record, 'startLine', 1, { min: 1, max: 1_000_000 });
  const endLine = optionalInteger(record, 'endLine', startLine + 199, { min: startLine, max: 1_000_000 });
  if (endLine - startLine + 1 > 500) {
    throw new MoAgentToolError('INVALID_TOOL_INPUT', 'read_file_range accepts at most 500 lines per call.');
  }
  return { path: requiredString(record, 'path', { maxLength: 1_024 }), startLine, endLine };
}

export function createReadFileRangeTool(options: MoAgentFileToolOptions): MoAgentTool<ReadFileRangeInput> {
  const runtime = createRuntime(options);
  return {
    name: 'read_file_range',
    description: 'Read an inclusive, one-based line range from a UTF-8 workspace file (maximum 500 lines). Use query_json for JSON and query_text_file with an anchors array for batched source inspection.',
    effect: 'read',
    idempotency: 'intrinsic',
    observationCache: 'workspace_generation',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        startLine: { type: 'integer', minimum: 1, default: 1 },
        endLine: { type: 'integer', minimum: 1, description: 'Inclusive; defaults to startLine + 199.' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    parseInput: parseReadFileRangeInput,
    execute: (input, context) => executeMoAgentTool(context.signal, runtime.timeoutMs, async (signal) => {
      const file = await readTextFile(await runtime.policy(), input.path, runtime.maxFileBytes, signal);
      assertRawJsonReadAllowed(
        runtime,
        file.relativePath,
        file.canonicalRelativePath,
        file.content,
      );
      const lines = file.content.split(/\r?\n/);
      const selected = lines.slice(input.startLine - 1, input.endLine);
      const rendered = selected.map((line, index) => `${input.startLine + index}: ${line}`).join('\n');
      const output = truncateToolOutput(rendered, runtime.maxOutputChars);
      return {
        ok: true,
        data: {
          path: input.path,
          startLine: input.startLine,
          endLine: Math.min(input.endLine, lines.length),
          totalLines: lines.length,
          truncated: output.truncated,
        },
        content: output.text,
      };
    }),
  };
}

interface SearchFilesInput {
  query: string;
  path: string;
  fileGlob?: string;
  caseSensitive: boolean;
  maxResults: number;
}

function parseSearchFilesInput(value: unknown): SearchFilesInput {
  const record = inputRecord(value);
  const fileGlob = record.fileGlob === undefined
    ? undefined
    : requiredString(record, 'fileGlob', { maxLength: 256 });
  return {
    query: requiredString(record, 'query', { maxLength: 2_000 }),
    path: optionalString(record, 'path', '.', { maxLength: 1_024 }),
    fileGlob,
    caseSensitive: optionalBoolean(record, 'caseSensitive', false),
    maxResults: optionalInteger(record, 'maxResults', DEFAULT_MAX_SEARCH_RESULTS, { min: 1, max: 500 }),
  };
}

export function createSearchFilesTool(options: MoAgentFileToolOptions): MoAgentTool<SearchFilesInput> {
  const runtime = createRuntime(options);
  return {
    name: 'search_files',
    description: 'Search workspace text files for a literal string. This is a typed, bounded replacement for shell grep/rg.',
    effect: 'read',
    idempotency: 'intrinsic',
    observationCache: 'workspace_generation',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Literal text to find.' },
        path: { type: 'string', default: '.' },
        fileGlob: { type: 'string', description: 'Optional workspace glob such as **/*.tsx.' },
        caseSensitive: { type: 'boolean', default: false },
        maxResults: { type: 'integer', minimum: 1, maximum: 500, default: DEFAULT_MAX_SEARCH_RESULTS },
      },
      required: ['query'],
      additionalProperties: false,
    },
    parseInput: parseSearchFilesInput,
    execute: (input, context) => executeMoAgentTool(context.signal, runtime.timeoutMs, async (signal) => {
      const policy = await runtime.policy();
      const listing = await collectEntries({
        policy,
        startPath: input.path,
        recursive: true,
        maxDepth: 12,
        maxEntries: 5_000,
        signal,
        ignoreSearchDirectories: true,
      });
      const needle = input.caseSensitive ? input.query : input.query.toLocaleLowerCase();
      const matches: Array<{ path: string; line: number; column: number; preview: string }> = [];
      let skippedLargeFiles = 0;
      for (const entry of listing.entries) {
        throwIfAborted(signal);
        if (entry.type === 'directory' || entry.type === 'symlink') continue;
        if (input.fileGlob && !matchesWorkspaceGlob(entry.path, input.fileGlob)) continue;
        if ((entry.bytes ?? 0) > runtime.maxFileBytes) {
          skippedLargeFiles += 1;
          continue;
        }
        let file;
        try {
          file = await readTextFile(policy, entry.path, runtime.maxFileBytes, signal);
        } catch (error) {
          if (error instanceof MoAgentToolError && error.code === 'BINARY_FILE_DENIED') continue;
          throw error;
        }
        const lines = file.content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          const haystack = input.caseSensitive ? lines[index] : lines[index].toLocaleLowerCase();
          const column = haystack.indexOf(needle);
          if (column < 0) continue;
          matches.push({
            path: entry.path,
            line: index + 1,
            column: column + 1,
            preview: lines[index].slice(0, 500),
          });
          if (matches.length >= input.maxResults) break;
        }
        if (matches.length >= input.maxResults) break;
      }
      const rendered = matches.map((match) => `${match.path}:${match.line}:${match.column}: ${match.preview}`).join('\n');
      const output = truncateToolOutput(rendered, runtime.maxOutputChars);
      return {
        ok: true,
        data: {
          matchCount: matches.length,
          truncated: matches.length >= input.maxResults || listing.truncated || output.truncated,
          skippedLargeFiles,
          skippedUnsafeLinks: listing.skippedUnsafeLinks,
          skippedSensitivePaths: listing.skippedSensitivePaths,
        },
        content: output.text || 'No matches.',
      };
    }),
  };
}

interface WriteFileInput { path: string; content: string; encoding: 'utf8' | 'base64' }

function parseWriteFileInput(value: unknown): WriteFileInput {
  const record = inputRecord(value);
  const encoding = optionalString(record, 'encoding', 'utf8');
  if (encoding !== 'utf8' && encoding !== 'base64') {
    throw new MoAgentToolError('INVALID_TOOL_INPUT', 'encoding must be utf8 or base64.');
  }
  return {
    path: requiredString(record, 'path', { maxLength: 1_024 }),
    content: requiredString(record, 'content', { allowEmpty: true }),
    encoding,
  };
}

export function createWriteFileTool(options: MoAgentFileToolOptions): MoAgentTool<WriteFileInput> {
  const runtime = createRuntime(options);
  return {
    name: 'write_file',
    description: 'Atomically create or replace an allowed workspace file. package files, scripts, env files, and .quantpilot are always denied.',
    effect: 'workspace_write',
    idempotency: 'reconcile_required',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Workspace-relative destination.' },
        content: { type: 'string' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], default: 'utf8' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    parseInput: parseWriteFileInput,
    execute: (input, context) => executeMoAgentTool(context.signal, runtime.timeoutMs, async (signal) => {
      const content = Buffer.from(input.content, input.encoding);
      const result = await atomicWrite({
        policy: await runtime.policy(),
        relativePath: input.path,
        content,
        maxBytes: runtime.maxWriteBytes,
        signal,
        lockIdentity: { runId: context.runId, operationId: context.operationId },
        resourceLockWaitTimeoutMs: runtime.resourceLockWaitTimeoutMs,
        commitWorkspaceMutation: context.commitWorkspaceMutation,
      });
      const contentText = `${result.created ? 'Created' : 'Updated'} ${result.path} (${result.bytes} bytes).`;
      return { ok: true, data: result, content: contentText };
    }),
  };
}

interface EditFileInput { path: string; oldText: string; newText: string }

function parseEditFileInput(value: unknown): EditFileInput {
  const record = inputRecord(value);
  return {
    path: requiredString(record, 'path', { maxLength: 1_024 }),
    oldText: requiredString(record, 'oldText'),
    newText: requiredString(record, 'newText', { allowEmpty: true }),
  };
}

function replaceUnique(content: string, oldText: string, newText: string, pathLabel: string): string {
  const first = content.indexOf(oldText);
  if (first < 0) {
    throw new MoAgentToolError('EDIT_MATCH_NOT_FOUND', `oldText was not found in ${pathLabel}.`);
  }
  if (content.indexOf(oldText, first + 1) >= 0) {
    throw new MoAgentToolError('EDIT_MATCH_AMBIGUOUS', `oldText occurs more than once in ${pathLabel}; provide a unique match.`);
  }
  return `${content.slice(0, first)}${newText}${content.slice(first + oldText.length)}`;
}

export function createEditFileTool(options: MoAgentFileToolOptions): MoAgentTool<EditFileInput> {
  const runtime = createRuntime(options);
  return {
    name: 'edit_file',
    description: 'Safely replace one unique text occurrence in an allowed UTF-8 workspace file.',
    effect: 'workspace_write',
    idempotency: 'reconcile_required',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' } },
      required: ['path', 'oldText', 'newText'],
      additionalProperties: false,
    },
    parseInput: parseEditFileInput,
    execute: (input, context) => executeMoAgentTool(context.signal, runtime.timeoutMs, async (signal) => {
      const policy = await runtime.policy();
      await policy.resolveWritePath(input.path);
      const file = await readTextFile(policy, input.path, runtime.maxFileBytes, signal);
      const updated = replaceUnique(file.content, input.oldText, input.newText, input.path);
      const result = await atomicWrite({
        policy,
        relativePath: input.path,
        content: Buffer.from(updated),
        maxBytes: runtime.maxWriteBytes,
        signal,
        expectedBeforeSha256: file.sha256,
        lockIdentity: { runId: context.runId, operationId: context.operationId },
        resourceLockWaitTimeoutMs: runtime.resourceLockWaitTimeoutMs,
        commitWorkspaceMutation: context.commitWorkspaceMutation,
      });
      return { ok: true, data: { ...result, replacements: 1 }, content: `Edited ${result.path} (1 replacement).` };
    }),
  };
}

interface ApplyPatchInput {
  path: string;
  edits: Array<{ oldText: string; newText: string }>;
}

function parseApplyPatchInput(value: unknown): ApplyPatchInput {
  const record = inputRecord(value);
  if (!Array.isArray(record.edits) || record.edits.length === 0 || record.edits.length > 50) {
    throw new MoAgentToolError('INVALID_TOOL_INPUT', 'edits must contain between 1 and 50 replacements.');
  }
  const edits = record.edits.map((rawEdit, index) => {
    const edit = inputRecord(rawEdit);
    try {
      return {
        oldText: requiredString(edit, 'oldText'),
        newText: requiredString(edit, 'newText', { allowEmpty: true }),
      };
    } catch (error) {
      if (error instanceof MoAgentToolError) {
        throw new MoAgentToolError(error.code, `Invalid edit at index ${index}: ${error.message}`);
      }
      throw error;
    }
  });
  return { path: requiredString(record, 'path', { maxLength: 1_024 }), edits };
}

export function createApplyPatchTool(options: MoAgentFileToolOptions): MoAgentTool<ApplyPatchInput> {
  const runtime = createRuntime(options);
  return {
    name: 'apply_patch',
    description: 'Atomically apply an ordered set of unique exact-text replacements to one allowed workspace file.',
    effect: 'workspace_write',
    idempotency: 'reconcile_required',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        edits: {
          type: 'array',
          minItems: 1,
          maxItems: 50,
          items: {
            type: 'object',
            properties: { oldText: { type: 'string' }, newText: { type: 'string' } },
            required: ['oldText', 'newText'],
            additionalProperties: false,
          },
        },
      },
      required: ['path', 'edits'],
      additionalProperties: false,
    },
    parseInput: parseApplyPatchInput,
    execute: (input, context) => executeMoAgentTool(context.signal, runtime.timeoutMs, async (signal) => {
      const policy = await runtime.policy();
      await policy.resolveWritePath(input.path);
      const file = await readTextFile(policy, input.path, runtime.maxFileBytes, signal);
      let updated = file.content;
      for (const edit of input.edits) {
        throwIfAborted(signal);
        updated = replaceUnique(updated, edit.oldText, edit.newText, input.path);
      }
      const result = await atomicWrite({
        policy,
        relativePath: input.path,
        content: Buffer.from(updated),
        maxBytes: runtime.maxWriteBytes,
        signal,
        expectedBeforeSha256: file.sha256,
        lockIdentity: { runId: context.runId, operationId: context.operationId },
        resourceLockWaitTimeoutMs: runtime.resourceLockWaitTimeoutMs,
        commitWorkspaceMutation: context.commitWorkspaceMutation,
      });
      return {
        ok: true,
        data: { ...result, replacements: input.edits.length },
        content: `Patched ${result.path} (${input.edits.length} replacements).`,
      };
    }),
  };
}

export function createMoAgentFileTools(options: MoAgentFileToolOptions): MoAgentTool[] {
  return [
    createListFilesTool(options),
    createReadFileTool(options),
    createReadFileRangeTool(options),
    createSearchFilesTool(options),
    createWriteFileTool(options),
    createEditFileTool(options),
    createApplyPatchTool(options),
  ];
}
