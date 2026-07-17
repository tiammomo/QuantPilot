#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = process.cwd();
const standalone = path.join(root, '.next', 'standalone');
const port = Number(process.env.QUANTPILOT_STANDALONE_SMOKE_PORT)
  || 39_000 + (process.pid % 1_000);
const baseUrl = `http://127.0.0.1:${port}`;

function assertArtifact() {
  for (const required of [
    'server.js',
    '.next/server',
    '.next/static',
    'public/generated/quantpilot-tailwind.css',
  ]) {
    if (!fs.existsSync(path.join(standalone, required))) {
      throw new Error(`standalone artifact is missing ${required}`);
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
      const response = await fetch(`${baseUrl}/api/health`, { cache: 'no-store' });
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

async function main() {
  assertArtifact();
  const output = [];
  const child = spawn(process.execPath, ['server.js'], {
    cwd: standalone,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      HOSTNAME: '127.0.0.1',
      PORT: String(port),
      QUANTPILOT_AUTH_MODE: 'disabled',
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
    const css = await fetch(`${baseUrl}/generated/quantpilot-tailwind.css`);
    const cssBytes = (await css.arrayBuffer()).byteLength;
    if (!css.ok || cssBytes === 0) {
      throw new Error(`standalone stable CSS request failed with HTTP ${css.status}`);
    }
    console.log(`[standalone-smoke] ready on ${baseUrl}; liveness, assets and security headers verified`);
  } finally {
    await stop(child);
  }
}

main().catch((error) => {
  console.error('[standalone-smoke] failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
