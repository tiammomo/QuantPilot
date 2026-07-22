import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { financeContextReceiptProjector } from './context-receipts';

describe('finance context receipts', () => {
  it('derives one stable artifact digest for a compiled multi-file dashboard', () => {
    const projector = financeContextReceiptProjector('apply_dashboard_spec')!;
    const files = [
      { path: 'app/page.tsx', afterSha256: 'page' },
      { path: 'app/globals.css', afterSha256: 'css' },
    ];
    const expected = createHash('sha256').update(JSON.stringify([
      { path: 'app/globals.css', afterSha256: 'css' },
      { path: 'app/page.tsx', afterSha256: 'page' },
    ])).digest('hex');
    expect(projector({}, { ok: true, data: { files } })).toEqual({
      targetReferences: ['app/page.tsx', 'app/globals.css'],
      artifactSha256: expected,
    });
  });
});
