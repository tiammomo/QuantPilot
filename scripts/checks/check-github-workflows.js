#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const root = process.cwd();
const workflowDir = path.join(root, '.github', 'workflows');
const expectedActions = new Map([
  ['actions/checkout', 'v7'],
  ['actions/setup-node', 'v7'],
  ['actions/upload-artifact', 'v7'],
  // setup-uv publishes immutable release tags but does not currently expose
  // a moving v8 tag, so the major-only reference cannot be resolved by Actions.
  ['astral-sh/setup-uv', 'v8.3.2'],
]);
const failures = [];

for (const filename of fs.readdirSync(workflowDir).filter((name) => /\.ya?ml$/.test(name)).sort()) {
  const relativePath = path.posix.join('.github', 'workflows', filename);
  const source = fs.readFileSync(path.join(workflowDir, filename), 'utf8');
  for (const match of source.matchAll(/^\s*uses:\s*([^\s@]+)@([^\s#]+).*$/gm)) {
    const [, action, revision] = match;
    const expectedRevision = expectedActions.get(action);
    if (expectedRevision && revision !== expectedRevision) {
      failures.push(`${relativePath}: ${action} must use ${expectedRevision}, found ${revision}`);
    }
  }
}

const nightlyPath = path.join(workflowDir, 'eval-nightly.yml');
const nightly = fs.readFileSync(nightlyPath, 'utf8');
const nightlyContracts = [
  ['scheduled runs expose a configuration job', /^  configuration:\s*$/m],
  ['configuration exports the secret availability result', /deepseek-configured:\s*\$\{\{\s*steps\.secret\.outputs\.configured\s*\}\}/],
  ['live evaluation depends on configuration', /^\s+needs:\s*configuration\s*$/m],
  ['live evaluation only runs with a configured secret', /if:\s*needs\.configuration\.outputs\.deepseek-configured\s*==\s*'true'/],
  ['manual live evaluation remains fail-closed', /GITHUB_EVENT_NAME.*workflow_dispatch[\s\S]*DEEPSEEK_API_KEY must be configured/],
  ['scheduled missing-secret runs emit a notice', /::notice::DEEPSEEK_API_KEY is not configured/],
  ['hosted live evaluation selects the remote DeepSeek model', /QUANTPILOT_EVAL_MODEL:\s*deepseek-v4-flash/],
  ['generation passes the expected DeepSeek model explicitly', /benchmark:quant:e2e -- --model deepseek-v4-flash/],
  ['the independent gate expects the same DeepSeek model', /eval:ci:e2e -- --model deepseek-v4-flash/],
];
for (const [description, pattern] of nightlyContracts) {
  if (!pattern.test(nightly)) failures.push(`.github/workflows/eval-nightly.yml: ${description}`);
}

const release = fs.readFileSync(path.join(workflowDir, 'release-evidence.yml'), 'utf8');
if (!/DEEPSEEK_API_KEY is required; release evidence cannot be skipped/.test(release)) {
  failures.push('.github/workflows/release-evidence.yml: release evidence must remain fail-closed without DEEPSEEK_API_KEY');
}

if (failures.length > 0) {
  console.error('[github-workflows] failed');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log('[github-workflows] ok: current action runtimes and evaluation secret policies are enforced');
