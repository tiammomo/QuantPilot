#!/usr/bin/env node

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { databaseEnvironment, requireCommand, run } = require('./release-database-tools');

process.umask(0o077);

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
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

async function archiveDirectory(source, target) {
  try {
    const stat = await fs.stat(source);
    if (!stat.isDirectory()) return false;
  } catch {
    return false;
  }
  await run('tar', ['-czf', target, '-C', source, '.']);
  return true;
}

async function main() {
  requireCommand('pg_dump');
  requireCommand('tar');
  const root = process.cwd();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupRoot = process.env.QUANTPILOT_BACKUP_ROOT || path.join(root, 'backups');
  const output = path.resolve(argument('--output', path.join(backupRoot, `quantpilot-${timestamp}`)));
  const temporary = `${output}.partial-${process.pid}`;
  const { database, env } = databaseEnvironment();

  try {
    await fs.access(output);
    throw new Error(`backup destination already exists: ${output}`);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  await fs.mkdir(temporary, { recursive: true });
  const files = [];
  try {
    const databaseFile = path.join(temporary, 'database.dump');
    await run('pg_dump', ['--format=custom', '--no-owner', '--file', databaseFile], { env });
    files.push({ kind: 'database', name: 'database.dump' });

    const projectsDir = path.resolve(process.env.PROJECTS_DIR || path.join(root, 'data', 'projects'));
    if (await archiveDirectory(projectsDir, path.join(temporary, 'workspaces.tar.gz'))) {
      files.push({ kind: 'workspaces', name: 'workspaces.tar.gz' });
    }
    const uploadsDir = path.join(root, 'public', 'uploads');
    if (await archiveDirectory(uploadsDir, path.join(temporary, 'uploads.tar.gz'))) {
      files.push({ kind: 'uploads', name: 'uploads.tar.gz' });
    }

    for (const file of files) {
      const absolute = path.join(temporary, file.name);
      const stat = await fs.stat(absolute);
      file.bytes = stat.size;
      file.sha256 = await sha256(absolute);
    }
    const encryptionKey = process.env.ENCRYPTION_KEY || '';
    const manifest = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      database,
      gitRevision: (() => {
        try {
          return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
        } catch {
          return null;
        }
      })(),
      encryptionKeyFingerprint: encryptionKey
        ? crypto.createHash('sha256').update(encryptionKey).digest('hex').slice(0, 16)
        : null,
      files,
    };
    await fs.writeFile(
      path.join(temporary, 'manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 },
    );
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.rename(temporary, output);
    console.log(`[release-backup] verified backup created at ${output}`);
  } catch (error) {
    await fs.rm(temporary, { recursive: true, force: true });
    throw error;
  }
}

main().catch((error) => {
  console.error('[release-backup] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
