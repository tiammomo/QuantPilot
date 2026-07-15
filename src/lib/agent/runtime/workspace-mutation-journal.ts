import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export const MOAGENT_WORKSPACE_MUTATION_JOURNAL_DIRECTORY =
  '.moagent-mutation-journal';

const JOURNAL_SCHEMA_VERSION = 'moagent-workspace-mutation-journal-v1';
const MANIFEST_FILE = 'manifest.json';
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

type JournalState = 'prepared' | 'committing' | 'applied' | 'rolled_back';

interface WorkspaceMutationJournalFile {
  target: string;
  staged: string;
  backup: string | null;
  existedBefore: boolean;
  mode: number;
  beforeSha256: string | null;
  afterSha256: string;
}

interface WorkspaceMutationJournalManifest {
  schemaVersion: typeof JOURNAL_SCHEMA_VERSION;
  runId: string;
  operationId: string;
  state: JournalState;
  createdAt: string;
  files: WorkspaceMutationJournalFile[];
}

export interface PrepareWorkspaceMutationJournalFile {
  /** Canonical POSIX path relative to the canonical workspace root. */
  target: string;
  content: Buffer;
  existedBefore: boolean;
  mode: number;
  beforeSha256: string | null;
  afterSha256: string;
}

export interface MoAgentWorkspaceMutationJournal {
  workspaceRoot: string;
  transactionDirectory: string;
  manifest: WorkspaceMutationJournalManifest;
}

export class MoAgentWorkspaceMutationRecoveryConflictError extends Error {
  constructor(readonly target: string, message: string) {
    super(message);
    this.name = 'MoAgentWorkspaceMutationRecoveryConflictError';
  }
}

function transactionName(operationId: string): string {
  return createHash('sha256').update(operationId, 'utf8').digest('hex');
}

function sha256(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || /[\r\n\0]/.test(value)) {
    throw new Error(`Invalid MoAgent mutation journal ${label}.`);
  }
}

function assertRelativePath(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.includes('\0')) {
    throw new Error(`Invalid MoAgent mutation journal ${label}.`);
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value ||
    normalized === '.' ||
    normalized === '..' ||
    normalized.startsWith('../') ||
    path.posix.isAbsolute(normalized)
  ) {
    throw new Error(`Unsafe MoAgent mutation journal ${label}.`);
  }
}

