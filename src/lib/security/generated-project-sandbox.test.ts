import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { buildGeneratedProjectEnv, wrapGeneratedProjectCommand } from './generated-project-sandbox';

afterEach(() => {
  delete process.env.QUANTPILOT_ALLOW_UNSANDBOXED_GENERATED_CODE;
  delete process.env.QUANTPILOT_GENERATED_SANDBOX;
});

describe('generated project sandbox', () => {
  it.runIf(process.env.QUANTPILOT_TEST_GENERATED_SANDBOX === '1')(
    'executes the mounted npm runtime with an unreachable host alias while preserving isolation', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quantpilot-sandbox-regression-'));
      const workspace = path.join(root, 'workspace');
      const sentinel = path.join(root, 'host-only.txt');
      try {
        await fs.mkdir(workspace);
        await fs.writeFile(sentinel, 'host-only');
        const script = [
          "const {execFileSync}=require('node:child_process');",
          "const fs=require('node:fs');",
          "const version=execFileSync('npm',['--version'],{encoding:'utf8'}).trim();",
          "if(!/^\\d+\\.\\d+\\.\\d+$/.test(version))throw new Error('npm unavailable');",
          `if(fs.existsSync(${JSON.stringify(sentinel)}))throw new Error('host path exposed');`,
          "if(process.env.DATABASE_URL)throw new Error('platform environment exposed');",
          "process.stdout.write('isolated runtime ready');",
        ].join('\n');
        const wrapped = await wrapGeneratedProjectCommand(workspace, 'node', ['-e', script]);
        const result = await promisify(execFile)(wrapped.command, wrapped.args, {
          cwd: workspace,
          env: buildGeneratedProjectEnv(workspace, {
            PATH: '/unmounted/node-version-alias/bin:/usr/bin:/bin',
            DATABASE_URL: 'host-only',
          }),
          timeout: 20_000,
        });
        expect(result.stdout).toBe('isolated runtime ready');
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }, 25_000,
  );

  it('uses an explicit minimal environment without platform secrets', () => {
    const env = buildGeneratedProjectEnv('/tmp/project', {
      PATH: '/usr/bin',
      PORT: '4100',
      QUANTPILOT_SANDBOX_PREVIEW_SOCKET: '/tmp/project/.next/preview.sock',
      QUANTPILOT_SANDBOX_PREVIEW_PORT: '4100',
      QUANTPILOT_SANDBOX_MARKET_SOCKET: '/tmp/project/.next/market.sock',
      QUANTPILOT_SANDBOX_MARKET_PORT: '8000',
      DEEPSEEK_API_KEY: 'must-not-leak',
      DATABASE_URL: 'must-not-leak',
    });
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      PORT: '4100',
      QUANTPILOT_SANDBOX_PREVIEW_SOCKET: '/tmp/project/.next/preview.sock',
      QUANTPILOT_SANDBOX_PREVIEW_PORT: '4100',
      QUANTPILOT_SANDBOX_MARKET_SOCKET: '/tmp/project/.next/market.sock',
      QUANTPILOT_SANDBOX_MARKET_PORT: '8000',
      NEXT_TELEMETRY_DISABLED: '1',
      QUANTPILOT_WORKSPACE_ROOT: '/tmp/project',
    });
    expect(env).not.toHaveProperty('DEEPSEEK_API_KEY');
    expect(env).not.toHaveProperty('DATABASE_URL');
  });

  it.runIf(process.platform === 'linux')('wraps commands in user, mount, network, and PID namespaces', async () => {
    const projectPath = path.resolve('data/projects');
    const wrapped = await wrapGeneratedProjectCommand(projectPath, 'npm', ['run', 'build']);
    expect(wrapped.command).toBe('unshare');
    expect(wrapped.args).toEqual(expect.arrayContaining([
      '--user',
      '--map-root-user',
      '--mount',
      '--net',
      '--pid',
      '--fork',
      'npm',
      'run',
      'build',
    ]));
  });

  it('requires the paired explicit override before running a trusted command directly', async () => {
    const projectPath = path.resolve('data/projects');
    process.env.QUANTPILOT_GENERATED_SANDBOX = '0';

    await expect(
      wrapGeneratedProjectCommand(projectPath, 'npm', ['run', 'build']),
    ).rejects.toThrow('explicit unsafe override');

    process.env.QUANTPILOT_ALLOW_UNSANDBOXED_GENERATED_CODE = '1';
    await expect(
      wrapGeneratedProjectCommand(projectPath, 'npm', ['run', 'build']),
    ).resolves.toEqual({ command: 'npm', args: ['run', 'build'] });
  });
});
