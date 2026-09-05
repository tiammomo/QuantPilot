import { describe, expect, it } from 'vitest';

import { GET } from './route';

describe('GET /api/health', () => {
  it('returns a cache-safe liveness response', async () => {
    const response = GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0');
    await expect(response.json()).resolves.toEqual({ ok: true, service: 'quantpilot-web' });
  });
});
