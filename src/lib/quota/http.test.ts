import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/db/client', () => ({ prisma: {} }));

import { QuotaExceededError } from './service';
import type { QuotaReserveResult } from './types';
import { quotaErrorResponse } from './http';

describe('quotaErrorResponse', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T08:00:00.000Z'));
  });

  it('returns a structured 429 with decimal-safe counters and Retry-After', async () => {
    const decision: QuotaReserveResult = {
      allowed: false,
      mode: 'metered',
      policy: {
        actorUserId: 'member-1',
        metric: 'projects.owned',
        source: 'profile',
        unlimited: false,
        limit: 10n,
        enforcement: 'hard',
        windowType: 'month',
        windowSeconds: null,
        reservationTtlSeconds: 900,
        enforcementExempt: false,
      },
      counter: {
        used: 8n,
        reserved: 2n,
        requested: 1n,
        limit: 10n,
        remaining: 0n,
        exceeded: true,
      },
      window: {
        start: new Date('2026-07-01T00:00:00.000Z'),
        end: new Date('2026-07-16T08:01:30.001Z'),
      },
      reservation: null,
    };

    const response = quotaErrorResponse(new QuotaExceededError(decision));

    expect(response).not.toBeNull();
    expect(response!.status).toBe(429);
    expect(response!.headers.get('Retry-After')).toBe('91');
    await expect(response!.json()).resolves.toEqual({
      success: false,
      error: 'QUOTA_EXCEEDED',
      message: '当前操作会超过可用配额，请等待额度重置或联系管理员调整策略。',
      quota: {
        metric: 'projects.owned',
        enforcement: 'hard',
        used: '8',
        reserved: '2',
        requested: '1',
        limit: '10',
        remaining: '0',
        resetAt: '2026-07-16T08:01:30.001Z',
      },
    });
  });

  it('leaves unrelated errors to the route-level error handler', () => {
    expect(quotaErrorResponse(new Error('database unavailable'))).toBeNull();
  });
});
