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
});
