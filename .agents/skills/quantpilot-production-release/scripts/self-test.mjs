#!/usr/bin/env node

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const classifier = path.join(scriptsDir, 'classify-release.mjs');
const targetChecker = path.join(scriptsDir, 'check-target.mjs');
const roots = [];

function git(repo, ...args) {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(repo, relativePath, contents) {
  const target = path.join(repo, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function commit(repo, message) {
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

function repository() {
  const repo = mkdtempSync(path.join(tmpdir(), 'quantpilot-release-skill-'));
  roots.push(repo);
  git(repo, 'init', '--quiet');
  git(repo, 'config', 'user.name', 'Release Skill Test');
  git(repo, 'config', 'user.email', 'release-skill@example.invalid');
  write(repo, 'src/base.ts', 'export const version = 1;\n');
  return { repo, base: commit(repo, 'base') };
}

function classify(repo, base, extraArgs = []) {
  const output = execFileSync(
    process.execPath,
    [classifier, '--base-ref', base, '--head-ref', 'HEAD', ...extraArgs],
    { cwd: repo, encoding: 'utf8' },
  );
  return JSON.parse(output);
}

function checkTarget(overrides = {}) {
  return spawnSync(process.execPath, [targetChecker], {
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      QUANTPILOT_RELEASE_HOST: 'deployer@quantpilot-prod',
      QUANTPILOT_PUBLIC_URL: 'https://quantpilot.example.com',
      QUANTPILOT_RELEASE_ROOT: '/opt/quantpilot',
      QUANTPILOT_RELEASE_ENV_FILE: '/etc/quantpilot/quantpilot.env',
      QUANTPILOT_BACKUP_ROOT: '/var/backups/quantpilot',
      ...overrides,
    },
  });
}

try {
  {
    const { repo, base } = repository();
    write(repo, 'src/feature.ts', 'export const enabled = true;\n');
    commit(repo, 'feature');
    const result = classify(repo, base);
    assert.equal(result.mode, 'feature_only');
    assert.equal(result.schemaAction, 'none');
    assert.equal(result.dataAction, 'none');
    assert.equal(result.routineDataSyncAllowed, false);
  }

  {
    const { repo, base } = repository();
    write(repo, 'prisma/schema.prisma', 'model ReleaseTest { id Int @id }\n');
    write(
      repo,
      'prisma/migrations/20260726000000_release_test/migration.sql',
      'CREATE TABLE "ReleaseTest" ("id" INTEGER PRIMARY KEY);\n',
    );
    commit(repo, 'migration');
    const result = classify(repo, base);
    assert.equal(result.mode, 'schema_migration');
    assert.equal(result.schemaAction, 'schema_only');
    assert.equal(result.requiresReleaseBackup, true);
    assert.ok(result.next.includes('run npm run prisma:deploy'));
  }

  {
    const { repo, base } = repository();
    write(repo, 'prisma/schema.prisma', 'model MissingMigration { id Int @id }\n');
    commit(repo, 'unsafe schema');
    const run = spawnSync(
      process.execPath,
      [classifier, '--base-ref', base, '--head-ref', 'HEAD'],
      { cwd: repo, encoding: 'utf8' },
    );
    assert.equal(run.status, 1);
    const result = JSON.parse(run.stdout);
    assert.equal(result.mode, 'blocked');
    assert.match(result.blockers.join(' '), /without a versioned migration/);
  }

  {
    const { repo, base } = repository();
    write(repo, 'scripts/backfills/safe-example.ts', 'export {};\n');
    commit(repo, 'backfill implementation');
    const result = classify(repo, base);
    assert.equal(result.mode, 'feature_only');
    assert.equal(result.dataOperationCodeChanged, true);
    assert.equal(result.dataAction, 'none');
  }

  {
    const { repo, base } = repository();
    write(repo, 'prisma/schema.prisma', 'model Combined { id Int @id }\n');
    write(
      repo,
      'prisma/migrations/20260726000001_combined/migration.sql',
      'CREATE TABLE "Combined" ("id" INTEGER PRIMARY KEY);\n',
    );
    commit(repo, 'combined plan');
    const result = classify(repo, base, [
      '--request-data-operation',
      'tenant-scoped-backfill',
    ]);
    assert.equal(result.mode, 'bounded_data_review');
    assert.equal(result.schemaAction, 'schema_only');
    assert.equal(result.dataAction, 'separate_approval_required');
    assert.ok(result.next.includes('run npm run prisma:deploy'));
    assert.ok(
      result.next.includes(
        'finish and verify the code/schema release before any data operation',
      ),
    );
  }

  {
    const valid = checkTarget();
    assert.equal(valid.status, 0, valid.stderr);
    const result = JSON.parse(valid.stdout);
    assert.equal(result.ok, true);
    assert.equal(result.host, 'deployer@quantpilot-prod');

    const injection = checkTarget({
      QUANTPILOT_RELEASE_HOST: '-oProxyCommand=malicious',
    });
    assert.equal(injection.status, 2);
    assert.match(injection.stderr, /must be one SSH host/);

    const traversal = checkTarget({
      QUANTPILOT_RELEASE_ROOT: '/opt/quantpilot/../other',
    });
    assert.equal(traversal.status, 2);
    assert.match(traversal.stderr, /normalized POSIX path/);
  }

  console.log('[quantpilot-production-release] self-test passed');
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}
