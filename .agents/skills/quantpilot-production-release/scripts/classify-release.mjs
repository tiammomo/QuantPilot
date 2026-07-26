#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

function usage() {
  console.log(`Usage:
  classify-release.mjs --base-ref <deployed-commit> [--head-ref <candidate>]
    [--include-working-tree]
    [--request-data-operation <operation-name>]

Classify a QuantPilot release without changing files, data, or external systems.`);
}

function fail(message) {
  console.error(`[release-classifier] ${message}`);
  process.exit(2);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function runGit(args) {
  try {
    return execFileSync('git', args, {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim();
    fail(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
}

function parseNameStatus(output) {
  const tokens = output.split('\0').filter(Boolean);
  const entries = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (!status) break;
    if (status.startsWith('R') || status.startsWith('C')) {
      const from = tokens[index++];
      const path = tokens[index++];
      if (path) entries.push({ status, path, from });
      continue;
    }
    const path = tokens[index++];
    if (path) entries.push({ status, path });
  }
  return entries;
}

const baseRef = argument('--base-ref');
const headRef = argument('--head-ref') || 'HEAD';
const includeWorkingTree = process.argv.includes('--include-working-tree');
const requestedDataOperation = argument('--request-data-operation');

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  usage();
  process.exit(0);
}

if (!baseRef) {
  fail('pass --base-ref with the exact deployed commit or an explicit comparison ref');
}

runGit(['rev-parse', '--verify', `${baseRef}^{commit}`]);
runGit(['rev-parse', '--verify', `${headRef}^{commit}`]);
try {
  execFileSync('git', ['merge-base', '--is-ancestor', baseRef, headRef], {
    cwd: process.cwd(),
    stdio: 'ignore',
  });
} catch {
  fail(`${baseRef} is not an ancestor of ${headRef}; inspect release ancestry before deployment`);
}

const entries = parseNameStatus(
  runGit(['diff', '--name-status', '-z', `${baseRef}...${headRef}`]),
);

if (includeWorkingTree) {
  entries.push(...parseNameStatus(runGit(['diff', '--name-status', '-z', headRef])));
  for (const path of runGit(['ls-files', '--others', '--exclude-standard', '-z'])
    .split('\0')
    .filter(Boolean)) {
    entries.push({ status: '??', path });
  }
}

const byPath = new Map();
for (const entry of entries) byPath.set(entry.path, entry);
const changes = [...byPath.values()].sort((left, right) =>
  left.path.localeCompare(right.path),
);
const paths = changes.map((entry) => entry.path);

const matches = (pattern) => paths.filter((path) => pattern.test(path));
const migrations = matches(/^prisma\/migrations\/[^/]+\/migration\.sql$/);
const schemaFiles = matches(/^prisma\/schema\.prisma$/);
const sensitiveOrPersistent = matches(
  /^(?:\.env$|\.env\.(?!.*(?:example|sample|template)$)|data\/|backups\/|public\/uploads\/)/,
);
const dataOperations = matches(
  /^(?:scripts\/(?:data-migrations|backfills)\b|prisma\/seed\b|scripts\/db\/.*(?:backfill|bootstrap|import|init|migrate|restore|seed|sync)|scripts\/ops\/.*(?:backfill|import|refresh|restore|sync))/,
);

const blockers = [];
if (schemaFiles.length > 0 && migrations.length === 0) {
  blockers.push('prisma/schema.prisma changed without a versioned migration');
}
if (sensitiveOrPersistent.length > 0) {
  blockers.push('candidate contains environment, backup, upload, or persistent data paths');
}

let mode = 'feature_only';
if (migrations.length > 0) mode = 'schema_migration';
if (requestedDataOperation) mode = 'bounded_data_review';
if (blockers.length > 0) mode = 'blocked';

const schemaAction =
  blockers.length > 0
    ? 'forbidden'
    : migrations.length > 0
      ? 'schema_only'
      : 'none';
const dataAction =
  blockers.length > 0
    ? 'forbidden'
    : requestedDataOperation
      ? 'separate_approval_required'
      : 'none';

const next = [];
if (blockers.length > 0) {
  next.push('resolve every blocker before release');
} else {
  next.push('run release gates');
  if (migrations.length > 0) {
    next.push(
      'review migration',
      'create and verify the release backup',
      'run npm run prisma:deploy',
    );
  }
  next.push(
    'build the immutable artifact',
    'restart only affected services',
    'verify readiness and the running revision',
  );
  if (requestedDataOperation) {
    next.push(
      'finish and verify the code/schema release before any data operation',
      `review the bounded data-operation contract for ${requestedDataOperation}`,
      'request separate explicit authorization for the named scope',
    );
  }
}

const serviceImpact = {
  web: paths.some((path) =>
    /^(?:src\/|public\/|prisma\/|next\.config|package(?:-lock)?\.json|tsconfig)/.test(path),
  ),
  generationWorker: paths.some((path) =>
    /^(?:scripts\/workers\/|src\/lib\/|prisma\/|package(?:-lock)?\.json)/.test(path),
  ),
  marketData: paths.some((path) => path.startsWith('services/market-data/')),
  systemd: paths.some((path) => path.startsWith('deploy/systemd/')),
};

const result = {
  schemaVersion: 1,
  baseRef,
  headRef,
  includeWorkingTree,
  mode,
  changeCount: changes.length,
  changes,
  evidence: {
    migrations,
    schemaFiles,
    dataOperations,
    requestedDataOperation,
    sensitiveOrPersistent,
  },
  serviceImpact,
  blockers,
  schemaAction,
  dataAction,
  requiresReleaseBackup: schemaAction === 'schema_only',
  requiresSeparateDataApproval: dataAction === 'separate_approval_required',
  routineDataSyncAllowed: false,
  dataOperationCodeChanged: dataOperations.length > 0,
  next,
};

console.log(JSON.stringify(result, null, 2));
if (mode === 'blocked') process.exit(1);
