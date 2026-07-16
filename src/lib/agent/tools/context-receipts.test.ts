import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { firstPartyContextReceiptProjector } from './context-receipts';

describe('first-party context receipts', () => {
  it('retains the post-write digest instead of the pre-write read digest', () => {
    const projector = firstPartyContextReceiptProjector('edit_file')!;
    expect(projector({ path: 'app/page.tsx' }, {
      ok: true,
      data: {
        path: 'app/page.tsx',
        sha256: 'before',
        afterSha256: 'after',
        bytes: 42,
      },
    })).toEqual({
      targetReferences: ['app/page.tsx'],
      artifactSha256: 'after',
      bytes: 42,
    });
  });

  it('derives one stable artifact digest for a compiled multi-file dashboard', () => {
    const projector = firstPartyContextReceiptProjector('apply_dashboard_spec')!;
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
