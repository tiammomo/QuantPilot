import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QuantRunPlan } from '@/lib/domains/finance/workspace';
import { collectSymbolDatasets } from './collection';
import { fetchSymbolDataset } from './market';

vi.mock('./market', () => ({ fetchSymbolDataset: vi.fn() }));
afterEach(() => vi.resetAllMocks());

describe('bounded symbol collection', () => {
  it('drains in-flight symbols on cancellation without starting another symbol', async () => {
    const finish = new Map<string, () => void>();
    let cancelled = false;
    const assertActive = async () => { if (cancelled) throw new Error('cancelled'); };
    vi.mocked(fetchSymbolDataset).mockImplementation(async params => {
      await new Promise<void>(resolve => finish.set(params.symbol, resolve));
      await params.assertActive?.();
      return { symbol: params.symbol };
    });
    let settled = false;
    const pending = collectSymbolDatasets({
      projectPath: '/unused', runId: 'run', plan: {} as QuantRunPlan,
      symbols: ['A', 'B', 'C'], quotes: new Map(), assertActive,
    }).catch(error => { settled = true; return error; });
    await vi.waitFor(() => expect(finish.size).toBe(2));
    cancelled = true;
    finish.get('A')!();
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    expect(finish.has('C')).toBe(false);
    finish.get('B')!();
    expect(await pending).toMatchObject({ message: 'cancelled' });
    expect(fetchSymbolDataset).toHaveBeenCalledTimes(2);
  });

  it('runs at most two symbols, isolates failures and keeps requested evidence order', async () => {
    const finish = new Map<string, () => void>();
    let active = 0;
    let peak = 0;
    vi.mocked(fetchSymbolDataset).mockImplementation(async params => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise<void>(resolve => finish.set(params.symbol, resolve));
      active -= 1;
      params.rawFiles.push(`${params.symbol}/quote.json`);
      if (params.symbol === 'B') throw new Error('upstream unavailable');
      params.warnings.push(`${params.symbol}: incomplete history`);
      return { symbol: params.symbol, quote: params.quote };
    });
    const onProgress = vi.fn().mockResolvedValue(undefined);
    const quote = { symbol: 'A', price: '10' };
    const pending = collectSymbolDatasets({
      projectPath: '/unused', runId: 'run', plan: {} as QuantRunPlan,
      symbols: ['A', 'B', 'C', 'D'], quotes: new Map([['A', quote]]), onProgress,
    });
    expect([...finish.keys()]).toEqual(['A', 'B']);
    finish.get('B')!();
    await vi.waitFor(() => expect(finish.has('C')).toBe(true));
    finish.get('C')!();
    await vi.waitFor(() => expect(finish.has('D')).toBe(true));
    finish.get('D')!();
    finish.get('A')!();
    const result = await pending;
    expect(peak).toBe(2);
    expect(result.assets.map(asset => asset.symbol)).toEqual(['A', 'C', 'D']);
    expect(result.assets[0].quote).toBe(quote);
    expect(result.rawFiles).toEqual(['A/quote.json', 'B/quote.json', 'C/quote.json', 'D/quote.json']);
    expect(result.warnings).toEqual([
      'A: incomplete history', 'B 预取失败：upstream unavailable',
      'C: incomplete history', 'D: incomplete history',
    ]);
    expect(onProgress.mock.calls.map(([progress]) => progress.completed)).toEqual([1, 2, 3, 4]);
    expect(onProgress).toHaveBeenLastCalledWith({ completed: 4, total: 4, succeeded: 3, failed: 1 });
  });

  it('serializes progress writes and continues collecting after a projection failure', async () => {
    vi.mocked(fetchSymbolDataset).mockImplementation(async ({ symbol }) => ({ symbol }));
    let release!: () => void;
    const slow = new Promise<void>(resolve => { release = resolve; });
    const onProgress = vi.fn().mockReturnValueOnce(slow).mockRejectedValueOnce(new Error('projection unavailable'));
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const pending = collectSymbolDatasets({
        projectPath: '/unused', runId: 'run', plan: {} as QuantRunPlan,
        symbols: ['A', 'B'], quotes: new Map(), onProgress,
      });
      await vi.waitFor(() => expect(onProgress).toHaveBeenCalledTimes(1));
      release();
      expect((await pending).assets).toHaveLength(2);
      expect(onProgress).toHaveBeenCalledTimes(2);
      expect(warning).toHaveBeenCalledOnce();
    } finally { warning.mockRestore(); }
  });
});
