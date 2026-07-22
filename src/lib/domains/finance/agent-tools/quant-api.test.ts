import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MoAgentTool, MoAgentToolContext, MoAgentToolResult } from '@/lib/agent/types';
import { createFinanceMoAgentTools as createMoAgentTools } from './factory';
import { createQuantApiGetTool } from './quant-api';
import { createSubmitResultTool } from '@/lib/agent/tools/submit-result';

function context(signal = new AbortController().signal): MoAgentToolContext {
  return {
    runId: 'run',
    turn: 1,
    toolCallId: 'call',
    operationId: 'op_test',
    signal,
    commitWorkspaceMutation: (commit) => commit(),
  };
}

async function invoke(tool: MoAgentTool, input: unknown, signal?: AbortSignal): Promise<MoAgentToolResult> {
  return tool.execute(tool.parseInput ? tool.parseInput(input) : input, context(signal));
}

describe('MoAgent typed quant and terminal tools', () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moagent-terminal-'));
    await fs.mkdir(path.join(workspace, 'app'), { recursive: true });
    await fs.writeFile(path.join(workspace, 'app', 'page.tsx'), 'export default function Page() { return null; }\n');
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  it('uses GET against only the fixed local API and URL-encodes query values', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const tool = createQuantApiGetTool({ fetchImpl });
    const result = await invoke(tool, {
      path: '/api/v1/quotes/history/600519',
      query: { symbol: '600519.SH & test', limit: 20, adjusted: true },
    });
    expect(result).toMatchObject({ ok: true, data: { status: 200 } });
    if (result.ok) expect(result.content).toBe('{"ok":true}');
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [requestUrl, init] = fetchImpl.mock.calls[0] as unknown as [URL | RequestInfo, RequestInit | undefined];
    expect(String(requestUrl)).toBe('http://127.0.0.1:8000/api/v1/quotes/history/600519?symbol=600519.SH+%26+test&limit=20&adjusted=true');
    expect(init).toMatchObject({ method: 'GET', redirect: 'error' });
  });

  it('returns a valid, bounded JSON window for large time-series responses', async () => {
    const responseBody = JSON.stringify({
      symbol: '600589.SH',
      summary: { latest_close: 12.34, period_return_pct: 8.7 },
      data_quality: { status: 'ok', warnings: [] },
      bars: Array.from({ length: 240 }, (_, index) => ({
        sequence: index,
        date: `2026-01-${String((index % 28) + 1).padStart(2, '0')}`,
        open: 10 + index / 100,
        high: 11 + index / 100,
        low: 9 + index / 100,
        close: 10.5 + index / 100,
        volume: 1_000_000 + index,
      })),
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(responseBody, {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const result = await invoke(createQuantApiGetTool({
      fetchImpl,
      maxOutputChars: 2_500,
    }), {
      path: '/api/v1/research/bars/600589.SH',
      query: { limit: 240 },
    });

    expect(result).toMatchObject({
      ok: true,
      data: { truncated: true, outputStrategy: 'json_window' },
    });
    if (!result.ok || result.content === undefined) {
      throw new Error('Expected successful quant API result with content');
    }
    expect(result.content.length).toBeLessThanOrEqual(2_500);
    const content = JSON.parse(result.content);
    expect(content.$moagent).toMatchObject({
      kind: 'quant_api_result_window',
      version: 1,
      strategy: 'head_and_recent_tail',
      sourcePath: '/api/v1/research/bars/600589.SH',
      truncated: true,
    });
    expect(content.data).toMatchObject({
      symbol: '600589.SH',
      summary: { latest_close: 12.34, period_return_pct: 8.7 },
      data_quality: { status: 'ok' },
    });
    expect(content.data.bars[0].sequence).toBe(0);
    expect(content.data.bars.at(-1).sequence).toBe(239);
    expect(content.data.bars.length).toBeLessThan(240);
  });

  it('turns a response-byte overflow into valid bounded JSON with a narrower-query hint', async () => {
    const responseBody = JSON.stringify({
      bars: Array.from({ length: 500 }, (_, index) => ({ index, value: '行情数据'.repeat(20) })),
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(responseBody));
    const result = await invoke(createQuantApiGetTool({
      fetchImpl,
      maxResponseBytes: 512,
      maxOutputChars: 1_000,
    }), {
      path: '/api/v1/quotes/history/600589.SH',
      query: { limit: 500 },
    });

    expect(result).toMatchObject({
      ok: true,
      data: { truncated: true, outputStrategy: 'response_byte_limit' },
    });
    if (!result.ok || result.content === undefined) {
      throw new Error('Expected successful bounded quant API result with content');
    }
    expect(result.content.length).toBeLessThanOrEqual(1_000);
    const content = JSON.parse(result.content);
    expect(content.$moagent).toMatchObject({
      kind: 'quant_api_result_window',
      responseByteLimitReached: true,
      strategy: 'response_byte_limit',
    });
    expect(content.$moagent.retryHint).toContain('smaller limit');
  });

  it('rejects arbitrary hosts, traversal, encoded traversal, and query text in path', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const tool = createQuantApiGetTool({ fetchImpl });
    for (const deniedPath of [
      'http://evil.example/api/v1/bars',
      '//evil.example/api/v1/bars',
      '/api/v1/../admin',
      '/api/v1/%2e%2e/admin',
      '/api/v1/bars?host=evil.example',
    ]) {
      await expect(invoke(tool, { path: deniedPath }), deniedPath).resolves.toMatchObject({
        ok: false,
        error: { code: 'QUANT_API_PATH_DENIED' },
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects local management endpoints outside the read-only quant allowlist', async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const tool = createQuantApiGetTool({ fetchImpl });
    for (const deniedPath of [
      '/api/v1/provider-candidates/probe',
      '/api/v1/ingestion/jobs',
    ]) {
      await expect(invoke(tool, { path: deniedPath }), deniedPath).resolves.toMatchObject({
        ok: false,
        error: { code: 'QUANT_API_ENDPOINT_DENIED' },
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('enforces timeout and caller cancellation even if an injected transport never settles', async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => undefined));
    const timedOut = await invoke(createQuantApiGetTool({ fetchImpl, timeoutMs: 10 }), {
      path: '/api/v1/quotes/realtime/600519',
    });
    expect(timedOut).toMatchObject({ ok: false, error: { code: 'TOOL_TIMEOUT' } });

    const aborted = await invoke(
      createQuantApiGetTool({ fetchImpl }),
      { path: '/api/v1/quotes/realtime/600519' },
      AbortSignal.abort(),
    );
    expect(aborted).toMatchObject({ ok: false, error: { code: 'ABORTED' } });
  });

  it('enforces a per-run request budget before making another local call', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{}'));
    const tool = createQuantApiGetTool({ fetchImpl, maxRequests: 1 });
    await expect(invoke(tool, { path: '/api/v1/registry' })).resolves.toMatchObject({ ok: true });
    await expect(invoke(tool, { path: '/api/v1/registry' })).resolves.toMatchObject({
      ok: false,
      error: { code: 'QUANT_API_REQUEST_BUDGET_EXCEEDED' },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('marks submit_result terminal and verifies artifact containment', async () => {
    const tool = createSubmitResultTool({ workspaceRoot: workspace });
    expect(tool.terminal).toBe(true);
    await expect(invoke(tool, {
      summary: 'Dashboard complete.',
      artifacts: ['app/page.tsx'],
    })).resolves.toMatchObject({
      ok: true,
      data: { verifiedArtifacts: ['app/page.tsx'] },
    });
    await expect(invoke(tool, {
      summary: 'Invalid.',
      artifacts: ['../host.txt'],
    })).resolves.toMatchObject({ ok: false, error: { code: 'PATH_TRAVERSAL_DENIED' } });
  });

  it('builds generation and repair registries without any Bash tool', () => {
    const imageTool: MoAgentTool = {
      name: 'image_extract',
      description: 'test typed extension',
      inputSchema: { type: 'object' },
      projectContextReceipt: () => ({ targetReferences: ['../../untrusted'] }),
      execute: () => ({ ok: true, data: {} }),
    };
    const generation = createMoAgentTools({ workspaceRoot: workspace, additionalTools: [imageTool] });
    expect(generation.map((tool) => tool.name)).toEqual([
      'list_files',
      'read_file',
      'read_file_range',
      'search_files',
      'write_file',
      'edit_file',
      'apply_patch',
      'inspect_dashboard_contract',
      'query_json',
      'query_text_file',
      'quant_api_get',
      'submit_result',
      'quant_extract_uploaded_image',
      'image_extract',
    ]);
    expect(generation.some((tool) => /bash|shell/i.test(tool.name))).toBe(false);
    expect(generation.find((tool) => tool.name === 'read_file')?.projectContextReceipt)
      .toEqual(expect.any(Function));
    expect(generation.find((tool) => tool.name === 'image_extract')?.projectContextReceipt)
      .toBeUndefined();
    expect(() => createMoAgentTools({
      workspaceRoot: workspace,
      additionalTools: [generation[0]],
    })).toThrow(/Duplicate MoAgent tool name/);
  });

  it('builds a minimal recoverable standard surface for prepared data', () => {
    const prepared = createMoAgentTools({
      workspaceRoot: workspace,
      targetedReadsOnly: true,
      preparedSurface: 'standard',
      profileAllowedWriteGlobs: ['app/page.tsx', 'app/globals.css'],
      includeDefaultWriteGlobs: false,
      includeQuantApi: false,
      includeImageExtraction: false,
      includeDashboardSpec: true,
      includeSemanticEdit: true,
    });

    expect(prepared.map((tool) => tool.name)).toEqual([
      'apply_dashboard_spec',
      'submit_result',
    ]);
    expect(prepared.some((tool) => [
      'list_files',
      'read_file',
      'read_file_range',
      'search_files',
      'quant_api_get',
    ].includes(tool.name))).toBe(false);
    const dashboard = prepared.find((tool) => tool.name === 'apply_dashboard_spec')!;
    expect(dashboard.projectContextReceipt?.({}, {
      ok: true,
      data: {
        files: [
          { path: 'app/page.tsx' },
          { path: 'app/globals.css' },
        ],
      },
    })).toEqual({ targetReferences: ['app/page.tsx', 'app/globals.css'] });
  });

  it('builds a compiler-free prepared custom surface without legacy mutations', () => {
    const custom = createMoAgentTools({
      workspaceRoot: workspace,
      preparedSurface: 'custom',
      profileAllowedWriteGlobs: ['app/page.tsx', 'app/globals.css'],
      includeDefaultWriteGlobs: false,
      includeQuantApi: false,
      includeImageExtraction: false,
      includeDashboardSpec: false,
      includeSemanticEdit: true,
    });

    expect(custom.map((tool) => tool.name)).toEqual([
      'query_json',
      'query_text_file',
      'semantic_edit',
      'submit_result',
    ]);
    expect(custom.some((tool) => [
      'write_file',
      'edit_file',
      'apply_patch',
      'apply_dashboard_spec',
      'inspect_dashboard_contract',
    ].includes(tool.name))).toBe(false);
  });

  it('fails configuration instead of silently discarding tools from a prepared surface', () => {
    expect(() => createMoAgentTools({
      workspaceRoot: workspace,
      preparedSurface: 'standard',
      includeDashboardSpec: true,
      includeQuantApi: true,
      includeImageExtraction: false,
    })).toThrow(/require quant API, image extraction, and plugin tools to be disabled/);

    expect(() => createMoAgentTools({
      workspaceRoot: workspace,
      preparedSurface: 'custom',
      includeQuantApi: false,
      includeImageExtraction: false,
      includeSemanticEdit: true,
    })).toThrow(/includeDefaultWriteGlobs=false/);

    expect(() => createMoAgentTools({
      workspaceRoot: workspace,
      preparedSurface: 'custom',
      profileAllowedWriteGlobs: ['public/**'],
      includeDefaultWriteGlobs: false,
      includeQuantApi: false,
      includeImageExtraction: false,
      includeSemanticEdit: true,
    })).toThrow(/outside the certified app source scope/);
  });

  it('narrows a repair episode to its trusted mutation strategy', () => {
    const repair = createMoAgentTools({
      workspaceRoot: workspace,
      profile: 'repair',
      profileAllowedWriteGlobs: ['app/page.tsx', 'app/globals.css'],
      includeQuantApi: false,
      includeImageExtraction: false,
      includeDashboardSpec: true,
      includeSemanticEdit: true,
      allowedMutationToolNames: ['semantic_edit'],
    });

    expect(repair.some((tool) => tool.name === 'semantic_edit')).toBe(true);
    expect(repair.filter((tool) => tool.effect === 'workspace_write').map((tool) => tool.name))
      .toEqual(['semantic_edit']);
    expect(repair.some((tool) => tool.name === 'submit_result')).toBe(true);
  });

  it('treats extension tools without an effect as mutations in the allowlist gate', () => {
    const implicitMutator: MoAgentTool = {
      name: 'implicit_mutator',
      description: 'Effect intentionally omitted.',
      inputSchema: { type: 'object' },
      execute: () => ({ ok: true, data: {} }),
    };
    const repair = createMoAgentTools({
      workspaceRoot: workspace,
      profile: 'repair',
      profileAllowedWriteGlobs: ['app/page.tsx'],
      includeQuantApi: false,
      includeImageExtraction: false,
      includeSemanticEdit: true,
      allowedMutationToolNames: ['semantic_edit'],
      additionalTools: [implicitMutator],
    });

    expect(repair.some((tool) => tool.name === 'implicit_mutator')).toBe(false);
    expect(repair.some((tool) => tool.name === 'semantic_edit')).toBe(true);
  });

  it('omits dashboard inspection after orchestration already preflighted the contract', () => {
    const tools = createMoAgentTools({
      workspaceRoot: workspace,
      includeDashboardInspector: false,
      includeImageExtraction: false,
    });

    expect(tools.some((tool) => tool.name === 'inspect_dashboard_contract')).toBe(false);
  });

  it('rejects unknown mutation allowlist entries', () => {
    expect(() => createMoAgentTools({
      workspaceRoot: workspace,
      allowedMutationToolNames: ['shell'],
    })).toThrow(/Unknown MoAgent mutation tool allowlist entries: shell/);
  });

  it('applies the named generation and repair write profiles', async () => {
    const generationWrite = createMoAgentTools({
      workspaceRoot: workspace,
      profile: 'generation',
      includeImageExtraction: false,
    }).find((tool) => tool.name === 'write_file')!;
    const repairWrite = createMoAgentTools({
      workspaceRoot: workspace,
      profile: 'repair',
      profileAllowedWriteGlobs: ['data_file/final/**', 'evidence/**'],
      includeImageExtraction: false,
    }).find((tool) => tool.name === 'write_file')!;

    await expect(invoke(generationWrite, {
      path: 'evidence/data_quality.json',
      content: '{"status":"ok"}\n',
    })).resolves.toMatchObject({ ok: false, error: { code: 'WRITE_PATH_DENIED' } });
    await expect(invoke(repairWrite, {
      path: 'evidence/data_quality.json',
      content: '{"status":"ok"}\n',
    })).resolves.toMatchObject({ ok: true });
  });

  it('passes the exact repair allowlist to semantic tools without reopening default source roots', async () => {
    const pagePath = path.join(workspace, 'app', 'page.tsx');
    const page = await fs.readFile(pagePath, 'utf8');
    const repairTools = createMoAgentTools({
      workspaceRoot: workspace,
      profile: 'repair',
      profileAllowedWriteGlobs: ['app/**/*.tsx'],
      includeDefaultWriteGlobs: false,
      includeSemanticEdit: true,
      includeImageExtraction: false,
    });
    const semanticEdit = repairTools.find((tool) => tool.name === 'semantic_edit')!;
    const writeFile = repairTools.find((tool) => tool.name === 'write_file')!;

    await expect(invoke(semanticEdit, {
      path: 'app/page.tsx',
      kind: 'line_range',
      beforeSha256: createHash('sha256').update(page).digest('hex'),
      startLine: 1,
      endLine: 1,
      replacement: 'export default function Page() { return <main />; }',
    })).resolves.toMatchObject({ ok: true });
    await expect(invoke(writeFile, {
      path: 'components/Unauthorized.tsx',
      content: 'export function Unauthorized() { return null; }\n',
    })).resolves.toMatchObject({ ok: false, error: { code: 'WRITE_PATH_DENIED' } });
  });
});
