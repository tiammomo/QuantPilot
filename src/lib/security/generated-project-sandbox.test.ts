import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildGeneratedProjectEnv, wrapGeneratedProjectCommand } from './generated-project-sandbox';

afterEach(() => {
  delete process.env.QUANTPILOT_ALLOW_UNSANDBOXED_GENERATED_CODE;
  delete process.env.QUANTPILOT_GENERATED_SANDBOX;
});

describe('generated project sandbox', () => {
  it('uses an explicit minimal environment without platform secrets', () => {
    const env = buildGeneratedProjectEnv('/tmp/project', {
      PATH: '/usr/bin',
      PORT: '4100',
      DEEPSEEK_API_KEY: 'must-not-leak',
      DATABASE_URL: 'must-not-leak',
    });
    expect(env).toMatchObject({
      PATH: '/usr/bin',
      PORT: '4100',
      NEXT_TELEMETRY_DISABLED: '1',
      QUANTPILOT_WORKSPACE_ROOT: '/tmp/project',
    });
    expect(env).not.toHaveProperty('DEEPSEEK_API_KEY');
    expect(env).not.toHaveProperty('DATABASE_URL');
  });

  it.runIf(process.platform === 'linux')('wraps commands in user, mount, and PID namespaces', async () => {
    const projectPath = path.resolve('data/projects');
    const wrapped = await wrapGeneratedProjectCommand(projectPath, 'npm', ['run', 'build']);
    expect(wrapped.command).toBe('unshare');
    expect(wrapped.args).toEqual(expect.arrayContaining([
      '--user',
      '--map-root-user',
      '--mount',
      '--pid',
      '--fork',
      'npm',
      'run',
      'build',
    ]));
  });
});
