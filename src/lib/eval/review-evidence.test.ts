import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadReviewEvidence, resolvesReviewEvidence } from './review-evidence';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });
async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qp-review-evidence-'));
  roots.push(root);
  for (const [file, data] of Object.entries({
    'data_file/final/dashboard-data.json': { symbol: '600519', bars: Array.from({ length: 1500 }, (_, i) => ({ date: String(i), close: '10.1234567890123456789', note: '数据仅供研究' })) },
    'evidence/sources.json': { sources: [{ source: 'fixture' }] },
    'evidence/data_quality.json': { status: 'ok' },
    '.data-agent/finance-run-plan.json': { question: '仅分析可得数据', 'a/b': { '~key': 'value' } },
  })) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), JSON.stringify(data));
  }
  return root;
}

describe('review evidence packet', () => {
  it('keeps bounded valid JSON and exact prices with explicit partial coverage', async () => {
    const evidence = await loadReviewEvidence(await workspace());
    expect(evidence.finalData.truncated).toBe(true);
    expect(JSON.stringify(evidence.finalData.value).length).toBeLessThanOrEqual(24_000);
    expect(JSON.stringify(evidence.finalData.value)).toContain('10.1234567890123456789');
    expect(resolvesReviewEvidence('finalData#/symbol', evidence)).toBe(true);
    expect(resolvesReviewEvidence('runPlan#/a~1b/~0key', evidence)).toBe(true);
    for (const ref of ['sources#/sources/0/invented', 'finalData#/__proto__', 'sources#/sources/constructor', '/etc/passwd', 'quality#', 'quality#/missing']) {
      expect(resolvesReviewEvidence(ref, evidence), ref).toBe(false);
    }
  });
  it('fails before model dispatch when a required artifact is missing or linked', async () => {
    const root = await workspace();
    const file = path.join(root, 'evidence/sources.json');
    await fs.unlink(file);
    await expect(loadReviewEvidence(root)).rejects.toThrow('sources');
    await fs.symlink(path.join(root, 'evidence/data_quality.json'), file);
    await expect(loadReviewEvidence(root)).rejects.toThrow('sources');
  });
});
