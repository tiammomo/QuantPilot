#!/usr/bin/env node

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '../..');
const project = path.join(root, 'services/market-data');
const pythonVersion = fs.readFileSync(path.join(project, '.python-version'), 'utf8').trim();
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'quantpilot-market-audit-'));
const requirements = path.join(directory, 'requirements.txt');

function run(args) {
  const result = spawnSync('uv', args, { cwd: project, stdio: 'inherit', timeout: 300_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Market dependency audit command failed (${result.status ?? result.signal})`);
}

try {
  run([
    'export', '--frozen', '--all-extras', '--no-dev', '--no-emit-project',
    '--format', 'requirements-txt', '--output-file', requirements, '--quiet',
  ]);
  // uv exports every transitive dependency with its locked version and hashes. Audit that
  // complete list without a second install/resolve, using the service's Python
  // version to evaluate environment markers (including optional providers).
  run(['tool', 'run', '--python', pythonVersion, 'pip-audit', '--require-hashes', '--disable-pip', '-r', requirements]);
} catch (error) {
  console.error(`[market-audit] ${error.message}`);
  process.exitCode = 1;
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
