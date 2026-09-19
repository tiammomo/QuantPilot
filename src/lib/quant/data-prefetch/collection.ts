import type { QuantRunPlan } from '@/lib/domains/finance/workspace';
import { fetchSymbolDataset } from './market';
import type { JsonRecord } from './values';

export interface PrefetchProgress {
  completed: number;
  total: number;
  succeeded: number;
  failed: number;
}

/** Two symbol workers bound upstream load; each symbol's endpoints remain sequential. */
export async function collectSymbolDatasets(params: {
  projectPath: string;
  runId: string;
  plan: QuantRunPlan;
  symbols: string[];
  quotes: Map<string, JsonRecord>;
  onProgress?: (progress: PrefetchProgress) => Promise<void>;
}) {
  let next = 0;
  let completed = 0;
  let succeeded = 0;
  let reporting = Promise.resolve();
  const results: Array<{ asset: JsonRecord | null; rawFiles: string[]; warnings: string[] }> = [];
  async function worker() {
    while (next < params.symbols.length) {
      const index = next++;
      const symbol = params.symbols[index];
      const result = { asset: null as JsonRecord | null, rawFiles: [] as string[], warnings: [] as string[] };
      try {
        result.asset = await fetchSymbolDataset({
          projectPath: params.projectPath,
          runId: params.runId,
          plan: params.plan,
          symbol,
          rawFiles: result.rawFiles,
          warnings: result.warnings,
          quote: params.quotes.get(symbol),
        });
        succeeded += 1;
      } catch (error) {
        result.warnings.push(`${symbol} 预取失败：${error instanceof Error ? error.message : String(error)}`);
      }
      results[index] = result;
      completed += 1;
      const progress = { completed, total: params.symbols.length, succeeded, failed: completed - succeeded };
      // Serialize projections so slower writes cannot overwrite a newer count.
      reporting = reporting.then(() => params.onProgress?.(progress)).catch(error => {
        console.warn('[Data prefetch] Unable to publish progress:', error);
      });
      await reporting;
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, params.symbols.length) }, worker));
  // Completion order must never change the primary asset or evidence ordering.
  return {
    assets: results.flatMap(result => result.asset ? [result.asset] : []),
    rawFiles: results.flatMap(result => result.rawFiles),
    warnings: results.flatMap(result => result.warnings),
  };
}
