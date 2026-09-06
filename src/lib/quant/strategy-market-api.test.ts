import { afterEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ enabled: true }));
vi.mock('@/lib/config/degradation', () => ({
  getRuntimeDegradationConfig: () => ({ components: { marketApi: config } }),
}));
import { fetchMarketApiJson, fetchBacktest } from './strategy-market-api';
import { controlStrategyIngestionJob } from './strategy-market-client';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  config.enabled = true;
});

describe('strategy market transport', () => {
  it('keeps the deadline active until a slowly streamed JSON body is complete', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      async (_url, init) =>
        ({
          ok: true,
          json: () =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
                once: true,
              });
            }),
        }) as Response
    );
    vi.stubGlobal('fetch', fetcher);
    let error: unknown;
    const pending = fetchMarketApiJson('/slow-body', { timeoutMs: 100 }).catch((value) => {
      error = value;
    });
    await vi.advanceTimersByTimeAsync(101);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('timeout after 100ms');
    await pending;
  });

  it('rejects disabled data access before issuing a request', async () => {
    config.enabled = false;
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await expect(fetchMarketApiJson('/anything')).rejects.toThrow('停用');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('preserves backtest fees, strategy identity and supplied parameter overrides', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ summary: { trade_count: 12 } }));
    vi.stubGlobal('fetch', fetcher);
    const result = await fetchBacktest({
      strategyId: 'ma/crossover',
      symbol: '510300',
      parameters: { fast_window: 5, fee_bps: 8 },
      limit: 252,
    });
    const url = new URL(String(fetcher.mock.calls[0][0]));
    expect(url.pathname).toContain('/ma%2Fcrossover/510300');
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      fee_bps: '8',
      fast_window: '5',
      limit: '252',
      adjustment: 'qfq',
    });
    expect(result).toEqual({ summary: { trade_count: 12 } });
  });

  it('retains administrator authorization and control payloads across the new client boundary', async () => {
    vi.stubEnv('QUANTPILOT_MARKET_ADMIN_TOKEN', 'unit-fixture-admin');
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ job_id: 'job/1', action: 'pause', status: 'paused' }));
    vi.stubGlobal('fetch', fetcher);
    await controlStrategyIngestionJob({ jobId: 'job/1', action: 'pause', reason: 'review' });
    const [url, init] = fetcher.mock.calls[0];
    expect(String(url)).toContain('/job%2F1/control');
    expect(init).toMatchObject({ method: 'POST', headers: { 'X-QuantPilot-Admin-Token': 'unit-fixture-admin' } });
    expect(JSON.parse(String(init?.body))).toEqual({ action: 'pause', reason: 'review' });
  });
});
