import { describe, expect, it, vi } from 'vitest';

import { runReadinessProbes } from './readiness';

describe('runReadinessProbes', () => {
  it('blocks traffic when a required dependency fails without exposing its error', async () => {
    const result = await runReadinessProbes([
      {
        name: 'database',
        enabled: true,
        required: true,
        run: vi.fn().mockRejectedValue(new Error('secret database hostname')),
      },
      {
        name: 'observability',
        enabled: true,
        required: false,
        run: vi.fn().mockRejectedValue(new Error('optional outage')),
      },
    ], () => new Date('2026-07-17T00:00:00.000Z'));

    expect(result.ok).toBe(false);
    expect(result.checkedAt).toBe('2026-07-17T00:00:00.000Z');
    expect(result.components).toMatchObject([
      { name: 'database', required: true, ok: false, status: 'failed' },
      { name: 'observability', required: false, ok: false, status: 'failed' },
    ]);
    expect(JSON.stringify(result)).not.toContain('secret database hostname');
  });

  it('allows disabled and failed optional dependencies', async () => {
    const disabledProbe = vi.fn();
    const result = await runReadinessProbes([
      {
        name: 'marketApi',
        enabled: false,
        required: false,
        run: disabledProbe,
      },
      {
        name: 'redis',
        enabled: true,
        required: false,
        run: vi.fn().mockRejectedValue(new Error('down')),
      },
      {
        name: 'workspace',
        enabled: true,
        required: true,
        run: vi.fn().mockResolvedValue(undefined),
      },
    ]);

    expect(result.ok).toBe(true);
    expect(disabledProbe).not.toHaveBeenCalled();
    expect(result.components[0]).toMatchObject({ status: 'disabled', ok: true });
  });
});
