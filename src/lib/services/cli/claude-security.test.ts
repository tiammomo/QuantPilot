import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildClaudeRuntimeEnv,
  compactToolOutputForPersistence,
  guardClaudeToolUse,
  validateAgentProjectPath,
} from './claude';

const original = {
  deepseek: process.env.DEEPSEEK_API_KEY,
  database: process.env.DATABASE_URL,
  github: process.env.GITHUB_TOKEN,
};

afterEach(() => {
  for (const [key, value] of Object.entries({
    DEEPSEEK_API_KEY: original.deepseek,
    DATABASE_URL: original.database,
    GITHUB_TOKEN: original.github,
  })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('DeepSeek Agent security boundary', () => {
  it('keeps persisted tool previews bounded without changing small results', () => {
    expect(compactToolOutputForPersistence('small result')).toBe('small result');

    const compacted = compactToolOutputForPersistence(`HEAD:${'x'.repeat(30_000)}:TAIL_ERROR`);
    expect(compacted.length).toBeLessThanOrEqual(12_000);
    expect(compacted).toContain('QuantPilot 已截断');
    expect(compacted).toContain('原始输出 30016 个字符');
    expect(compacted).toContain('HEAD:');
    expect(compacted).toContain(':TAIL_ERROR');
  });

  it('passes only the minimal runtime environment to the SDK process', () => {
    process.env.DEEPSEEK_API_KEY = 'deepseek-test-key';
    process.env.DATABASE_URL = 'postgresql://secret';
    process.env.GITHUB_TOKEN = 'github-secret';

    const env = buildClaudeRuntimeEnv('deepseek-v4-flash');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('deepseek-test-key');
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(env.DEEPSEEK_API_KEY).toBeUndefined();
  });

  it('rejects host filesystem access and environment enumeration', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'quantpilot-agent-security-'));
    try {
      await fs.mkdir(path.join(projectPath, 'app'), { recursive: true });
      await expect(guardClaudeToolUse('Read', { file_path: '/etc/passwd' }, projectPath)).resolves.toMatchObject({ behavior: 'deny' });
      await expect(guardClaudeToolUse('Bash', { command: `ls ${path.dirname(projectPath)}` }, projectPath)).resolves.toMatchObject({ behavior: 'deny' });
      await expect(guardClaudeToolUse('Bash', { command: `ls ${path.join(projectPath, 'app')}` }, projectPath)).resolves.toMatchObject({ behavior: 'allow' });
      await expect(guardClaudeToolUse('Bash', { command: 'printenv' }, projectPath)).resolves.toMatchObject({ behavior: 'deny' });
      await expect(guardClaudeToolUse('Read', { file_path: 'app/page.tsx' }, projectPath)).resolves.toMatchObject({ behavior: 'allow' });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('rejects relative, dynamic, and symlink-based Bash workspace escapes', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'quantpilot-agent-shell-'));
    const outsidePath = await fs.mkdtemp(path.join(os.tmpdir(), 'quantpilot-agent-shell-outside-'));
    try {
      await fs.mkdir(path.join(projectPath, 'app'), { recursive: true });
      await fs.writeFile(path.join(projectPath, 'app', 'page.tsx'), 'export default function Page() { return null; }\n');
      await fs.writeFile(path.join(outsidePath, 'secret.txt'), 'host secret\n');
      await fs.symlink(outsidePath, path.join(projectPath, 'existing-escape'));
      await fs.symlink(path.join(projectPath, 'app'), path.join(projectPath, 'safe-link'));

      const deniedCommands = [
        'cd .. && pwd',
        'cat ../.env.local',
        'cat app/../../.env.local',
        'ls "$PWD/.."',
        'cat "${HOME}/.env"',
        'cat "$(dirname "$PWD")/.env.local"',
        'cat `pwd`/package.json',
        'ln -s .. escape',
        "python -c \"import os; os.symlink('..', 'escape')\"",
        'cat existing-escape/secret.txt',
      ];
      for (const command of deniedCommands) {
        await expect(guardClaudeToolUse('Bash', { command }, projectPath), command)
          .resolves.toMatchObject({ behavior: 'deny' });
      }

      const allowedCommands = [
        'npm run build',
        'CI=1 npm run build',
        'npx next build',
        'cd app && npm run build',
        'rg "dashboard/data" app',
        'cat safe-link/page.tsx',
      ];
      for (const command of allowedCommands) {
        await expect(guardClaudeToolUse('Bash', { command }, projectPath), command)
          .resolves.toMatchObject({ behavior: 'allow' });
      }
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
      await fs.rm(outsidePath, { recursive: true, force: true });
    }
  });

  it('keeps platform-owned .quantpilot artifacts read-only', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'quantpilot-agent-artifacts-'));
    try {
      await fs.mkdir(path.join(projectPath, '.quantpilot'), { recursive: true });
      await expect(guardClaudeToolUse('Read', { file_path: '.quantpilot/validation.json' }, projectPath))
        .resolves.toMatchObject({ behavior: 'allow' });
      await expect(guardClaudeToolUse('Edit', { file_path: '.quantpilot/events.jsonl' }, projectPath))
        .resolves.toMatchObject({ behavior: 'deny' });
      await expect(guardClaudeToolUse('Write', { file_path: path.join(projectPath, '.quantpilot', 'run_plan.json') }, projectPath))
        .resolves.toMatchObject({ behavior: 'deny' });
      await expect(guardClaudeToolUse('MultiEdit', { file_path: '.quantpilot/run_plan.json', edits: [] }, projectPath))
        .resolves.toMatchObject({ behavior: 'deny' });
      await expect(guardClaudeToolUse('MultiEdit', { edits: [{ path: '.quantpilot/events.jsonl' }] }, projectPath))
        .resolves.toMatchObject({ behavior: 'deny' });
      await expect(guardClaudeToolUse('Bash', { command: 'rm -rf .quantpilot' }, projectPath))
        .resolves.toMatchObject({ behavior: 'deny' });
      await expect(guardClaudeToolUse('Bash', { command: 'cd .quantpilot && rm validation.json' }, projectPath))
        .resolves.toMatchObject({ behavior: 'deny' });
      await expect(guardClaudeToolUse('Bash', { command: 'find .quantpilot -type f -delete' }, projectPath))
        .resolves.toMatchObject({ behavior: 'deny' });
      await expect(guardClaudeToolUse('Bash', { command: 'cd .quantpilot && git clean -fd' }, projectPath))
        .resolves.toMatchObject({ behavior: 'deny' });
      await expect(guardClaudeToolUse('Bash', { command: 'rm app/old.ts && ls .quantpilot' }, projectPath))
        .resolves.toMatchObject({ behavior: 'deny' });
      await expect(guardClaudeToolUse('Bash', { command: 'cat .quantpilot/run_plan.json | jq .status' }, projectPath))
        .resolves.toMatchObject({ behavior: 'allow' });
    } finally {
      await fs.rm(projectPath, { recursive: true, force: true });
    }
  });

  it('rejects a project directory that escapes through a symlinked parent', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'quantpilot-agent-root-'));
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'quantpilot-agent-outside-'));
    try {
      await fs.symlink(outside, path.join(root, 'escaped'));
      await expect(validateAgentProjectPath(path.join(root, 'escaped', 'workspace'), root))
        .rejects.toThrow(/resolves outside/);
      await expect(validateAgentProjectPath(path.join(root, 'safe-workspace'), root))
        .resolves.toBe(path.join(root, 'safe-workspace'));
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outside, { recursive: true, force: true });
    }
  });
});
