#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');

const root = process.cwd();
const standalone = path.join(root, '.next', 'standalone');
const port = Number(process.env.QUANTPILOT_STANDALONE_SMOKE_PORT)
  || 39_000 + (process.pid % 1_000);
const baseUrl = `http://127.0.0.1:${port}`;

function assertArtifact() {
  function checkLinks(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        const resolved = fs.realpathSync(file);
        if (!resolved.startsWith(`${standalone}${path.sep}`)) throw new Error(`standalone symlink escapes the artifact: ${path.relative(standalone, file)}`);
      } else if (entry.isDirectory()) checkLinks(file);
    }
  }
  checkLinks(standalone);
  for (const required of [
    'server.js',
    '.next/server',
    '.next/static',
    'public/generated/quantpilot-tailwind.css',
    '.pi/skills.registry.json',
    '.pi/skills.lock.json',
    '.pi/skills.changelog.json',
    'config/pi-agent-skill-capsules.json',
    'scripts/skills/package-skills.js',
    'scripts/checks/check-skills-registry.js',
    'scripts/checks/check-skill-scripts.js',
    'tests/skills/test_contracts.py',
    'node_modules/js-yaml/package.json',
    'node_modules/tar/package.json',
    'node_modules/next/dist/compiled/next-server/app-route-turbo.runtime.prod.js',
    'scripts/security',
  ]) {
    if (!fs.existsSync(path.join(standalone, required))) {
      throw new Error(`standalone artifact is missing ${required}`);
    }
  }
  const registry = JSON.parse(fs.readFileSync(path.join(standalone, '.pi/skills.registry.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(standalone, '.pi/skills.lock.json'), 'utf8'));
  for (const skill of registry.coreSkills) {
    const entry = lock.skills[skill.id];
    const skillSource = path.join(standalone, '.pi', 'skills', skill.id, 'SKILL.md');
    if (!entry || entry.version !== skill.version || !fs.existsSync(skillSource)) {
      throw new Error(`standalone skill source or lock is missing: ${skill.id}`);
    }
    const bytes = fs.readFileSync(path.join(standalone, entry.packagePath));
    if (createHash('sha256').update(bytes).digest('hex') !== entry.packageSha256) {
      throw new Error(`standalone skill package hash mismatch: ${skill.id}`);
    }
  }
  const leakedEnv = fs.readdirSync(standalone)
    .filter((entry) => entry === '.env' || entry.startsWith('.env.'));
  if (leakedEnv.length > 0) {
    throw new Error(`standalone artifact contains forbidden environment files: ${leakedEnv.join(', ')}`);
  }
}

async function waitForHealth(child, output) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`standalone server exited early (${child.exitCode})\n${output.join('')}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/health`, { cache: 'no-store', signal: AbortSignal.timeout(5_000) });
      if (response.ok) return response;
    } catch {
      // The listener may not be ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`standalone server did not become healthy\n${output.join('')}`);
}

async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function verifySkillPublication(token) {
  async function mutate(body) {
    const response = await fetch(`${baseUrl}/api/skills`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-quantpilot-admin-token': token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const content = await response.text();
    if (!response.ok) throw new Error(`standalone Skill ${body.action} HTTP ${response.status}: ${content.slice(0, 1000)}`);
    const payload = JSON.parse(content);
    if (!response.ok || !payload.success) throw new Error(`standalone Skill ${body.action} failed: ${payload.error ?? response.status}`);
    return payload.data;
  }
  const skillId = 'image-extraction';
  const source = await mutate({ action: 'read-file', skillId, filePath: 'SKILL.md' });
  const before = await (await fetch(`${baseUrl}/api/skills`, { signal: AbortSignal.timeout(10_000) })).json();
  const originalVersion = before.data.skills.find((skill) => skill.id === skillId).version;
  const version = `${Number(originalVersion.split('.')[0]) + 1}.0.0`;
  const saved = await mutate({ action: 'save-file', skillId, content: `${source.content}\n<!-- standalone publication smoke -->\n`, expectedRevision: source.revision });
  const published = await mutate({ action: 'publish-version', skillId, expectedRevision: saved.revision, version, summary: 'Isolated standalone smoke', changes: ['Verify packaged publication dependencies'] });
  const skill = published.skills.find((item) => item.id === skillId);
  if (skill.version !== version || skill.health.status !== 'ok') throw new Error('standalone Skill publication did not activate a healthy release');
  const restored = await mutate({ action: 'rollback-version', skillId, version: originalVersion, expectedRevision: skill.editing.revision });
  if (restored.skills.find((item) => item.id === skillId).version !== originalVersion) throw new Error('standalone Skill rollback did not restore the baseline');
}

async function main() {
  assertArtifact();
  const output = [];
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'quantpilot-standalone-smoke-'));
  const runtimeArtifact = path.join(isolated, 'application');
  try {
    // Running inside the checkout could silently borrow missing dependencies
    // from its parent node_modules and disguise an incomplete release artifact.
    fs.cpSync(standalone, runtimeArtifact, { recursive: true, verbatimSymlinks: true });
  } catch (error) {
    fs.rmSync(isolated, { recursive: true, force: true });
    throw error;
  }
  const adminToken = randomUUID();
  const child = spawn(process.execPath, ['server.js'], {
    cwd: runtimeArtifact,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      NODE_PATH: '',
      HOSTNAME: '127.0.0.1',
      PORT: String(port),
      QUANTPILOT_AUTH_MODE: 'disabled',
      QUANTPILOT_AUTH_SECRET: randomUUID() + randomUUID(),
      QUANTPILOT_ADMIN_TOKEN: adminToken,
      QUANTPILOT_DEGRADATION_MODE: 'offline',
      QUANTPILOT_DATABASE_ENABLED: '0',
      QUANTPILOT_KNOWLEDGE_ENABLED: '0',
      QUANTPILOT_SKILLS_STATE_DIR: path.join(isolated, 'skill-catalog'),
      PROJECTS_DIR: path.join(isolated, 'projects'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (chunk) => {
      output.push(chunk.toString());
      if (output.length > 80) output.shift();
    });
  }

  try {
    const health = await waitForHealth(child, output);
    const payload = await health.json();
    if (payload?.ok !== true || payload?.service !== 'quantpilot-web') {
      throw new Error('standalone liveness response has an invalid contract');
    }
    for (const header of [
      'content-security-policy',
      'referrer-policy',
      'x-content-type-options',
      'x-frame-options',
    ]) {
      if (!health.headers.get(header)) throw new Error(`security header missing: ${header}`);
    }
    const css = await fetch(`${baseUrl}/generated/quantpilot-tailwind.css`, { signal: AbortSignal.timeout(5_000) });
    const cssBytes = (await css.arrayBuffer()).byteLength;
    if (!css.ok || cssBytes === 0) {
      throw new Error(`standalone stable CSS request failed with HTTP ${css.status}`);
    }
    const auth = await fetch(`${baseUrl}/api/auth/get-session`, { signal: AbortSignal.timeout(10_000) });
    if (auth.status !== 404 || (await auth.json()).error !== 'AUTH_DISABLED') throw new Error(`standalone auth route failed to load: HTTP ${auth.status}`);
    await verifySkillPublication(adminToken);
    console.log(`[standalone-smoke] ready on ${baseUrl}; isolated Skill publication/rollback, packages, liveness, assets and security headers verified`);
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${output.join('').slice(-8000)}`);
  } finally {
    await stop(child);
    fs.rmSync(isolated, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('[standalone-smoke] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