function assertHash(value: unknown, label: string, nullable = false): asserts value is string | null {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new Error(`Invalid MoAgent mutation journal ${label}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseManifest(value: unknown): WorkspaceMutationJournalManifest {
  if (!isRecord(value) || value.schemaVersion !== JOURNAL_SCHEMA_VERSION) {
    throw new Error('Unsupported or corrupt MoAgent mutation journal manifest.');
  }
  assertIdentifier(value.runId, 'runId');
  assertIdentifier(value.operationId, 'operationId');
  if (!['prepared', 'committing', 'applied', 'rolled_back'].includes(String(value.state))) {
    throw new Error('Invalid MoAgent mutation journal state.');
  }
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new Error('Invalid MoAgent mutation journal createdAt.');
  }
  if (!Array.isArray(value.files) || value.files.length === 0 || value.files.length > 8) {
    throw new Error('Invalid MoAgent mutation journal file set.');
  }
  const targets = new Set<string>();
  const files = value.files.map((candidate, index): WorkspaceMutationJournalFile => {
    if (!isRecord(candidate)) throw new Error(`Invalid MoAgent mutation journal file ${index}.`);
    assertRelativePath(candidate.target, `files[${index}].target`);
    assertRelativePath(candidate.staged, `files[${index}].staged`);
    if (candidate.backup !== null) {
      assertRelativePath(candidate.backup, `files[${index}].backup`);
    }
    if (typeof candidate.existedBefore !== 'boolean') {
      throw new Error(`Invalid MoAgent mutation journal files[${index}].existedBefore.`);
    }
    if (!Number.isSafeInteger(candidate.mode) || Number(candidate.mode) < 0 || Number(candidate.mode) > 0o777) {
      throw new Error(`Invalid MoAgent mutation journal files[${index}].mode.`);
    }
    assertHash(candidate.beforeSha256, `files[${index}].beforeSha256`, true);
    assertHash(candidate.afterSha256, `files[${index}].afterSha256`);
    const afterSha256 = candidate.afterSha256 as string;
    if (
      candidate.existedBefore !== (candidate.beforeSha256 !== null) ||
      candidate.existedBefore !== (candidate.backup !== null)
    ) {
      throw new Error(`Inconsistent MoAgent mutation journal file ${index}.`);
    }
    if (targets.has(candidate.target)) {
      throw new Error(`Duplicate MoAgent mutation journal target ${candidate.target}.`);
    }
    targets.add(candidate.target);
    return {
      target: candidate.target,
      staged: candidate.staged,
      backup: candidate.backup,
      existedBefore: candidate.existedBefore,
      mode: Number(candidate.mode),
      beforeSha256: candidate.beforeSha256,
      afterSha256,
    };
  });
  return {
    schemaVersion: JOURNAL_SCHEMA_VERSION,
    runId: value.runId,
    operationId: value.operationId,
    state: value.state as JournalState,
    createdAt: value.createdAt,
    files,
  };
}

async function canonicalWorkspaceRoot(workspaceRoot: string): Promise<string> {
  const root = await fs.realpath(path.resolve(workspaceRoot));
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) throw new Error('MoAgent mutation journal workspace must be a directory.');
  return root;
}

async function assertNoSymlinkComponents(base: string, candidate: string): Promise<void> {
  const relative = path.relative(base, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('MoAgent mutation journal path escaped its root.');
  }
  let current = base;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new MoAgentWorkspaceMutationRecoveryConflictError(
          path.relative(base, current).split(path.sep).join('/'),
          'Refusing to follow a symbolic link while applying or recovering a workspace mutation.',
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

async function ensureJournalRoot(workspaceRoot: string): Promise<string> {
  const journalRoot = path.join(workspaceRoot, MOAGENT_WORKSPACE_MUTATION_JOURNAL_DIRECTORY);
  try {
    await fs.mkdir(journalRoot, { mode: 0o700 });
    await syncDirectory(workspaceRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = await fs.lstat(journalRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('MoAgent mutation journal root must be a framework-owned directory.');
  }
  await fs.chmod(journalRoot, 0o700);
  return journalRoot;
}

function pathInside(base: string, relativePath: string): string {
  assertRelativePath(relativePath, 'path');
  const candidate = path.resolve(base, ...relativePath.split('/'));
  const relative = path.relative(base, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('MoAgent mutation journal path escaped its root.');
  }
  return candidate;
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeFileDurably(filePath: string, content: Buffer, mode = 0o600): Promise<void> {
  const handle = await fs.open(filePath, 'wx', mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replaceManifestDurably(
  transactionDirectory: string,
  manifest: WorkspaceMutationJournalManifest,
): Promise<void> {
  const manifestPath = path.join(transactionDirectory, MANIFEST_FILE);
  const temporaryPath = path.join(
    transactionDirectory,
    `.${MANIFEST_FILE}.${randomUUID()}.tmp`,
  );
  await writeFileDurably(
    temporaryPath,
    Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8'),
  );
  try {
    await fs.rename(temporaryPath, manifestPath);
    await syncDirectory(transactionDirectory);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readManifest(transactionDirectory: string): Promise<WorkspaceMutationJournalManifest> {
  const manifestPath = path.join(transactionDirectory, MANIFEST_FILE);
  const stat = await fs.lstat(manifestPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('MoAgent mutation journal manifest must be a regular file.');
  }
  const content = await fs.readFile(manifestPath, 'utf8');
  return parseManifest(JSON.parse(content));
}

async function currentHash(workspaceRoot: string, target: string): Promise<string | null> {
  await assertNoSymlinkComponents(workspaceRoot, target);
  try {
    const stat = await fs.lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new MoAgentWorkspaceMutationRecoveryConflictError(
        target,
        'A mutation target is no longer a regular file.',
      );
    }
    return sha256(await fs.readFile(target));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export async function prepareMoAgentWorkspaceMutationJournal(options: {
  workspaceRoot: string;
  runId: string;
  operationId: string;
  files: readonly PrepareWorkspaceMutationJournalFile[];
}): Promise<MoAgentWorkspaceMutationJournal> {
  assertIdentifier(options.runId, 'runId');
  assertIdentifier(options.operationId, 'operationId');
  if (options.files.length === 0 || options.files.length > 8) {
    throw new Error('A MoAgent mutation journal must contain between 1 and 8 files.');
  }
  const workspaceRoot = await canonicalWorkspaceRoot(options.workspaceRoot);
  const journalRoot = await ensureJournalRoot(workspaceRoot);

  const transactionDirectory = path.join(journalRoot, transactionName(options.operationId));
  const targets = new Set<string>();
  const files: WorkspaceMutationJournalFile[] = [];
  let transactionCreated = false;
  try {
    await fs.mkdir(transactionDirectory, { mode: 0o700 });
    transactionCreated = true;
    await Promise.all([
      fs.mkdir(path.join(transactionDirectory, 'staged'), { mode: 0o700 }),
      fs.mkdir(path.join(transactionDirectory, 'backups'), { mode: 0o700 }),
    ]);
    for (const [index, input] of options.files.entries()) {
      assertRelativePath(input.target, `files[${index}].target`);
      assertHash(input.beforeSha256, `files[${index}].beforeSha256`, true);
      assertHash(input.afterSha256, `files[${index}].afterSha256`);
      if (input.existedBefore !== (input.beforeSha256 !== null)) {
        throw new Error(`Inconsistent MoAgent mutation journal input ${input.target}.`);
      }
      if (sha256(input.content) !== input.afterSha256) {
        throw new Error(`MoAgent mutation journal after hash mismatch for ${input.target}.`);
      }
      const target = pathInside(workspaceRoot, input.target);
      await assertNoSymlinkComponents(workspaceRoot, target);
      if (targets.has(target)) throw new Error(`Duplicate mutation journal target ${input.target}.`);
      targets.add(target);

      const staged = `staged/${index}`;
      await writeFileDurably(pathInside(transactionDirectory, staged), input.content, input.mode & 0o777);
      let backup: string | null = null;
      if (input.existedBefore) {
        const before = await fs.readFile(target);
        if (sha256(before) !== input.beforeSha256) {
          throw new MoAgentWorkspaceMutationRecoveryConflictError(
            input.target,
            `The target changed while its durable backup was being prepared: ${input.target}.`,
          );
        }
        backup = `backups/${index}`;
        await writeFileDurably(pathInside(transactionDirectory, backup), before, input.mode & 0o777);
      }
      files.push({
        target: input.target,
        staged,
        backup,
        existedBefore: input.existedBefore,
        mode: input.mode & 0o777,
        beforeSha256: input.beforeSha256,
        afterSha256: input.afterSha256,
      });
    }
    await Promise.all([
      syncDirectory(path.join(transactionDirectory, 'staged')),
      syncDirectory(path.join(transactionDirectory, 'backups')),
    ]);
    const manifest: WorkspaceMutationJournalManifest = {
      schemaVersion: JOURNAL_SCHEMA_VERSION,
      runId: options.runId,
      operationId: options.operationId,
      state: 'prepared',
      createdAt: new Date().toISOString(),
      files,
    };
    await replaceManifestDurably(transactionDirectory, manifest);
    await syncDirectory(journalRoot);
    return { workspaceRoot, transactionDirectory, manifest };
  } catch (error) {
    if (transactionCreated) {
      await fs.rm(transactionDirectory, { recursive: true, force: true }).catch(() => undefined);
    }
    await syncDirectory(journalRoot).catch(() => undefined);
    throw error;
  }
}

export async function setMoAgentWorkspaceMutationJournalState(
  journal: MoAgentWorkspaceMutationJournal,
  state: Extract<JournalState, 'committing' | 'applied'>,
): Promise<void> {
  journal.manifest = { ...journal.manifest, state };
  await replaceManifestDurably(journal.transactionDirectory, journal.manifest);
}

export async function commitMoAgentWorkspaceMutationJournal(
  journal: MoAgentWorkspaceMutationJournal,
): Promise<void> {
  await setMoAgentWorkspaceMutationJournalState(journal, 'committing');
  for (const file of journal.manifest.files) {
    const staged = pathInside(journal.transactionDirectory, file.staged);
    const target = pathInside(journal.workspaceRoot, file.target);
    await assertNoSymlinkComponents(journal.transactionDirectory, staged);
    await assertNoSymlinkComponents(journal.workspaceRoot, target);
    const stagedStat = await fs.lstat(staged);
    if (!stagedStat.isFile() || stagedStat.isSymbolicLink() || sha256(await fs.readFile(staged)) !== file.afterSha256) {
      throw new Error(`MoAgent mutation journal staged content is corrupt for ${file.target}.`);
    }
    await fs.rename(staged, target);
    await syncDirectory(path.dirname(target));
  }
  await setMoAgentWorkspaceMutationJournalState(journal, 'applied');
}

/**
 * Roll a journal back only when every target still equals either the recorded
 * pre-state or this transaction's post-state. This preflight is deliberately
 * completed before the first restore so a user's later edit is never covered.
 */
export async function rollbackMoAgentWorkspaceMutationJournal(
  journal: MoAgentWorkspaceMutationJournal,
): Promise<void> {
  if (journal.manifest.state === 'rolled_back') return;
  if (journal.manifest.state === 'prepared') {
    // `committing` is persisted and fsynced before the first target rename.
    // A merely prepared journal therefore has no physical effect to undo,
    // even if an independent user changed a target in the meantime.
    journal.manifest = { ...journal.manifest, state: 'rolled_back' };
    await replaceManifestDurably(journal.transactionDirectory, journal.manifest);
    return;
  }
  const states: Array<{ file: WorkspaceMutationJournalFile; current: string | null }> = [];
  for (const file of journal.manifest.files) {
    const target = pathInside(journal.workspaceRoot, file.target);
    const current = await currentHash(journal.workspaceRoot, target);
    if (current !== file.beforeSha256 && current !== file.afterSha256) {
      throw new MoAgentWorkspaceMutationRecoveryConflictError(
        file.target,
        `Refusing to recover ${file.target} because it was modified after the interrupted MoAgent write.`,
      );
    }
    if (file.existedBefore) {
      const backupPath = pathInside(journal.transactionDirectory, file.backup!);
      await assertNoSymlinkComponents(journal.transactionDirectory, backupPath);
      const backup = await fs.readFile(backupPath);
      if (sha256(backup) !== file.beforeSha256) {
        throw new Error(`MoAgent mutation journal backup is corrupt for ${file.target}.`);
      }
    }
    states.push({ file, current });
  }

  for (const { file, current } of states) {
    if (current === file.beforeSha256) continue;
    const target = pathInside(journal.workspaceRoot, file.target);
    if (!file.existedBefore) {
      await fs.rm(target, { force: true });
    } else {
      const restorePath = path.join(
        path.dirname(target),
        `.${path.basename(target)}.moagent-restore-${randomUUID()}.tmp`,
      );
      const backupPath = pathInside(journal.transactionDirectory, file.backup!);
      await assertNoSymlinkComponents(journal.transactionDirectory, backupPath);
      const backup = await fs.readFile(backupPath);
      await writeFileDurably(restorePath, backup, file.mode);
      try {
        await fs.rename(restorePath, target);
      } catch (error) {
        await fs.rm(restorePath, { force: true }).catch(() => undefined);
        throw error;
      }
    }
    await syncDirectory(path.dirname(target));
  }
  journal.manifest = { ...journal.manifest, state: 'rolled_back' };
  await replaceManifestDurably(journal.transactionDirectory, journal.manifest);
}

export async function cleanupMoAgentWorkspaceMutationJournal(
  journal: MoAgentWorkspaceMutationJournal,
): Promise<void> {
  const journalRoot = path.dirname(journal.transactionDirectory);
  await fs.rm(journal.transactionDirectory, { recursive: true, force: true });
  await syncDirectory(journalRoot);
}

export async function listMoAgentWorkspaceMutationJournals(
  workspaceRoot: string,
): Promise<MoAgentWorkspaceMutationJournal[]> {
  const root = await canonicalWorkspaceRoot(workspaceRoot);
  const journalRoot = path.join(root, MOAGENT_WORKSPACE_MUTATION_JOURNAL_DIRECTORY);
  let entries;
  try {
    const journalRootStat = await fs.lstat(journalRoot);
    if (!journalRootStat.isDirectory() || journalRootStat.isSymbolicLink()) {
      throw new Error('MoAgent mutation journal root must be a framework-owned directory.');
    }
    entries = await fs.readdir(journalRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const journals: MoAgentWorkspaceMutationJournal[] = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || !SHA256_PATTERN.test(entry.name)) {
      throw new Error('Unexpected entry in the MoAgent mutation journal directory.');
    }
    const transactionDirectory = path.join(journalRoot, entry.name);
    let manifest: WorkspaceMutationJournalManifest;
    try {
      manifest = await readManifest(transactionDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // The manifest is written last and targets cannot be mutated before it
        // exists, so an interrupted prepare directory is safe to discard.
        await fs.rm(transactionDirectory, { recursive: true, force: true });
        await syncDirectory(journalRoot);
        continue;
      }
      throw error;
    }
    if (transactionName(manifest.operationId) !== entry.name) {
      throw new Error('MoAgent mutation journal operation identity mismatch.');
    }
    journals.push({ workspaceRoot: root, transactionDirectory, manifest });
  }
  return journals;
}

export const __workspaceMutationJournalTesting = {
  schemaVersion: JOURNAL_SCHEMA_VERSION,
};
