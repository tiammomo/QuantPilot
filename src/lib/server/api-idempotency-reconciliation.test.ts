import { describe, expect, it, vi } from 'vitest';

import { reconcileApiOperationQuotaSettlements } from './api-idempotency-reconciliation';

function operation() {
  return {
    id: 'operation-1',
    actorKey: 'member-1',
    status: 'completed',
    completedAt: new Date('2026-07-17T00:00:00.000Z'),
    createdAt: new Date('2026-07-17T00:00:00.000Z'),
    quotaSettlement: {
      reservationId: 'reservation-1',
      actorUserId: 'member-1',
      projectId: 'project-1',
      metric: 'quant.data_units.daily',
      actualQuantity: '2',
      sourceType: 'strategy_api',
      sourceId: 'bars-1',
      usageEventIdempotencyKey: 'strategy:bars-1:attempt:1:usage',
      metadata: { action: 'symbol-bars' },
    },
  };
}

describe('API operation quota reconciliation', () => {
  it('fails closed when reservation identity differs from the persisted plan', async () => {
    const updateMany = vi.fn();
    const onError = vi.fn();
    const client = {
      apiIdempotencyOperation: {
        findMany: vi.fn().mockResolvedValue([operation()]),
        updateMany,
      },
      quotaReservation: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'reservation-1',
          actorUserId: 'another-user',
          projectId: 'project-1',
          metric: 'quant.data_units.daily',
          status: 'settled',
          expiresAt: new Date('2026-07-18T00:00:00.000Z'),
        }),
      },
    } as never;

    const result = await reconcileApiOperationQuotaSettlements({ client, onError });

    expect(result).toEqual({ scanned: 1, reconciled: 0, failed: 1 });
    expect(updateMany).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('operation-1', expect.any(Error));
  });

  it('marks an already-settled matching reservation as accounted', async () => {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const client = {
      apiIdempotencyOperation: {
        findMany: vi.fn().mockResolvedValue([operation()]),
        updateMany,
      },
      quotaReservation: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'reservation-1',
          actorUserId: 'member-1',
          projectId: 'project-1',
          metric: 'quant.data_units.daily',
          status: 'settled',
          expiresAt: new Date('2026-07-18T00:00:00.000Z'),
        }),
      },
    } as never;

    const result = await reconcileApiOperationQuotaSettlements({
      client,
      now: new Date('2026-07-17T01:00:00.000Z'),
    });

    expect(result).toEqual({ scanned: 1, reconciled: 1, failed: 0 });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'operation-1', quotaAccountedAt: null },
      data: { quotaAccountedAt: new Date('2026-07-17T01:00:00.000Z') },
    });
  });

  it('repairs additional postpaid usage before marking the operation accounted', async () => {
    const baseOperation = operation();
    const withTokens = {
      ...baseOperation,
      quotaSettlement: {
        ...baseOperation.quotaSettlement,
        additionalUsage: [{
          actorUserId: 'member-1',
          metric: 'llm.total_tokens.monthly',
          quantity: '321',
          idempotencyKey: 'query-rewrite:member-1:rewrite-1:attempt:1:tokens',
          sourceType: 'query_rewrite',
          sourceId: 'rewrite-1',
          metadata: { inputTokens: 200, outputTokens: 121 },
        }],
      },
    };
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const recordUsage = vi.fn().mockResolvedValue({ eventId: 'usage-token-1' });
    const client = {
      apiIdempotencyOperation: {
        findMany: vi.fn().mockResolvedValue([withTokens]),
        updateMany,
      },
      quotaReservation: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'reservation-1',
          actorUserId: 'member-1',
          projectId: 'project-1',
          metric: 'quant.data_units.daily',
          status: 'settled',
          expiresAt: new Date('2026-07-18T00:00:00.000Z'),
        }),
      },
    } as never;

    const result = await reconcileApiOperationQuotaSettlements({
      client,
      quotaService: { settle: vi.fn(), recordUsage } as never,
    });

    expect(result).toEqual({ scanned: 1, reconciled: 1, failed: 0 });
    expect(recordUsage).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 'member-1',
      metric: 'llm.total_tokens.monthly',
      quantity: 321n,
      idempotencyKey: 'query-rewrite:member-1:rewrite-1:attempt:1:tokens',
    }));
    expect(recordUsage.mock.invocationCallOrder[0]).toBeLessThan(updateMany.mock.invocationCallOrder[0]);
  });

  it('keeps accounting pending when additional postpaid usage repair fails', async () => {
    const baseOperation = operation();
    const withTokens = {
      ...baseOperation,
      quotaSettlement: {
        ...baseOperation.quotaSettlement,
        additionalUsage: [{
          actorUserId: 'member-1',
          metric: 'llm.total_tokens.monthly',
          quantity: '321',
          idempotencyKey: 'query-rewrite:member-1:rewrite-1:attempt:1:tokens',
          sourceType: 'query_rewrite',
        }],
      },
    };
    const updateMany = vi.fn();
    const client = {
      apiIdempotencyOperation: {
        findMany: vi.fn().mockResolvedValue([withTokens]),
        updateMany,
      },
      quotaReservation: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'reservation-1', actorUserId: 'member-1', projectId: 'project-1',
          metric: 'quant.data_units.daily', status: 'settled',
          expiresAt: new Date('2026-07-18T00:00:00.000Z'),
        }),
      },
    } as never;

    const result = await reconcileApiOperationQuotaSettlements({
      client,
      quotaService: {
        settle: vi.fn(),
        recordUsage: vi.fn().mockRejectedValue(new Error('usage store unavailable')),
      } as never,
    });

    expect(result).toEqual({ scanned: 1, reconciled: 0, failed: 1 });
    expect(updateMany).not.toHaveBeenCalled();
  });
});
