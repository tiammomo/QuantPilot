import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { MoAgentToolContext } from '@/lib/agent/types';

import { createSemanticEditTool } from './semantic-edit';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('semantic_edit tool', () => {
  let workspace: string;
  let page: string;
  let styles: string;
  let commitCount: number;

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'moagent-semantic-edit-'));
    await fs.mkdir(path.join(workspace, 'app'), { recursive: true });
    page = [
      "import type { ReactNode } from 'react';",
      '',
      'function PriceChart({ value }: { value: number }) {',
      '  return <svg aria-label="old-chart"><text>{value}</text></svg>;',
      '}',
      '',
      'export default function Page() {',
      '  return <main><PriceChart value={1} /></main>;',
      '}',
      '',
    ].join('\n');
    styles = [
      '.dashboard {',
      '  display: grid;',
      '}',
      '',
      '@media (max-width: 700px) {',
      '  .dashboard {',
      '    display: block;',
      '  }',
      '}',
      '',
    ].join('\n');
    await fs.writeFile(path.join(workspace, 'app', 'page.tsx'), page, 'utf8');
    await fs.writeFile(path.join(workspace, 'app', 'globals.css'), styles, 'utf8');
    commitCount = 0;
  });

  afterEach(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
  });

  function context(): MoAgentToolContext {
    return {
      runId: 'run-semantic-edit',
      turn: 2,
      toolCallId: 'call-semantic-edit',
      operationId: `op_semantic_edit_${commitCount}`,
      signal: new AbortController().signal,
      commitWorkspaceMutation: async <T>(commit: () => Promise<T>): Promise<T> => {
        commitCount += 1;
        return commit();
      },
    };
  }

  it('replaces one named TypeScript declaration with an optimistic hash', async () => {
    const tool = createSemanticEditTool({ workspaceRoot: workspace });
    const result = await tool.execute(tool.parseInput?.({
      path: 'app/page.tsx',
      kind: 'typescript_symbol',
      beforeSha256: sha256(page),
      symbol: 'PriceChart',
      replacement: [
        'function PriceChart({ value }: { value: number }) {',
        '  return <figure aria-label="price-chart">{value}</figure>;',
        '}',
      ].join('\n'),
    }) as never, context());

    expect(result).toMatchObject({
      ok: true,
      data: { kind: 'typescript_symbol', target: 'PriceChart', startLine: 3, endLine: 5 },
    });
    expect(commitCount).toBe(1);
    const updated = await fs.readFile(path.join(workspace, 'app', 'page.tsx'), 'utf8');
    expect(updated).toContain('aria-label="price-chart"');
    expect(updated).not.toContain('old-chart');
    expect(updated).toContain('export default function Page()');
  });

  it('rejects stale source hashes before preparing a workspace commit', async () => {
    const tool = createSemanticEditTool({ workspaceRoot: workspace });
    const result = await tool.execute(tool.parseInput?.({
      path: 'app/page.tsx',
      kind: 'typescript_symbol',
      beforeSha256: '0'.repeat(64),
      symbol: 'PriceChart',
      replacement: 'function PriceChart() { return null; }',
    }) as never, context());

    expect(result).toMatchObject({ ok: false, error: { code: 'WORKSPACE_WRITE_CONFLICT' } });
    expect(commitCount).toBe(0);
    await expect(fs.readFile(path.join(workspace, 'app', 'page.tsx'), 'utf8')).resolves.toBe(page);
  });

  it('requires replacement declarations to preserve the symbol identity', async () => {
    const tool = createSemanticEditTool({ workspaceRoot: workspace });
    const result = await tool.execute(tool.parseInput?.({
      path: 'app/page.tsx',
      kind: 'typescript_symbol',
      beforeSha256: sha256(page),
      symbol: 'PriceChart',
      replacement: 'function OtherChart() { return null; }',
    }) as never, context());

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'SEMANTIC_REPLACEMENT_IDENTITY_MISMATCH' },
    });
    expect(commitCount).toBe(0);
  });

  it('does not let a Next page replacement drop export default or async modifiers', async () => {
    const nextPage = [
      'export default async function Home() {',
      '  return <main>before</main>;',
      '}',
      '',
    ].join('\n');
    await fs.writeFile(path.join(workspace, 'app', 'page.tsx'), nextPage, 'utf8');
    const tool = createSemanticEditTool({ workspaceRoot: workspace });
    const result = await tool.execute(tool.parseInput?.({
      path: 'app/page.tsx',
      kind: 'typescript_symbol',
      beforeSha256: sha256(nextPage),
      symbol: 'Home',
      replacement: 'function Home() { return <main>after</main>; }',
    }) as never, context());

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'SEMANTIC_REPLACEMENT_IDENTITY_MISMATCH' },
    });
    expect(commitCount).toBe(0);
    await expect(fs.readFile(path.join(workspace, 'app', 'page.tsx'), 'utf8')).resolves.toBe(nextPage);
  });

  it.each([
    {
      caseName: 'async function status',
      source: 'export async function load() { return 1; }\n',
      symbol: 'load',
      replacement: 'export function load() { return 2; }',
    },
    {
      caseName: 'generator function status',
      source: 'export async function* stream() { yield 1; }\n',
      symbol: 'stream',
      replacement: 'export async function stream() { return 2; }',
    },
    {
      caseName: 'declare modifier',
      source: 'export declare function resolve(): string;\n',
      symbol: 'resolve',
      replacement: 'export function resolve(): string { return "value"; }',
    },
    {
      caseName: 'abstract modifier',
      source: 'export abstract class Store { abstract read(): string; }\n',
      symbol: 'Store',
      replacement: 'export class Store { read(): string { return "value"; } }',
    },
    {
      caseName: 'variable declaration kind',
      source: 'export const threshold = 1;\n',
      symbol: 'threshold',
      replacement: 'export let threshold = 2;',
    },
    {
      caseName: 'declaration kind',
      source: 'export interface Result { value: number; }\n',
      symbol: 'Result',
      replacement: 'export type Result = { value: number };',
    },
  ])('preserves $caseName when replacing a TypeScript symbol', async ({ source, symbol, replacement }) => {
    await fs.writeFile(path.join(workspace, 'app', 'page.tsx'), source, 'utf8');
    const tool = createSemanticEditTool({ workspaceRoot: workspace });
    const result = await tool.execute(tool.parseInput?.({
      path: 'app/page.tsx',
      kind: 'typescript_symbol',
      beforeSha256: sha256(source),
      symbol,
      replacement,
    }) as never, context());

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'SEMANTIC_REPLACEMENT_IDENTITY_MISMATCH' },
    });
    expect(commitCount).toBe(0);
    await expect(fs.readFile(path.join(workspace, 'app', 'page.tsx'), 'utf8')).resolves.toBe(source);
  });

  it('rejects a replacement variable statement that declares an extra symbol', async () => {
    const source = 'export const score = 1;\n';
    await fs.writeFile(path.join(workspace, 'app', 'page.tsx'), source, 'utf8');
    const tool = createSemanticEditTool({ workspaceRoot: workspace });
    const result = await tool.execute(tool.parseInput?.({
      path: 'app/page.tsx',
      kind: 'typescript_symbol',
      beforeSha256: sha256(source),
      symbol: 'score',
      replacement: 'export const score = 2, { hiddenSideEffect } = run();',
    }) as never, context());

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'SEMANTIC_REPLACEMENT_IDENTITY_MISMATCH' },
    });
    expect(commitCount).toBe(0);
    await expect(fs.readFile(path.join(workspace, 'app', 'page.tsx'), 'utf8')).resolves.toBe(source);
  });

  it('fails on an ambiguous CSS selector instead of guessing an at-rule scope', async () => {
    const tool = createSemanticEditTool({ workspaceRoot: workspace });
    const result = await tool.execute(tool.parseInput?.({
      path: 'app/globals.css',
      kind: 'css_rule',
      beforeSha256: sha256(styles),
      selector: '.dashboard',
      replacement: '.dashboard { display: flex; }',
    }) as never, context());

    expect(result).toMatchObject({ ok: false, error: { code: 'SEMANTIC_TARGET_AMBIGUOUS' } });
    expect(commitCount).toBe(0);
  });

  it('replaces a unique CSS rule and preserves surrounding rules', async () => {
    const uniqueStyles = '.shell { display: grid; }\n.metric { color: red; }\n';
    await fs.writeFile(path.join(workspace, 'app', 'globals.css'), uniqueStyles, 'utf8');
    const tool = createSemanticEditTool({ workspaceRoot: workspace });
    const result = await tool.execute(tool.parseInput?.({
      path: 'app/globals.css',
      kind: 'css_rule',
      beforeSha256: sha256(uniqueStyles),
      selector: '.shell',
      replacement: '.shell { display: flex; gap: 12px; }',
    }) as never, context());

    expect(result).toMatchObject({ ok: true, data: { kind: 'css_rule', target: '.shell' } });
    const updated = await fs.readFile(path.join(workspace, 'app', 'globals.css'), 'utf8');
    expect(updated).toContain('.shell { display: flex; gap: 12px; }');
    expect(updated).toContain('.metric { color: red; }');
  });

  it('supports a versioned exact line range as a bounded fallback', async () => {
    const tool = createSemanticEditTool({ workspaceRoot: workspace });
    const result = await tool.execute(tool.parseInput?.({
      path: 'app/page.tsx',
      kind: 'line_range',
      beforeSha256: sha256(page),
      startLine: 4,
      endLine: 4,
      replacement: '  return <svg aria-label="range-edited" />;',
    }) as never, context());

    expect(result).toMatchObject({
      ok: true,
      data: { kind: 'line_range', target: '4-4', startLine: 4, endLine: 4 },
    });
    const updated = await fs.readFile(path.join(workspace, 'app', 'page.tsx'), 'utf8');
    expect(updated).toContain('aria-label="range-edited"');
  });

  it.each(['startLine', 'endLine'])('requires %s for a line-range edit', async (missingKey) => {
    const tool = createSemanticEditTool({ workspaceRoot: workspace });
    const input: Record<string, unknown> = {
      path: 'app/page.tsx',
      kind: 'line_range',
      beforeSha256: sha256(page),
      startLine: 4,
      endLine: 4,
      replacement: '  return null;',
    };
    delete input[missingKey];

    expect(() => tool.parseInput?.(input)).toThrow(/startLine and endLine are required/);
    expect(commitCount).toBe(0);
    await expect(fs.readFile(path.join(workspace, 'app', 'page.tsx'), 'utf8')).resolves.toBe(page);
  });

  it('rejects a line-range edit that leaves the complete TypeScript file invalid', async () => {
    const tool = createSemanticEditTool({ workspaceRoot: workspace });
    const result = await tool.execute(tool.parseInput?.({
      path: 'app/page.tsx',
      kind: 'line_range',
      beforeSha256: sha256(page),
      startLine: 4,
      endLine: 4,
      replacement: '  return <svg aria-label="broken">;',
    }) as never, context());

    expect(result).toMatchObject({ ok: false, error: { code: 'SEMANTIC_REPLACEMENT_INVALID' } });
    expect(commitCount).toBe(0);
    await expect(fs.readFile(path.join(workspace, 'app', 'page.tsx'), 'utf8')).resolves.toBe(page);
  });

  it('rejects a line-range edit that leaves the complete stylesheet invalid', async () => {
    const tool = createSemanticEditTool({ workspaceRoot: workspace });
    const result = await tool.execute(tool.parseInput?.({
      path: 'app/globals.css',
      kind: 'line_range',
      beforeSha256: sha256(styles),
      startLine: 3,
      endLine: 3,
      replacement: '',
    }) as never, context());

    expect(result).toMatchObject({ ok: false, error: { code: 'SEMANTIC_REPLACEMENT_INVALID' } });
    expect(commitCount).toBe(0);
    await expect(fs.readFile(path.join(workspace, 'app', 'globals.css'), 'utf8')).resolves.toBe(styles);
  });

  it('rejects non-source files even when the workspace policy would otherwise allow them', async () => {
    await fs.mkdir(path.join(workspace, 'public'), { recursive: true });
    const data = '{"safe":true}\n';
    await fs.writeFile(path.join(workspace, 'public', 'data.json'), data, 'utf8');
    const tool = createSemanticEditTool({ workspaceRoot: workspace });
    const result = await tool.execute(tool.parseInput?.({
      path: 'public/data.json',
      kind: 'line_range',
      beforeSha256: sha256(data),
      startLine: 1,
      endLine: 1,
      replacement: '{"safe":false}',
    }) as never, context());

    expect(result).toMatchObject({
      ok: false,
      error: { code: 'SEMANTIC_EDIT_FILE_TYPE_MISMATCH' },
    });
    expect(commitCount).toBe(0);
  });

  it('rejects oversized line-range rewrites and removal of a default export', async () => {
    const oversized = await createSemanticEditTool({ workspaceRoot: workspace }).execute({
      path: 'app/page.tsx',
      kind: 'line_range',
      beforeSha256: sha256(page),
      startLine: 1,
      endLine: 9,
      replacement: 'export default function Page() { return <main />; }',
    }, context());
    expect(oversized).toMatchObject({ ok: false, error: { code: 'SEMANTIC_TARGET_UNSAFE' } });

    const oneLine = 'export default function Page() { return <main />; }\n';
    await fs.writeFile(path.join(workspace, 'app', 'page.tsx'), oneLine, 'utf8');
    const dropsDefault = await createSemanticEditTool({ workspaceRoot: workspace }).execute({
      path: 'app/page.tsx',
      kind: 'line_range',
      beforeSha256: sha256(oneLine),
      startLine: 1,
      endLine: 1,
      replacement: 'export function Page() { return <main />; }',
    }, context());
    expect(dropsDefault).toMatchObject({
      ok: false,
      error: { code: 'SEMANTIC_REPLACEMENT_IDENTITY_MISMATCH' },
    });
  });

  it('rejects a no-op so it cannot satisfy the workspace mutation requirement', async () => {
    const tool = createSemanticEditTool({ workspaceRoot: workspace });
    const result = await tool.execute(tool.parseInput?.({
      path: 'app/page.tsx',
      kind: 'line_range',
      beforeSha256: sha256(page),
      startLine: 4,
      endLine: 4,
      replacement: '  return <svg aria-label="old-chart"><text>{value}</text></svg>;',
    }) as never, context());

    expect(result).toMatchObject({ ok: false, error: { code: 'SEMANTIC_NO_CHANGE' } });
    expect(commitCount).toBe(0);
  });
});
