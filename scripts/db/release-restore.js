#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');

const { databaseEnvironment, requireCommand, run } = require('./release-database-tools');

process.umask(0o077);

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(file, 'r');
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function safeArchive(file) {
  const output = [];
  const { spawn } = require('node:child_process');
  await new Promise((resolve, reject) => {
    const child = spawn('tar', ['-tzf', file], { stdio: ['ignore', 'pipe', 'inherit'] });
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`cannot inspect ${file}`)));
  });
  const entries = Buffer.concat(output).toString('utf8').split(/\r?\n/).filter(Boolean);
  if (entries.some((entry) => path.isAbsolute(entry) || entry.split('/').includes('..'))) {
    throw new Error(`unsafe path found in ${path.basename(file)}`);
  }
}

async function restoreDirectory(archive, destination, restoreId) {
  await safeArchive(archive);
  const temporary = `${destination}.restore-${restoreId}`;
  const previous = `${destination}.pre-restore-${restoreId}`;
  await fs.rm(temporary, { recursive: true, force: true });
  await fs.mkdir(temporary, { recursive: true });
  await run('tar', ['-xzf', archive, '-C', temporary, '--no-same-owner', '--no-same-permissions']);
  try {
    await fs.rename(destination, previous);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.rename(temporary, destination);
  } catch (error) {
    try {
      await fs.rename(previous, destination);
    } catch {
      // Preserve both paths for manual recovery if the rollback rename fails.
    }
    throw error;
  }
  return previous;
}

async function main() {
  requireCommand('pg_restore');
  requireCommand('tar');
  const root = process.cwd();
  const backup = path.resolve(argument('--backup') || '');
  if (!argument('--backup')) throw new Error('--backup is required');
  const manifest = JSON.parse(await fs.readFile(path.join(backup, 'manifest.json'), 'utf8'));
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files)) {
    throw new Error('unsupported or invalid backup manifest');
  }
  const allowedFiles = new Set(['database.dump', 'workspaces.tar.gz', 'uploads.tar.gz']);
  const manifestNames = manifest.files.map((file) => file?.name);
  if (
    !manifestNames.includes('database.dump')
    || new Set(manifestNames).size !== manifestNames.length
    || manifestNames.some((name) => typeof name !== 'string' || !allowedFiles.has(name))
  ) {
    throw new Error('backup manifest contains missing, duplicate, or unexpected files');
  }
  const { database, env } = databaseEnvironment();
  if (argument('--confirm-database') !== database || manifest.database !== database) {
    throw new Error(`pass --confirm-database ${database}; backup and target names must match`);
  }
  if (!process.argv.includes('--replace-files')) {
    throw new Error('--replace-files is required; current directories are retained as pre-restore snapshots');
  }
  const key = process.env.ENCRYPTION_KEY || '';
  const keyFingerprint = key
    ? crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)
    : null;
  if (manifest.encryptionKeyFingerprint && manifest.encryptionKeyFingerprint !== keyFingerprint) {
    throw new Error('ENCRYPTION_KEY does not match the backup fingerprint');
  }

  for (const file of manifest.files) {
    const absolute = path.join(backup, file.name);
    if (await sha256(absolute) !== file.sha256) {
      throw new Error(`checksum mismatch: ${file.name}`);
    }
  }

  const databaseDump = path.join(backup, 'database.dump');
  await run('pg_restore', ['--list', databaseDump], { env, stdio: 'ignore' });
  for (const archiveName of ['workspaces.tar.gz', 'uploads.tar.gz']) {
    if (manifest.files.some((file) => file.name === archiveName)) {
      await safeArchive(path.join(backup, archiveName));
    }
  }
  await run('pg_restore', [
    '--clean',
    '--if-exists',
    '--no-owner',
    '--exit-on-error',
    '--dbname',
    database,
    databaseDump,
  ], { env });

  const restoreId = new Date().toISOString().replace(/[:.]/g, '-');
  const retained = [];
  const workspaceArchive = path.join(backup, 'workspaces.tar.gz');
  if (manifest.files.some((file) => file.name === 'workspaces.tar.gz')) {
    retained.push(await restoreDirectory(
      workspaceArchive,
      path.resolve(process.env.PROJECTS_DIR || path.join(root, 'data', 'projects')),
      restoreId,
    ));
  }
  const uploadArchive = path.join(backup, 'uploads.tar.gz');
  if (manifest.files.some((file) => file.name === 'uploads.tar.gz')) {
    retained.push(await restoreDirectory(
      uploadArchive,
      path.join(root, 'public', 'uploads'),
      restoreId,
    ));
  }
  console.log(`[release-restore] restore completed; retained snapshots: ${retained.join(', ') || 'none'}`);
}

main().catch((error) => {
  console.error('[release-restore] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
