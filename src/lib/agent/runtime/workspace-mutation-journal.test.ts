import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cleanupMoAgentWorkspaceMutationJournal,
  commitMoAgentWorkspaceMutationJournal,
  listMoAgentWorkspaceMutationJournals,
  MoAgentWorkspaceMutationRecoveryConflictError,
  prepareMoAgentWorkspaceMutationJournal,
  rollbackMoAgentWorkspaceMutationJournal,
  setMoAgentWorkspaceMutationJournalState,
} from './workspace-mutation-journal';

function hash(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

describe('MoAgent durable workspace mutation journal', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moagent-mutation-journal-'));
    await fs.mkdir(path.join(workspace, 'app'));
    await Promise.all([
      fs.writeFile(path.join(workspace, 'app', 'page.tsx'), 'before page\n'),
      fs.writeFile(path.join(workspace, 'app', 'globals.css'), 'before css\n'),
    ]);
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  async function prepare(operationId: string) {
    const page = Buffer.from('after page\n');
    const css = Buffer.from('after css\n');
    return prepareMoAgentWorkspaceMutationJournal({
      workspaceRoot: workspace,
      runId: 'run-journal-test',
      operationId,
      files: [
        {
          target: 'app/page.tsx',
          content: page,
          existedBefore: true,
          mode: 0o644,
          beforeSha256: hash('before page\n'),
          afterSha256: hash(page),
        },
        {
          target: 'app/globals.css',
          content: css,
          existedBefore: true,
          mode: 0o644,
          beforeSha256: hash('before css\n'),
          afterSha256: hash(css),
        },
      ],
    });
  }

  it('persists pre-images, applies a batch, and deterministically rolls it back', async () => {
    const journal = await prepare('op_journal_complete');
    await commitMoAgentWorkspaceMutationJournal(journal);
    await expect(fs.readFile(path.join(workspace, 'app', 'page.tsx'), 'utf8'))
      .resolves.toBe('after page\n');
    await expect(fs.readFile(path.join(workspace, 'app', 'globals.css'), 'utf8'))
      .resolves.toBe('after css\n');

    await rollbackMoAgentWorkspaceMutationJournal(journal);
    await expect(fs.readFile(path.join(workspace, 'app', 'page.tsx'), 'utf8'))
      .resolves.toBe('before page\n');
    await expect(fs.readFile(path.join(workspace, 'app', 'globals.css'), 'utf8'))
      .resolves.toBe('before css\n');
    expect(journal.manifest.state).toBe('rolled_back');

    await cleanupMoAgentWorkspaceMutationJournal(journal);
    await expect(listMoAgentWorkspaceMutationJournals(workspace)).resolves.toEqual([]);
  });

  it('recovers a fault injected between two target renames', async () => {
    const journal = await prepare('op_journal_partial_rename');
    await setMoAgentWorkspaceMutationJournalState(journal, 'committing');
    await fs.rename(
      path.join(journal.transactionDirectory, 'staged', '0'),
      path.join(workspace, 'app', 'page.tsx'),
    );

    await rollbackMoAgentWorkspaceMutationJournal(journal);

    await expect(fs.readFile(path.join(workspace, 'app', 'page.tsx'), 'utf8'))
      .resolves.toBe('before page\n');
    await expect(fs.readFile(path.join(workspace, 'app', 'globals.css'), 'utf8'))
      .resolves.toBe('before css\n');
  });

  it('preflights every target and never overwrites a later user modification', async () => {
    const journal = await prepare('op_journal_user_conflict');
    await commitMoAgentWorkspaceMutationJournal(journal);
    await fs.writeFile(path.join(workspace, 'app', 'globals.css'), 'user changed css\n');

    await expect(rollbackMoAgentWorkspaceMutationJournal(journal))
      .rejects.toBeInstanceOf(MoAgentWorkspaceMutationRecoveryConflictError);

    // No earlier target was restored before the conflict on the second target.
    await expect(fs.readFile(path.join(workspace, 'app', 'page.tsx'), 'utf8'))
      .resolves.toBe('after page\n');
    await expect(fs.readFile(path.join(workspace, 'app', 'globals.css'), 'utf8'))
      .resolves.toBe('user changed css\n');
  });

  it('refuses a symlinked framework journal root', async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'moagent-journal-outside-'));
    try {
      await fs.symlink(outside, path.join(workspace, '.moagent-mutation-journal'));

      await expect(prepare('op_journal_symlink_root'))
        .rejects.toThrow('framework-owned directory');
      await expect(fs.readdir(outside)).resolves.toEqual([]);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
