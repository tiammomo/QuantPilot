import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ getWebReadiness: vi.fn() }));

vi.mock('@/lib/ops/readiness', () => ({ getWebReadiness: mocks.getWebReadiness }));

import { GET } from './route';

describe('GET /api/ready', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 200 only when required components are ready', async () => {
    mocks.getWebReadiness.mockResolvedValue({ ok: true, service: 'quantpilot-web', components: [] });

    const response = await GET();

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store, max-age=0');
  });

  it('returns 503 while preserving the readiness projection', async () => {
    mocks.getWebReadiness.mockResolvedValue({
      ok: false,
      service: 'quantpilot-web',
      components: [{ name: 'database', status: 'failed' }],
    });

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      ok: false,
      components: [{ name: 'database', status: 'failed' }],
    });
  });
});
