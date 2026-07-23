import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MoAgentTool, MoAgentToolContext, MoAgentToolResult } from '@/lib/agent/types';

import { createReadFileRangeTool, createReadFileTool } from './filesystem';
import { createMoAgentTools } from './index';
import { createQueryJsonTool, createQueryTextFileTool } from './structured-read';

const TEST_JSON_ARTIFACTS = {
  paths: {
    final_dashboard: 'data_file/final/dashboard-data.json',
    sources_evidence: 'evidence/sources.json',
    data_quality_evidence: 'evidence/data_quality.json',
  },
  resolveAlias(requestedPath: string) {
    const normalized = requestedPath.replace(/^\/+/u, '');
    const symbol = normalized.match(/^public\/data\/(\d{6})\.json$/u)?.[1];
    return /^(?:public\/data\/(?:dashboard|\d{6})|data\/dashboard)\.json$/u.test(normalized)
      ? {
          artifactId: 'final_dashboard',
          ...(symbol ? { requestedIdentity: symbol } : {}),
        }
      : null;
  },
  validateAliasIdentity(root: unknown, requestedIdentity: string) {
    const record = root && typeof root === 'object' && !Array.isArray(root)
      ? root as Record<string, unknown>
      : {};
    const values = [
      record.symbol,
      record.quote && typeof record.quote === 'object'
        ? (record.quote as Record<string, unknown>).symbol
        : null,
    ].flatMap((value) => {
      const match = String(value ?? '').match(/\d{6}/u);
      return match ? [match[0]] : [];
    });
    const availableIdentities = [...new Set(values)];
    return {
      matches: availableIdentities.includes(requestedIdentity),
      availableIdentities,
    };
  },
} as const;

const context: MoAgentToolContext = {
  runId: 'run-structured-read',
  turn: 1,
  toolCallId: 'call-structured-read',
  operationId: 'op_structured_read',
  signal: new AbortController().signal,
};

async function invoke(tool: MoAgentTool, input: unknown): Promise<MoAgentToolResult> {
  const parsed = tool.parseInput ? tool.parseInput(input) : input;
  return tool.execute(parsed, context);
}

