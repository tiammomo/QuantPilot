import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkEvidenceFiles } from './evidence-checks';

vi.mock('@/lib/quant/evidence', () => ({ ensureBaselineEvidenceFiles: async () => ({ created: false }) }));
describe('evidence artifact verification', () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'qp-evidence-validation-'));
    await fs.mkdir(path.join(root, 'evidence'));
    await fs.mkdir(path.join(root, 'data_file/raw'), { recursive: true });
    await fs.writeFile(path.join(root, 'evidence/sources.json'), JSON.stringify({ sources: [{ source: 'fixture', fetched_at: '2026-01-01T00:00:00Z', artifact_path: 'data_file/raw/quote.json' }] }));
    await fs.writeFile(path.join(root, 'evidence/data_quality.json'), JSON.stringify({ status: 'ok', datasets: [] }));
  });
  afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
  it('requires the source artifact to exist, not just a plausible filename', async () => {
    expect((await checkEvidenceFiles(root)).status).toBe('failed');
    await fs.writeFile(path.join(root, 'data_file/raw/quote.json'), '{"symbol":"600519"}');
    expect((await checkEvidenceFiles(root)).status).toBe('passed');
  });
  it('refuses linked evidence even when the link points to valid JSON', async () => {
    await fs.symlink(path.join(root, 'evidence/data_quality.json'), path.join(root, 'data_file/raw/quote.json'));
    expect((await checkEvidenceFiles(root)).status).toBe('failed');
  });
});
