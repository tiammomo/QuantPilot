import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QuantRunPlan } from '@/lib/domains/finance/workspace';
import { fetchSymbolDataset } from './market';

const projects: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(projects.splice(0).map((project) => fs.rm(project, { recursive: true, force: true })));
});

describe('backtest experiment artifacts', () => {
  it('reuses validated batch quotes in both the final data and raw evidence', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'qp-batch-quote-'));
    projects.push(projectPath);
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const quote = { symbol: '510300', price: '3.9', asset_type: 'etf', as_of: '2026-09-18' };
    const result = await fetchSymbolDataset({
      projectPath, runId: 'batch', symbol: '510300', quote, rawFiles: [], warnings: [],
      plan: { dataRequirements: [] } as unknown as QuantRunPlan,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(result).toMatchObject({ symbol: '510300', asset_type: 'etf', as_of: quote.as_of, quote });
    expect(JSON.parse(await fs.readFile(path.join(projectPath, 'data_file/raw/batch/510300/quote.json'), 'utf8'))).toEqual(quote);
  });

  it.each([
    { symbol: '600519', price: 10 },
    { symbol: '510300', price: -1 },
    { symbol: '510300', price: null },
    { symbol: '510300', price: 10, data_quality: { status: 'error' } },
  ])('falls back from unusable batch rows instead of overwriting verified data: %j', async quote => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'qp-batch-fallback-'));
    projects.push(projectPath);
    const fallback = { symbol: '510300', price: '3.9', asset_type: 'etf' };
    const fetcher = vi.fn().mockResolvedValue(Response.json(fallback));
    vi.stubGlobal('fetch', fetcher);
    const warnings: string[] = [];
    const result = await fetchSymbolDataset({
      projectPath, runId: 'batch', symbol: '510300', quote, rawFiles: [], warnings,
      plan: { dataRequirements: [] } as unknown as QuantRunPlan,
    });
    expect(result.quote).toEqual(fallback);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(warnings[0]).toContain('批量行情不可用');
  });

  it('keeps complete inputs in the raw artifact and only a reference in research context', async () => {
    const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'qp-backtest-artifact-'));
    projects.push(projectPath);
    const artifact = {
      symbol: '510300',
      summary: { total_return_pct: '5.2' },
      experiment: {
        schema_version: 1,
        experiment_id: `sha256:${'a'.repeat(64)}`,
        data_sha256: `sha256:${'b'.repeat(64)}`,
        result_sha256: `sha256:${'c'.repeat(64)}`,
        data: { bars: [{ date: '2026-01-01', close: '10.1234567890123456789' }] },
      },
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/backtests/')) return new Response(JSON.stringify(artifact));
        if (url.includes('/quotes/realtime/'))
          return new Response(
            JSON.stringify({
              symbol: '510300',
              asset_type: 'etf',
              fetched_at: '2026-01-02T00:00:00Z',
            })
          );
        throw new Error(`Unexpected network access: ${url}`);
      })
    );
    const rawFiles: string[] = [];
    const warnings: string[] = [];
    const result = await fetchSymbolDataset({
      projectPath,
      runId: 'replay-fixture',
      symbol: '510300',
      rawFiles,
      warnings,
      plan: {
        capabilityId: 'backtest_review',
        question: '回看已归档的回测',
        dataRequirements: ['/api/v1/backtests/ma-crossover/510300'],
      } as QuantRunPlan,
    });
    const artifactPath = `data_file/raw/replay-fixture/510300/backtest-ma-crossover-${'a'.repeat(64)}.json`;
    expect(JSON.parse(await fs.readFile(path.join(projectPath, artifactPath), 'utf8'))).toEqual(artifact);
    expect(result.backtest).toEqual({
      symbol: '510300',
      summary: artifact.summary,
      experiment_ref: {
        artifact_path: artifactPath,
        experiment_id: artifact.experiment.experiment_id,
        data_sha256: artifact.experiment.data_sha256,
        result_sha256: artifact.experiment.result_sha256,
      },
    });
    expect(JSON.stringify(result)).not.toContain('10.1234567890123456789');
    expect(rawFiles).toContain(artifactPath);
    expect(warnings).toEqual([]);

    const original = structuredClone(artifact);
    artifact.experiment.experiment_id = `sha256:${'d'.repeat(64)}`;
    artifact.experiment.data.bars[0].close = '99';
    await fetchSymbolDataset({
      projectPath,
      runId: 'replay-fixture',
      symbol: '510300',
      rawFiles,
      warnings,
      plan: { dataRequirements: ['/api/v1/backtests/ma-crossover/510300'] } as QuantRunPlan,
    });
    expect(JSON.parse(await fs.readFile(path.join(projectPath, artifactPath), 'utf8'))).toEqual(original);
    expect(rawFiles).toContain(`data_file/raw/replay-fixture/510300/backtest-ma-crossover-${'d'.repeat(64)}.json`);
  });
});