describe('MoAgent structured read tools', () => {
  let workspace: string;
  let outside: string;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moagent-structured-read-'));
    outside = await fs.mkdtemp(path.join(os.tmpdir(), 'moagent-structured-outside-'));
    await fs.mkdir(path.join(workspace, 'data_file', 'final'), { recursive: true });
    await fs.mkdir(path.join(workspace, 'evidence'), { recursive: true });
    await fs.mkdir(path.join(workspace, 'app'), { recursive: true });
  });

  afterEach(async () => {
    await Promise.all([
      fs.rm(workspace, { recursive: true, force: true }),
      fs.rm(outside, { recursive: true, force: true }),
    ]);
  });

  it('queries business values with JSON Pointers and bounds large arrays as early plus recent samples', async () => {
    const dashboard = {
      quote: { symbol: '600589.SH', price: 12.34, change_percent: 2.1 },
      kline: {
        bars: Array.from({ length: 240 }, (_, index) => ({
          sequence: index,
          date: `2026-01-${String((index % 28) + 1).padStart(2, '0')}`,
          open: 10 + index / 100,
          high: 11 + index / 100,
          low: 9 + index / 100,
          close: 10.5 + index / 100,
          volume: 1_000_000 + index,
        })),
      },
      evidence: { warnings: ['样本仅供研究，不构成投资建议'] },
    };
    const filePath = path.join(workspace, 'data_file', 'final', 'dashboard-data.json');
    await fs.writeFile(filePath, `${JSON.stringify(dashboard, null, 2)}\n`, 'utf8');
    const result = await invoke(createQueryJsonTool({
      workspaceRoot: workspace,
      maxOutputChars: 4_000,
    }), {
      path: 'data_file/final/dashboard-data.json',
      pointers: ['/quote', '/kline/bars', '/evidence/warnings', '/not-found'],
      maxArrayItems: 12,
    });

    expect(result).toMatchObject({
      ok: true,
      data: {
        path: 'data_file/final/dashboard-data.json',
        queryCount: 4,
        truncated: true,
      },
    });
    if (!result.ok || !result.content) throw new Error('Expected query_json content');
    expect(result.content.length).toBeLessThanOrEqual(4_000);
    const report = JSON.parse(result.content);
    expect(report.$moagent).toMatchObject({
      kind: 'bounded_json_pointer_query',
      selection: 'head_and_recent_tail',
      omissionCount: expect.any(Number),
    });
    const quote = report.queries.find((query: { pointer: string }) => query.pointer === '/quote');
    const bars = report.queries.find((query: { pointer: string }) => query.pointer === '/kline/bars');
    const missing = report.queries.find((query: { pointer: string }) => query.pointer === '/not-found');
    expect(quote.value).toEqual(dashboard.quote);
    expect(bars).toMatchObject({ found: true, valueType: 'array', originalSize: 240 });
    expect(bars.value.length).toBeLessThan(240);
    expect(bars.value[0].sequence).toBe(0);
    expect(bars.value.at(-1).sequence).toBe(239);
    expect(missing).toEqual({ pointer: '/not-found', found: false, valueType: null });
  });

  it('resolves authoritative artifact handles and safely corrects recognized dashboard aliases', async () => {
    const dashboard = {
      symbol: '600589',
      quote: { symbol: '600589.SH', price: 12.34 },
    };
    await fs.writeFile(
      path.join(workspace, 'data_file', 'final', 'dashboard-data.json'),
      JSON.stringify(dashboard),
      'utf8',
    );
    const tool = createQueryJsonTool({
      workspaceRoot: workspace,
      jsonArtifacts: TEST_JSON_ARTIFACTS,
    });

    const artifactResult = await invoke(tool, {
      artifact: 'final_dashboard',
      pointers: ['/quote'],
    });
    expect(artifactResult).toMatchObject({
      ok: true,
      data: {
        path: 'data_file/final/dashboard-data.json',
        requestedPath: 'artifact:final_dashboard',
        resolvedPath: 'data_file/final/dashboard-data.json',
        pathResolved: true,
        pathCorrected: false,
        correctionReason: 'artifact_handle',
      },
    });

    for (const alias of ['/public/data/dashboard.json', '/public/data/600589.json']) {
      const corrected = await invoke(tool, { path: alias, pointers: ['/quote'] });
      expect(corrected).toMatchObject({
        ok: true,
        data: {
          requestedPath: alias,
          resolvedPath: 'data_file/final/dashboard-data.json',
          pathResolved: true,
          pathCorrected: true,
          correctionReason: 'recognized_artifact_alias',
        },
      });
      if (!corrected.ok || !corrected.content) throw new Error('Expected corrected query');
      expect(JSON.parse(corrected.content).$moagent.pathCorrection).toEqual({
        requestedPath: alias,
        resolvedPath: 'data_file/final/dashboard-data.json',
        reason: 'recognized_artifact_alias',
      });
    }
  });

  it('rejects symbol aliases that do not match the authoritative final artifact', async () => {
    await fs.writeFile(
      path.join(workspace, 'data_file', 'final', 'dashboard-data.json'),
      JSON.stringify({ symbol: '600589', quote: { symbol: '600589.SH' } }),
      'utf8',
    );
    const result = await invoke(createQueryJsonTool({
      workspaceRoot: workspace,
      jsonArtifacts: TEST_JSON_ARTIFACTS,
    }), {
      path: '/public/data/000001.json',
      pointers: ['/quote'],
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'ARTIFACT_IDENTITY_MISMATCH',
        details: {
          requestedIdentity: '000001',
          availableIdentities: ['600589'],
        },
      },
    });
  });

  it('returns authoritative JSON candidates for an unknown missing path', async () => {
    await fs.writeFile(
      path.join(workspace, 'data_file', 'final', 'dashboard-data.json'),
      JSON.stringify({ symbol: '600589' }),
      'utf8',
    );
    const result = await invoke(createQueryJsonTool({
      workspaceRoot: workspace,
      jsonArtifacts: TEST_JSON_ARTIFACTS,
    }), {
      path: 'public/data/not-real.json',
      pointers: [''],
    });

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'PATH_NOT_FOUND',
        details: {
          requestedPath: 'public/data/not-real.json',
          suggestions: ['data_file/final/dashboard-data.json'],
        },
      },
    });
    expect(result.content).toContain('data_file/final/dashboard-data.json');
  });

  it('implements RFC 6901 escaping and exact array-index lookup', async () => {
    await fs.writeFile(
      path.join(workspace, 'evidence', 'pointer.json'),
      JSON.stringify({ 'a/b': { '~key': [{ value: 1 }, { value: 2 }] } }),
      'utf8',
    );
    const tool = createQueryJsonTool({ workspaceRoot: workspace });
    const result = await invoke(tool, {
      path: 'evidence/pointer.json',
      pointers: ['/a~1b/~0key/1/value'],
    });

    expect(result).toMatchObject({ ok: true });
    if (!result.ok || !result.content) throw new Error('Expected pointer result');
    expect(JSON.parse(result.content).queries[0]).toMatchObject({
      found: true,
      valueType: 'number',
      value: 2,
    });
    expect(tool.parseInput?.({
      path: 'evidence/pointer.json',
      pointers: ['not-a-pointer'],
    })).toMatchObject({ pointers: ['/not-a-pointer'] });
    expect(() => tool.parseInput?.({
      path: 'evidence/pointer.json',
      pointers: ['/bad~2escape'],
    })).toThrow(/invalid '~' escape/);
    expect(tool.parseInput?.({
      path: 'evidence/pointer.json',
      pointer: '/a~1b/~0key/0/value',
    })).toMatchObject({ pointers: ['/a~1b/~0key/0/value'] });
    expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(['artifact', 'path', 'pointers']);
  });

  it('keeps values for a dashboard-wide pointer batch within one bounded result', async () => {
    const dashboard = {
      quote: {
        symbol: '600589.SH', name: '大位科技', source: 'eastmoney', price: 12.34,
        open: 12, high: 12.5, low: 11.8, change_percent: 2.1, fetched_at: '2026-07-15',
      },
      kline: { bars: Array.from({ length: 240 }, (_, index) => ({ date: index, close: index })) },
      technicalIndicators: { summary: { symbol: '600589.SH', latest_close: 12.34, trend_state: 'up' } },
      financials: { reports: Array.from({ length: 20 }, (_, index) => ({ report_date: index, revenue: index })) },
      announcements: { announcements: Array.from({ length: 20 }, (_, index) => ({ date: index, title: `event-${index}` })) },
      computedMetrics: { periodReturn: 0.2, return20d: 0.1, maxDrawdown: -0.08, volatility20d: 0.3 },
      liquidity: { method: 'daily', rows: Array.from({ length: 20 }, (_, index) => ({ date: index })) },
      visualization: { summary: 'terminal', rows: Array.from({ length: 20 }, (_, index) => ({ id: index })) },
      conclusion: { summary: '中性偏多', risk_disclaimer: '仅供研究' },
    };
    await fs.writeFile(
      path.join(workspace, 'data_file', 'final', 'dashboard-data.json'),
      JSON.stringify(dashboard),
      'utf8',
    );
    const pointers = [
      '/quote', '/kline/bars', '/technicalIndicators/summary', '/financials/reports',
      '/announcements/announcements', '/computedMetrics', '/liquidity', '/visualization',
      '/conclusion',
    ];
    const result = await invoke(createQueryJsonTool({
      workspaceRoot: workspace,
      maxOutputChars: 6_000,
    }), {
      path: 'data_file/final/dashboard-data.json',
      pointers,
    });

    expect(result).toMatchObject({ ok: true, data: { queryCount: pointers.length } });
    if (!result.ok || !result.content) throw new Error('Expected dashboard batch');
    expect(result.content.length).toBeLessThanOrEqual(6_000);
    const report = JSON.parse(result.content);
    expect(report.queries).toHaveLength(pointers.length);
    expect(report.queries.every((query: Record<string, unknown>) => Object.hasOwn(query, 'value'))).toBe(true);
    const quote = report.queries.find((query: { pointer: string }) => query.pointer === '/quote');
    expect(quote.value).toMatchObject({ symbol: '600589.SH', price: 12.34, change_percent: 2.1 });
  });

  it('compresses a broad batch before falling back to metadata-only results', async () => {
    const row = Object.fromEntries(Array.from({ length: 20 }, (_unused, index) => [
      `field_${index}`,
      `value-${index}-${'x'.repeat(200)}`,
    ]));
    const broad = Object.fromEntries(Array.from({ length: 4 }, (_unused, index) => [
      `dataset_${index}`,
      Array.from({ length: 40 }, () => row),
    ]));
    await fs.writeFile(
      path.join(workspace, 'data_file', 'final', 'dashboard-data.json'),
      JSON.stringify(broad),
      'utf8',
    );
    const result = await invoke(createQueryJsonTool({
      workspaceRoot: workspace,
      maxOutputChars: 3_000,
    }), {
      path: 'data_file/final/dashboard-data.json',
      pointers: ['/dataset_0', '/dataset_1', '/dataset_2', '/dataset_3'],
    });

    expect(result).toMatchObject({ ok: true, data: { truncated: true, queryCount: 4 } });
    if (!result.ok || !result.content) throw new Error('Expected bounded batch');
    expect(result.content.length).toBeLessThanOrEqual(3_000);
    const report = JSON.parse(result.content);
    expect(report.$moagent).toMatchObject({
      kind: 'bounded_json_pointer_query',
      omissionCount: expect.any(Number),
      omissionDetailsTruncated: true,
    });
    expect(report.queries[0]).toMatchObject({
      pointer: '/dataset_0',
      found: true,
      valueType: 'array',
      originalSize: 40,
    });
    expect(report.queries.every((query: Record<string, unknown>) => Object.hasOwn(query, 'value'))).toBe(true);
  });

  it('reads merged source windows around named anchors instead of scanning a whole page', async () => {
    const lines = Array.from({ length: 400 }, (_, index) => `const filler${index + 1} = ${index + 1};`);
    lines[99] = 'function PriceCard({ price }: { price: number }) {';
    lines[100] = '  return <strong>{price}</strong>;';
    lines[101] = '}';
    lines[139] = 'function RiskPanel({ risk }: { risk: string }) {';
    lines[140] = '  return <section>{risk}</section>;';
    lines[141] = '}';
    await fs.writeFile(path.join(workspace, 'app', 'page.tsx'), lines.join('\n'), 'utf8');
    const result = await invoke(createQueryTextFileTool({
      workspaceRoot: workspace,
      maxOutputChars: 6_000,
    }), {
      path: 'app/page.tsx',
      anchors: ['function PriceCard', 'function RiskPanel'],
      beforeLines: 2,
      afterLines: 5,
    });

    expect(result).toMatchObject({
      ok: true,
      data: { totalLines: 400, windowCount: 2, truncated: false },
    });
    if (!result.ok || !result.content) throw new Error('Expected source windows');
    expect(result.content).toContain('function PriceCard');
    expect(result.content).toContain('function RiskPanel');
    expect(result.content).toContain('98:');
    expect(result.content).not.toContain('const filler1 = 1;');
    expect(result.content).not.toContain('const filler400 = 400;');
  });

  it('accepts DeepSeek anchor aliases, clamps legacy window tuning, and fairly preserves a batch', async () => {
    const lines = Array.from({ length: 1_200 }, (_, index) => `const filler_${index + 1} = ${index + 1};`);
    const anchors = Array.from({ length: 16 }, (_unused, index) => `ANCHOR_${index}`);
    anchors.forEach((anchor, index) => {
      lines[20 + index * 60] = `function ${anchor}() { return ${index}; }`;
    });
    await fs.writeFile(path.join(workspace, 'app', 'page.tsx'), lines.join('\n'), 'utf8');
    const tool = createQueryTextFileTool({ workspaceRoot: workspace, maxOutputChars: 2_400 });

    expect(tool.parseInput?.({
      path: 'app/page.tsx',
      anchors: 'function ANCHOR_0()',
      afterLines: 999,
      beforeLines: '-5',
      maxMatchesPerQuery: '99',
    })).toMatchObject({
      anchors: ['function ANCHOR_0()'],
      afterLines: 200,
      beforeLines: 0,
      maxMatchesPerAnchor: 10,
    });
    expect(tool.parseInput?.({
      path: 'app/page.tsx',
      queries: ['function ANCHOR_1()'],
    })).toMatchObject({ anchors: ['function ANCHOR_1()'] });
    expect(tool.parseInput?.({
      path: 'app/page.tsx',
      query: 'function ANCHOR_2()',
    })).toMatchObject({ anchors: ['function ANCHOR_2()'] });
    expect(tool.parseInput?.({
      path: 'app/page.tsx',
      anchors: ['function ANCHOR_3() {\n  return 3;\n}', 'x'.repeat(260)],
    })).toMatchObject({
      anchors: ['function ANCHOR_3() {', 'return 3;', '}', 'x'.repeat(200)],
    });
    expect(tool.parseInput?.({ path: 'app/page.tsx' })).toMatchObject({ anchors: [''] });
    expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(['path', 'anchors']);

    const result = await invoke(tool, {
      path: 'app/page.tsx',
      anchors: anchors.map((anchor) => `function ${anchor}()`),
      afterLines: 999,
    });
    expect(result).toMatchObject({
      ok: true,
      data: {
        selectedMatchCount: 16,
        matchesTruncated: false,
        truncated: true,
      },
    });
    if (!result.ok || !result.content) throw new Error('Expected fair anchor batch');
    expect(result.content.length).toBeLessThanOrEqual(2_400);
    for (const anchor of anchors) expect(result.content).toContain(anchor);
  });

  it('accepts workspace-root-style paths and returns the canonical relative path', async () => {
    await fs.writeFile(
      path.join(workspace, 'app', 'page.tsx'),
      'export default function Page() { return <main />; }\n',
      'utf8',
    );
    const result = await invoke(createQueryTextFileTool({ workspaceRoot: workspace }), {
      path: '/app/page.tsx',
      anchors: ['export default'],
    });

    expect(result).toMatchObject({ ok: true, data: { path: 'app/page.tsx' } });
  });

  it('fails closed for traversal, escaping symlinks, invalid JSON, and JSON text queries', async () => {
    await fs.writeFile(path.join(outside, 'secret.json'), '{"secret":"HOST-SECRET"}', 'utf8');
    await fs.symlink(path.join(outside, 'secret.json'), path.join(workspace, 'evidence', 'escape.json'));
    await fs.writeFile(path.join(workspace, 'evidence', 'invalid.json'), '{broken', 'utf8');
    const jsonTool = createQueryJsonTool({ workspaceRoot: workspace });
    const textTool = createQueryTextFileTool({ workspaceRoot: workspace });

    await expect(invoke(jsonTool, {
      path: '../outside.json',
      pointers: [''],
    })).resolves.toMatchObject({ ok: false, error: { code: 'PATH_TRAVERSAL_DENIED' } });
    const escaped = await invoke(jsonTool, {
      path: 'evidence/escape.json',
      pointers: [''],
    });
    expect(escaped).toMatchObject({ ok: false, error: { code: 'SYMLINK_ESCAPE_DENIED' } });
    expect(JSON.stringify(escaped)).not.toContain('HOST-SECRET');
    await expect(invoke(jsonTool, {
      path: 'evidence/invalid.json',
      pointers: [''],
    })).resolves.toMatchObject({ ok: false, error: { code: 'INVALID_JSON_FILE' } });
    await expect(invoke(textTool, {
      path: 'evidence/invalid.json',
      queries: ['broken'],
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'STRUCTURED_JSON_QUERY_REQUIRED' },
    });
  });

  it('routes generation final/evidence and any large valid JSON away from raw readers', async () => {
    const finalPath = path.join(workspace, 'data_file', 'final', 'dashboard-data.json');
    await fs.writeFile(finalPath, '{"quote":{"price":12.34}}\n', 'utf8');
    await fs.writeFile(
      path.join(workspace, 'evidence', 'sources.json'),
      '{"sources":[{"dataset":"quote"}]}\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(workspace, 'large.json'),
      JSON.stringify({ rows: Array.from({ length: 100 }, (_, index) => ({ index })) }),
      'utf8',
    );
    const generation = createMoAgentTools({
      workspaceRoot: workspace,
      profile: 'generation',
    });
    const read = generation.find((tool) => tool.name === 'read_file')!;
    const range = generation.find((tool) => tool.name === 'read_file_range')!;

    await expect(invoke(read, {
      path: 'data_file/final/dashboard-data.json',
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'STRUCTURED_JSON_QUERY_REQUIRED',
        details: { reason: 'structured_path_policy' },
      },
    });
    await expect(invoke(range, {
      path: 'evidence/sources.json',
      startLine: 1,
      endLine: 20,
    })).resolves.toMatchObject({
      ok: false,
      error: { code: 'STRUCTURED_JSON_QUERY_REQUIRED' },
    });
    await expect(invoke(createReadFileTool({
      workspaceRoot: workspace,
      maxOutputChars: 200,
    }), {
      path: 'large.json',
    })).resolves.toMatchObject({
      ok: false,
      error: {
        code: 'STRUCTURED_JSON_QUERY_REQUIRED',
        details: { reason: 'large_json' },
      },
    });

    const repairRange = createReadFileRangeTool({ workspaceRoot: workspace });
    await expect(invoke(repairRange, {
      path: 'data_file/final/dashboard-data.json',
      startLine: 1,
      endLine: 20,
    })).resolves.toMatchObject({ ok: true });
  });
});
