/** Synthetic transport benchmark, not live provider latency or full Agent delivery time.
 * Run: node -r tsconfig-paths/register --import tsx scripts/checks/benchmark-data-prefetch.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import type { QuantRunPlan } from '../../src/lib/domains/finance/workspace';
import { collectSymbolDatasets } from '../../src/lib/quant/data-prefetch/collection';
import { fetchSymbolDataset } from '../../src/lib/quant/data-prefetch/market';
import { fetchJson } from '../../src/lib/quant/data-prefetch/transport';
import type { JsonRecord } from '../../src/lib/quant/data-prefetch/values';

async function main() {
  const projectPath = await fs.mkdtemp(path.join(os.tmpdir(), 'qp-prefetch-benchmark-'));
  const originalFetch = globalThis.fetch;
  const symbols = Array.from({ length: 8 }, (_, index) => `60000${index}`);
  const quote = (symbol: string) => ({ symbol, price: '10', asset_type: 'stock', fetched_at: '2026-09-18T08:00:00Z' });
  const plan = {
    capabilityId: 'stock_diagnosis', timeRange: '最近 20 个交易日',
    dataRequirements: ['/api/v1/quotes/history/{symbol}', '/api/v1/fundamentals/financials/{symbol}'],
  } as QuantRunPlan;
  const samples = [];
  let baseline: unknown;
  try {
    for (const mode of ['previous_serial', 'bounded_batch_reuse'] as const) {
      for (let repeat = 0; repeat < 3; repeat++) {
        let requests = 0;
        let active = 0;
        let peak = 0;
        globalThis.fetch = async input => {
          requests += 1;
          peak = Math.max(peak, ++active);
          await delay(50);
          active -= 1;
          const endpoint = new URL(String(input)).pathname;
          const symbol = endpoint.split('/').at(-1)!;
          if (endpoint === '/api/v1/quotes/realtime') return Response.json({ quotes: symbols.map(quote) });
          if (endpoint.startsWith('/api/v1/quotes/realtime/')) return Response.json(quote(symbol));
          if (endpoint.startsWith('/api/v1/quotes/history/')) return Response.json({
            symbol, bars: [{ date: '2026-09-18', close: '10', volume: 1000 }],
          });
          if (endpoint.startsWith('/api/v1/fundamentals/financials/')) return Response.json({ symbol, reports: [] });
          throw new Error(`Unexpected fixture endpoint: ${endpoint}`);
        };
        const started = performance.now();
        const batch = await fetchJson('/api/v1/quotes/realtime', {
          method: 'POST', body: JSON.stringify({ symbols }),
        });
        let assets: JsonRecord[];
        const runId = `${mode}-${repeat}`;
        if (mode === 'previous_serial') {
          assets = [];
          for (const symbol of symbols) assets.push(await fetchSymbolDataset({
            projectPath, runId, plan, symbol, rawFiles: [], warnings: [],
          }));
        } else {
          assets = (await collectSymbolDatasets({
            projectPath, runId, plan, symbols,
            quotes: new Map((batch.quotes as JsonRecord[]).map(row => [String(row.symbol), row])),
          })).assets;
        }
        const durationMs = Math.round(performance.now() - started);
        const comparable = assets.map(({ generatedAt: _timestamp, ...asset }) => asset);
        if (!baseline) baseline = comparable;
        assert.deepEqual(comparable, baseline, 'Optimization changed the research data');
        samples.push({ mode, durationMs, requests, peakConcurrentRequests: peak });
      }
    }
    console.log(JSON.stringify({
      kind: 'synthetic_transport', symbols: symbols.length, fixtureLatencyMs: 50,
      scope: 'Quote, history and financial collection only; no LLM or live market service.',
      equivalentData: true, samples,
    }, null, 2));
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(projectPath, { recursive: true, force: true });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
