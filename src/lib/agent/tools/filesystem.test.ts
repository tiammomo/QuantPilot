import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MoAgentTool, MoAgentToolContext, MoAgentToolResult } from '@/lib/agent/types';
import {
  createApplyPatchTool,
  createEditFileTool,
  createListFilesTool,
  createReadFileRangeTool,
  createReadFileTool,
  createSearchFilesTool,
  createWriteFileTool,
} from './filesystem';
import { MoAgentWorkspacePolicy } from './path-policy';

const context: MoAgentToolContext = {
  runId: 'test-run',
  turn: 1,
  toolCallId: 'test-call',
  operationId: 'op_test',
  signal: new AbortController().signal,
  commitWorkspaceMutation: (commit) => commit(),
};

async function invoke(tool: MoAgentTool, input: unknown): Promise<MoAgentToolResult> {
  const parsed = tool.parseInput ? tool.parseInput(input) : input;
  return tool.execute(parsed, context);
}

describe('MoAgent typed filesystem tools', () => {
  let workspace: string;
  let outside: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moagent-workspace-'));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'moagent-outside-'));
    await fs.mkdir(path.join(workspace, 'app'), { recursive: true });
    await fs.mkdir(path.join(workspace, '.quantpilot'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'app', 'page.tsx'), [
      'export default function Page() {',
      '  return <main>Quant dashboard</main>;',
      '}',
      '',
    ].join('\n'));
    await fs.writeFile(path.join(workspace, '.quantpilot', 'run_plan.json'), '{"status":"ready"}\n');
    await fs.writeFile(path.join(outside, 'secret.txt'), 'host secret\n');
  });

  afterEach(async () => {
    await Promise.all([
      fs.rm(workspace, { recursive: true, force: true }),
      fs.rm(outside, { recursive: true, force: true }),
    ]);
  });

  it('supports bounded list, read, range, and literal search operations', async () => {
    const options = { workspaceRoot: workspace };
    const list = await invoke(createListFilesTool(options), { path: 'app' });
    expect(list).toMatchObject({ ok: true });
    if (list.ok) expect(list.content).toContain('app/page.tsx');

    const read = await invoke(createReadFileTool(options), { path: 'app/page.tsx' });
    expect(read).toMatchObject({ ok: true });
    if (read.ok) expect(read.content).toContain('Quant dashboard');

    const range = await invoke(createReadFileRangeTool(options), {
      path: 'app/page.tsx',
      startLine: 2,
      endLine: 2,
    });
    expect(range).toMatchObject({ ok: true });
    if (range.ok) expect(range.content).toBe('2:   return <main>Quant dashboard</main>;');

    const search = await invoke(createSearchFilesTool(options), {
      path: '.',
      query: 'quant DASHBOARD',
      fileGlob: '**/*.tsx',
    });
    expect(search).toMatchObject({ ok: true });
    if (search.ok) expect(search.content).toContain('app/page.tsx:2:');
  });

  it('rejects traversal and absolute paths, including absolute paths inside the workspace', async () => {
    const tool = createReadFileTool({ workspaceRoot: workspace });
    await expect(invoke(tool, { path: '../secret.txt' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'PATH_TRAVERSAL_DENIED' },
    });
    await expect(invoke(tool, { path: path.join(workspace, 'app', 'page.tsx') })).resolves.toMatchObject({
      ok: false,
      error: { code: 'ABSOLUTE_PATH_DENIED' },
    });
    await expect(invoke(tool, { path: 'app/../../etc/passwd' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'PATH_TRAVERSAL_DENIED' },
    });
  });

  it('denies secrets consistently across read, list, and search tools', async () => {
    await fs.writeFile(path.join(workspace, '.env.local'), 'DEEPSEEK_API_KEY=host-secret\n');
    await fs.writeFile(path.join(workspace, '.npmrc'), '//registry.example/:_authToken=secret\n');
    await fs.writeFile(path.join(workspace, 'private-key.pem'), 'secret key\n');

    for (const sensitivePath of ['.env.local', '.npmrc', 'private-key.pem']) {
      await expect(invoke(createReadFileTool({ workspaceRoot: workspace }), {
        path: sensitivePath,
      }), sensitivePath).resolves.toMatchObject({
        ok: false,
        error: { code: 'SENSITIVE_READ_PATH_DENIED' },
      });
    }

    const listed = await invoke(createListFilesTool({ workspaceRoot: workspace }), { path: '.' });
    expect(listed).toMatchObject({ ok: true, data: { skippedSensitivePaths: 3 } });
    if (listed.ok) {
      expect(listed.content).not.toContain('.env.local');
      expect(listed.content).not.toContain('.npmrc');
      expect(listed.content).not.toContain('private-key.pem');
    }

    const searched = await invoke(createSearchFilesTool({ workspaceRoot: workspace }), {
      path: '.',
      query: 'secret',
    });
    expect(searched).toMatchObject({ ok: true });
    if (searched.ok) expect(searched.content).not.toContain('secret');
  });

  it('hides and protects the internal workspace resource lock', async () => {
    const lockDirectory = path.join(workspace, '.moagent-workspace.lock');
    await fs.mkdir(lockDirectory);
    await fs.writeFile(path.join(lockDirectory, 'owner.json'), '{"pid":123}\n');
    const policy = await MoAgentWorkspacePolicy.create({
      workspaceRoot: workspace,
      allowedWriteGlobs: ['**'],
    });

    await expect(policy.resolveReadPath('.moagent-workspace.lock/owner.json'))
      .rejects.toMatchObject({ code: 'SENSITIVE_READ_PATH_DENIED' });
    await expect(policy.resolveWritePath('.moagent-workspace.lock/owner.json'))
      .rejects.toMatchObject({ code: 'SENSITIVE_PATH_DENIED' });

    const listed = await invoke(createListFilesTool({ workspaceRoot: workspace }), { path: '.' });
    expect(listed).toMatchObject({ ok: true });
    if (listed.ok) expect(listed.content).not.toContain('.moagent-workspace.lock');
  });

  it('rejects read and write escapes through symbolic links', async () => {
    await fs.symlink(outside, path.join(workspace, 'app', 'escape'));

    await expect(invoke(createReadFileTool({ workspaceRoot: workspace }), {
      path: 'app/escape/secret.txt',
    })).resolves.toMatchObject({ ok: false, error: { code: 'SYMLINK_ESCAPE_DENIED' } });

    await expect(invoke(createWriteFileTool({ workspaceRoot: workspace }), {
      path: 'app/escape/stolen.ts',
      content: 'export const stolen = true;\n',
    })).resolves.toMatchObject({ ok: false, error: { code: 'SYMLINK_ESCAPE_DENIED' } });
    await expect(fs.stat(path.join(outside, 'stolen.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps .quantpilot permanently read-only even when a profile supplies a wildcard', async () => {
    const options = { workspaceRoot: workspace, allowedWriteGlobs: ['**'] };
    const read = await invoke(createReadFileTool(options), { path: '.quantpilot/run_plan.json' });
    expect(read).toMatchObject({ ok: true });

    await expect(invoke(createWriteFileTool(options), {
      path: '.quantpilot/run_plan.json',
      content: '{}\n',
    })).resolves.toMatchObject({ ok: false, error: { code: 'PLATFORM_PATH_READ_ONLY' } });
    await expect(fs.readFile(path.join(workspace, '.quantpilot', 'run_plan.json'), 'utf8'))
      .resolves.toBe('{"status":"ready"}\n');
  });

  it('detects a writable-looking symlink alias that resolves into .quantpilot', async () => {
    await fs.symlink(path.join(workspace, '.quantpilot'), path.join(workspace, 'app', 'platform-alias'));
    await expect(invoke(createWriteFileTool({
      workspaceRoot: workspace,
      allowedWriteGlobs: ['**'],
    }), {
      path: 'app/platform-alias/forged.ts',
      content: 'export const forged = true;\n',
    })).resolves.toMatchObject({ ok: false, error: { code: 'PLATFORM_PATH_READ_ONLY' } });
    await expect(fs.stat(path.join(workspace, '.quantpilot', 'forged.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('atomically writes, uniquely edits, and applies structured patches to allowed source files', async () => {
    const options = { workspaceRoot: workspace };
    const write = await invoke(createWriteFileTool(options), {
      path: 'components/cards/Metric.tsx',
      content: 'export const Metric = () => <div>Alpha</div>;\n',
    });
    expect(write).toMatchObject({ ok: true, data: { created: true } });

    const edit = await invoke(createEditFileTool(options), {
      path: 'components/cards/Metric.tsx',
      oldText: 'Alpha',
      newText: 'Beta',
    });
    expect(edit).toMatchObject({ ok: true, data: { replacements: 1 } });

    const patch = await invoke(createApplyPatchTool(options), {
      path: 'components/cards/Metric.tsx',
      edits: [
        { oldText: 'Metric', newText: 'MetricCard' },
        { oldText: 'Beta', newText: 'Gamma' },
      ],
    });
    expect(patch).toMatchObject({ ok: true, data: { replacements: 2 } });
    await expect(fs.readFile(path.join(workspace, 'components/cards/Metric.tsx'), 'utf8'))
      .resolves.toBe('export const MetricCard = () => <div>Gamma</div>;\n');
  });

  it('fails closed when a workspace write has no durable commit fence', async () => {
    const tool = createWriteFileTool({ workspaceRoot: workspace });
    const parsed = tool.parseInput?.({
      path: 'app/unfenced.ts',
      content: 'export const unfenced = true;\n',
    });
    expect(parsed).toBeDefined();
    const result = await tool.execute(parsed!, {
      ...context,
      commitWorkspaceMutation: undefined,
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'WORKSPACE_COMMIT_FENCE_REQUIRED' },
    });
    await expect(fs.stat(path.join(workspace, 'app', 'unfenced.ts')))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses ambiguous edits without modifying the file', async () => {
    const original = 'same\nsame\n';
    await fs.writeFile(path.join(workspace, 'app', 'duplicate.ts'), original);
    await expect(invoke(createEditFileTool({ workspaceRoot: workspace }), {
      path: 'app/duplicate.ts',
      oldText: 'same',
      newText: 'changed',
    })).resolves.toMatchObject({ ok: false, error: { code: 'EDIT_MATCH_AMBIGUOUS' } });
    await expect(fs.readFile(path.join(workspace, 'app', 'duplicate.ts'), 'utf8')).resolves.toBe(original);
  });

  it('denies package, script, env, and final/evidence writes unless the profile explicitly allows final/evidence', async () => {
    const defaultWrite = createWriteFileTool({ workspaceRoot: workspace });
    for (const deniedPath of [
      'package.json',
      'scripts/build.ts',
      '.env.local',
      'data_file/final/dashboard-data.json',
      'evidence/should-not-be-source.ts',
    ]) {
      await expect(invoke(defaultWrite, { path: deniedPath, content: '{}\n' }), deniedPath)
        .resolves.toMatchObject({ ok: false });
    }

    const repairWrite = createWriteFileTool({
      workspaceRoot: workspace,
      allowedWriteGlobs: ['data_file/final/**', 'evidence/**'],
    });
    await expect(invoke(repairWrite, {
      path: 'data_file/final/dashboard-data.json',
      content: '{"series":[]}\n',
    })).resolves.toMatchObject({ ok: true });
    await expect(invoke(repairWrite, {
      path: 'evidence/data_quality.json',
      content: '{"status":"ok"}\n',
    })).resolves.toMatchObject({ ok: true });

    const dataOnlyRepairWrite = createWriteFileTool({
      workspaceRoot: workspace,
      includeDefaultWriteGlobs: false,
      allowedWriteGlobs: ['data_file/final/**'],
    });
    await expect(invoke(dataOnlyRepairWrite, {
      path: 'app/page.tsx',
      content: 'export default function Page() { return null; }\n',
    })).resolves.toMatchObject({ ok: false, error: { code: 'WRITE_PATH_DENIED' } });
    await expect(invoke(dataOnlyRepairWrite, {
      path: 'data_file/final/dashboard-data.json',
      content: '{"series":[]}\n',
    })).resolves.toMatchObject({ ok: true });
  });

  it('does not allow root executable hooks or internal symlink aliases by default', async () => {
    await expect(invoke(createWriteFileTool({ workspaceRoot: workspace }), {
      path: 'middleware.ts',
      content: 'export function middleware() {}\n',
    })).resolves.toMatchObject({ ok: false, error: { code: 'WRITE_PATH_DENIED' } });

    await fs.mkdir(path.join(workspace, 'components'), { recursive: true });
    await fs.symlink(path.join(workspace, 'app'), path.join(workspace, 'components', 'alias'));
    await expect(invoke(createWriteFileTool({ workspaceRoot: workspace }), {
      path: 'components/alias/through-link.ts',
      content: 'export const unsafe = true;\n',
    })).resolves.toMatchObject({ ok: false, error: { code: 'SYMLINK_WRITE_DENIED' } });
  });

  it('truncates model-visible output with an explicit MoAgent marker', async () => {
    await fs.writeFile(path.join(workspace, 'app', 'large.ts'), `HEAD${'x'.repeat(2_000)}TAIL`);
    const result = await invoke(createReadFileTool({
      workspaceRoot: workspace,
      maxOutputChars: 200,
    }), { path: 'app/large.ts' });
    expect(result).toMatchObject({ ok: true, data: { truncated: true } });
    if (result.ok) {
      expect(result.content?.length).toBeLessThanOrEqual(200);
      expect(result.content).toContain('MoAgent output truncated');
      expect(result.content).toContain('HEAD');
      expect(result.content).toContain('TAIL');
    }
  });
});
