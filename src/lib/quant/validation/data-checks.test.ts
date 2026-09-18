import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { checkFinalDataFile } from './data-checks';

it('does not hide an invalid displayed dataset behind another valid file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'qp-final-data-validation-'));
  try {
    const directory = path.join(root, 'data_file/final');
    await fs.mkdir(directory, { recursive: true });
    const data = {
      symbol: '600519', quote: { symbol: '600519', price: 100 },
      kline: { symbol: '600519', bars: [{ date: '2026-01-01', close: '100' }] },
    };
    await fs.writeFile(path.join(directory, 'backup.json'), JSON.stringify(data));
    data.kline.symbol = '000001';
    await fs.writeFile(path.join(directory, 'dashboard-data.json'), JSON.stringify(data));
    const result = await checkFinalDataFile(root);
    expect(result.status).toBe('failed');
    expect(result.details).toContain('symbol_mismatch');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
